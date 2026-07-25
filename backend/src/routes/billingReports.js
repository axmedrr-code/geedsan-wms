const express  = require('express');
const router   = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

const FINANCIAL_ROLES = ['admin', 'manager', 'finance', 'billing_officer', 'viewer'];

// Shared by the JSON and PDF customer-statement routes so both always
// compute the exact same numbers — opening balance, ledger, aging, etc.
// are assembled once here.
const buildCustomerStatement = async (customerId, { from, to } = {}) => {
  const custR = await query(
    `SELECT c.*, z.zone_name AS zone_name FROM customers c LEFT JOIN zones z ON z.id = c.zone_id WHERE c.id = $1`,
    [customerId]
  );
  if (!custR.rows[0]) return null;
  const customer = custR.rows[0];

  // ── Opening balance: everything before the period, collapsed to one number ──
  // No `from` means "since the beginning" — nothing precedes it, so 0.
  let openingBalance = 0;
  if (from) {
    const openingR = await query(
      `SELECT
         COALESCE((SELECT SUM(total_amount) FROM invoices
                    WHERE customer_id=$1 AND status != 'cancelled' AND issue_date < $2), 0) AS invoiced_before,
         COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id
                    WHERE i.customer_id=$1 AND ip.payment_date < $2), 0) AS paid_before`,
      [customerId, from]
    );
    openingBalance = Number(openingR.rows[0].invoiced_before) - Number(openingR.rows[0].paid_before);
  }

  // ── Invoices in range (unchanged query, still status-agnostic like before) ──
  let invoiceQuery = `
    SELECT i.*, COALESCE(p.total_paid, 0) AS paid_amount,
           i.total_amount - COALESCE(p.total_paid, 0) AS balance
    FROM invoices i
    LEFT JOIN (SELECT invoice_id, SUM(amount) total_paid FROM invoice_payments GROUP BY invoice_id) p
      ON p.invoice_id = i.id
    WHERE i.customer_id = $1`;
  const invoiceParams = [customerId];
  if (from) { invoiceParams.push(from); invoiceQuery += ` AND i.issue_date >= $${invoiceParams.length}`; }
  if (to)   { invoiceParams.push(to);   invoiceQuery += ` AND i.issue_date <= $${invoiceParams.length}`; }
  invoiceQuery += ' ORDER BY i.issue_date DESC';
  const invoicesR = await query(invoiceQuery, invoiceParams);
  const invoices = invoicesR.rows.map(r => ({ ...r, odoo_synced: !!r.odoo_id }));

  // ── Payments in range — previously ignored from/to entirely (bug); now
  // filtered by payment_date so it actually respects the requested period. ──
  let paymentQuery = `
    SELECT ip.*, i.invoice_number FROM invoice_payments ip
    JOIN invoices i ON i.id = ip.invoice_id
    WHERE i.customer_id = $1`;
  const paymentParams = [customerId];
  if (from) { paymentParams.push(from); paymentQuery += ` AND ip.payment_date >= $${paymentParams.length}`; }
  if (to)   { paymentParams.push(to);   paymentQuery += ` AND ip.payment_date <= $${paymentParams.length}`; }
  paymentQuery += ' ORDER BY ip.payment_date DESC';
  const paymentsR = await query(paymentQuery, paymentParams);
  const payments = paymentsR.rows.map(r => ({ ...r, odoo_synced: !!r.odoo_id }));

  const totalInvoiced = invoices.reduce((s, r) => s + Number(r.total_amount), 0);
  const totalPaid     = invoices.reduce((s, r) => s + Number(r.paid_amount), 0);
  const totalBalance  = invoices.reduce((s, r) => s + Number(r.balance), 0);
  const overdueCount  = invoices.filter(r => r.status === 'overdue').length;
  const closingBalance = openingBalance + totalInvoiced - totalPaid;

  // ── Chronological merged ledger: invoices (debit) + payments (credit),
  // sorted by date, running balance starting from the opening balance. ──
  const ledger = [
    ...invoices.map(inv => ({
      date: inv.issue_date, type: 'invoice', id: inv.id, reference: inv.invoice_number,
      description: `Invoice ${inv.invoice_number}`,
      debit: Number(inv.total_amount), credit: 0, odoo_synced: inv.odoo_synced,
    })),
    ...payments.map(p => ({
      date: p.payment_date, type: 'payment', id: p.id, reference: p.reference || p.invoice_number,
      description: `Payment — ${p.invoice_number}${p.method ? ` (${p.method})` : ''}`,
      debit: 0, credit: Number(p.amount), odoo_synced: p.odoo_synced,
    })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  let running = openingBalance;
  for (const entry of ledger) {
    running += entry.debit - entry.credit;
    entry.running_balance = +running.toFixed(2);
  }

  // ── Aging: current outstanding balance as of today, independent of the
  // period being viewed — matches the bucket definitions in the /aging
  // report so the two stay consistent. ──
  const agingR = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN due_date >= NOW() THEN total_amount - paid ELSE 0 END), 0)                                                 AS current_balance,
       COALESCE(SUM(CASE WHEN due_date < NOW() AND due_date >= NOW() - INTERVAL '30 days' THEN total_amount - paid ELSE 0 END), 0)        AS overdue_30,
       COALESCE(SUM(CASE WHEN due_date < NOW() - INTERVAL '30 days' AND due_date >= NOW() - INTERVAL '60 days' THEN total_amount - paid ELSE 0 END), 0) AS overdue_60,
       COALESCE(SUM(CASE WHEN due_date < NOW() - INTERVAL '60 days' AND due_date >= NOW() - INTERVAL '90 days' THEN total_amount - paid ELSE 0 END), 0) AS overdue_90,
       COALESCE(SUM(CASE WHEN due_date < NOW() - INTERVAL '90 days' THEN total_amount - paid ELSE 0 END), 0)                              AS overdue_90_plus,
       COALESCE(SUM(total_amount - paid), 0) AS total_outstanding
     FROM (
       SELECT i.due_date, i.total_amount, COALESCE(p.paid, 0) AS paid
       FROM invoices i
       LEFT JOIN (SELECT invoice_id, SUM(amount) paid FROM invoice_payments GROUP BY invoice_id) p ON p.invoice_id = i.id
       WHERE i.customer_id = $1 AND i.status IN ('pending','overdue')
     ) x
     WHERE total_amount - paid > 0`,
    [customerId]
  );
  const ag = agingR.rows[0];
  const aging = {
    current_balance:   +Number(ag.current_balance).toFixed(2),
    overdue_30:        +Number(ag.overdue_30).toFixed(2),
    overdue_60:        +Number(ag.overdue_60).toFixed(2),
    overdue_90:        +Number(ag.overdue_90).toFixed(2),
    overdue_90_plus:   +Number(ag.overdue_90_plus).toFixed(2),
    total_outstanding: +Number(ag.total_outstanding).toFixed(2),
  };

  return {
    customer,
    period: { from: from || null, to: to || null },
    summary: {
      opening_balance:  +openingBalance.toFixed(2),
      total_invoiced:   +totalInvoiced.toFixed(2),
      total_paid:       +totalPaid.toFixed(2),
      total_balance:    +totalBalance.toFixed(2),
      closing_balance:  +closingBalance.toFixed(2),
      overdue_count:    overdueCount,
    },
    aging,
    invoices,
    payments,
    ledger,
    generated_at: new Date().toISOString(),
  };
};

// GET /api/billing-reports/customer-statement/:customerId
// Response shape is additive-only over the previous version: every field
// that existed before (customer, summary.total_invoiced/total_paid/
// total_balance/overdue_count, invoices, payments, generated_at) is still
// present with the same meaning — opening_balance/closing_balance were
// added inside summary, and period/aging/ledger are new top-level keys.
router.get('/customer-statement/:customerId', authenticate, authorize(...FINANCIAL_ROLES), async (req, res) => {
  try {
    const statement = await buildCustomerStatement(req.params.customerId, req.query);
    if (!statement) return res.status(404).json({ error: 'Customer not found' });
    res.json(statement);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing-reports/customer-statement/:customerId/pdf
// Same data as the JSON route above (buildCustomerStatement) — a separate
// route rather than a ?format=pdf flag on the existing one, matching the
// existing convention of billing.js's GET /:id/pdf being its own route
// alongside the JSON invoice route.
router.get('/customer-statement/:customerId/pdf', authenticate, authorize(...FINANCIAL_ROLES), async (req, res) => {
  try {
    const statement = await buildCustomerStatement(req.params.customerId, req.query);
    if (!statement) return res.status(404).json({ error: 'Customer not found' });
    const { customer, period, summary, aging, ledger } = statement;

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    const fname = `Statement-${customer.customer_number || customer.id}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fname}"`);
    doc.pipe(res);

    const BRAND = '#1e40af', MUTED = '#64748b', BLACK = '#0f172a', WHITE = '#ffffff', LIGHT = '#f1f5f9', LINE = '#e2e8f0';
    const RED = '#ef4444', GREEN = '#10b981';
    const fmtDate  = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' }) : '—';
    const fmtMoney = (v) => `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const pageW = doc.page.width, pageH = doc.page.height;
    const L = 50, R = pageW - 50;

    // ── Header band ──────────────────────────────────────────────────────────
    doc.rect(0, 0, pageW, 90).fill(BRAND);
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(22).text('NUWACO', L, 22);
    doc.fillColor('rgba(255,255,255,0.7)').font('Helvetica').fontSize(9).text('National Urban Water Company', L, 47);
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(16).text('CUSTOMER STATEMENT', R - 220, 22, { width: 220, align: 'right' });
    const periodLabel = period.from || period.to
      ? `${period.from ? fmtDate(period.from) : 'Start'} — ${period.to ? fmtDate(period.to) : 'Today'}`
      : 'All time';
    doc.fillColor('rgba(255,255,255,0.7)').font('Helvetica').fontSize(9).text(periodLabel, R - 220, 47, { width: 220, align: 'right' });

    // ── Customer block ───────────────────────────────────────────────────────
    const metaY = 110;
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5).text('CUSTOMER', L, metaY);
    doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(11).text(customer.full_name || '—', L, metaY + 12);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
       .text(`Customer #: ${customer.customer_number || '—'}`, L, metaY + 26)
       .text(customer.email || '', L, metaY + 38)
       .text(customer.phone || '', L, metaY + 50)
       .text([customer.address, customer.city].filter(Boolean).join(', '), L, metaY + 62, { width: 220 });

    // ── Summary box (opening / invoiced / paid / closing) ───────────────────
    const sumX = R - 220, sumW = 220;
    const sumLines = [
      ['Opening Balance', fmtMoney(summary.opening_balance)],
      ['Invoiced (period)', fmtMoney(summary.total_invoiced)],
      ['Paid (period)', `-${fmtMoney(summary.total_paid)}`],
    ];
    doc.rect(sumX, metaY, sumW, 16 * sumLines.length + 32).fill(LIGHT);
    let sy = metaY + 8;
    for (const [label, val] of sumLines) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(label, sumX + 10, sy, { width: 110 });
      doc.fillColor(BLACK).font('Helvetica').fontSize(8.5).text(val, sumX + 120, sy, { width: 90, align: 'right' });
      sy += 16;
    }
    doc.rect(sumX, sy, sumW, 28).fill(summary.closing_balance > 0 ? BRAND : GREEN);
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(9).text('CLOSING BALANCE', sumX + 10, sy + 9, { width: 110 });
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(11).text(fmtMoney(summary.closing_balance), sumX + 120, sy + 8, { width: 90, align: 'right' });

    // ── Ledger table ──────────────────────────────────────────────────────────
    let tableY = metaY + 130;
    doc.moveTo(L, tableY - 10).lineTo(R, tableY - 10).strokeColor(LINE).lineWidth(1).stroke();

    const colDate = L, colDesc = L + 75, colDebit = R - 220, colCredit = R - 140, colRunning = R - 60;
    const drawHeader = (y) => {
      doc.rect(L, y, R - L, 18).fill(LIGHT);
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5)
         .text('DATE', colDate + 4, y + 5)
         .text('DESCRIPTION', colDesc, y + 5)
         .text('DEBIT', colDebit - 10, y + 5, { width: 70, align: 'right' })
         .text('CREDIT', colCredit - 10, y + 5, { width: 70, align: 'right' })
         .text('BALANCE', colRunning - 10, y + 5, { width: 70, align: 'right' });
      return y + 18;
    };
    tableY = drawHeader(tableY);

    // Opening balance as the first row, matching how a real statement reads.
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(8.5)
       .text('Opening balance', colDesc, tableY + 5, { width: colDebit - colDesc - 10 });
    doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(8.5)
       .text(fmtMoney(summary.opening_balance), colRunning - 10, tableY + 5, { width: 70, align: 'right' });
    tableY += 18;
    doc.moveTo(L, tableY).lineTo(R, tableY).strokeColor(LINE).lineWidth(0.5).stroke();

    for (const entry of ledger) {
      if (tableY + 18 > pageH - 160) {
        doc.addPage();
        tableY = drawHeader(50);
      }
      doc.fillColor(BLACK).font('Helvetica').fontSize(8.5)
         .text(fmtDate(entry.date), colDate + 4, tableY + 5, { width: 70 })
         .text(entry.description, colDesc, tableY + 5, { width: colDebit - colDesc - 10 })
         .text(entry.debit  ? fmtMoney(entry.debit)  : '—', colDebit  - 10, tableY + 5, { width: 70, align: 'right' })
         .text(entry.credit ? fmtMoney(entry.credit) : '—', colCredit - 10, tableY + 5, { width: 70, align: 'right' });
      doc.fillColor(entry.running_balance > 0 ? RED : GREEN).font('Helvetica-Bold').fontSize(8.5)
         .text(fmtMoney(entry.running_balance), colRunning - 10, tableY + 5, { width: 70, align: 'right' });
      tableY += 18;
      doc.moveTo(L, tableY).lineTo(R, tableY).strokeColor(LINE).lineWidth(0.5).stroke();
    }
    if (!ledger.length) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(9).text('No activity in this period', colDesc, tableY + 5);
      tableY += 20;
    }

    // ── Aging summary ─────────────────────────────────────────────────────────
    if (tableY + 90 > pageH - 100) { doc.addPage(); tableY = 50; }
    tableY += 20;
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5).text('AGING SUMMARY (as of today, all outstanding invoices)', L, tableY);
    tableY += 14;
    const agingCols = [
      ['Current', aging.current_balance], ['1-30 days', aging.overdue_30],
      ['31-60 days', aging.overdue_60], ['61-90 days', aging.overdue_90],
      ['90+ days', aging.overdue_90_plus],
    ];
    const agingColW = (R - L) / agingCols.length;
    agingCols.forEach(([label, val], i) => {
      const x = L + i * agingColW;
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(label, x, tableY, { width: agingColW, align: 'center' });
      doc.fillColor(Number(val) > 0 ? RED : BLACK).font('Helvetica-Bold').fontSize(9.5).text(fmtMoney(val), x, tableY + 11, { width: agingColW, align: 'center' });
    });

    // ── Footer ────────────────────────────────────────────────────────────────
    const footY = pageH - 45;
    doc.moveTo(L, footY).lineTo(R, footY).strokeColor(LINE).lineWidth(1).stroke();
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
       .text(`Generated by NUWACO WMS · ${new Date().toUTCString()}`, L, footY + 8, { width: R - L, align: 'center' });

    doc.end();
  } catch (err) {
    console.error('Statement PDF generation error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// GET /api/billing-reports/zone/:zoneId
router.get('/zone/:zoneId', authenticate, authorize(...FINANCIAL_ROLES), async (req, res) => {
  try {
    const { zoneId } = req.params;
    const { from, to } = req.query;

    const zoneR = await query('SELECT * FROM zones WHERE id=$1', [zoneId]);
    if (!zoneR.rows[0]) return res.status(404).json({ error: 'Zone not found' });

    let q = `
      SELECT c.id, c.house_number, c.full_name, c.tariff_type,
             COUNT(i.id)::INT                    AS invoice_count,
             COALESCE(SUM(i.total_amount), 0)    AS total_invoiced,
             COALESCE(SUM(COALESCE(p.paid, 0)), 0) AS total_paid,
             COALESCE(SUM(i.total_amount - COALESCE(p.paid, 0)), 0) AS outstanding,
             COUNT(CASE WHEN i.status = 'overdue' THEN 1 END)::INT  AS overdue_count
      FROM customers c
      LEFT JOIN invoices i ON i.customer_id = c.id`;
    const params = [zoneId];
    if (from) { params.push(from); q += ` AND i.issue_date >= $${params.length}`; }
    if (to)   { params.push(to);   q += ` AND i.issue_date <= $${params.length}`; }
    q += `
      LEFT JOIN (SELECT invoice_id, SUM(amount) paid FROM invoice_payments GROUP BY invoice_id) p
        ON p.invoice_id = i.id
      WHERE c.zone_id = $1
      GROUP BY c.id, c.house_number, c.full_name, c.tariff_type
      ORDER BY c.house_number`;

    const rows = await query(q, params);

    const totals = rows.rows.reduce((acc, r) => {
      acc.total_invoiced += Number(r.total_invoiced);
      acc.total_paid     += Number(r.total_paid);
      acc.outstanding    += Number(r.outstanding);
      acc.overdue_count  += Number(r.overdue_count);
      return acc;
    }, { total_invoiced: 0, total_paid: 0, outstanding: 0, overdue_count: 0 });

    res.json({
      zone: zoneR.rows[0],
      summary: { customer_count: rows.rows.length, total_invoiced: +totals.total_invoiced.toFixed(2), total_paid: +totals.total_paid.toFixed(2), outstanding: +totals.outstanding.toFixed(2), overdue_count: totals.overdue_count },
      customers: rows.rows,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing-reports/aging
router.get('/aging', authenticate, authorize(...FINANCIAL_ROLES), async (req, res) => {
  try {
    const today = new Date();
    const agingR = await query(`
      SELECT c.id, c.house_number, c.full_name, z.zone_name AS zone_name,
             SUM(CASE WHEN i.due_date >= NOW() THEN i.total_amount - COALESCE(p.paid,0) ELSE 0 END)                            AS current_balance,
             SUM(CASE WHEN i.due_date < NOW() AND i.due_date >= NOW() - INTERVAL '30 days' THEN i.total_amount - COALESCE(p.paid,0) ELSE 0 END) AS overdue_30,
             SUM(CASE WHEN i.due_date < NOW() - INTERVAL '30 days' AND i.due_date >= NOW() - INTERVAL '60 days' THEN i.total_amount - COALESCE(p.paid,0) ELSE 0 END) AS overdue_60,
             SUM(CASE WHEN i.due_date < NOW() - INTERVAL '60 days' AND i.due_date >= NOW() - INTERVAL '90 days' THEN i.total_amount - COALESCE(p.paid,0) ELSE 0 END) AS overdue_90,
             SUM(CASE WHEN i.due_date < NOW() - INTERVAL '90 days' THEN i.total_amount - COALESCE(p.paid,0) ELSE 0 END) AS overdue_90_plus,
             SUM(i.total_amount - COALESCE(p.paid,0)) AS total_outstanding
      FROM customers c
      JOIN invoices i ON i.customer_id = c.id
      LEFT JOIN zones z ON z.id = c.zone_id
      LEFT JOIN (SELECT invoice_id, SUM(amount) paid FROM invoice_payments GROUP BY invoice_id) p
        ON p.invoice_id = i.id
      WHERE i.status IN ('pending','overdue') AND i.total_amount - COALESCE(p.paid,0) > 0
      GROUP BY c.id, c.house_number, c.full_name, z.zone_name
      HAVING SUM(i.total_amount - COALESCE(p.paid,0)) > 0
      ORDER BY total_outstanding DESC`
    );

    const totals = agingR.rows.reduce((acc, r) => {
      acc.current_balance  += Number(r.current_balance  || 0);
      acc.overdue_30       += Number(r.overdue_30       || 0);
      acc.overdue_60       += Number(r.overdue_60       || 0);
      acc.overdue_90       += Number(r.overdue_90       || 0);
      acc.overdue_90_plus  += Number(r.overdue_90_plus  || 0);
      acc.total_outstanding+= Number(r.total_outstanding|| 0);
      return acc;
    }, { current_balance: 0, overdue_30: 0, overdue_60: 0, overdue_90: 0, overdue_90_plus: 0, total_outstanding: 0 });

    res.json({
      report_date: today.toISOString().slice(0, 10),
      summary: {
        customer_count:    agingR.rows.length,
        current_balance:   +totals.current_balance.toFixed(2),
        overdue_30:        +totals.overdue_30.toFixed(2),
        overdue_60:        +totals.overdue_60.toFixed(2),
        overdue_90:        +totals.overdue_90.toFixed(2),
        overdue_90_plus:   +totals.overdue_90_plus.toFixed(2),
        total_outstanding: +totals.total_outstanding.toFixed(2),
      },
      customers: agingR.rows,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing-reports/unpaid
router.get('/unpaid', authenticate, authorize(...FINANCIAL_ROLES), async (req, res) => {
  try {
    const { zone_id, tariff_type, overdue_only } = req.query;

    let q = `
      SELECT i.id, i.invoice_number, i.issue_date, i.due_date, i.status, i.tariff_type,
             i.total_amount, COALESCE(p.paid,0) AS paid_amount,
             i.total_amount - COALESCE(p.paid,0) AS balance,
             c.id AS customer_id, c.house_number, c.full_name, c.phone,
             z.zone_name AS zone_name,
             CASE WHEN i.due_date < NOW() THEN (NOW()::date - i.due_date::date)::INT ELSE 0 END AS days_overdue
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      LEFT JOIN zones z ON z.id = c.zone_id
      LEFT JOIN (SELECT invoice_id, SUM(amount) paid FROM invoice_payments GROUP BY invoice_id) p
        ON p.invoice_id = i.id
      WHERE i.status IN ('pending','overdue') AND i.total_amount - COALESCE(p.paid,0) > 0`;

    const params = [];
    if (overdue_only === 'true') { q += ` AND i.status = 'overdue'`; }
    if (zone_id)     { params.push(zone_id);     q += ` AND c.zone_id = $${params.length}`; }
    if (tariff_type) { params.push(tariff_type); q += ` AND i.tariff_type = $${params.length}`; }
    q += ' ORDER BY days_overdue DESC, i.due_date ASC';

    const r = await query(q, params);
    const totalBalance = r.rows.reduce((s, row) => s + Number(row.balance), 0);

    res.json({
      count: r.rows.length,
      total_balance: +totalBalance.toFixed(2),
      invoices: r.rows,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing-reports/consumption
router.get('/consumption', authenticate, authorize(...FINANCIAL_ROLES), async (req, res) => {
  try {
    const { from, to, zone_id } = req.query;
    const params = [];
    let filter = '';
    if (from) { params.push(from); filter += ` AND i.billing_period_start >= $${params.length}`; }
    if (to)   { params.push(to);   filter += ` AND i.billing_period_end   <= $${params.length}`; }
    if (zone_id) { params.push(zone_id); filter += ` AND c.zone_id = $${params.length}`; }

    const r = await query(`
      SELECT c.id AS customer_id, c.house_number, c.full_name, c.tariff_type, z.zone_name AS zone_name,
             COUNT(i.id)::INT                          AS invoice_count,
             COALESCE(SUM(i.consumption_m3), 0)        AS total_consumption_m3,
             COALESCE(SUM(i.total_amount), 0)          AS total_billed,
             CASE WHEN SUM(i.consumption_m3) > 0
                  THEN SUM(i.total_amount) / SUM(i.consumption_m3)
                  ELSE 0 END                           AS avg_rate_per_m3
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      LEFT JOIN zones z ON z.id = c.zone_id
      WHERE i.status != 'cancelled' ${filter}
      GROUP BY c.id, c.house_number, c.full_name, c.tariff_type, z.zone_name
      ORDER BY total_consumption_m3 DESC`, params);

    const totals = r.rows.reduce((acc, row) => {
      acc.total_consumption_m3 += Number(row.total_consumption_m3);
      acc.total_billed         += Number(row.total_billed);
      return acc;
    }, { total_consumption_m3: 0, total_billed: 0 });

    res.json({
      period: { from: from || null, to: to || null },
      summary: {
        customer_count:       r.rows.length,
        total_consumption_m3: +totals.total_consumption_m3.toFixed(3),
        total_billed:         +totals.total_billed.toFixed(2),
        avg_rate_per_m3:      totals.total_consumption_m3 > 0 ? +(totals.total_billed / totals.total_consumption_m3).toFixed(4) : 0,
      },
      customers: r.rows,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing-reports/revenue
router.get('/revenue', authenticate, authorize(...FINANCIAL_ROLES), async (req, res) => {
  try {
    const { from, to, group_by = 'month' } = req.query;
    const params = [];
    let filter = '';
    if (from) { params.push(from); filter += ` AND payment_date >= $${params.length}`; }
    if (to)   { params.push(to);   filter += ` AND payment_date <= $${params.length}`; }

    const dateTrunc = group_by === 'day' ? 'day' : group_by === 'year' ? 'year' : 'month';

    const revenueR = await query(`
      SELECT DATE_TRUNC('${dateTrunc}', ip.payment_date)::date AS period,
             COUNT(ip.id)::INT       AS payment_count,
             SUM(ip.amount)          AS revenue,
             COUNT(DISTINCT i.customer_id)::INT AS customer_count
      FROM invoice_payments ip
      JOIN invoices i ON i.id = ip.invoice_id
      WHERE 1=1 ${filter}
      GROUP BY DATE_TRUNC('${dateTrunc}', ip.payment_date)
      ORDER BY period`, params);

    const invoicedR = await query(`
      SELECT DATE_TRUNC('${dateTrunc}', issue_date)::date AS period,
             COUNT(id)::INT          AS invoice_count,
             SUM(total_amount)       AS invoiced
      FROM invoices
      WHERE status != 'cancelled' ${filter.replace(/payment_date/g, 'issue_date')}
      GROUP BY DATE_TRUNC('${dateTrunc}', issue_date)
      ORDER BY period`, params);

    const invoicedMap = {};
    invoicedR.rows.forEach(r => { invoicedMap[r.period] = r; });

    const combined = revenueR.rows.map(r => {
      const inv = invoicedMap[r.period] || { invoice_count: 0, invoiced: 0 };
      return {
        period: r.period,
        payment_count:  r.payment_count,
        revenue:        Number(r.revenue),
        customer_count: r.customer_count,
        invoice_count:  Number(inv.invoice_count),
        invoiced:       Number(inv.invoiced),
        collection_rate: Number(inv.invoiced) > 0 ? +((Number(r.revenue) / Number(inv.invoiced)) * 100).toFixed(1) : 0,
      };
    });

    const totalRevenue  = combined.reduce((s, r) => s + r.revenue, 0);
    const totalInvoiced = combined.reduce((s, r) => s + r.invoiced, 0);

    res.json({
      period:   { from: from || null, to: to || null },
      group_by: dateTrunc,
      summary: {
        total_revenue:   +totalRevenue.toFixed(2),
        total_invoiced:  +totalInvoiced.toFixed(2),
        collection_rate: totalInvoiced > 0 ? +((totalRevenue / totalInvoiced) * 100).toFixed(1) : 0,
        period_count:    combined.length,
      },
      periods: combined,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
