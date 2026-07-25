const { query } = require('../config/database');
const logger = require('./logger');
const { recordAudit } = require('./auditService');
const odoo = require('./odooXmlRpcClient');

// Derive a stable, non-empty Odoo ref for a customer.
// Uses customer_number when present; falls back to a WMS-prefixed UUID slice
// so the idempotency search in Odoo never runs against an empty string.
const effectiveRef = (customer) => {
  const hn = customer.house_number;
  return (hn && typeof hn === 'string' && hn.trim())
    ? hn.trim()
    : `WMS-${customer.id.slice(0, 8).toUpperCase()}`;
};

// WMS account_status → Odoo wms_account_status selection value.
// WMS uses 'inactive'; Odoo selection now includes it (phase-2 addon).
const mapAccountStatus = (status) => {
  const allowed = { active: 'active', inactive: 'inactive', suspended: 'suspended', terminated: 'terminated' };
  return allowed[status] || 'active';
};

// Builds the HTML master-record note written to the partner's comment field.
// This displays in Odoo under the Notes tab to remind users WMS is the master.
const buildMasterRecordComment = (customer, primaryMeter, wmsUrl) => {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const url = `${wmsUrl.replace(/\/+$/, '')}/dashboard/customers/${customer.id}`;
  return [
    '<div>',
    '<h4 style="color:#0066cc;margin:0 0 8px;">&#9888;&#65039; Master Record: NUWACO WMS</h4>',
    '<p style="margin:0 0 6px;">Customer information is managed by <strong>NUWACO WMS</strong>.',
    ' To edit customer details, use the NUWACO WMS application.',
    ' Changes made here may be overwritten on the next synchronisation.</p>',
    `<p style="margin:0 0 6px;"><strong>House Number:</strong> ${customer.house_number || '&#8212;'}`,
    ` &nbsp;|&nbsp; <strong>Primary Meter:</strong> ${primaryMeter || '&#8212;'}</p>`,
    `<p style="margin:0 0 6px;"><strong>Last Sync:</strong> ${now}</p>`,
    `<p style="margin:0;"><a href="${url}" target="_blank">&#8594; Open in NUWACO WMS</a></p>`,
    '</div>',
  ].join('');
};

// Writes a row to odoo_sync_log. Best-effort: errors are swallowed so a log
// failure never masks the underlying sync result.
const writeOdooSyncLog = async (_query, { entityId, odooId, action, status, error, durationMs, fieldsChanged }) => {
  try {
    await _query(
      `INSERT INTO odoo_sync_log
         (entity_type, entity_id, odoo_id, action, status, error, duration_ms, fields_changed, created_at)
       VALUES ('customer', $1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        entityId,
        odooId ? String(odooId) : null,
        action,
        status,
        error || null,
        durationMs,
        fieldsChanged ? JSON.stringify(fieldsChanged) : null,
      ]
    );
  } catch (logErr) {
    logger.warn('Failed to write odoo_sync_log', { error: logErr.message, entityId });
  }
};

// Full phase-2 customer sync.
// UPSERT priority: cached odoo_id → search by wms_customer_id (UUID) → search by ref → create.
// Syncs 11 WMS custom fields + standard partner fields.
// Sets the partner comment with a master-record note.
// Writes every attempt (success or failure) to odoo_sync_log.
const syncCustomerToOdoo = async (customerId, { _query = query, _odoo = odoo } = {}) => {
  const start = Date.now();
  let odooId = null;
  let action = 'update';

  try {
    const customerResult = await _query('SELECT * FROM customers WHERE id=$1', [customerId]);
    const customer = customerResult.rows[0];
    if (!customer) throw new Error('Customer not found');

    // Primary active meter for this customer (oldest active assignment)
    const meterResult = await _query(
      `SELECT meter_number FROM meters WHERE customer_id=$1 AND status='active' ORDER BY created_at ASC LIMIT 1`,
      [customerId]
    );
    const primaryMeter = meterResult.rows[0]?.meter_number || null;

    // Publish WMS URL to Odoo ir.config_parameter so the smart button reads it.
    const wmsUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    try {
      await _odoo.execute('ir.config_parameter', 'set_param', ['nuwaco.wms_url', wmsUrl]);
    } catch (_) { /* best-effort — never block sync for a config write failure */ }

    const ref = effectiveRef(customer);

    const payload = {
      // Standard partner fields
      name:          customer.full_name,
      ref,
      email:         customer.email         || false,
      phone:         customer.phone         || false,
      street:        customer.address       || false,
      city:          customer.city          || false,
      is_company:    false,
      customer_rank: 1,
      // WMS master-record fields
      is_water_customer:    true,
      wms_customer_id:      customer.id,
      wms_customer_number:  customer.house_number     || false,
      wms_tariff_type:      customer.tariff_type      || 'residential',
      wms_account_status:   mapAccountStatus(customer.account_status),
      wms_primary_meter:    primaryMeter              || false,
      wms_national_id:      customer.national_id      || false,
      wms_house_number:     customer.address_ref      || false,
      wms_gps_lat:          customer.gps_lat  !== null && customer.gps_lat  !== undefined ? Number(customer.gps_lat)  : false,
      wms_gps_lng:          customer.gps_lng  !== null && customer.gps_lng  !== undefined ? Number(customer.gps_lng)  : false,
      wms_connection_date:  toOdooDate(customer.connection_date),
      wms_last_sync:        toOdooDatetime(new Date()),
      comment:              buildMasterRecordComment(customer, primaryMeter, wmsUrl),
    };

    const fieldsChanged = Object.keys(payload);

    // UPSERT: cached odoo_id → by UUID → by ref → create
    odooId = customer.odoo_id ? parseInt(customer.odoo_id, 10) : null;

    if (!odooId) {
      const byUuid = await _odoo.execute('res.partner', 'search', [[['wms_customer_id', '=', customer.id]]]);
      if (byUuid.length) {
        odooId = byUuid[0];
      } else {
        const byRef = await _odoo.execute('res.partner', 'search', [[['ref', '=', ref]]]);
        if (byRef.length) {
          odooId = byRef[0];
        } else {
          action = 'create';
        }
      }
    }

    if (action === 'create') {
      odooId = await _odoo.execute('res.partner', 'create', [payload]);
    } else {
      await _odoo.execute('res.partner', 'write', [[odooId], payload]);
    }

    // Write odoo_id back to WMS if not already stored (or if it changed)
    if (!customer.odoo_id || String(customer.odoo_id) !== String(odooId)) {
      await _query('UPDATE customers SET odoo_id=$1, updated_at=NOW() WHERE id=$2', [String(odooId), customerId]);
    }

    const duration = Date.now() - start;
    await writeOdooSyncLog(_query, { entityId: customerId, odooId, action, status: 'completed', durationMs: duration, fieldsChanged });

    return { customerId, odooId, action, fieldsChanged, duration };

  } catch (err) {
    const duration = Date.now() - start;
    await writeOdooSyncLog(_query, { entityId: customerId, odooId, action, status: 'failed', error: err.message, durationMs: duration, fieldsChanged: null });
    throw err;
  }
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

// WMS payment method → Odoo journal type mapping
const WMS_METHOD_TO_JOURNAL = { cash: 'cash', pos: 'cash', sahal: 'cash', evc: 'cash', other: 'cash', bank: 'bank', cheque: 'bank', adjustment: 'bank' };

const syncPaymentToOdoo = async (paymentId, { _query = query, _odoo = odoo } = {}) => {
  const paymentR = await _query('SELECT * FROM invoice_payments WHERE id=$1', [paymentId]);
  const payment = paymentR.rows[0];
  if (!payment) throw new Error('Payment not found');
  if (payment.odoo_id) return { paymentId, odooId: parseInt(payment.odoo_id, 10), skipped: 'already synced' };

  const invoiceR = await _query('SELECT * FROM invoices WHERE id=$1', [payment.invoice_id]);
  const invoice = invoiceR.rows[0];
  if (!invoice) throw new Error('Invoice not found for payment');
  if (!invoice.odoo_id) await syncInvoiceToOdoo(invoice.id, { _query, _odoo });

  const refreshedR = await _query('SELECT odoo_id FROM invoices WHERE id=$1', [invoice.id]);
  const odooMoveId = parseInt(refreshedR.rows[0]?.odoo_id, 10);
  if (!odooMoveId) throw new Error('Invoice not in Odoo after sync');

  const jType = WMS_METHOD_TO_JOURNAL[payment.method] || 'cash';
  const memo  = payment.reference
    ? `${payment.reference}${payment.note ? ' — ' + payment.note : ''}`
    : (payment.note || `WMS Payment for ${invoice.invoice_number}`);

  const result = await registerPaymentOnOdooMove(odooMoveId, {
    _query: _query,
    _odoo:  _odoo,
    amount: Number(payment.amount),
    journalType: jType,
    memo,
    paymentId,
  });

  const paymentOdooId = result.odooPaymentId;
  if (!paymentOdooId) throw new Error('Odoo payment wizard did not return a payment ID (invoice may already be fully paid)');

  await _query('UPDATE invoice_payments SET odoo_id=$1 WHERE id=$2', [String(paymentOdooId), paymentId]);
  return { paymentId, odooId: paymentOdooId, odooMoveId, paymentStateAfter: result.paymentStateAfter };
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

// Looks up the Odoo payment reconciled against a given move. Shared by both
// the already-paid fast path and the post-registration lookup below (BUG-018
// fix) — previously only the post-registration path performed this lookup, so
// a retry landing on the fast path could never recover the payment ID and
// invoice_payments.odoo_id was left permanently unset even though the payment
// had already succeeded in Odoo. Never throws — a lookup failure is logged
// and treated as "not found" so callers degrade exactly as before this fix.
const findReconciledOdooPaymentId = async (moveIdNum, _odoo, { paymentId = null, reason = null } = {}) => {
  try {
    const payments = await _odoo.execute('account.payment', 'search_read',
      [[['reconciled_invoice_ids', 'in', [moveIdNum]]]],
      { fields: ['id', 'name', 'amount', 'date', 'state'], order: 'id desc', limit: 1 }
    );
    return payments.length ? payments[0].id : null;
  } catch (err) {
    logger.warn('[ODOO_PAYMENT_LOOKUP_FAILED] Odoo payment lookup failed', { paymentId, odooMoveId: moveIdNum, reason: reason || err.message });
    return null;
  }
};

// Registers a payment against a posted Odoo account.move (invoice).
// Takes the Odoo move ID (integer). Pays the full residual unless `amount` is
// provided in deps (for partial payment). Uses account.payment.register wizard
// so reconciliation is handled automatically by Odoo.
// Idempotency: if invoice is already fully paid, returns early without touching Odoo.
// All payment attempts are logged to odoo_payment_log for audit and re-lookup.
const registerPaymentOnOdooMove = async (odooMoveId, { _query = query, _odoo = odoo, amount = null, journalType = null, memo = null, paymentId = null } = {}) => {
  const moveIdNum = Number(odooMoveId);
  if (!moveIdNum || isNaN(moveIdNum)) throw new Error('Invalid Odoo move ID');

  // 1. Read move header from Odoo
  const moves = await _odoo.execute('account.move', 'read', [[moveIdNum]], {
    fields: ['id', 'name', 'ref', 'state', 'payment_state', 'amount_total', 'amount_residual', 'partner_id'],
  });
  if (!moves || !moves.length) throw new Error(`Odoo move id=${moveIdNum} not found`);
  const move = moves[0];
  if (move.state !== 'posted') throw new Error(`Invoice ${moveIdNum} has state "${move.state}" — only posted invoices can be paid`);

  // 2. Idempotency fast path: invoice already fully paid. Still looks up the
  // reconciled payment ID so a retry landing here can complete the WMS-side
  // write-back instead of throwing forever (BUG-018).
  if (move.payment_state === 'paid') {
    const odooPaymentId = await findReconciledOdooPaymentId(moveIdNum, _odoo, { paymentId, reason: 'already_paid fast-path' });
    return {
      odooMoveId:     moveIdNum,
      odooPaymentId,
      invoiceName:    move.name,
      paymentStateBefore: move.payment_state,
      paymentStateAfter:  move.payment_state,
      amountTotal:    Number(move.amount_total),
      amountResidual: Number(move.amount_residual),
      status:         'already_paid',
    };
  }

  // 3. Journal: caller-specified type preferred, then bank, then cash
  const preferredType = journalType || 'bank';
  let journals = await _odoo.execute('account.journal', 'search_read',
    [[['type', '=', preferredType]]],
    { fields: ['id', 'name'], limit: 1 }
  );
  if (!journals.length && preferredType !== 'bank') {
    journals = await _odoo.execute('account.journal', 'search_read',
      [[['type', '=', 'bank']]],
      { fields: ['id', 'name'], limit: 1 }
    );
  }
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

  const wizardPayload = { payment_date: paymentDate, amount: paymentAmount, journal_id: journal.id };
  if (memo) wizardPayload.communication = memo;
  const wizardId = await _odoo.execute('account.payment.register', 'create',
    [wizardPayload],
    { context: ctx }
  );
  await _odoo.execute('account.payment.register', 'action_create_payments', [[wizardId]], { context: ctx });

  // 6. Read updated move state
  const updated = await _odoo.execute('account.move', 'read', [[moveIdNum]], {
    fields: ['payment_state', 'amount_residual'],
  });
  const updatedMove = updated[0];

  // 7. Find the Odoo payment ID (reconciled with this invoice)
  const odooPaymentId = await findReconciledOdooPaymentId(moveIdNum, _odoo, { paymentId, reason: 'post-payment lookup' });

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

// Returns a per-customer field-level verification report comparing WMS data to
// the synced Odoo partner. Checks 10 key fields per customer.
const verifySyncedCustomers = async () => {
  const customersResult = await query('SELECT * FROM customers ORDER BY created_at ASC');
  const customers = customersResult.rows;

  // Last sync log entry per customer (for report metadata)
  const logResult = await query(
    `SELECT DISTINCT ON (entity_id) entity_id, action, status, error, duration_ms, created_at
     FROM odoo_sync_log WHERE entity_type='customer'
     ORDER BY entity_id, created_at DESC`
  );
  const logMap = {};
  for (const row of logResult.rows) logMap[row.entity_id] = row;

  const results = [];

  for (const customer of customers) {
    const entry = {
      wms_id:          customer.id,
      customer_number: customer.customer_number,
      full_name:       customer.full_name,
      odoo_id:         customer.odoo_id ? parseInt(customer.odoo_id, 10) : null,
      last_sync_log:   logMap[customer.id] || null,
      checks:          {},
    };

    if (!customer.odoo_id) {
      entry.status = 'NOT_SYNCED';
      entry.error  = 'No odoo_id — customer has not been synced yet';
      results.push(entry);
      continue;
    }

    try {
      const partnerId = parseInt(customer.odoo_id, 10);
      const partnerRows = await odoo.execute('res.partner', 'read', [[partnerId]], {
        fields: [
          'id', 'name', 'ref', 'email', 'phone', 'street', 'city',
          'is_water_customer', 'wms_customer_id', 'wms_customer_number',
          'wms_tariff_type', 'wms_account_status', 'wms_primary_meter',
          'wms_national_id', 'wms_house_number', 'wms_last_sync',
        ],
      });

      if (!partnerRows || !partnerRows.length) {
        entry.status = 'FAIL';
        entry.error  = `Odoo partner id=${partnerId} not found (may have been deleted)`;
        results.push(entry);
        continue;
      }

      const p = partnerRows[0];

      const check = (field, wmsVal, odooVal, exact = true) => ({
        pass: exact
          ? String(wmsVal ?? '') === String(odooVal ?? '')
          : !!(odooVal),
        wms:  wmsVal  ?? null,
        odoo: odooVal ?? null,
      });

      entry.checks.name               = check('name',               customer.full_name,                          p.name);
      entry.checks.wms_customer_id    = check('wms_customer_id',    customer.id,                                 p.wms_customer_id);
      entry.checks.wms_customer_number= check('wms_customer_number', customer.customer_number || '',              p.wms_customer_number || '');
      entry.checks.wms_tariff_type    = check('wms_tariff_type',    customer.tariff_type || 'residential',       p.wms_tariff_type);
      entry.checks.wms_account_status = check('wms_account_status', mapAccountStatus(customer.account_status),   p.wms_account_status);
      entry.checks.is_water_customer  = check('is_water_customer',  true,                                        p.is_water_customer);
      entry.checks.email              = check('email',              customer.email || '',                         p.email || '');
      entry.checks.phone              = check('phone',              customer.phone || '',                         p.phone || '');
      entry.checks.wms_last_sync      = check('wms_last_sync',      'set', p.wms_last_sync, false);  // truthy check
      entry.checks.wms_primary_meter  = { pass: true, note: 'informational', odoo: p.wms_primary_meter || null };

      const allPass  = Object.values(entry.checks).every(c => c.pass);
      const anyFail  = Object.values(entry.checks).some(c => !c.pass);
      entry.status   = allPass ? 'PASS' : anyFail ? 'PARTIAL' : 'PASS';

    } catch (err) {
      entry.status = 'FAIL';
      entry.error  = err.message;
    }

    results.push(entry);
  }

  const summary = {
    total:      results.length,
    synced:     results.filter(r => r.odoo_id).length,
    not_synced: results.filter(r => r.status === 'NOT_SYNCED').length,
    pass:       results.filter(r => r.status === 'PASS').length,
    partial:    results.filter(r => r.status === 'PARTIAL').length,
    fail:       results.filter(r => r.status === 'FAIL').length,
    generated_at: new Date().toISOString(),
  };

  return { summary, customers: results };
};

// Field-level verification report comparing WMS invoices to their synced
// Odoo account.move records. Mirrors verifySyncedCustomers()'s shape and
// approach. For any invoice with no odoo_id, cross-references
// odoo_sync_queue so the report explains *why* (never enqueued, still
// retrying, or exhausted retries) rather than just "not synced".
// Optional from/to filter by issue_date, matching the rest of this file's
// report endpoints — the underlying customer-statement report calls this
// scoped to whatever range is being viewed, and it's also usable
// unscoped for a full system audit.
const verifyInvoiceSync = async ({ from = null, to = null } = {}) => {
  const params = [];
  let filter = "WHERE i.status != 'cancelled'";
  if (from) { params.push(from); filter += ` AND i.issue_date >= $${params.length}`; }
  if (to)   { params.push(to);   filter += ` AND i.issue_date <= $${params.length}`; }

  const invoicesResult = await query(
    `SELECT i.*, c.odoo_id AS customer_odoo_id, c.full_name AS customer_name
     FROM invoices i JOIN customers c ON c.id = i.customer_id
     ${filter} ORDER BY i.issue_date DESC`,
    params
  );

  const queueResult = await query(
    `SELECT entity_id, status, attempts, last_error, next_attempt_at FROM odoo_sync_queue WHERE entity_type='invoice'`
  );
  const queueMap = {};
  for (const row of queueResult.rows) queueMap[row.entity_id] = row;

  const results = [];
  for (const inv of invoicesResult.rows) {
    const queueEntry = queueMap[inv.id] || null;
    const entry = {
      wms_id: inv.id,
      invoice_number: inv.invoice_number,
      customer_name: inv.customer_name,
      odoo_id: inv.odoo_id ? parseInt(inv.odoo_id, 10) : null,
      queue: queueEntry,
    };

    if (!inv.odoo_id) {
      entry.status = 'NOT_SYNCED';
      entry.error = queueEntry
        ? `In retry queue: status=${queueEntry.status}, attempts=${queueEntry.attempts}, last_error=${queueEntry.last_error || 'none recorded yet'}`
        : 'Never synced and not in the retry queue — no sync has ever been attempted';
      results.push(entry);
      continue;
    }

    try {
      const moveId = parseInt(inv.odoo_id, 10);
      const moves = await odoo.execute('account.move', 'read', [[moveId]], {
        fields: ['id', 'ref', 'amount_total', 'state', 'partner_id', 'move_type'],
      });
      if (!moves.length) {
        entry.status = 'FAIL';
        entry.error = `Odoo move id=${moveId} not found (may have been deleted in Odoo)`;
        results.push(entry);
        continue;
      }
      const m = moves[0];
      const checks = {
        ref:        { pass: m.ref === inv.invoice_number, wms: inv.invoice_number, odoo: m.ref },
        amount:     { pass: Math.abs(Number(m.amount_total) - Number(inv.total_amount)) < 0.01, wms: Number(inv.total_amount), odoo: Number(m.amount_total) },
        partner:    { pass: Array.isArray(m.partner_id) && String(m.partner_id[0]) === String(inv.customer_odoo_id), wms: inv.customer_odoo_id, odoo: Array.isArray(m.partner_id) ? m.partner_id[0] : m.partner_id },
        move_type:  { pass: m.move_type === 'out_invoice', wms: 'out_invoice', odoo: m.move_type },
      };
      entry.checks = checks;
      entry.odoo_state = m.state;
      entry.status = Object.values(checks).every(c => c.pass) ? 'PASS' : 'MISMATCH';
    } catch (err) {
      entry.status = 'FAIL';
      entry.error = err.message;
    }
    results.push(entry);
  }

  const summary = {
    total:       results.length,
    synced:      results.filter(r => r.odoo_id).length,
    not_synced:  results.filter(r => r.status === 'NOT_SYNCED').length,
    pass:        results.filter(r => r.status === 'PASS').length,
    mismatch:    results.filter(r => r.status === 'MISMATCH').length,
    fail:        results.filter(r => r.status === 'FAIL').length,
    generated_at: new Date().toISOString(),
  };

  return { summary, invoices: results };
};

// Same as verifyInvoiceSync but for payments vs. Odoo account.payment.
// Odoo's payment_state lives on the move, not the payment, so this checks
// the payment's own amount/date/partner rather than reconciliation state —
// reconciliation correctness is Odoo's own responsibility once the payment
// exists there (it was created via the account.payment.register wizard).
const verifyPaymentSync = async ({ from = null, to = null } = {}) => {
  const params = [];
  let filter = 'WHERE 1=1';
  if (from) { params.push(from); filter += ` AND ip.payment_date >= $${params.length}`; }
  if (to)   { params.push(to);   filter += ` AND ip.payment_date <= $${params.length}`; }

  const paymentsResult = await query(
    `SELECT ip.*, i.invoice_number, c.odoo_id AS customer_odoo_id, c.full_name AS customer_name
     FROM invoice_payments ip
     JOIN invoices i  ON i.id = ip.invoice_id
     JOIN customers c ON c.id = i.customer_id
     ${filter} ORDER BY ip.payment_date DESC`,
    params
  );

  const queueResult = await query(
    `SELECT entity_id, status, attempts, last_error, next_attempt_at FROM odoo_sync_queue WHERE entity_type='payment'`
  );
  const queueMap = {};
  for (const row of queueResult.rows) queueMap[row.entity_id] = row;

  const results = [];
  for (const pay of paymentsResult.rows) {
    const queueEntry = queueMap[pay.id] || null;
    const entry = {
      wms_id: pay.id,
      invoice_number: pay.invoice_number,
      customer_name: pay.customer_name,
      odoo_id: pay.odoo_id ? parseInt(pay.odoo_id, 10) : null,
      queue: queueEntry,
    };

    if (!pay.odoo_id) {
      entry.status = 'NOT_SYNCED';
      entry.error = queueEntry
        ? `In retry queue: status=${queueEntry.status}, attempts=${queueEntry.attempts}, last_error=${queueEntry.last_error || 'none recorded yet'}`
        : 'Never synced and not in the retry queue — no sync has ever been attempted';
      results.push(entry);
      continue;
    }

    try {
      const paymentId = parseInt(pay.odoo_id, 10);
      const payments = await odoo.execute('account.payment', 'read', [[paymentId]], {
        fields: ['id', 'amount', 'date', 'state', 'partner_id'],
      });
      if (!payments.length) {
        entry.status = 'FAIL';
        entry.error = `Odoo payment id=${paymentId} not found (may have been deleted in Odoo)`;
        results.push(entry);
        continue;
      }
      const p = payments[0];
      const checks = {
        amount:  { pass: Math.abs(Number(p.amount) - Number(pay.amount)) < 0.01, wms: Number(pay.amount), odoo: Number(p.amount) },
        partner: { pass: Array.isArray(p.partner_id) && String(p.partner_id[0]) === String(pay.customer_odoo_id), wms: pay.customer_odoo_id, odoo: Array.isArray(p.partner_id) ? p.partner_id[0] : p.partner_id },
      };
      entry.checks = checks;
      entry.odoo_state = p.state;
      entry.status = Object.values(checks).every(c => c.pass) ? 'PASS' : 'MISMATCH';
    } catch (err) {
      entry.status = 'FAIL';
      entry.error = err.message;
    }
    results.push(entry);
  }

  const summary = {
    total:       results.length,
    synced:      results.filter(r => r.odoo_id).length,
    not_synced:  results.filter(r => r.status === 'NOT_SYNCED').length,
    pass:        results.filter(r => r.status === 'PASS').length,
    mismatch:    results.filter(r => r.status === 'MISMATCH').length,
    fail:        results.filter(r => r.status === 'FAIL').length,
    generated_at: new Date().toISOString(),
  };

  return { summary, payments: results };
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
  verifySyncedCustomers,
  verifyInvoiceSync,
  verifyPaymentSync,
};
