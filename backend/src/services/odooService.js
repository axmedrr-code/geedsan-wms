const { query } = require('../config/database');
const logger = require('./logger');
const { recordAudit } = require('./auditService');
const odoo = require('./odooXmlRpcClient');

const syncCustomerToOdoo = async (customerId) => {
  const customerResult = await query('SELECT * FROM customers WHERE id=$1', [customerId]);
  const customer = customerResult.rows[0];
  if (!customer) throw new Error('Customer not found');

  const payload = {
    name: customer.full_name,
    ref: customer.customer_number,
    email: customer.email || false,
    phone: customer.phone || false,
    street: customer.address || false,
    city: customer.city || false,
    is_company: false,
    customer_rank: 1
  };

  let odooId = customer.odoo_id ? parseInt(customer.odoo_id, 10) : null;
  if (odooId) {
    await odoo.execute('res.partner', 'write', [[odooId], payload]);
  } else {
    const existing = await odoo.execute('res.partner', 'search', [[['ref', '=', customer.customer_number]]]);
    if (existing.length) {
      odooId = existing[0];
      await odoo.execute('res.partner', 'write', [[odooId], payload]);
    } else {
      odooId = await odoo.execute('res.partner', 'create', [payload]);
    }
    await query('UPDATE customers SET odoo_id=$1, updated_at=NOW() WHERE id=$2', [String(odooId), customerId]);
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

const syncInvoiceToOdoo = async (invoiceId) => {
  const invoiceR = await query('SELECT * FROM invoices WHERE id=$1', [invoiceId]);
  const invoice = invoiceR.rows[0];
  if (!invoice) throw new Error('Invoice not found');
  if (invoice.odoo_id) return { invoiceId, odooId: parseInt(invoice.odoo_id, 10), skipped: 'already synced' };

  const customerSync = await syncCustomerToOdoo(invoice.customer_id);

  const itemsR = await query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY line_order ASC', [invoiceId]);
  const items = itemsR.rows;
  if (!items.length) throw new Error('Invoice has no line items to sync');

  const linePayload = items.map(item => [0, 0, {
    name: item.description,
    quantity: Number(item.quantity),
    price_unit: Number(item.unit_price),
  }]);

  // Idempotency search: find any existing move with this WMS invoice number as the Odoo ref.
  // This prevents duplicate account.move records when retrying after partial failures.
  const found = await odoo.execute('account.move', 'search_read',
    [[['ref', '=', invoice.invoice_number], ['move_type', '=', 'out_invoice']]],
    { fields: ['id', 'state'], limit: 1 }
  );

  let moveId, branch;

  if (found.length === 0) {
    // Branch A: MISS — no existing move in Odoo; create a fresh draft
    branch = 'miss';
    moveId = await odoo.execute('account.move', 'create', [{
      move_type:        'out_invoice',
      partner_id:       customerSync.odooId,
      invoice_date:     toOdooDate(invoice.issue_date),
      invoice_date_due: toOdooDate(invoice.due_date),
      ref:              invoice.invoice_number,
      invoice_line_ids: linePayload,
    }]);
  } else if (found[0].state === 'draft') {
    // Branch B: HIT Draft — move exists but not posted; update its fields and post
    branch = 'hit_draft';
    moveId = found[0].id;
    await odoo.execute('account.move', 'write', [[moveId], {
      partner_id:       customerSync.odooId,
      invoice_date:     toOdooDate(invoice.issue_date),
      invoice_date_due: toOdooDate(invoice.due_date),
      invoice_line_ids: [[5, 0, 0], ...linePayload],  // ORM cmd 5: delete all lines before re-adding
    }]);
  } else {
    // Branch C: HIT Posted — move is already confirmed in Odoo; do not touch it
    branch = 'hit_posted';
    moveId = found[0].id;
    await query('UPDATE invoices SET odoo_id=$1, updated_at=NOW() WHERE id=$2', [String(moveId), invoiceId]);
    return { invoiceId, odooId: moveId, branch, skipped: 'already posted in Odoo' };
  }

  // Post the draft (Branches A and B).
  // On failure: odoo_id is deliberately NOT written back — the draft remains in Odoo
  // with ref set, so the next retry enters Branch B instead of creating a duplicate.
  try {
    await odoo.execute('account.move', 'action_post', [[moveId]]);
  } catch (postErr) {
    throw new Error(
      `Odoo move id=${moveId} created/updated but action_post failed: ${postErr.message}. ` +
      `odoo_id not written to WMS. Retry will find the draft via idempotency search (Branch B).`
    );
  }

  await query('UPDATE invoices SET odoo_id=$1, updated_at=NOW() WHERE id=$2', [String(moveId), invoiceId]);
  return { invoiceId, odooId: moveId, branch };
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

  // Prefer 'bank' journal, fall back to 'cash'.
  // Note: in Odoo 18 account.payment does not accept invoice_ids at creation;
  // reconciliation is handled by Odoo automatically via outstanding credits.
  let journals = await odoo.execute('account.journal', 'search', [[['type', '=', 'bank']]], { limit: 1 });
  if (!journals.length) journals = await odoo.execute('account.journal', 'search', [[['type', '=', 'cash']]], { limit: 1 });
  if (!journals.length) throw new Error('No bank or cash journal found in Odoo');

  const payDate = payment.payment_date
    ? new Date(payment.payment_date).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const paymentOdooId = await odoo.execute('account.payment', 'create', [{
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: partnerId,
    amount: Number(payment.amount),
    date: payDate,
    journal_id: journals[0],
    ref: payment.reference || `Payment for ${invoice.invoice_number}`,
    memo: payment.note || `WMS payment id ${paymentId}`,
  }]);

  await odoo.execute('account.payment', 'action_post', [[paymentOdooId]]);
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

const syncMeterToOdoo = async (meterId) => {
  const meterR = await query(`
    SELECT m.*, c.odoo_id AS customer_odoo_id
    FROM meters m
    LEFT JOIN customers c ON c.id = m.customer_id
    WHERE m.id = $1`, [meterId]);
  const meter = meterR.rows[0];
  if (!meter) throw new Error('Meter not found');

  // Ensure the linked customer is in Odoo first
  let partnerId = meter.customer_odoo_id ? parseInt(meter.customer_odoo_id, 10) : null;
  if (meter.customer_id && !partnerId) {
    const customerSync = await syncCustomerToOdoo(meter.customer_id);
    partnerId = customerSync.odooId;
  }

  const payload = {
    name: meter.meter_number || meter.device_eui,
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
    await odoo.execute('nuwaco.meter', 'write', [[odooId], payload]);
  } else {
    const existing = await odoo.execute('nuwaco.meter', 'search', [[['wms_meter_id', '=', String(meter.id)]]]);
    if (existing.length) {
      odooId = existing[0];
      await odoo.execute('nuwaco.meter', 'write', [[odooId], payload]);
    } else {
      odooId = await odoo.execute('nuwaco.meter', 'create', [payload]);
    }
    await query('UPDATE meters SET odoo_id=$1, odoo_synced_at=NOW(), updated_at=NOW() WHERE id=$2', [String(odooId), meterId]);
  }

  return { meterId, odooId, payload };
};

// ── Reading ────────────────────────────────────────────────────────────────

const syncReadingToOdoo = async (readingId) => {
  const readingR = await query(`
    SELECT r.*, m.odoo_id AS meter_odoo_id, m.id AS meter_uuid
    FROM meter_readings r
    LEFT JOIN meters m ON m.id = r.meter_id
    WHERE r.id = $1`, [readingId]);
  const reading = readingR.rows[0];
  if (!reading) throw new Error('Reading not found');
  if (reading.odoo_id) return { readingId, odooId: parseInt(reading.odoo_id, 10), skipped: 'already synced' };

  // Ensure meter is in Odoo first
  let meterOdooId = reading.meter_odoo_id ? parseInt(reading.meter_odoo_id, 10) : null;
  if (reading.meter_uuid && !meterOdooId) {
    const meterSync = await syncMeterToOdoo(reading.meter_uuid);
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

  const odooId = await odoo.execute('nuwaco.reading', 'create', [payload]);
  await query('UPDATE meter_readings SET odoo_id=$1 WHERE id=$2', [String(odooId), readingId]);

  return { readingId, odooId };
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

const enqueueOdooSync = async (entityType, entityId) => {
  const validTypes = ['customer', 'product', 'invoice', 'payment', 'meter', 'reading', 'alarm'];
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
  customer: syncCustomerToOdoo,
  product:  syncProductToOdoo,
  invoice:  syncInvoiceToOdoo,
  payment:  syncPaymentToOdoo,
  meter:    syncMeterToOdoo,
  reading:  syncReadingToOdoo,
  alarm:    syncAlarmToOdoo,
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
  syncCustomerToOdoo,
  syncProductToOdoo,
  syncInvoiceToOdoo,
  syncPaymentToOdoo,
  syncMeterToOdoo,
  syncReadingToOdoo,
  syncAlarmToOdoo,
  enqueueOdooSync,
  processRetryQueue,
  getOdooQueue,
  getOdooStatus,
};
