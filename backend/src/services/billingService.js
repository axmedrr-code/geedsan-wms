const { query, getClient } = require('../config/database');
const { publish }         = require('./realtimeService');
const { recordAudit }     = require('./auditService');
const { enqueueOdooSync, syncInvoiceToOdoo, syncPaymentToOdoo } = require('./odooService');
const pdf    = require('pdfkit');
const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const INVOICE_DIR = process.env.REPORTS_DIR || path.join(__dirname, '../../reports');
if (!fs.existsSync(INVOICE_DIR)) fs.mkdirSync(INVOICE_DIR, { recursive: true });

// ── Tariff ────────────────────────────────────────────────────────────────────

const TARIFF_FALLBACK = {
  residential: { price_per_m3: 1.20, min_charge: 2.00, service_fee: 1.50, vat_rate: 0, penalty_rate: 0, discount_rate: 0 },
  commercial:  { price_per_m3: 1.80, min_charge: 5.00, service_fee: 3.00, vat_rate: 0, penalty_rate: 0, discount_rate: 0 },
  industrial:  { price_per_m3: 2.40, min_charge:10.00, service_fee: 5.00, vat_rate: 0, penalty_rate: 0, discount_rate: 0 },
  government:  { price_per_m3: 1.00, min_charge: 3.00, service_fee: 2.00, vat_rate: 0, penalty_rate: 0, discount_rate: 0 },
  bulk_water:  { price_per_m3: 0.80, min_charge:15.00, service_fee: 0.00, vat_rate: 0, penalty_rate: 0, discount_rate: 0 },
  custom:      { price_per_m3: 1.00, min_charge: 0.00, service_fee: 0.00, vat_rate: 0, penalty_rate: 0, discount_rate: 0 },
};

const getTariff = async (tariffCode, _query = query) => {
  try {
    const r = await _query(
      'SELECT * FROM water_tariffs WHERE tariff_code=$1 AND is_active=true LIMIT 1',
      [tariffCode]
    );
    if (r.rows[0]) return r.rows[0];
  } catch { /* table may not exist yet — use fallback */ }
  return { tariff_code: tariffCode, ...(TARIFF_FALLBACK[tariffCode] || TARIFF_FALLBACK.residential) };
};

// ── Tariff-aware invoice amount calculation ───────────────────────────────────

const calculateInvoiceBreakdown = async (customerId, startDate, endDate, _query = query) => {
  const metersR = await _query(
    'SELECT id, meter_number FROM meters WHERE customer_id=$1 AND status=\'active\'',
    [customerId]
  );
  const custR = await _query('SELECT tariff_type FROM customers WHERE id=$1', [customerId]);
  const tariffCode = custR.rows[0]?.tariff_type || 'residential';
  const tariff = await getTariff(tariffCode, _query);

  let totalConsumption = 0;
  let primaryMeter = null;
  let prevReading = null, currReading = null;

  for (const meter of metersR.rows) {
    const currR = await _query(
      'SELECT total_consumption FROM meter_readings WHERE meter_id=$1 AND timestamp::date <= $2::date ORDER BY timestamp DESC LIMIT 1',
      [meter.id, endDate]
    );
    if (!currR.rows[0]) continue;
    const prevR = await _query(
      'SELECT total_consumption FROM meter_readings WHERE meter_id=$1 AND timestamp::date < $2::date ORDER BY timestamp DESC LIMIT 1',
      [meter.id, startDate]
    );
    const curr = Number(currR.rows[0].total_consumption || 0);
    const prev = prevR.rows[0] ? Number(prevR.rows[0].total_consumption) : 0;
    const cons = Math.max(0, curr - prev);
    totalConsumption += cons;
    if (!primaryMeter) {
      primaryMeter = meter;
      currReading = curr;
      prevReading = prev;
    }
  }

  const usageCharge = totalConsumption * Number(tariff.price_per_m3);
  const subtotal    = Math.max(Number(tariff.min_charge), usageCharge);
  const serviceFee  = Number(tariff.service_fee);
  const vatAmount   = +((subtotal + serviceFee) * (Number(tariff.vat_rate) / 100)).toFixed(2);
  const discount    = +((subtotal + serviceFee + vatAmount) * (Number(tariff.discount_rate) / 100)).toFixed(2);
  const total       = +(subtotal + serviceFee + vatAmount - discount).toFixed(2);

  return {
    tariff,
    tariff_code:      tariffCode,
    consumption_m3:   +totalConsumption.toFixed(3),
    previous_reading: prevReading !== null ? +Number(prevReading).toFixed(3) : null,
    current_reading:  currReading !== null ? +Number(currReading).toFixed(3) : null,
    meter_id:         primaryMeter?.id || null,
    subtotal:         +subtotal.toFixed(2),
    service_fee_amount: +serviceFee.toFixed(2),
    vat_amount:       vatAmount,
    discount_amount:  discount,
    total_amount:     total,
  };
};

// Legacy thin wrapper kept for backward compatibility
const calculateUsageAmount = async (customerId, startDate, endDate) => {
  const bd = await calculateInvoiceBreakdown(customerId, startDate, endDate);
  return bd.total_amount;
};

// ── PDF ───────────────────────────────────────────────────────────────────────

const createInvoicePDF = async (invoice, items, customer) => {
  const filename = `invoice-${invoice.invoice_number}.pdf`;
  const filePath = path.join(INVOICE_DIR, filename);
  const issueDate = invoice.issue_date ? new Date(invoice.issue_date).toISOString().slice(0, 10) : '';
  const dueDate   = invoice.due_date   ? new Date(invoice.due_date).toISOString().slice(0, 10)   : '';

  await new Promise((resolve, reject) => {
    const doc    = new pdf({ size: 'A4', margin: 40 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    doc.fillColor('#0B2447').fontSize(20).text('NUWACO WMS', { align: 'left' });
    doc.fontSize(10).fillColor('#334155').text('Billing Invoice', { align: 'right' });
    doc.moveDown();
    doc.fontSize(12).text(`Invoice #: ${invoice.invoice_number}`);
    doc.text(`Issue Date: ${issueDate}`);
    doc.text(`Due Date: ${dueDate}`);
    doc.text(`Status: ${invoice.status}`);
    doc.moveDown();
    doc.fontSize(11).fillColor('#0F172A').text('Bill To:', { underline: true });
    doc.fontSize(10).text(customer.full_name);
    if (customer.address) doc.text(customer.address);
    if (customer.email)   doc.text(customer.email);
    if (customer.phone)   doc.text(customer.phone);
    doc.moveDown();
    doc.fontSize(11).text('Invoice Items:', { underline: true });
    const tableTop = doc.y + 10;
    doc.fontSize(10).text('Description', 40, tableTop);
    doc.text('Qty',        300, tableTop);
    doc.text('Unit Price', 360, tableTop);
    doc.text('Amount',     460, tableTop);
    doc.moveTo(40, tableTop + 15).lineTo(540, tableTop + 15).stroke();
    let position = tableTop + 25;
    items.forEach(item => {
      doc.text(item.description, 40, position);
      doc.text(String(item.quantity), 300, position);
      doc.text(`$${Number(item.unit_price).toFixed(2)}`, 360, position);
      doc.text(`$${(Number(item.quantity) * Number(item.unit_price)).toFixed(2)}`, 460, position);
      position += 20;
    });
    doc.moveTo(40, position).lineTo(540, position).stroke();
    position += 10;
    doc.fontSize(11).text(`Total: $${Number(invoice.total_amount).toFixed(2)}`, 400, position);
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
  return { filePath, filename };
};

// ── Settings ──────────────────────────────────────────────────────────────────

const getBillingSettings = async ({ _query = query } = {}) => {
  const r = await _query('SELECT * FROM billing_settings WHERE id=1');
  return r.rows[0] || {
    id: 1, billing_cycle: 'monthly', due_days: 14, default_tariff: 'residential',
    currency: 'USD', auto_post_invoice: true, auto_sync_odoo: true,
  };
};

const updateBillingSettings = async (settings, userId, { _query = query, _recordAudit = recordAudit } = {}) => {
  const { billing_cycle, due_days, default_tariff, currency, auto_post_invoice, auto_sync_odoo } = settings;
  const r = await _query(
    `INSERT INTO billing_settings
       (id, billing_cycle, due_days, default_tariff, currency, auto_post_invoice, auto_sync_odoo, updated_at, updated_by)
     VALUES (1, $1, $2, $3, $4, $5, $6, NOW(), $7)
     ON CONFLICT (id) DO UPDATE SET
       billing_cycle     = EXCLUDED.billing_cycle,
       due_days          = EXCLUDED.due_days,
       default_tariff    = EXCLUDED.default_tariff,
       currency          = EXCLUDED.currency,
       auto_post_invoice = EXCLUDED.auto_post_invoice,
       auto_sync_odoo    = EXCLUDED.auto_sync_odoo,
       updated_at        = NOW(),
       updated_by        = EXCLUDED.updated_by
     RETURNING *`,
    [
      billing_cycle     || 'monthly',
      due_days          != null ? parseInt(due_days, 10) : 14,
      default_tariff    || 'residential',
      currency          || 'USD',
      auto_post_invoice != null ? Boolean(auto_post_invoice) : true,
      auto_sync_odoo    != null ? Boolean(auto_sync_odoo)    : true,
      userId || null,
    ]
  );
  await _recordAudit({ userId, action: 'update_billing_settings', entityType: 'billing_settings', entityId: null, newValues: settings });
  return r.rows[0];
};

// ── Billing Cycle ─────────────────────────────────────────────────────────────

const createBillingCycleForCustomer = async (customerId, cycleType, startDate, endDate, dueDate, generatedBy, notes, precomputedAmount = null) => {
  const amount = precomputedAmount !== null ? precomputedAmount : await calculateUsageAmount(customerId, startDate, endDate);
  const r = await query(
    `INSERT INTO billing_cycles (customer_id, cycle_type, period_start, period_end, due_date, amount, status, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8) RETURNING *`,
    [customerId, cycleType, startDate, endDate, dueDate, amount, notes || null, generatedBy]
  );
  return r.rows[0];
};

const postBillingCycleInvoice = async (billingCycleId, invoiceNumber, note, userId, breakdown = null) => {
  const cycle = await query('SELECT * FROM billing_cycles WHERE id=$1', [billingCycleId]);
  if (!cycle.rows[0]) throw new Error('Billing cycle not found');
  const bc = cycle.rows[0];

  const existing = await query('SELECT id FROM invoices WHERE invoice_number=$1', [invoiceNumber]);
  if (existing.rows.length) throw new Error('Invoice number already exists');

  const customer = await query('SELECT * FROM customers WHERE id=$1', [bc.customer_id]);
  if (!customer.rows[0]) throw new Error('Customer not found');
  const cust = customer.rows[0];
  const tariffCode = cust.tariff_type || 'residential';

  // Use provided breakdown or recalculate
  const bd = breakdown || await calculateInvoiceBreakdown(bc.customer_id, bc.period_start, bc.period_end);

  // Capture meter state at billing time
  const meterSnap = bd.meter_id
    ? (await query('SELECT id,device_eui,meter_number,serial_number,firmware_version,installation_address FROM meters WHERE id=$1', [bd.meter_id])).rows[0] || null
    : null;
  const tariffSnap = bd.tariff || null;

  const r = await query(
    `INSERT INTO invoices
       (customer_id, invoice_number, issue_date, due_date, tariff_type, total_amount, status,
        billing_period_start, billing_period_end, consumption_m3, previous_reading, current_reading,
        meter_id, subtotal, vat_amount, service_fee_amount, discount_amount, notes, created_by,
        meter_snapshot, tariff_snapshot, reading_source, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW()) RETURNING *`,
    [
      bc.customer_id, invoiceNumber, bc.period_end, bc.due_date, tariffCode, bc.amount,
      bc.period_start, bc.period_end,
      bd.consumption_m3, bd.previous_reading, bd.current_reading,
      bd.meter_id, bd.subtotal, bd.vat_amount, bd.service_fee_amount, bd.discount_amount,
      note, userId,
      meterSnap ? JSON.stringify(meterSnap) : null,
      tariffSnap ? JSON.stringify(tariffSnap) : null,
      'meter_reading',
    ]
  );
  const invoice = r.rows[0];

  await query('UPDATE billing_cycles SET invoice_id=$1,status=$2,updated_at=NOW() WHERE id=$3', [invoice.id, 'posted', billingCycleId]);

  const periodStart  = bc.period_start ? new Date(bc.period_start).toISOString().slice(0, 10) : '';
  const periodEnd    = bc.period_end   ? new Date(bc.period_end).toISOString().slice(0, 10)   : '';
  const invoiceItems = [{ description: `Water usage from ${periodStart} to ${periodEnd}`, quantity: 1, unit_price: bc.amount }];

  for (let i = 0; i < invoiceItems.length; i++) {
    const item = invoiceItems[i];
    await query(
      'INSERT INTO invoice_items (invoice_id,description,quantity,unit_price,line_order) VALUES ($1,$2,$3,$4,$5)',
      [invoice.id, item.description, item.quantity, item.unit_price, i]
    );
  }

  const pdfMeta = await createInvoicePDF(invoice, invoiceItems, cust);
  await recordAudit({ userId, action: 'post_invoice', entityType: 'billing_cycle', entityId: billingCycleId, newValues: { invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, amount: bc.amount, dueDate: bc.due_date } });
  try {
    await syncInvoiceToOdoo(invoice.id);
  } catch (syncErr) {
    logger.warn('Immediate Odoo invoice sync failed — queuing for retry', { error: syncErr.message, invoiceId: invoice.id });
    await enqueueOdooSync('invoice', invoice.id).catch(e => logger.warn('Odoo invoice enqueue also failed', { error: e.message }));
  }
  publish('invoice_created', { invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, customerId: invoice.customer_id, pdf: pdfMeta.filename, pdf_url: `/reports/${pdfMeta.filename}` });

  return { ...invoice, invoice_pdf: pdfMeta.filename, pdf_url: `/reports/${pdfMeta.filename}` };
};

// ── Direct Invoice Generation (atomic, stores full breakdown) ─────────────────

const generateInvoiceForCustomer = async (customerId, opts = {}) => {
  const settings = await getBillingSettings();
  const now         = new Date();
  const periodStart = opts.period_start ? new Date(opts.period_start) : new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const periodEnd   = opts.period_end   ? new Date(opts.period_end)   : new Date(now.getFullYear(), now.getMonth(), 0);
  const dueDays     = opts.due_days != null ? opts.due_days : settings.due_days;
  const dueDate     = new Date(periodEnd.getTime() + dueDays * 24 * 60 * 60 * 1000);
  const userId      = opts.created_by || null;
  const pStartStr   = periodStart.toISOString().slice(0, 10);
  const pEndStr     = periodEnd.toISOString().slice(0, 10);
  const ym          = `${periodStart.getFullYear()}${String(periodStart.getMonth() + 1).padStart(2, '0')}`;

  const custR = await query('SELECT * FROM customers WHERE id=$1 AND account_status=\'active\'', [customerId]);
  if (!custR.rows[0]) throw new Error(`Customer ${customerId} not found or not active`);
  const cust = custR.rows[0];

  // Duplicate check
  const dupR = await query(
    'SELECT id FROM invoices WHERE customer_id=$1 AND billing_period_start=$2 AND billing_period_end=$3',
    [customerId, pStartStr, pEndStr]
  );
  if (dupR.rows.length) throw new Error(`Invoice already exists for ${cust.house_number} period ${pStartStr}–${pEndStr}`);

  const bd = await calculateInvoiceBreakdown(customerId, pStartStr, pEndStr);
  if (bd.total_amount === 0 && bd.consumption_m3 === 0) {
    throw new Error(`Zero consumption for ${cust.house_number} in period ${pStartStr}–${pEndStr}`);
  }

  const custRef   = (cust.house_number && cust.house_number.trim()) ? cust.house_number.trim() : cust.id.slice(0, 8).toUpperCase();
  const invNumber = opts.invoice_number || `INV-${ym}-${custRef}`;
  const tariffCode = cust.tariff_type || 'residential';

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const existInv = await client.query('SELECT id FROM invoices WHERE invoice_number=$1', [invNumber]);
    if (existInv.rows.length) throw new Error(`Invoice number ${invNumber} already exists`);

    const meterSnap = bd.meter_id
      ? (await client.query('SELECT id,device_eui,meter_number,serial_number,firmware_version,installation_address FROM meters WHERE id=$1', [bd.meter_id])).rows[0] || null
      : null;
    const tariffSnap = bd.tariff || null;

    const r = await client.query(
      `INSERT INTO invoices
         (customer_id, invoice_number, issue_date, due_date, tariff_type, total_amount, status,
          billing_period_start, billing_period_end, consumption_m3, previous_reading, current_reading,
          meter_id, subtotal, vat_amount, service_fee_amount, discount_amount, notes, created_by,
          meter_snapshot, tariff_snapshot, reading_source, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW()) RETURNING *`,
      [
        customerId, invNumber, pEndStr, dueDate.toISOString().slice(0,10), tariffCode, bd.total_amount,
        pStartStr, pEndStr,
        bd.consumption_m3, bd.previous_reading, bd.current_reading,
        bd.meter_id, bd.subtotal, bd.vat_amount, bd.service_fee_amount, bd.discount_amount,
        opts.notes || null, userId,
        meterSnap ? JSON.stringify(meterSnap) : null,
        tariffSnap ? JSON.stringify(tariffSnap) : null,
        'meter_reading',
      ]
    );
    const invoice = r.rows[0];

    // Build line items: usage + min-charge adjustment (if floor applied) + service fee + VAT + discount
    const lineItems  = [];
    const usageCharge  = +(bd.consumption_m3 * Number(bd.tariff?.price_per_m3 || 0)).toFixed(2);
    const minCharge    = +Number(bd.tariff?.min_charge || 0).toFixed(2);
    const minChargeAdj = +(Math.max(0, minCharge - usageCharge)).toFixed(2);
    lineItems.push({
      description: `Water consumption ${pStartStr} to ${pEndStr} (${bd.consumption_m3} m³ × $${Number(bd.tariff?.price_per_m3 || 0).toFixed(4)}/m³)`,
      quantity: bd.consumption_m3, unit_price: Number(bd.tariff?.price_per_m3 || 0),
    });
    if (minChargeAdj > 0) {
      lineItems.push({ description: `Minimum charge (floor $${minCharge.toFixed(2)})`, quantity: 1, unit_price: minChargeAdj });
    }
    if (bd.service_fee_amount > 0) {
      lineItems.push({ description: 'Monthly service fee', quantity: 1, unit_price: bd.service_fee_amount });
    }
    if (bd.vat_amount > 0) {
      lineItems.push({ description: `VAT (${bd.tariff?.vat_rate}%)`, quantity: 1, unit_price: bd.vat_amount });
    }
    if (bd.discount_amount > 0) {
      lineItems.push({ description: `Discount (${bd.tariff?.discount_rate}%)`, quantity: 1, unit_price: -bd.discount_amount });
    }

    for (let i = 0; i < lineItems.length; i++) {
      const item = lineItems[i];
      await client.query(
        'INSERT INTO invoice_items (invoice_id,description,quantity,unit_price,line_order) VALUES ($1,$2,$3,$4,$5)',
        [invoice.id, item.description, item.quantity, item.unit_price, i]
      );
    }

    // Create billing_cycle record
    const cycleR = await client.query(
      `INSERT INTO billing_cycles (customer_id, cycle_type, period_start, period_end, due_date, amount, status, invoice_id, notes, created_by)
       VALUES ($1,'monthly',$2,$3,$4,$5,'posted',$6,$7,$8) RETURNING id`,
      [customerId, pStartStr, pEndStr, dueDate.toISOString().slice(0,10), bd.total_amount, invoice.id, opts.notes || 'Direct invoice', userId]
    );

    await client.query('COMMIT');

    await recordAudit({ userId, action: 'generate_invoice', entityType: 'invoice', entityId: invoice.id, newValues: { invoiceNumber: invNumber, customerId, amount: bd.total_amount, consumption: bd.consumption_m3, period: `${pStartStr} to ${pEndStr}` } });
    try {
      await syncInvoiceToOdoo(invoice.id);
    } catch (syncErr) {
      logger.warn('Immediate Odoo invoice sync failed — queuing for retry', { error: syncErr.message, invoiceId: invoice.id });
      await enqueueOdooSync('invoice', invoice.id).catch(e => logger.warn('Odoo invoice enqueue also failed', { error: e.message }));
    }
    publish('invoice_created', { invoiceId: invoice.id, invoiceNumber: invNumber, customerId });

    return { invoice, breakdown: bd, billing_cycle_id: cycleR.rows[0]?.id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const generateInvoiceForZone = async (zoneId, opts = {}) => {
  const customersR = await query(
    `SELECT DISTINCT c.id FROM customers c
     JOIN meters m ON m.customer_id=c.id
     WHERE c.zone_id=$1 AND c.account_status='active' AND m.status='active'`,
    [zoneId]
  );
  const results = { total: customersR.rows.length, ok: 0, skipped: 0, failed: 0, invoices: [] };
  for (const c of customersR.rows) {
    try {
      const inv = await generateInvoiceForCustomer(c.id, { ...opts, created_by: opts.created_by });
      results.ok++;
      results.invoices.push({ customer_id: c.id, invoice_number: inv.invoice.invoice_number, amount: inv.invoice.total_amount });
    } catch (e) {
      if (e.message.includes('already exists') || e.message.includes('Zero consumption')) {
        results.skipped++;
      } else {
        results.failed++;
        logger.error('Zone billing failed for customer', { customer_id: c.id, error: e.message });
      }
    }
  }
  return results;
};

const generateInvoiceForSelected = async (customerIds, opts = {}) => {
  const results = { total: customerIds.length, ok: 0, skipped: 0, failed: 0, invoices: [] };
  for (const customerId of customerIds) {
    try {
      const inv = await generateInvoiceForCustomer(customerId, { ...opts, created_by: opts.created_by });
      results.ok++;
      results.invoices.push({ customer_id: customerId, invoice_number: inv.invoice.invoice_number, amount: inv.invoice.total_amount });
    } catch (e) {
      if (e.message.includes('already exists') || e.message.includes('Zero consumption')) {
        results.skipped++;
      } else {
        results.failed++;
        logger.error('Selected billing failed for customer', { customer_id: customerId, error: e.message });
      }
    }
  }
  return results;
};

// ── Payments ──────────────────────────────────────────────────────────────────

const recordPayment = async (invoiceId, amount, method, reference, note, userId) => {
  const invoice = await query('SELECT * FROM invoices WHERE id=$1', [invoiceId]);
  if (!invoice.rows[0]) throw new Error('Invoice not found');

  const paymentR = await query(
    'INSERT INTO invoice_payments (invoice_id, amount, payment_date, method, reference, note, created_by) VALUES ($1,$2,NOW(),$3,$4,$5,$6) RETURNING id',
    [invoiceId, amount, method, reference, note, userId]
  );
  const paymentId = paymentR.rows[0].id;

  const payments   = await query('SELECT COALESCE(SUM(amount),0) AS total_paid FROM invoice_payments WHERE invoice_id=$1', [invoiceId]);
  const totalPaid  = parseFloat(payments.rows[0].total_paid);
  const invoiceAmt = parseFloat(invoice.rows[0].total_amount);
  const invoiceDue = invoice.rows[0].due_date ? new Date(invoice.rows[0].due_date) : null;
  const newStatus  = totalPaid >= invoiceAmt ? 'paid' : invoiceDue && invoiceDue < new Date() ? 'overdue' : 'pending';

  await query('UPDATE invoices SET status=$1, updated_at=NOW() WHERE id=$2', [newStatus, invoiceId]);

  const invoiceLink = await query('SELECT invoice_id FROM billing_cycles WHERE invoice_id=$1', [invoiceId]);
  if (invoiceLink.rows.length) {
    await query('UPDATE billing_cycles SET status=$1, updated_at=NOW() WHERE invoice_id=$2', [newStatus, invoiceId]);
  }

  await recordAudit({ userId, action: 'record_payment', entityType: 'invoice', entityId: invoiceId, newValues: { amount, method, reference, note, totalPaid, status: newStatus } });
  try {
    await syncPaymentToOdoo(paymentId);
  } catch (syncErr) {
    logger.warn('Immediate Odoo payment sync failed — queuing for retry', { error: syncErr.message, paymentId });
    await enqueueOdooSync('payment', paymentId).catch(e => logger.warn('Odoo payment enqueue also failed', { error: e.message }));
  }
  publish('invoice_payment', { invoiceId, totalPaid, status: newStatus, amount, method });

  return { invoiceId, totalPaid, newStatus };
};

// ── Validation ────────────────────────────────────────────────────────────────

const validateBillingPeriod = async (opts = {}, { _query = query } = {}) => {
  const now         = new Date();
  const periodStart = opts.periodStart ? new Date(opts.periodStart) : new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const periodEnd   = opts.periodEnd   ? new Date(opts.periodEnd)   : new Date(now.getFullYear(), now.getMonth(), 0);
  const pStartStr   = periodStart.toISOString().slice(0, 10);
  const pEndStr     = periodEnd.toISOString().slice(0, 10);

  const errors         = [];
  const warnings       = [];
  const customerIssues = [];

  if (periodEnd > now) {
    errors.push({ code: 'FUTURE_PERIOD', message: `Period end (${pEndStr}) is in the future.` });
  }
  if (periodEnd < periodStart) {
    errors.push({ code: 'INVALID_PERIOD', message: `Period end (${pEndStr}) is before period start (${pStartStr}).` });
  }

  const customersR = await _query(
    `SELECT DISTINCT c.id, c.house_number, c.full_name, c.tariff_type
     FROM customers c JOIN meters m ON m.customer_id = c.id
     WHERE c.account_status='active' AND m.status='active'`
  );

  if (!customersR.rows.length) {
    errors.push({ code: 'NO_ACTIVE_CUSTOMERS', message: 'No active customers with active meters found.' });
    return { valid: false, errors, warnings, customerIssues, periodStart: pStartStr, periodEnd: pEndStr, totalCustomers: 0 };
  }

  let duplicateCount = 0, missingReadCount = 0, negativeConsCount = 0, zeroConsCount = 0, missingTariffCount = 0;

  for (const customer of customersR.rows) {
    const dupR = await _query(
      'SELECT id FROM billing_cycles WHERE customer_id=$1 AND period_start=$2 AND period_end=$3',
      [customer.id, periodStart, periodEnd]
    );
    if (dupR.rows.length) {
      customerIssues.push({ customerId: customer.id, customerName: customer.full_name, houseNumber: customer.house_number, issue: 'Billing cycle already exists', severity: 'info', code: 'DUPLICATE_PERIOD' });
      duplicateCount++;
      continue;
    }

    const validTariffs = ['residential','commercial','industrial','government','bulk_water','custom'];
    if (!customer.tariff_type || !validTariffs.includes(customer.tariff_type)) {
      customerIssues.push({ customerId: customer.id, customerName: customer.full_name, houseNumber: customer.house_number, issue: `Unknown tariff: "${customer.tariff_type}" — defaults to residential`, severity: 'warning', code: 'MISSING_TARIFF' });
      missingTariffCount++;
    }

    const metersR = await _query('SELECT id, meter_number FROM meters WHERE customer_id=$1 AND status=\'active\'', [customer.id]);
    for (const meter of metersR.rows) {
      const currR = await _query(
        'SELECT total_consumption FROM meter_readings WHERE meter_id=$1 AND timestamp::date <= $2::date ORDER BY timestamp DESC LIMIT 1',
        [meter.id, periodEnd]
      );
      if (!currR.rows[0]) {
        customerIssues.push({ customerId: customer.id, customerName: customer.full_name, houseNumber: customer.house_number, issue: `Meter ${meter.meter_number}: no readings in period`, severity: 'warning', code: 'MISSING_READING' });
        missingReadCount++;
        continue;
      }
      const prevR = await _query(
        'SELECT total_consumption FROM meter_readings WHERE meter_id=$1 AND timestamp::date < $2::date ORDER BY timestamp DESC LIMIT 1',
        [meter.id, periodStart]
      );
      const curr = Number(currR.rows[0].total_consumption);
      const prev = prevR.rows[0] ? Number(prevR.rows[0].total_consumption) : 0;
      const consumption = curr - prev;
      if (consumption < 0) {
        customerIssues.push({ customerId: customer.id, customerName: customer.full_name, houseNumber: customer.house_number, issue: `Meter ${meter.meter_number}: negative consumption (${consumption.toFixed(3)} m³)`, severity: 'warning', code: 'NEGATIVE_CONSUMPTION' });
        negativeConsCount++;
      } else if (consumption === 0) {
        zeroConsCount++;
      }
    }
  }

  if (duplicateCount    > 0) warnings.push({ code: 'HAS_DUPLICATES',           message: `${duplicateCount} customer(s) already billed for this period.` });
  if (missingReadCount  > 0) warnings.push({ code: 'HAS_MISSING_READINGS',     message: `${missingReadCount} meter(s) have no readings.` });
  if (negativeConsCount > 0) warnings.push({ code: 'HAS_NEGATIVE_CONSUMPTION', message: `${negativeConsCount} meter(s) show negative consumption.` });
  if (zeroConsCount     > 0) warnings.push({ code: 'HAS_ZERO_CONSUMPTION',     message: `${zeroConsCount} meter(s) show zero consumption.` });
  if (missingTariffCount > 0) warnings.push({ code: 'HAS_MISSING_TARIFF',     message: `${missingTariffCount} customer(s) have an unknown tariff.` });

  return { valid: errors.length === 0, errors, warnings, customerIssues, periodStart: pStartStr, periodEnd: pEndStr, totalCustomers: customersR.rows.length, duplicateCount, missingReadCount, negativeConsCount, zeroConsCount, missingTariffCount };
};

// ── Cancel / Post pending run ─────────────────────────────────────────────────

const cancelBillingRun = async (runId, reason, userId, { _query = query, _recordAudit = recordAudit } = {}) => {
  const runR = await _query('SELECT * FROM billing_runs WHERE id=$1', [runId]);
  const run  = runR.rows[0];
  if (!run) throw new Error('Billing run not found');
  if (!['running', 'pending_post'].includes(run.status)) {
    throw new Error(`Cannot cancel a run with status '${run.status}'.`);
  }
  if (run.status === 'pending_post') {
    const itemsR = await _query('SELECT billing_cycle_id FROM billing_run_items WHERE run_id=$1 AND billing_cycle_id IS NOT NULL', [runId]);
    for (const item of itemsR.rows) {
      await _query('DELETE FROM billing_cycles WHERE id=$1', [item.billing_cycle_id]);
    }
    await _query(`UPDATE billing_run_items SET billing_status='failed', error_message='Run cancelled' WHERE run_id=$1 AND billing_status='pending_post'`, [runId]);
  }
  await _query(`UPDATE billing_runs SET status='cancelled', cancelled_at=NOW(), cancelled_by=$1, cancel_reason=$2, completed_at=NOW() WHERE id=$3`, [userId || null, reason || null, runId]);
  await _recordAudit({ userId, action: 'cancel_billing_run', entityType: 'billing_run', entityId: runId, newValues: { reason } });
  return { runId, status: 'cancelled', cancelledAt: new Date().toISOString(), cancelledBy: userId };
};

const postPendingBillingRun = async (runId, userId, { _query = query, _postCycleInvoice = postBillingCycleInvoice } = {}) => {
  const runR = await _query('SELECT * FROM billing_runs WHERE id=$1', [runId]);
  const run  = runR.rows[0];
  if (!run) throw new Error('Billing run not found');
  if (run.status !== 'pending_post') throw new Error(`Run ${runId} is not in pending_post status (current: ${run.status}).`);

  const itemsR = await _query(
    `SELECT bri.*, c.house_number FROM billing_run_items bri
     LEFT JOIN customers c ON c.id = bri.customer_id
     WHERE bri.run_id=$1 AND bri.billing_status='pending_post' AND bri.billing_cycle_id IS NOT NULL`,
    [runId]
  );

  let ok = parseInt(run.customers_ok, 10) || 0;
  let failed = parseInt(run.customers_failed, 10) || 0;
  let totalRevenue = parseFloat(run.total_revenue) || 0;

  for (const item of itemsR.rows) {
    const ym      = run.period_start.toString().slice(0, 7).replace('-', '');
    const custRef = (item.house_number && item.house_number.trim()) ? item.house_number.trim() : item.customer_id.slice(0, 8).toUpperCase();
    const invNumber = `INV-${ym}-${custRef}`;
    try {
      await _postCycleInvoice(item.billing_cycle_id, invNumber, 'Auto-generated invoice', userId);
      await _query(`UPDATE billing_run_items SET billing_status='success', invoice_reference=$1 WHERE id=$2`, [invNumber, item.id]);
      ok++;
      totalRevenue += parseFloat(item.amount || 0);
    } catch (err) {
      await _query(`UPDATE billing_run_items SET billing_status='failed', error_message=$1 WHERE id=$2`, [err.message, item.id]);
      failed++;
    }
  }

  const skipped = parseInt(run.customers_skipped, 10) || 0;
  const total   = parseInt(run.customers_total, 10) || 0;
  const finalStatus = ok === 0 && failed > 0 ? 'failed' : failed > 0 ? 'partial' : 'completed';

  await _query(
    `UPDATE billing_runs SET status=$1, customers_ok=$2, customers_failed=$3, total_revenue=$4, completed_at=NOW() WHERE id=$5`,
    [finalStatus, ok, failed, Number(totalRevenue.toFixed(2)), runId]
  );
  return { runId, status: finalStatus, total, ok, skipped, failed };
};

// ── Monthly Auto-Billing ──────────────────────────────────────────────────────

const runMonthlyAutoBilling = async (opts = {}, { _query = query, _calculateUsage = calculateUsageAmount, _createCycle = createBillingCycleForCustomer, _postCycleInvoice = postBillingCycleInvoice, _getSettings = getBillingSettings } = {}) => {
  const settings    = await _getSettings({ _query });
  const triggeredBy = opts.triggeredBy || 'scheduler';
  const now         = new Date();
  const periodStart = opts.periodStart ? new Date(opts.periodStart) : new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const periodEnd   = opts.periodEnd   ? new Date(opts.periodEnd)   : new Date(now.getFullYear(), now.getMonth(), 0);
  const dueDays     = opts.dueDays  != null ? opts.dueDays  : settings.due_days;
  const autoPost    = opts.autoPost != null ? opts.autoPost : settings.auto_post_invoice;
  const dueDate     = new Date(periodEnd.getTime() + dueDays * 24 * 60 * 60 * 1000);
  const ym          = `${periodStart.getFullYear()}${String(periodStart.getMonth() + 1).padStart(2, '0')}`;
  const pStartStr   = periodStart.toISOString().slice(0, 10);
  const pEndStr     = periodEnd.toISOString().slice(0, 10);

  const runR = await _query(
    'INSERT INTO billing_runs (period_start, period_end, triggered_by, status) VALUES ($1,$2,$3,\'running\') RETURNING id',
    [pStartStr, pEndStr, triggeredBy]
  );
  const runId = runR.rows[0].id;

  const customers = await _query(
    `SELECT DISTINCT c.id, c.house_number, c.full_name FROM customers c
     JOIN meters m ON m.customer_id = c.id
     WHERE c.account_status='active' AND m.status='active'`
  );

  let ok = 0, skipped = 0, failed = 0, pendingPost = 0;
  let totalConsumption = 0, totalRevenue = 0;
  const total = customers.rows.length;

  for (const customer of customers.rows) {
    const billingAccount = (customer.house_number && customer.house_number.trim()) ? customer.house_number.trim() : null;

    const existingR = await _query(
      `SELECT bc.id, i.invoice_number FROM billing_cycles bc
       LEFT JOIN invoices i ON i.id = bc.invoice_id
       WHERE bc.customer_id=$1 AND bc.period_start=$2 AND bc.period_end=$3`,
      [customer.id, periodStart, periodEnd]
    );
    if (existingR.rows.length) {
      await _query(
        `INSERT INTO billing_run_items (run_id, customer_id, billing_account, billing_period_start, billing_period_end, invoice_reference, billing_status)
         VALUES ($1,$2,$3,$4,$5,$6,'skipped')`,
        [runId, customer.id, billingAccount, pStartStr, pEndStr, existingR.rows[0].invoice_number || null]
      );
      skipped++;
      continue;
    }

    try {
      const bd = await calculateInvoiceBreakdown(customer.id, periodStart, periodEnd, _query);
      const amount = bd.total_amount;
      const metersR = await _query('SELECT meter_number FROM meters WHERE customer_id=$1 AND status=\'active\'', [customer.id]);
      const meterNums = metersR.rows.map(m => m.meter_number).join(', ');

      if (amount === 0) {
        await _query(
          `INSERT INTO billing_run_items (run_id, customer_id, billing_account, billing_period_start, billing_period_end, meter_number, billing_status, error_message)
           VALUES ($1,$2,$3,$4,$5,$6,'skipped','Zero consumption for period')`,
          [runId, customer.id, billingAccount, pStartStr, pEndStr, meterNums]
        );
        skipped++;
        continue;
      }

      const cycle   = await _createCycle(customer.id, 'monthly', periodStart, periodEnd, dueDate, null, 'Auto-generated monthly billing', amount);
      const custRef = billingAccount || customer.id.slice(0, 8).toUpperCase();
      const invoiceNumber = `INV-${ym}-${custRef}`;

      if (autoPost) {
        await _postCycleInvoice(cycle.id, invoiceNumber, 'Auto-generated invoice', null, bd);
        await _query(
          `INSERT INTO billing_run_items (run_id, customer_id, billing_account, billing_period_start, billing_period_end, meter_number, invoice_reference, billing_status, amount, billing_cycle_id, consumption)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'success',$8,$9,$10)`,
          [runId, customer.id, billingAccount, pStartStr, pEndStr, meterNums, invoiceNumber, amount, cycle.id, bd.consumption_m3]
        );
        totalRevenue += amount;
        totalConsumption += bd.consumption_m3 || 0;
        ok++;
      } else {
        await _query(
          `INSERT INTO billing_run_items (run_id, customer_id, billing_account, billing_period_start, billing_period_end, meter_number, billing_status, amount, billing_cycle_id, consumption)
           VALUES ($1,$2,$3,$4,$5,$6,'pending_post',$7,$8,$9)`,
          [runId, customer.id, billingAccount, pStartStr, pEndStr, meterNums, amount, cycle.id, bd.consumption_m3]
        );
        pendingPost++;
      }
    } catch (err) {
      logger.error(`Auto-billing failed for customer ${customer.id}:`, { error: err.message });
      await _query(
        `INSERT INTO billing_run_items (run_id, customer_id, billing_account, billing_period_start, billing_period_end, billing_status, error_message)
         VALUES ($1,$2,$3,$4,$5,'failed',$6)`,
        [runId, customer.id, billingAccount, pStartStr, pEndStr, err.message]
      );
      failed++;
    }
  }

  const finalStatus = pendingPost > 0 && failed === 0 ? 'pending_post' : ok === 0 && failed > 0 ? 'failed' : failed > 0 ? 'partial' : 'completed';

  await _query(
    `UPDATE billing_runs SET status=$1, customers_total=$2, customers_ok=$3, customers_skipped=$4, customers_failed=$5, total_consumption=$6, total_revenue=$7, completed_at=NOW() WHERE id=$8`,
    [finalStatus, total, ok, skipped, failed, Number(totalConsumption.toFixed(3)), Number(totalRevenue.toFixed(2)), runId]
  );
  return { runId, periodStart: pStartStr, periodEnd: pEndStr, total, ok, skipped, failed, pendingPost, status: finalStatus };
};

// ── Preview ───────────────────────────────────────────────────────────────────

const previewMonthlyBilling = async (opts = {}, { _query = query } = {}) => {
  const now         = new Date();
  const periodStart = opts.periodStart ? new Date(opts.periodStart) : new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const periodEnd   = opts.periodEnd   ? new Date(opts.periodEnd)   : new Date(now.getFullYear(), now.getMonth(), 0);
  const pStartStr   = periodStart.toISOString().slice(0, 10);
  const pEndStr     = periodEnd.toISOString().slice(0, 10);

  const customers = await _query(
    `SELECT DISTINCT c.id, c.house_number, c.full_name, c.tariff_type AS customer_tariff_type
     FROM customers c JOIN meters m ON m.customer_id = c.id
     WHERE c.account_status='active' AND m.status='active'`
  );

  const preview = [];
  let totalEstimatedRevenue = 0, totalEstimatedConsumption = 0;

  for (const customer of customers.rows) {
    const billingAccount = (customer.house_number && customer.house_number.trim()) ? customer.house_number.trim() : null;

    const existingR = await _query(
      'SELECT bc.id FROM billing_cycles bc WHERE bc.customer_id=$1 AND bc.period_start=$2 AND bc.period_end=$3',
      [customer.id, periodStart, periodEnd]
    );
    if (existingR.rows.length) {
      preview.push({ customerId: customer.id, houseNumber: customer.house_number, customerName: customer.full_name, billingAccount, wouldSkip: true, skipReason: 'Billing cycle already exists', meters: [], estimatedAmount: null, totalConsumption: null });
      continue;
    }

    const metersR  = await _query('SELECT id, meter_number FROM meters WHERE customer_id=$1 AND status=\'active\'', [customer.id]);
    const tariffCode = customer.customer_tariff_type || 'residential';
    const tariff   = await getTariff(tariffCode, _query);
    const meterDetails = [];
    let customerAmount = 0, customerConsumed = 0;

    for (const meter of metersR.rows) {
      const currR = await _query('SELECT total_consumption, timestamp FROM meter_readings WHERE meter_id=$1 AND timestamp::date <= $2::date ORDER BY timestamp DESC LIMIT 1', [meter.id, periodEnd]);
      const prevR = await _query('SELECT total_consumption, timestamp FROM meter_readings WHERE meter_id=$1 AND timestamp::date < $2::date ORDER BY timestamp DESC LIMIT 1', [meter.id, periodStart]);
      const currentVal  = currR.rows[0] ? Number(currR.rows[0].total_consumption) : null;
      const previousVal = prevR.rows[0] ? Number(prevR.rows[0].total_consumption) : 0;
      if (currentVal === null) {
        meterDetails.push({ meterNumber: meter.meter_number, tariff: tariffCode, pricePerM3: Number(tariff.price_per_m3), previousReading: null, currentReading: null, consumption: null, estimatedAmount: null, skipReason: 'No readings found' });
        continue;
      }
      const consumption = Number((currentVal - previousVal).toFixed(3));
      const billable    = Math.max(0, consumption);
      const usageCharge = billable * Number(tariff.price_per_m3);
      const amount      = +(Math.max(Number(tariff.min_charge), usageCharge) + Number(tariff.service_fee)).toFixed(2);
      customerAmount   += amount;
      customerConsumed += billable;
      meterDetails.push({ meterNumber: meter.meter_number, tariff: tariffCode, pricePerM3: Number(tariff.price_per_m3), minCharge: Number(tariff.min_charge), serviceFee: Number(tariff.service_fee), previousReading: previousVal, previousReadingDate: prevR.rows[0] ? new Date(prevR.rows[0].timestamp).toISOString().slice(0, 10) : null, currentReading: currentVal, currentReadingDate: new Date(currR.rows[0].timestamp).toISOString().slice(0, 10), consumption, estimatedAmount: amount, skipReason: consumption <= 0 ? 'Zero or negative consumption' : null });
    }

    const wouldSkip = customerAmount === 0;
    if (!wouldSkip) { totalEstimatedRevenue += customerAmount; totalEstimatedConsumption += customerConsumed; }
    preview.push({ customerId: customer.id, houseNumber: customer.house_number, customerName: customer.full_name, billingAccount, wouldSkip, skipReason: wouldSkip ? 'Zero consumption' : null, meters: meterDetails, estimatedAmount: wouldSkip ? null : Number(customerAmount.toFixed(2)), totalConsumption: wouldSkip ? null : Number(customerConsumed.toFixed(3)) });
  }

  return { periodStart: pStartStr, periodEnd: pEndStr, totalCustomers: customers.rows.length, willBill: preview.filter(p => !p.wouldSkip).length, willSkip: preview.filter(p => p.wouldSkip).length, totalEstimatedRevenue: Number(totalEstimatedRevenue.toFixed(2)), totalEstimatedConsumption: Number(totalEstimatedConsumption.toFixed(3)), preview };
};

// ── Overdue ───────────────────────────────────────────────────────────────────

const markOverdueInvoices = async () => {
  const r = await query(
    `UPDATE invoices SET status='overdue', updated_at=NOW() WHERE status='pending' AND due_date < NOW() RETURNING id, customer_id, invoice_number`
  );
  for (const invoice of r.rows) {
    await query('UPDATE billing_cycles SET status=\'overdue\', updated_at=NOW() WHERE invoice_id=$1', [invoice.id]);
    await recordAudit({ action: 'mark_overdue', entityType: 'invoice', entityId: invoice.id, newValues: { status: 'overdue' } });
    publish('invoice_overdue', invoice);
  }
  return r.rows.length;
};

// ── Dashboard Stats ───────────────────────────────────────────────────────────

const getBillingDashboardStats = async () => {
  const today = new Date().toISOString().split('T')[0];
  const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0,0,0,0);

  const [todayBills, outstanding, overdueCount, dueToday, monthlyBills, totalInvoiced, totalPaid, avgBill] = await Promise.all([
    query("SELECT COUNT(*)::INT AS count, COALESCE(SUM(total_amount),0) AS revenue FROM invoices WHERE DATE(created_at)=$1 AND status != 'cancelled'", [today]),
    query("SELECT COALESCE(SUM(i.total_amount - COALESCE(p.paid,0)),0) AS outstanding FROM invoices i LEFT JOIN (SELECT invoice_id, SUM(amount) paid FROM invoice_payments GROUP BY invoice_id) p ON p.invoice_id=i.id WHERE i.status IN ('pending','overdue')"),
    query("SELECT COUNT(DISTINCT customer_id)::INT AS count FROM invoices WHERE status='overdue'"),
    query("SELECT COUNT(*)::INT AS count FROM invoices WHERE due_date=$1 AND status IN ('pending','overdue')", [today]),
    query("SELECT COUNT(*)::INT AS count, COALESCE(SUM(total_amount),0) AS revenue FROM invoices WHERE created_at >= $1 AND status != 'cancelled'", [startOfMonth.toISOString()]),
    query("SELECT COALESCE(SUM(total_amount),0) AS total FROM invoices WHERE created_at >= $1 AND status != 'cancelled'", [startOfMonth.toISOString()]),
    query("SELECT COALESCE(SUM(amount),0) AS total FROM invoice_payments WHERE payment_date >= $1", [startOfMonth.toISOString()]),
    query("SELECT COALESCE(AVG(total_amount),0) AS avg FROM invoices WHERE created_at >= $1 AND status != 'cancelled'", [startOfMonth.toISOString()]),
  ]);

  const invoicedMonth = Number(totalInvoiced.rows[0].total);
  const paidMonth     = Number(totalPaid.rows[0].total);
  const collectionEff = invoicedMonth > 0 ? +((paidMonth / invoicedMonth) * 100).toFixed(1) : 0;

  return {
    bills_today:           todayBills.rows[0].count,
    revenue_today:         Number(todayBills.rows[0].revenue),
    outstanding_balance:   Number(outstanding.rows[0].outstanding),
    overdue_customers:     overdueCount.rows[0].count,
    bills_due_today:       dueToday.rows[0].count,
    monthly_bills:         monthlyBills.rows[0].count,
    monthly_revenue:       Number(monthlyBills.rows[0].revenue),
    collection_efficiency: collectionEff,
    avg_bill_value:        Number(Number(avgBill.rows[0].avg).toFixed(2)),
  };
};

module.exports = {
  getTariff,
  calculateInvoiceBreakdown,
  calculateUsageAmount,
  createInvoicePDF,
  createBillingCycleForCustomer,
  postBillingCycleInvoice,
  generateInvoiceForCustomer,
  generateInvoiceForZone,
  generateInvoiceForSelected,
  recordPayment,
  markOverdueInvoices,
  runMonthlyAutoBilling,
  previewMonthlyBilling,
  getBillingSettings,
  updateBillingSettings,
  validateBillingPeriod,
  cancelBillingRun,
  postPendingBillingRun,
  getBillingDashboardStats,
};
