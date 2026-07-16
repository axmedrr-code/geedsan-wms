const { query } = require('../config/database');
const { publish } = require('./realtimeService');
const { recordAudit } = require('./auditService');
const { enqueueOdooSync } = require('./odooService');
const pdf = require('pdfkit');
const fs = require('fs');
const path = require('path');

const INVOICE_DIR = process.env.REPORTS_DIR || path.join(__dirname, '../../reports');
if (!fs.existsSync(INVOICE_DIR)) fs.mkdirSync(INVOICE_DIR, { recursive: true });

const TARIFF_RATES = { residential: 1.2, commercial: 1.8, industrial: 2.4, government: 1.0 };

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

// ── Usage Calculation ─────────────────────────────────────────────────────────

const calculateUsageAmount = async (customerId, startDate, endDate) => {
  const meters = await query(`SELECT id FROM meters WHERE customer_id=$1 AND status='active'`, [customerId]);
  if (!meters.rows.length) return 0;

  const customerR  = await query(`SELECT tariff_type FROM customers WHERE id=$1`, [customerId]);
  const tariffType = customerR.rows[0]?.tariff_type || 'residential';
  const rate       = TARIFF_RATES[tariffType] || TARIFF_RATES.residential;
  let total = 0;

  for (const meter of meters.rows) {
    // Latest reading at or before period end (the "current" meter value)
    const currR = await query(
      `SELECT total_consumption FROM meter_readings
       WHERE meter_id=$1 AND timestamp::date <= $2::date
       ORDER BY timestamp DESC LIMIT 1`,
      [meter.id, endDate]
    );
    if (!currR.rows[0]) continue;

    // Latest reading strictly before period start (the "previous" baseline)
    const prevR = await query(
      `SELECT total_consumption FROM meter_readings
       WHERE meter_id=$1 AND timestamp::date < $2::date
       ORDER BY timestamp DESC LIMIT 1`,
      [meter.id, startDate]
    );

    const current  = parseFloat(currR.rows[0].total_consumption || 0);
    const previous = prevR.rows[0] ? parseFloat(prevR.rows[0].total_consumption) : 0;
    total += Math.max(0, current - previous) * rate;
  }
  return Number(total.toFixed(2));
};

// ── PDF ───────────────────────────────────────────────────────────────────────

const createInvoicePDF = async (invoice, items, customer) => {
  const filename  = `invoice-${invoice.invoice_number}.pdf`;
  const filePath  = path.join(INVOICE_DIR, filename);
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
      doc.text(item.quantity.toString(), 300, position);
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

const postBillingCycleInvoice = async (billingCycleId, invoiceNumber, note, userId) => {
  const cycle = await query('SELECT * FROM billing_cycles WHERE id=$1', [billingCycleId]);
  if (!cycle.rows[0]) throw new Error('Billing cycle not found');
  const bc = cycle.rows[0];

  const existing = await query('SELECT id FROM invoices WHERE invoice_number=$1', [invoiceNumber]);
  if (existing.rows.length) throw new Error('Invoice number already exists');

  const customer = await query('SELECT * FROM customers WHERE id=$1', [bc.customer_id]);
  if (!customer.rows[0]) throw new Error('Customer not found');

  const tariffType = customer.rows[0].tariff_type || 'residential';
  const r = await query(
    `INSERT INTO invoices (customer_id,invoice_number,issue_date,due_date,tariff_type,total_amount,status,notes,created_by,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,NOW()) RETURNING *`,
    [bc.customer_id, invoiceNumber, bc.period_end, bc.due_date, tariffType, bc.amount, note, userId]
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

  const pdfMeta = await createInvoicePDF(invoice, invoiceItems, customer.rows[0]);
  await recordAudit({ userId, action: 'post_invoice', entityType: 'billing_cycle', entityId: billingCycleId, newValues: { invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, amount: bc.amount, dueDate: bc.due_date } });
  await enqueueOdooSync('invoice', invoice.id).catch(err => console.error('Failed to enqueue Odoo invoice sync:', err.message));
  publish('invoice_created', { invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, customerId: invoice.customer_id, pdf: pdfMeta.filename, pdf_url: `/reports/${pdfMeta.filename}` });

  return { ...invoice, invoice_pdf: pdfMeta.filename, pdf_url: `/reports/${pdfMeta.filename}` };
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
  await enqueueOdooSync('payment', paymentId).catch(err => console.error('Failed to enqueue Odoo payment sync:', err.message));
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
    errors.push({ code: 'FUTURE_PERIOD', message: `Period end (${pEndStr}) is in the future — billing requires completed periods.` });
  }
  if (periodEnd < periodStart) {
    errors.push({ code: 'INVALID_PERIOD', message: `Period end (${pEndStr}) is before period start (${pStartStr}).` });
  }

  const customersR = await _query(
    `SELECT DISTINCT c.id, c.customer_number, c.full_name, c.tariff_type
     FROM customers c JOIN meters m ON m.customer_id = c.id
     WHERE c.account_status='active' AND m.status='active'`
  );

  if (!customersR.rows.length) {
    errors.push({ code: 'NO_ACTIVE_CUSTOMERS', message: 'No active customers with active meters found.' });
    return { valid: false, errors, warnings, customerIssues, periodStart: pStartStr, periodEnd: pEndStr, totalCustomers: 0 };
  }

  let duplicateCount     = 0;
  let missingReadCount   = 0;
  let negativeConsCount  = 0;
  let zeroConsCount      = 0;
  let missingTariffCount = 0;

  for (const customer of customersR.rows) {
    const dupR = await _query(
      `SELECT id FROM billing_cycles WHERE customer_id=$1 AND period_start=$2 AND period_end=$3`,
      [customer.id, periodStart, periodEnd]
    );
    if (dupR.rows.length) {
      customerIssues.push({ customerId: customer.id, customerName: customer.full_name, customerNumber: customer.customer_number, issue: 'Billing cycle already exists for this period', severity: 'info', code: 'DUPLICATE_PERIOD' });
      duplicateCount++;
      continue;
    }

    if (!customer.tariff_type || !TARIFF_RATES[customer.tariff_type]) {
      customerIssues.push({ customerId: customer.id, customerName: customer.full_name, customerNumber: customer.customer_number, issue: `Unknown tariff: "${customer.tariff_type}" — will default to residential`, severity: 'warning', code: 'MISSING_TARIFF' });
      missingTariffCount++;
    }

    const metersR = await _query(`SELECT id, meter_number FROM meters WHERE customer_id=$1 AND status='active'`, [customer.id]);
    for (const meter of metersR.rows) {
      const currR = await _query(
        `SELECT total_consumption FROM meter_readings WHERE meter_id=$1 AND timestamp::date <= $2::date ORDER BY timestamp DESC LIMIT 1`,
        [meter.id, periodEnd]
      );
      if (!currR.rows[0]) {
        customerIssues.push({ customerId: customer.id, customerName: customer.full_name, customerNumber: customer.customer_number, issue: `Meter ${meter.meter_number}: no readings found in or before billing period`, severity: 'warning', code: 'MISSING_READING' });
        missingReadCount++;
        continue;
      }
      const prevR = await _query(
        `SELECT total_consumption FROM meter_readings WHERE meter_id=$1 AND timestamp::date < $2::date ORDER BY timestamp DESC LIMIT 1`,
        [meter.id, periodStart]
      );
      const curr        = Number(currR.rows[0].total_consumption);
      const prev        = prevR.rows[0] ? Number(prevR.rows[0].total_consumption) : 0;
      const consumption = curr - prev;
      if (consumption < 0) {
        customerIssues.push({ customerId: customer.id, customerName: customer.full_name, customerNumber: customer.customer_number, issue: `Meter ${meter.meter_number}: negative consumption (${consumption.toFixed(3)} m³) — possible meter reset`, severity: 'warning', code: 'NEGATIVE_CONSUMPTION' });
        negativeConsCount++;
      } else if (consumption === 0) {
        zeroConsCount++;
      }
    }
  }

  if (duplicateCount    > 0) warnings.push({ code: 'HAS_DUPLICATES',           message: `${duplicateCount} customer(s) already have a billing cycle for this period and will be skipped.` });
  if (missingReadCount  > 0) warnings.push({ code: 'HAS_MISSING_READINGS',     message: `${missingReadCount} meter(s) have no readings in or before this period.` });
  if (negativeConsCount > 0) warnings.push({ code: 'HAS_NEGATIVE_CONSUMPTION', message: `${negativeConsCount} meter(s) show negative consumption (possible meter reset).` });
  if (zeroConsCount     > 0) warnings.push({ code: 'HAS_ZERO_CONSUMPTION',     message: `${zeroConsCount} meter(s) show zero consumption and will be skipped.` });
  if (missingTariffCount > 0) warnings.push({ code: 'HAS_MISSING_TARIFF',      message: `${missingTariffCount} customer(s) have an unknown tariff and will default to residential.` });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    customerIssues,
    periodStart: pStartStr,
    periodEnd:   pEndStr,
    totalCustomers:     customersR.rows.length,
    duplicateCount,
    missingReadCount,
    negativeConsCount,
    zeroConsCount,
    missingTariffCount,
  };
};

// ── Cancel / Post pending run ─────────────────────────────────────────────────

const cancelBillingRun = async (runId, reason, userId, { _query = query, _recordAudit = recordAudit } = {}) => {
  const runR = await _query('SELECT * FROM billing_runs WHERE id=$1', [runId]);
  const run  = runR.rows[0];
  if (!run) throw new Error('Billing run not found');
  if (!['running', 'pending_post'].includes(run.status)) {
    throw new Error(`Cannot cancel a run with status '${run.status}'. Only 'running' or 'pending_post' can be cancelled.`);
  }

  if (run.status === 'pending_post') {
    const itemsR = await _query(
      `SELECT billing_cycle_id FROM billing_run_items WHERE run_id=$1 AND billing_cycle_id IS NOT NULL`,
      [runId]
    );
    for (const item of itemsR.rows) {
      await _query('DELETE FROM billing_cycles WHERE id=$1', [item.billing_cycle_id]);
    }
    await _query(
      `UPDATE billing_run_items SET billing_status='failed', error_message='Run cancelled' WHERE run_id=$1 AND billing_status='pending_post'`,
      [runId]
    );
  }

  await _query(
    `UPDATE billing_runs SET status='cancelled', cancelled_at=NOW(), cancelled_by=$1, cancel_reason=$2, completed_at=NOW() WHERE id=$3`,
    [userId || null, reason || null, runId]
  );
  await _recordAudit({ userId, action: 'cancel_billing_run', entityType: 'billing_run', entityId: runId, newValues: { reason, cancelledBy: userId } });
  return { runId, status: 'cancelled', cancelledAt: new Date().toISOString(), cancelledBy: userId };
};

const postPendingBillingRun = async (runId, userId, { _query = query, _postCycleInvoice = postBillingCycleInvoice } = {}) => {
  const runR = await _query('SELECT * FROM billing_runs WHERE id=$1', [runId]);
  const run  = runR.rows[0];
  if (!run) throw new Error('Billing run not found');
  if (run.status !== 'pending_post') {
    throw new Error(`Run ${runId} is not in pending_post status (current: ${run.status}).`);
  }

  const itemsR = await _query(
    `SELECT bri.*, c.customer_number FROM billing_run_items bri
     LEFT JOIN customers c ON c.id = bri.customer_id
     WHERE bri.run_id=$1 AND bri.billing_status='pending_post' AND bri.billing_cycle_id IS NOT NULL`,
    [runId]
  );

  let ok          = parseInt(run.customers_ok,     10) || 0;
  let failed      = parseInt(run.customers_failed, 10) || 0;
  let totalRevenue = parseFloat(run.total_revenue) || 0;

  for (const item of itemsR.rows) {
    const ym        = run.period_start.toString().slice(0, 7).replace('-', '');
    const custRef   = (item.customer_number && item.customer_number.trim()) ? item.customer_number.trim() : item.customer_id.slice(0, 8).toUpperCase();
    const invNumber = `INV-${ym}-${custRef}`;
    try {
      await _postCycleInvoice(item.billing_cycle_id, invNumber, 'Auto-generated invoice', userId);
      await _query(
        `UPDATE billing_run_items SET billing_status='success', invoice_reference=$1 WHERE id=$2`,
        [invNumber, item.id]
      );
      ok++;
      totalRevenue += parseFloat(item.amount || 0);
    } catch (err) {
      await _query(
        `UPDATE billing_run_items SET billing_status='failed', error_message=$1 WHERE id=$2`,
        [err.message, item.id]
      );
      failed++;
    }
  }

  const skipped     = parseInt(run.customers_skipped, 10) || 0;
  const total       = parseInt(run.customers_total,   10) || 0;
  const finalStatus = ok === 0 && failed > 0 ? 'failed' : failed > 0 ? 'partial' : 'completed';

  await _query(
    `UPDATE billing_runs SET status=$1, customers_ok=$2, customers_failed=$3, total_revenue=$4, completed_at=NOW() WHERE id=$5`,
    [finalStatus, ok, failed, Number(totalRevenue.toFixed(2)), runId]
  );

  return { runId, status: finalStatus, total, ok, skipped, failed };
};

// ── Monthly Auto-Billing ──────────────────────────────────────────────────────

const runMonthlyAutoBilling = async (
  opts = {},
  {
    _query            = query,
    _calculateUsage   = calculateUsageAmount,
    _createCycle      = createBillingCycleForCustomer,
    _postCycleInvoice = postBillingCycleInvoice,
    _getSettings      = getBillingSettings,
  } = {}
) => {
  const settings    = await _getSettings({ _query });
  const triggeredBy = opts.triggeredBy || 'scheduler';
  const now         = new Date();

  const periodStart = opts.periodStart ? new Date(opts.periodStart) : new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const periodEnd   = opts.periodEnd   ? new Date(opts.periodEnd)   : new Date(now.getFullYear(), now.getMonth(), 0);
  const dueDays     = opts.dueDays  != null ? opts.dueDays  : settings.due_days;
  const autoPost    = opts.autoPost != null ? opts.autoPost : settings.auto_post_invoice;

  const dueDate   = new Date(periodEnd.getTime() + dueDays * 24 * 60 * 60 * 1000);
  const ym        = `${periodStart.getFullYear()}${String(periodStart.getMonth() + 1).padStart(2, '0')}`;
  const pStartStr = periodStart.toISOString().slice(0, 10);
  const pEndStr   = periodEnd.toISOString().slice(0, 10);

  const runR = await _query(
    `INSERT INTO billing_runs (period_start, period_end, triggered_by, status) VALUES ($1,$2,$3,'running') RETURNING id`,
    [pStartStr, pEndStr, triggeredBy]
  );
  const runId = runR.rows[0].id;

  const customers = await _query(
    `SELECT DISTINCT c.id, c.customer_number, c.full_name FROM customers c
     JOIN meters m ON m.customer_id = c.id
     WHERE c.account_status='active' AND m.status='active'`
  );

  let ok = 0, skipped = 0, failed = 0, pendingPost = 0;
  let totalConsumption = 0, totalRevenue = 0;
  const total = customers.rows.length;

  for (const customer of customers.rows) {
    const billingAccount = (customer.customer_number && customer.customer_number.trim()) ? customer.customer_number.trim() : null;

    const existingR = await _query(
      `SELECT bc.id, i.invoice_number FROM billing_cycles bc
       LEFT JOIN invoices i ON i.id = bc.invoice_id
       WHERE bc.customer_id=$1 AND bc.period_start=$2 AND bc.period_end=$3`,
      [customer.id, periodStart, periodEnd]
    );
    if (existingR.rows.length) {
      await _query(
        `INSERT INTO billing_run_items
         (run_id, customer_id, customer_number, billing_account, billing_period_start, billing_period_end, invoice_reference, billing_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'skipped')`,
        [runId, customer.id, customer.customer_number, billingAccount, pStartStr, pEndStr, existingR.rows[0].invoice_number || null]
      );
      skipped++;
      continue;
    }

    try {
      const amount = await _calculateUsage(customer.id, periodStart, periodEnd);

      const metersR   = await _query(`SELECT meter_number FROM meters WHERE customer_id=$1 AND status='active'`, [customer.id]);
      const meterNums = metersR.rows.map(m => m.meter_number).join(', ');

      if (amount === 0) {
        await _query(
          `INSERT INTO billing_run_items
           (run_id, customer_id, customer_number, billing_account, billing_period_start, billing_period_end, meter_number, billing_status, error_message)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'skipped','Zero consumption for period')`,
          [runId, customer.id, customer.customer_number, billingAccount, pStartStr, pEndStr, meterNums]
        );
        skipped++;
        continue;
      }

      const cycle   = await _createCycle(customer.id, 'monthly', periodStart, periodEnd, dueDate, null, 'Auto-generated monthly billing', amount);
      const custRef = billingAccount || customer.id.slice(0, 8).toUpperCase();
      const invoiceNumber = `INV-${ym}-${custRef}`;

      if (autoPost) {
        await _postCycleInvoice(cycle.id, invoiceNumber, 'Auto-generated invoice', null);
        await _query(
          `INSERT INTO billing_run_items
           (run_id, customer_id, customer_number, billing_account, billing_period_start, billing_period_end,
            meter_number, invoice_reference, billing_status, amount, billing_cycle_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'success',$9,$10)`,
          [runId, customer.id, customer.customer_number, billingAccount, pStartStr, pEndStr, meterNums, invoiceNumber, amount, cycle.id]
        );
        totalRevenue += amount;
        ok++;
      } else {
        await _query(
          `INSERT INTO billing_run_items
           (run_id, customer_id, customer_number, billing_account, billing_period_start, billing_period_end,
            meter_number, billing_status, amount, billing_cycle_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_post',$8,$9)`,
          [runId, customer.id, customer.customer_number, billingAccount, pStartStr, pEndStr, meterNums, amount, cycle.id]
        );
        pendingPost++;
      }

      // Approximate consumption from amount (used for run-level totals; precise value in preview)
      const tariffR = await _query(`SELECT tariff_type FROM customers WHERE id=$1`, [customer.id]);
      const tariff  = tariffR.rows[0]?.tariff_type || 'residential';
      const rate    = TARIFF_RATES[tariff] || TARIFF_RATES.residential;
      totalConsumption += amount / rate;

    } catch (err) {
      console.error(`Auto-billing failed for customer ${customer.id}:`, err.message);
      await _query(
        `INSERT INTO billing_run_items
         (run_id, customer_id, customer_number, billing_account, billing_period_start, billing_period_end, billing_status, error_message)
         VALUES ($1,$2,$3,$4,$5,$6,'failed',$7)`,
        [runId, customer.id, customer.customer_number, billingAccount, pStartStr, pEndStr, err.message]
      );
      failed++;
    }
  }

  let finalStatus;
  if (pendingPost > 0 && failed === 0) {
    finalStatus = 'pending_post';
  } else if (ok === 0 && failed > 0) {
    finalStatus = 'failed';
  } else if (failed > 0) {
    finalStatus = 'partial';
  } else {
    finalStatus = 'completed';
  }

  await _query(
    `UPDATE billing_runs SET status=$1, customers_total=$2, customers_ok=$3, customers_skipped=$4, customers_failed=$5,
     total_consumption=$6, total_revenue=$7, completed_at=NOW() WHERE id=$8`,
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
    `SELECT DISTINCT c.id, c.customer_number, c.full_name, c.tariff_type AS customer_tariff_type
     FROM customers c JOIN meters m ON m.customer_id = c.id
     WHERE c.account_status='active' AND m.status='active'`
  );

  const preview                  = [];
  let totalEstimatedRevenue      = 0;
  let totalEstimatedConsumption  = 0;

  for (const customer of customers.rows) {
    const billingAccount = (customer.customer_number && customer.customer_number.trim()) ? customer.customer_number.trim() : null;

    const existingR = await _query(
      `SELECT bc.id FROM billing_cycles bc WHERE bc.customer_id=$1 AND bc.period_start=$2 AND bc.period_end=$3`,
      [customer.id, periodStart, periodEnd]
    );
    if (existingR.rows.length) {
      preview.push({
        customerId: customer.id, customerNumber: customer.customer_number,
        customerName: customer.full_name, billingAccount,
        wouldSkip: true, skipReason: 'Billing cycle already exists for this period',
        meters: [], estimatedAmount: null, totalConsumption: null,
      });
      continue;
    }

    const metersR        = await _query(`SELECT id, meter_number FROM meters WHERE customer_id=$1 AND status='active'`, [customer.id]);
    const meterDetails   = [];
    let customerAmount   = 0;
    let customerConsumed = 0;
    const tariffType     = customer.customer_tariff_type || 'residential';

    for (const meter of metersR.rows) {
      const unitPrice = TARIFF_RATES[tariffType] || TARIFF_RATES.residential;

      const currR = await _query(
        `SELECT total_consumption, timestamp FROM meter_readings
         WHERE meter_id=$1 AND timestamp::date <= $2::date ORDER BY timestamp DESC LIMIT 1`,
        [meter.id, periodEnd]
      );
      const prevR = await _query(
        `SELECT total_consumption, timestamp FROM meter_readings
         WHERE meter_id=$1 AND timestamp::date < $2::date ORDER BY timestamp DESC LIMIT 1`,
        [meter.id, periodStart]
      );

      const currentVal  = currR.rows[0] ? Number(currR.rows[0].total_consumption) : null;
      const previousVal = prevR.rows[0] ? Number(prevR.rows[0].total_consumption) : 0;

      if (currentVal === null) {
        meterDetails.push({
          meterNumber: meter.meter_number, tariff: tariffType, unitPrice,
          previousReading: null, previousReadingDate: null,
          currentReading: null, currentReadingDate: null,
          consumption: null, estimatedAmount: null,
          skipReason: 'No readings found for this meter in the billing period',
        });
        continue;
      }

      const consumption = Number((currentVal - previousVal).toFixed(3));
      const billable    = Math.max(0, consumption);
      const amount      = Number((billable * unitPrice).toFixed(2));
      customerAmount   += amount;
      customerConsumed += billable;

      meterDetails.push({
        meterNumber:         meter.meter_number,
        tariff:              tariffType,
        unitPrice,
        previousReading:     previousVal,
        previousReadingDate: prevR.rows[0] ? new Date(prevR.rows[0].timestamp).toISOString().slice(0, 10) : null,
        currentReading:      currentVal,
        currentReadingDate:  new Date(currR.rows[0].timestamp).toISOString().slice(0, 10),
        consumption,
        estimatedAmount:     amount,
        skipReason:          consumption <= 0 ? 'Zero or negative consumption (meter reset / no usage)' : null,
      });
    }

    const wouldSkip = customerAmount === 0;
    if (!wouldSkip) {
      totalEstimatedRevenue     += customerAmount;
      totalEstimatedConsumption += customerConsumed;
    }

    preview.push({
      customerId:       customer.id,
      customerNumber:   customer.customer_number,
      customerName:     customer.full_name,
      billingAccount,
      wouldSkip,
      skipReason:       wouldSkip ? 'Zero consumption for period' : null,
      meters:           meterDetails,
      estimatedAmount:  wouldSkip ? null : Number(customerAmount.toFixed(2)),
      totalConsumption: wouldSkip ? null : Number(customerConsumed.toFixed(3)),
    });
  }

  return {
    periodStart:               pStartStr,
    periodEnd:                 pEndStr,
    totalCustomers:            customers.rows.length,
    willBill:                  preview.filter(p => !p.wouldSkip).length,
    willSkip:                  preview.filter(p =>  p.wouldSkip).length,
    totalEstimatedRevenue:     Number(totalEstimatedRevenue.toFixed(2)),
    totalEstimatedConsumption: Number(totalEstimatedConsumption.toFixed(3)),
    preview,
  };
};

// ── Overdue ───────────────────────────────────────────────────────────────────

const markOverdueInvoices = async () => {
  const r = await query(
    `UPDATE invoices SET status='overdue', updated_at=NOW() WHERE status='pending' AND due_date < NOW() RETURNING id, customer_id, invoice_number`
  );
  for (const invoice of r.rows) {
    await query(`UPDATE billing_cycles SET status='overdue', updated_at=NOW() WHERE invoice_id=$1`, [invoice.id]);
    await recordAudit({ action: 'mark_overdue', entityType: 'invoice', entityId: invoice.id, newValues: { status: 'overdue' } });
    publish('invoice_overdue', invoice);
  }
  return r.rows.length;
};

module.exports = {
  calculateUsageAmount,
  createInvoicePDF,
  createBillingCycleForCustomer,
  postBillingCycleInvoice,
  recordPayment,
  markOverdueInvoices,
  runMonthlyAutoBilling,
  previewMonthlyBilling,
  getBillingSettings,
  updateBillingSettings,
  validateBillingPeriod,
  cancelBillingRun,
  postPendingBillingRun,
};
