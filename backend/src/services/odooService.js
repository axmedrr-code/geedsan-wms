const { query } = require('../config/database');
const logger = require('./logger');
const { recordAudit } = require('./auditService');
const odoo = require('./odooXmlRpcClient');

// Derive a stable, non-empty Odoo ref for a customer.
// Uses customer_number when present; falls back to a WMS-prefixed UUID slice
// so the idempotency search in Odoo never runs against an empty string.
const effectiveRef = (customer) => {
  const cn = customer.customer_number;
  return (cn && typeof cn === 'string' && cn.trim())
    ? cn.trim()
    : `WMS-${customer.id.slice(0, 8).toUpperCase()}`;
};

// Optional second argument accepts injected _query/_odoo for unit tests.
// All production callers pass only customerId and rely on the defaults.
const syncCustomerToOdoo = async (customerId, { _query = query, _odoo = odoo } = {}) => {
  const customerResult = await _query('SELECT * FROM customers WHERE id=$1', [customerId]);
  const customer = customerResult.rows[0];
  if (!customer) throw new Error('Customer not found');

  const ref = effectiveRef(customer);

  const payload = {
    name: customer.full_name,
    ref,
    email: customer.email || false,
    phone: customer.phone || false,
    street: customer.address || false,
    city: customer.city || false,
    is_company: false,
    customer_rank: 1
  };

  let odooId = customer.odoo_id ? parseInt(customer.odoo_id, 10) : null;
  if (odooId) {
    await _odoo.execute('res.partner', 'write', [[odooId], payload]);
  } else {
    const existing = await _odoo.execute('res.partner', 'search', [[['ref', '=', ref]]]);
    if (existing.length) {
      odooId = existing[0];
      await _odoo.execute('res.partner', 'write', [[odooId], payload]);
    } else {
      odooId = await _odoo.execute('res.partner', 'create', [payload]);
    }
    await _query('UPDATE customers SET odoo_id=$1, updated_at=NOW() WHERE id=$2', [String(odooId), customerId]);
  }

  return { customerId, odooId, payload };
};

const syncProductToOdoo = async (productId) => {
  const productResult = await query('SELECT * FROM products WHERE id=$1', [productId]);
  const product = productResult.rows[0];
  if (!product) throw new Error('Product not found');

  const payload = {
    name: product.name,
    default_code: product.product_code,
    list_price: Number(product.unit_price),
    sale_ok: true,
    purchase_ok: false,
    type: 'service'
  };

  let odooId = product.odoo_id ? parseInt(product.odoo_id, 10) : null;
  if (odooId) {
    await odoo.execute('product.product', 'write', [[odooId], payload]);
  } else {
    const existing = await odoo.execute('product.product', 'search', [[['default_code', '=', product.product_code]]]);
    if (existing.length) {
      odooId = existing[0];
      await odoo.execute('product.product', 'write', [[odooId], payload]);
    } else {
      odooId = await odoo.execute('product.product', 'create', [payload]);
    }
    await query('UPDATE products SET odoo_id=$1, updated_at=NOW() WHERE id=$2', [String(odooId), productId]);
  }

  return { productId, odooId, payload };
};

// Optional second argument accepts injected deps for unit tests.
// All production callers pass only invoiceId and rely on the defaults.
const syncInvoiceToOdoo = async (invoiceId, { _query = query, _odoo = odoo, _syncCustomer = syncCustomerToOdoo } = {}) => {
  const invoiceR = await _query('SELECT * FROM invoices WHERE id=$1', [invoiceId]);
  const invoice = invoiceR.rows[0];
  if (!invoice) throw new Error('Invoice not found');
  if (invoice.odoo_id) return {
    invoiceId,
    odooId:        parseInt(invoice.odoo_id, 10),
    invoiceNumber: invoice.invoice_number,
    customerId:    invoice.customer_id,
    skipped:       'already synced',
  };

  const customerSync = await _syncCustomer(invoice.customer_id);

  const itemsR = await _query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY line_order ASC', [invoiceId]);
  const items = itemsR.rows;
  if (!items.length) throw new Error('Invoice has no line items to sync');

  const linePayload = items.map(item => [0, 0, {
    name:       item.description,
    quantity:   Number(item.quantity),
    price_unit: Number(item.unit_price),
  }]);

  // Idempotency search: find any existing move with this WMS invoice number as the Odoo ref.
  // This prevents duplicate account.move records when retrying after partial failures.
  const found = await _odoo.execute('account.move', 'search_read',
    [[['ref', '=', invoice.invoice_number], ['move_type', '=', 'out_invoice']]],
    { fields: ['id', 'state'], limit: 1 }
  );

  let moveId, branch;

  // Base move payload — extracted so it can be included in the return value.
  const movePayload = {
    move_type:        'out_invoice',
    partner_id:       customerSync.odooId,
    invoice_date:     toOdooDate(invoice.issue_date),
    invoice_date_due: toOdooDate(invoice.due_date),
    ref:              invoice.invoice_number,
    invoice_line_ids: linePayload,
  };

  if (found.length === 0) {
    // Branch A: MISS — no existing move in Odoo; create a fresh draft
    branch = 'miss';
    moveId = await _odoo.execute('account.move', 'create', [movePayload]);
  } else if (found[0].state === 'draft') {
    // Branch B: HIT Draft — move exists but not posted; update its fields and post
    branch = 'hit_draft';
    moveId = found[0].id;
    await _odoo.execute('account.move', 'write', [[moveId], {
      partner_id:       customerSync.odooId,
      invoice_date:     toOdooDate(invoice.issue_date),
      invoice_date_due: toOdooDate(invoice.due_date),
      invoice_line_ids: [[5, 0, 0], ...linePayload],  // ORM cmd 5: delete all lines before re-adding
    }]);
  } else {
    // Branch C: HIT Posted — move is already confirmed in Odoo; do not touch it
    branch = 'hit_posted';
    moveId = found[0].id;
    await _query('UPDATE invoices SET odoo_id=$1, updated_at=NOW() WHERE id=$2', [String(moveId), invoiceId]);
    return { invoiceId, odooId: moveId, invoiceNumber: invoice.invoice_number, customerId: invoice.customer_id, partnerId: customerSync.odooId, branch, skipped: 'already posted in Odoo' };
  }

  // Post the draft (Branches A and B).
  // On failure: odoo_id is deliberately NOT written back — the draft remains in Odoo
  // with ref set, so the next retry enters Branch B instead of creating a duplicate.
  try {
    await _odoo.execute('account.move', 'action_post', [[moveId]]);
  } catch (postErr) {
    throw new Error(
      `Odoo move id=${moveId} created/updated but action_post failed: ${postErr.message}. ` +
      `odoo_id not written to WMS. Retry will find the draft via idempotency search (Branch B).`
    );
  }

  await _query('UPDATE invoices SET odoo_id=$1, updated_at=NOW() WHERE id=$2', [String(moveId), invoiceId]);
  return { invoiceId, odooId: moveId, invoiceNumber: invoice.invoice_number, customerId: invoice.customer_id, partnerId: customerSync.odooId, branch, payload: movePayload };
};

const syncPaymentToOdoo = async (paymentId) => {
  const paymentR = await query('SELECT * FROM invoice_payments WHERE id=$1', [paymentId]);
  const payment = paymentR.rows[0];
  if (!payment) throw new Error('Payment not found');
  if (payment.odoo_id) return { paymentId, odooId: parseInt(payment.odoo_id, 10), skipped: 'already synced' };

  const invoiceR = await query('SELECT * FROM invoices WHERE id=$1', [payment.invoice_id]);
  const invoice = invoiceR.rows[0];
  if (!invoice) throw new Error('Invoice not found for payment');
  if (!invoice.odoo_id) await syncInvoiceToOdoo(invoice.id);

  const refreshedInvoice = await query('SELECT odoo_id, customer_id FROM invoices WHERE id=$1', [invoice.id]);
  const customer = await query('SELECT odoo_id FROM customers WHERE id=$1', [refreshedInvoice.rows[0].customer_id]);
  const partnerId = parseInt(customer.rows[0].odoo_id, 10);

  // Prefer 'cash' journal matching WMS payment method, fall back to 'bank'.
  // Odoo 18 requires payment_method_line_id at payment creation.
  let journalType = (payment.method === 'cash') ? 'cash' : 'bank';
  let journals = await odoo.execute('account.journal', 'search', [[['type', '=', journalType]]], { limit: 1 });
  if (!journals.length) {
    journals = await odoo.execute('account.journal', 'search', [[['type', 'in', ['bank', 'cash']]]], { limit: 1 });
  }
  if (!journals.length) throw new Error('No bank or cash journal found in Odoo');
  const journalId = journals[0];

  // Odoo 18: fetch the inbound payment method line for this journal (required field)
  const methodLines = await odoo.execute('account.payment.method.line', 'search_read',
    [[['journal_id', '=', journalId], ['payment_type', '=', 'inbound']]],
    { fields: ['id'], limit: 1 }
  );
  if (!methodLines.length) throw new Error('No inbound payment method line found for journal ' + journalId);

  const payDate = payment.payment_date
    ? new Date(payment.payment_date).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const paymentOdooId = await odoo.execute('account.payment', 'create', [{
    payment_type:           'inbound',
    partner_type:           'customer',
    partner_id:             partnerId,
    amount:                 Number(payment.amount),
    date:                   payDate,
    journal_id:             journalId,
    payment_method_line_id: methodLines[0].id,
    memo: payment.reference
      ? `${payment.reference}${payment.note ? ' — ' + payment.note : ''}`
      : (payment.note || `Payment for ${invoice.invoice_number}`),
  }]);

  // Odoo 18: action_post succeeds but its return value (an action dict) contains None fields
  // that the strict XML-RPC marshaler rejects.  The payment IS posted despite the fault.
  // Verify state explicitly rather than trusting the return value.
  try {
    await odoo.execute('account.payment', 'action_post', [[paymentOdooId]]);
  } catch (postErr) {
    if (!postErr.message.includes('cannot marshal None')) throw postErr;
    const stateR = await odoo.execute('account.payment', 'read', [[paymentOdooId], ['state']]);
    const state = stateR[0]?.state;
    if (!['in_process', 'posted', 'reconciled'].includes(state)) {
      throw new Error(`action_post for payment ${paymentOdooId} failed and state is "${state}": ${postErr.message.slice(0, 200)}`);
    }
  }

  // Reconcile the payment against the invoice's AR move line so Odoo shows payment_state='paid'.
  // This matches exactly what the UI's "Register Payment" wizard does.
  if (invoice.odoo_id) {
    const invMoveId = parseInt(invoice.odoo_id, 10);
    const invLines = await odoo.execute('account.move.line', 'search_read',
      [[['move_id', '=', invMoveId], ['account_id.account_type', '=', 'asset_receivable'], ['reconciled', '=', false]]],
      { fields: ['id'], limit: 1 }
    );
    const payLines = await odoo.execute('account.move.line', 'search_read',
      [[['payment_id', '=', paymentOdooId], ['account_id.account_type', '=', 'asset_receivable'], ['reconciled', '=', false]]],
      { fields: ['id'], limit: 1 }
    );
    if (invLines.length && payLines.length) {
      await odoo.execute('account.move.line', 'reconcile', [[invLines[0].id, payLines[0].id]])
        .catch(() => {}); // idempotent: silently ignore "already reconciled"
    }
  }

  await query('UPDATE invoice_payments SET odoo_id=$1 WHERE id=$2', [String(paymentOdooId), paymentId]);

  return { paymentId, odooId: paymentOdooId };
};

// Odoo XML-RPC rejects ISO 8601 format (milliseconds + Z suffix).
const toOdooDatetime = (v) => v ? new Date(v).toISOString().replace('T', ' ').slice(0, 19) : false;
// pg returns date columns as 'YYYY-MM-DD' strings; pass through as-is to avoid timezone shifts.
const toOdooDate = (v) => {
  if (!v) return false;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return new Date(v).toISOString().slice(0, 10);
};

// ── Meter ──────────────────────────────────────────────────────────────────

// Optional second argument accepts injected deps for unit tests.
// All production callers pass only meterId and rely on the defaults.
const syncMeterToOdoo = async (meterId, { _query = query, _odoo = odoo, _syncCustomer = syncCustomerToOdoo } = {}) => {
  const meterR = await _query(`
    SELECT m.*, c.odoo_id AS customer_odoo_id
    FROM meters m
    LEFT JOIN customers c ON c.id = m.customer_id
    WHERE m.id = $1`, [meterId]);
  const meter = meterR.rows[0];
  if (!meter) throw new Error('Meter not found');

  // Ensure the linked customer is in Odoo first
  let partnerId = meter.customer_odoo_id ? parseInt(meter.customer_odoo_id, 10) : null;
  if (meter.customer_id && !partnerId) {
    const customerSync = await _syncCustomer(meter.customer_id);
    partnerId = customerSync.odooId;
  }

  const payload = {
    // Three-level fallback: meter_number → device_eui → UUID (Odoo requires a non-empty name)
    name: meter.meter_number || meter.device_eui || String(meter.id),
    wms_meter_id: String(meter.id),
    device_eui: meter.device_eui || false,
    meter_serial: meter.meter_serial || false,
    partner_id: partnerId || false,
    meter_type: meter.tariff_type || 'residential',
    status: meter.status || 'active',
    total_consumption: Number(meter.total_consumption || 0),
    current_flow: Number(meter.current_flow || 0),
    battery_voltage: meter.battery_voltage ? Number(meter.battery_voltage) : false,
    is_online: Boolean(meter.is_online),
    valve_status: meter.valve_status || 'unknown',
    latitude: meter.latitude ? Number(meter.latitude) : false,
    longitude: meter.longitude ? Number(meter.longitude) : false,
    installation_address: meter.installation_address || false,
    installed_at: toOdooDatetime(meter.installed_at),
    last_seen:    toOdooDatetime(meter.last_seen),
  };

  let odooId = meter.odoo_id ? parseInt(meter.odoo_id, 10) : null;
  if (odooId) {
    await _odoo.execute('nuwaco.meter', 'write', [[odooId], payload]);
  } else {
    const existing = await _odoo.execute('nuwaco.meter', 'search', [[['wms_meter_id', '=', String(meter.id)]]]);
    if (existing.length) {
      odooId = existing[0];
      await _odoo.execute('nuwaco.meter', 'write', [[odooId], payload]);
    } else {
      odooId = await _odoo.execute('nuwaco.meter', 'create', [payload]);
    }
    await _query('UPDATE meters SET odoo_id=$1, odoo_synced_at=NOW(), updated_at=NOW() WHERE id=$2', [String(odooId), meterId]);
  }

  return { meterId, odooId, payload };
};

// ── Reading ────────────────────────────────────────────────────────────────

// Optional second argument accepts injected deps for unit tests.
// All production callers pass only readingId and rely on the defaults.
const syncReadingToOdoo = async (readingId, { _query = query, _odoo = odoo, _syncMeter = syncMeterToOdoo } = {}) => {
  const readingR = await _query(`
    SELECT r.*, m.odoo_id AS meter_odoo_id, m.id AS meter_uuid
    FROM meter_readings r
    LEFT JOIN meters m ON m.id = r.meter_id
    WHERE r.id = $1`, [readingId]);
  const reading = readingR.rows[0];
  if (!reading) throw new Error('Reading not found');

  // Fast path: odoo_id already written back from a previous successful sync
  if (reading.odoo_id) return { readingId, odooId: parseInt(reading.odoo_id, 10), skipped: 'already synced' };

  // Ensure meter is in Odoo first
  let meterOdooId = reading.meter_odoo_id ? parseInt(reading.meter_odoo_id, 10) : null;
  if (reading.meter_uuid && !meterOdooId) {
    const meterSync = await _syncMeter(reading.meter_uuid);
    meterOdooId = meterSync.odooId;
  }

  const payload = {
    wms_reading_id: Number(reading.id),
    meter_id: meterOdooId || false,
    timestamp: toOdooDatetime(reading.timestamp),
    total_consumption: Number(reading.total_consumption || 0),
    current_flow: Number(reading.current_flow || 0),
    battery_voltage: reading.battery_voltage ? Number(reading.battery_voltage) : false,
    rssi: reading.rssi ? Number(reading.rssi) : false,
  };

  // Safety-net idempotency: search Odoo by wms_reading_id before creating.
  // Guards against the case where a previous attempt created the record in Odoo
  // but the DB write-back (UPDATE meter_readings SET odoo_id) failed — without
  // this search a retry would create a duplicate nuwaco.reading record.
  const existing = await _odoo.execute('nuwaco.reading', 'search', [[['wms_reading_id', '=', Number(reading.id)]]]);
  let odooId;
  if (existing.length) {
    odooId = existing[0];
    await _query('UPDATE meter_readings SET odoo_id=$1 WHERE id=$2', [String(odooId), readingId]);
    return { readingId, odooId, payload, recovered: true };
  }

  odooId = await _odoo.execute('nuwaco.reading', 'create', [payload]);
  await _query('UPDATE meter_readings SET odoo_id=$1 WHERE id=$2', [String(odooId), readingId]);

  return { readingId, odooId, payload };
};

// ── Alarm ──────────────────────────────────────────────────────────────────

const syncAlarmToOdoo = async (alarmId) => {
  const alarmR = await query(`
    SELECT a.*, m.odoo_id AS meter_odoo_id, m.id AS meter_uuid
    FROM alarms a
    LEFT JOIN meters m ON m.id = a.meter_id
    WHERE a.id = $1`, [alarmId]);
  const alarm = alarmR.rows[0];
  if (!alarm) throw new Error('Alarm not found');

  let meterOdooId = alarm.meter_odoo_id ? parseInt(alarm.meter_odoo_id, 10) : null;
  if (alarm.meter_uuid && !meterOdooId) {
    const meterSync = await syncMeterToOdoo(alarm.meter_uuid);
    meterOdooId = meterSync.odooId;
  }

  const payload = {
    wms_alarm_id: String(alarm.id),
    meter_id: meterOdooId || false,
    alarm_type: alarm.alarm_type || 'unknown',
    severity: alarm.severity || 'warning',
    message: alarm.message || false,
    status: alarm.status || 'active',
    triggered_at: toOdooDatetime(alarm.triggered_at),
    resolved_at:  toOdooDatetime(alarm.resolved_at),
  };

  let odooId = alarm.odoo_id ? parseInt(alarm.odoo_id, 10) : null;
  if (odooId) {
    await odoo.execute('nuwaco.alarm', 'write', [[odooId], payload]);
  } else {
    const existing = await odoo.execute('nuwaco.alarm', 'search', [[['wms_alarm_id', '=', String(alarm.id)]]]);
    if (existing.length) {
      odooId = existing[0];
      await odoo.execute('nuwaco.alarm', 'write', [[odooId], payload]);
    } else {
      odooId = await odoo.execute('nuwaco.alarm', 'create', [payload]);
    }
    await query('UPDATE alarms SET odoo_id=$1, odoo_synced_at=NOW() WHERE id=$2', [String(odooId), alarmId]);
  }

  return { alarmId, odooId };
};

// Tariff rates — single source of truth, mirrors billingService.js
const TARIFF_RATES = { residential: 1.2, commercial: 1.8, industrial: 2.4, government: 1.0 };

// Creates an Odoo customer invoice directly from a meter reading.
// Calculates consumption = reading.total_consumption − previous_reading.total_consumption,
// applies the customer's tariff rate, and creates + posts an account.move.
// Idempotency: keyed on meter_readings.odoo_invoice_id (written back on success)
// and an Odoo-side search by ref='READING-{id}' before create (handles partial failures).
const syncInvoiceFromReadingToOdoo = async (readingId, { _query = query, _odoo = odoo, _syncCustomer = syncCustomerToOdoo } = {}) => {
  // 1. Reading + meter + customer in one JOIN
  const readingR = await _query(`
    SELECT mr.id, mr.meter_id, mr.device_eui, mr.timestamp,
           mr.total_consumption, mr.odoo_invoice_id,
           m.customer_id, m.meter_number,
           c.tariff_type AS customer_tariff_type,
           c.odoo_id     AS customer_odoo_id
    FROM meter_readings mr
    JOIN meters m ON m.id = mr.meter_id
    LEFT JOIN customers c ON c.id = m.customer_id
    WHERE mr.id = $1`,
    [readingId]
  );
  const reading = readingR.rows[0];
  if (!reading) throw new Error('Reading not found');
  if (!reading.customer_id) throw new Error('Reading has no customer — meter is unassigned');

  // 2. Fast-path idempotency: already synced
  if (reading.odoo_invoice_id) return {
    readingId:     Number(readingId),
    odooInvoiceId: parseInt(reading.odoo_invoice_id, 10),
    status:        'already_synced',
  };

  // 3. Compute consumption vs previous reading for the same meter
  const prevR = await _query(`
    SELECT total_consumption FROM meter_readings
    WHERE meter_id = $1 AND timestamp < $2
    ORDER BY timestamp DESC LIMIT 1`,
    [reading.meter_id, reading.timestamp]
  );
  const current     = Number(reading.total_consumption  || 0);
  const previous    = prevR.rows[0] ? Number(prevR.rows[0].total_consumption || 0) : 0;
  const consumption = Number((current - previous).toFixed(3));

  // 4. Validate
  if (consumption < 0)  throw new Error(`Negative consumption (${consumption} m³) — meter may have been replaced or reset`);
  if (consumption === 0) throw new Error('Zero consumption — no invoice needed for this reading');

  // 5. Tariff
  const tariffType = reading.customer_tariff_type || 'residential';
  const unitPrice  = TARIFF_RATES[tariffType] || TARIFF_RATES.residential;
  const amount     = Number((consumption * unitPrice).toFixed(2));

  // 6. Customer in Odoo
  const customerSync = await _syncCustomer(reading.customer_id);

  // 7. Payload
  const invoiceDate = new Date(reading.timestamp).toISOString().slice(0, 10);
  const refTag      = `READING-${readingId}`;
  const payload = {
    move_type:        'out_invoice',
    partner_id:       customerSync.odooId,
    invoice_date:     invoiceDate,
    ref:              refTag,
    invoice_line_ids: [[0, 0, {
      name:       `Water Consumption (${consumption.toFixed(3)} m³ × ${tariffType} rate)`,
      quantity:   consumption,
      price_unit: unitPrice,
    }]],
  };

  // 8. Idempotency search in Odoo (handles retries after partial failures)
  const found = await _odoo.execute('account.move', 'search_read',
    [[['ref', '=', refTag], ['move_type', '=', 'out_invoice']]],
    { fields: ['id', 'state'], limit: 1 }
  );

  let moveId, branch;
  if (found.length === 0) {
    branch = 'miss';
    moveId = await _odoo.execute('account.move', 'create', [payload]);
  } else if (found[0].state === 'draft') {
    branch = 'hit_draft';
    moveId = found[0].id;
    await _odoo.execute('account.move', 'write', [[moveId], {
      partner_id:       customerSync.odooId,
      invoice_date:     invoiceDate,
      invoice_line_ids: [[5, 0, 0], payload.invoice_line_ids[0]],
    }]);
  } else {
    branch = 'hit_posted';
    moveId = found[0].id;
    await _query('UPDATE meter_readings SET odoo_invoice_id=$1 WHERE id=$2', [String(moveId), readingId]);
    return { readingId: Number(readingId), odooInvoiceId: moveId, branch, status: 'already posted in Odoo' };
  }

  // 9. Post (on failure: odoo_invoice_id intentionally not written — retry finds draft via Branch B)
  try {
    await _odoo.execute('account.move', 'action_post', [[moveId]]);
  } catch (postErr) {
    throw new Error(`Odoo move id=${moveId} created but action_post failed: ${postErr.message}. Retry will recover via Branch B.`);
  }

  // 10. Write back
  await _query('UPDATE meter_readings SET odoo_invoice_id=$1 WHERE id=$2', [String(moveId), readingId]);

  return { readingId: Number(readingId), odooInvoiceId: moveId, branch, partnerId: customerSync.odooId, consumption, tariffType, unitPrice, amount, payload };
};

// Registers a payment against a posted Odoo account.move (invoice).
// Takes the Odoo move ID (integer). Pays the full residual unless `amount` is
// provided in deps (for partial payment). Uses account.payment.register wizard
// so reconciliation is handled automatically by Odoo.
// Idempotency: if invoice is already fully paid, returns early without touching Odoo.
// All payment attempts are logged to odoo_payment_log for audit and re-lookup.
const registerPaymentOnOdooMove = async (odooMoveId, { _query = query, _odoo = odoo, amount = null } = {}) => {
  const moveIdNum = Number(odooMoveId);
  if (!moveIdNum || isNaN(moveIdNum)) throw new Error('Invalid Odoo move ID');

  // 1. Read move header from Odoo
  const moves = await _odoo.execute('account.move', 'read', [[moveIdNum]], {
    fields: ['id', 'name', 'ref', 'state', 'payment_state', 'amount_total', 'amount_residual', 'partner_id'],
  });
  if (!moves || !moves.length) throw new Error(`Odoo move id=${moveIdNum} not found`);
  const move = moves[0];
  if (move.state !== 'posted') throw new Error(`Invoice ${moveIdNum} has state "${move.state}" — only posted invoices can be paid`);

  // 2. Idempotency fast path: invoice already fully paid
  if (move.payment_state === 'paid') return {
    odooMoveId:     moveIdNum,
    invoiceName:    move.name,
    paymentStateBefore: move.payment_state,
    paymentStateAfter:  move.payment_state,
    amountTotal:    Number(move.amount_total),
    amountResidual: Number(move.amount_residual),
    status:         'already_paid',
  };

  // 3. Journal: bank preferred, cash fallback
  let journals = await _odoo.execute('account.journal', 'search_read',
    [[['type', '=', 'bank']]],
    { fields: ['id', 'name'], limit: 1 }
  );
  if (!journals.length) {
    journals = await _odoo.execute('account.journal', 'search_read',
      [[['type', '=', 'cash']]],
      { fields: ['id', 'name'], limit: 1 }
    );
  }
  if (!journals.length) throw new Error('No bank or cash journal found in Odoo');
  const journal = journals[0];

  // 4. Payment amount: caller-supplied (partial) or full residual
  const amountResidual = Number(move.amount_residual);
  const paymentAmount  = (amount && Number(amount) > 0 && Number(amount) <= amountResidual)
    ? Number(Number(amount).toFixed(2))
    : amountResidual;

  // 5. Register payment via wizard — context sets the target invoice for reconciliation
  const paymentDate = new Date().toISOString().slice(0, 10);
  const ctx = { active_model: 'account.move', active_ids: [moveIdNum], active_id: moveIdNum };

  const wizardId = await _odoo.execute('account.payment.register', 'create',
    [{ payment_date: paymentDate, amount: paymentAmount, journal_id: journal.id }],
    { context: ctx }
  );
  await _odoo.execute('account.payment.register', 'action_create_payments', [[wizardId]], { context: ctx });

  // 6. Read updated move state
  const updated = await _odoo.execute('account.move', 'read', [[moveIdNum]], {
    fields: ['payment_state', 'amount_residual'],
  });
  const updatedMove = updated[0];

  // 7. Find the Odoo payment ID (reconciled with this invoice)
  let odooPaymentId = null;
  try {
    const payments = await _odoo.execute('account.payment', 'search_read',
      [[['reconciled_invoice_ids', 'in', [moveIdNum]]]],
      { fields: ['id', 'name', 'amount', 'date', 'state'], order: 'id desc', limit: 1 }
    );
    if (payments.length) odooPaymentId = payments[0].id;
  } catch (_) {}

  // 8. Log to DB
  await _query(
    `INSERT INTO odoo_payment_log (odoo_move_id, odoo_payment_id, amount, payment_date, payment_status, journal_name)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [moveIdNum, odooPaymentId, paymentAmount, paymentDate, updatedMove.payment_state, journal.name]
  );

  return {
    odooMoveId:          moveIdNum,
    odooPaymentId,
    invoiceName:         move.name,
    amount:              paymentAmount,
    paymentDate,
    journalId:           journal.id,
    journalName:         journal.name,
    partnerId:           Array.isArray(move.partner_id) ? move.partner_id[0] : Number(move.partner_id),
    partnerName:         Array.isArray(move.partner_id) ? move.partner_id[1] : null,
    paymentStateBefore:  move.payment_state,
    paymentStateAfter:   updatedMove.payment_state,
    amountTotal:         Number(move.amount_total),
    amountResidualAfter: Number(updatedMove.amount_residual),
    isPartial:           paymentAmount < amountResidual,
  };
};

const enqueueOdooSync = async (entityType, entityId) => {
  const validTypes = ['customer', 'product', 'invoice', 'payment', 'meter', 'reading', 'alarm', 'reading-invoice', 'register-payment'];
  if (!validTypes.includes(entityType)) throw new Error('Invalid Odoo entity type');

  const result = await query(
    `INSERT INTO odoo_sync_queue (entity_type, entity_id, payload, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES ($1, $2, NULL, 'pending', 0, NOW(), NOW(), NOW())
     ON CONFLICT (entity_type, entity_id)
     DO UPDATE SET status='pending', attempts=0, next_attempt_at=NOW(), updated_at=NOW()
     RETURNING *`,
    [entityType, entityId]
  );
  return result.rows[0];
};

const SYNC_HANDLERS = {
  customer:           syncCustomerToOdoo,
  product:            syncProductToOdoo,
  invoice:            syncInvoiceToOdoo,
  payment:            syncPaymentToOdoo,
  meter:              syncMeterToOdoo,
  reading:            syncReadingToOdoo,
  alarm:              syncAlarmToOdoo,
  'reading-invoice':  syncInvoiceFromReadingToOdoo,
  'register-payment': registerPaymentOnOdooMove,
};

const processRetryQueue = async () => {
  const queue = await query(
    `SELECT * FROM odoo_sync_queue WHERE status IN ('pending','retry') AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()) ORDER BY created_at ASC LIMIT 20`
  );
  if (!queue.rows.length) return 0;

  for (const item of queue.rows) {
    try {
      await query('UPDATE odoo_sync_queue SET status=$1, updated_at=NOW() WHERE id=$2', ['processing', item.id]);

      const handler = SYNC_HANDLERS[item.entity_type];
      if (!handler) throw new Error(`Unknown sync type ${item.entity_type}`);
      const result = await handler(item.entity_id);

      await query('UPDATE odoo_sync_queue SET status=$1, attempts=$2, last_error=NULL, next_attempt_at=NULL, updated_at=NOW() WHERE id=$3', ['completed', item.attempts + 1, item.id]);
      await recordAudit({ action: 'odoo_sync_success', entityType: item.entity_type, entityId: item.entity_id, newValues: result });
    } catch (err) {
      const attempts = item.attempts + 1;
      const nextAttemptMinutes = Math.min(60, 2 ** attempts);
      const nextAttemptAt = new Date(Date.now() + nextAttemptMinutes * 60 * 1000);
      const status = attempts >= 5 ? 'failed' : 'retry';

      await query(
        'UPDATE odoo_sync_queue SET status=$1, attempts=$2, last_error=$3, next_attempt_at=$4, updated_at=NOW() WHERE id=$5',
        [status, attempts, err.message, nextAttemptAt, item.id]
      );
      await recordAudit({ action: 'odoo_sync_failure', entityType: item.entity_type, entityId: item.entity_id, newValues: { error: err.message, attempts, status } });
      logger.error(`Odoo sync failed for ${item.entity_type}:${item.entity_id}`, { attempt: attempts, error: err.message });
    }
  }

  return queue.rows.length;
};

const getOdooQueue = async () => {
  const r = await query('SELECT * FROM odoo_sync_queue ORDER BY updated_at DESC LIMIT 100');
  return r.rows;
};

const getOdooStatus = async () => {
  try {
    const info = await odoo.version();
    return { ok: true, odoo: info };
  } catch (err) {
    logger.error('Odoo status check failed', { error: err.message });
    return { ok: false, error: err.message };
  }
};

module.exports = {
  effectiveRef,
  syncCustomerToOdoo,
  syncProductToOdoo,
  syncInvoiceToOdoo,
  syncPaymentToOdoo,
  syncMeterToOdoo,
  syncReadingToOdoo,
  syncAlarmToOdoo,
  syncInvoiceFromReadingToOdoo,
  registerPaymentOnOdooMove,
  enqueueOdooSync,
  processRetryQueue,
  getOdooQueue,
  getOdooStatus,
};
