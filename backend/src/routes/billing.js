const express = require('express');
const router  = express.Router();
const { query }            = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const {
  recordPayment,
  runMonthlyAutoBilling,
  previewMonthlyBilling,
  getBillingSettings,
  updateBillingSettings,
  validateBillingPeriod,
  cancelBillingRun,
  postPendingBillingRun,
  getBillingDashboardStats,
  generateInvoiceForCustomer,
  generateInvoiceForZone,
  generateInvoiceForSelected,
} = require('../services/billingService');
const { syncInvoiceToOdoo, enqueueOdooSync } = require('../services/odooService');
const logger = require('../services/logger');

// ── Billing Settings ──────────────────────────────────────────────────────────

router.get('/settings', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    res.json(await getBillingSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/settings', authenticate, authorize('admin'), async (req, res) => {
  try {
    const updated = await updateBillingSettings(req.body, req.user.id);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Billing-run endpoints (must be before /:id wildcard) ──────────────────────

// Pre-run validation — read-only, no writes.
// Query params: ?period_start=YYYY-MM-DD&period_end=YYYY-MM-DD (optional)
router.get('/validate', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const opts = {};
    if (req.query.period_start) opts.periodStart = req.query.period_start;
    if (req.query.period_end)   opts.periodEnd   = req.query.period_end;
    res.json(await validateBillingPeriod(opts));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Preview what monthly billing would generate — no DB writes.
// Query params: ?period_start=YYYY-MM-DD&period_end=YYYY-MM-DD (optional)
router.get('/preview', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const opts = {};
    if (req.query.period_start) opts.periodStart = req.query.period_start;
    if (req.query.period_end)   opts.periodEnd   = req.query.period_end;
    res.json(await previewMonthlyBilling(opts));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger monthly billing (admin only).
// Body: { period_start, period_end, due_days, auto_post, triggered_by } (all optional)
router.post('/run', authenticate, authorize('admin'), async (req, res) => {
  try {
    const opts = { triggeredBy: 'manual' };
    if (req.body?.period_start) opts.periodStart = req.body.period_start;
    if (req.body?.period_end)   opts.periodEnd   = req.body.period_end;
    if (req.body?.due_days  != null) opts.dueDays  = req.body.due_days;
    if (req.body?.auto_post != null) opts.autoPost = req.body.auto_post;
    res.json(await runMonthlyAutoBilling(opts));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List past billing runs with pagination and optional status filter.
router.get('/runs', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset  = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const params  = [];
    let where     = '';
    if (status) { params.push(status); where = `WHERE status=$${params.length}`; }

    const countR  = await query(`SELECT COUNT(*) FROM billing_runs ${where}`, params);
    const runsR   = await query(
      `SELECT * FROM billing_runs ${where} ORDER BY started_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit, 10), offset]
    );
    res.json({
      data:       runsR.rows,
      pagination: { total: parseInt(countR.rows[0].count), page: parseInt(page, 10), limit: parseInt(limit, 10) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single billing run with per-customer items.
router.get('/runs/:runId', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const runR   = await query('SELECT * FROM billing_runs WHERE id=$1', [req.params.runId]);
    if (!runR.rows[0]) return res.status(404).json({ error: 'Billing run not found' });
    const itemsR = await query(
      `SELECT bri.*, c.full_name AS customer_name FROM billing_run_items bri
       LEFT JOIN customers c ON c.id = bri.customer_id
       WHERE bri.run_id=$1 ORDER BY bri.created_at ASC`,
      [req.params.runId]
    );
    res.json({ run: runR.rows[0], items: itemsR.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a billing run that is 'running' or 'pending_post'.
router.post('/runs/:runId/cancel', authenticate, authorize('admin'), async (req, res) => {
  try {
    const result = await cancelBillingRun(req.params.runId, req.body?.reason, req.user.id);
    res.json(result);
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : err.message.includes('Cannot cancel') ? 409 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Post all pending_post items in a run (when auto_post_invoice was false).
router.post('/runs/:runId/post', authenticate, authorize('admin'), async (req, res) => {
  try {
    const result = await postPendingBillingRun(req.params.runId, req.user.id);
    res.json(result);
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : err.message.includes('pending_post') ? 409 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Billing Dashboard Stats ───────────────────────────────────────────────────

router.get('/stats', authenticate, authorize('admin', 'operator', 'manager', 'finance', 'billing_officer', 'viewer'), async (req, res) => {
  try {
    res.json(await getBillingDashboardStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Direct Invoice Generation ──────────────────────────────────────────────────

// Bill a single customer
router.post('/generate/customer/:id', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const result = await generateInvoiceForCustomer(req.params.id, {
      period_start:  req.body?.period_start,
      period_end:    req.body?.period_end,
      due_days:      req.body?.due_days,
      notes:         req.body?.notes,
      invoice_number: req.body?.invoice_number,
      created_by:    req.user.userId,
    });
    res.status(201).json(result);
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : err.message.includes('already exists') ? 409 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Bill all active customers in a zone
router.post('/generate/zone/:zoneId', authenticate, authorize('admin'), async (req, res) => {
  try {
    const result = await generateInvoiceForZone(req.params.zoneId, {
      period_start: req.body?.period_start,
      period_end:   req.body?.period_end,
      due_days:     req.body?.due_days,
      notes:        req.body?.notes,
      created_by:   req.user.userId,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bill a selected list of customers
// Body: { customer_ids: [uuid, ...], period_start?, period_end?, due_days?, notes? }
router.post('/generate/selected', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { customer_ids, ...opts } = req.body || {};
    if (!Array.isArray(customer_ids) || !customer_ids.length) {
      return res.status(400).json({ error: 'customer_ids array is required' });
    }
    const result = await generateInvoiceForSelected(customer_ids, { ...opts, created_by: req.user.userId });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Invoice CRUD ───────────────────────────────────────────────────────────────

router.get('/', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const { customer_id, status, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    let where    = '1=1';
    const params = [];

    if (customer_id) { params.push(customer_id); where += ` AND b.customer_id=$${params.length}`; }
    if (status)      { params.push(status);       where += ` AND b.status=$${params.length}`;      }

    const countR = await query(`SELECT COUNT(*) FROM invoices b WHERE ${where}`, params);
    const r      = await query(
      `SELECT b.*, c.full_name AS customer_name, c.house_number AS customer_number,
              COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip WHERE ip.invoice_id=b.id), 0) AS total_paid
       FROM invoices b
       LEFT JOIN customers c ON b.customer_id=c.id WHERE ${where}
       ORDER BY b.due_date DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json({ data: r.rows, pagination: { total: parseInt(countR.rows[0].count), page: parseInt(page), limit: parseInt(limit) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

router.get('/:id', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const invoiceR = await query(
      `SELECT b.*, c.full_name AS customer_name, c.house_number AS customer_number, c.email AS customer_email,
              u.full_name AS created_by_name,
              COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip WHERE ip.invoice_id=b.id), 0) AS total_paid
       FROM invoices b
       LEFT JOIN customers c ON b.customer_id=c.id
       LEFT JOIN users u ON b.created_by=u.id
       WHERE b.id=$1`,
      [req.params.id]
    );
    if (!invoiceR.rows[0]) return res.status(404).json({ error: 'Invoice not found' });
    const itemsR = await query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY line_order ASC', [req.params.id]);
    res.json({ invoice: invoiceR.rows[0], items: itemsR.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

router.get('/:id/payments', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const r = await query(
      `SELECT ip.*, u.full_name AS created_by_name
       FROM invoice_payments ip
       LEFT JOIN users u ON ip.created_by=u.id
       WHERE ip.invoice_id=$1 ORDER BY ip.payment_date ASC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

router.post('/', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const { customer_id, invoice_number, issue_date, due_date, tariff_type, line_items, notes, status = 'pending' } = req.body;
    if (!customer_id || !invoice_number || !issue_date || !due_date || !Array.isArray(line_items) || !line_items.length) {
      return res.status(400).json({ error: 'Missing invoice fields' });
    }

    const total_amount = line_items.reduce((sum, item) => sum + parseFloat(item.unit_price || 0) * parseFloat(item.quantity || 0), 0);
    const r = await query(
      `INSERT INTO invoices (customer_id,invoice_number,issue_date,due_date,tariff_type,total_amount,status,notes,created_by,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING *`,
      [customer_id, invoice_number, issue_date, due_date, tariff_type, total_amount, status, notes, req.user.id]
    );
    const invoiceId = r.rows[0].id;

    for (let i = 0; i < line_items.length; i++) {
      const item = line_items[i];
      await query(
        'INSERT INTO invoice_items (invoice_id,description,quantity,unit_price,line_order) VALUES ($1,$2,$3,$4,$5)',
        [invoiceId, item.description, item.quantity, item.unit_price, i]
      );
    }

    await query(
      'INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_values, ip_address, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [req.user.id, 'create_invoice', 'invoice', invoiceId, JSON.stringify({ customer_id, invoice_number, issue_date, due_date, tariff_type, total_amount, status, notes }), req.ip, req.headers['user-agent'] || null]
    );

    // Sync to Odoo immediately; fall back to retry queue if Odoo is unreachable
    try {
      await syncInvoiceToOdoo(invoiceId);
    } catch (syncErr) {
      logger.warn('Immediate Odoo invoice sync failed — queuing for retry', { error: syncErr.message, invoiceId });
      await enqueueOdooSync('invoice', invoiceId).catch(e => logger.warn('Odoo invoice enqueue also failed', { error: e.message }));
    }

    res.status(201).json({ invoice: r.rows[0] });
  } catch (err) {
    console.error(err);
    // Previously hardcoded "Failed to create invoice" regardless of cause —
    // inconsistent with every other route in this file (and in
    // billingReports.js), which return err.message. That masked the real
    // exception (e.g. a duplicate invoice_number hitting the UNIQUE
    // constraint) behind a generic string with no way to tell what
    // actually happened without reading the server log.
    res.status(500).json({ error: err.message || 'Failed to create invoice' });
  }
});

router.put('/:id', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const { status, due_date, notes } = req.body;
    const r = await query(
      `UPDATE invoices SET status=COALESCE($1,status), due_date=COALESCE($2,due_date), notes=COALESCE($3,notes), updated_at=NOW() WHERE id=$4 RETURNING *`,
      [status, due_date, notes, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Invoice not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

// ── Invoice PDF ───────────────────────────────────────────────────────────────
router.get('/:id/pdf', authenticate, authorize('admin', 'operator', 'manager', 'finance', 'billing_officer', 'customer_service'), async (req, res) => {
  try {
    const invoiceR = await query(
      `SELECT b.*, c.full_name AS customer_name, c.house_number AS customer_number, c.email AS customer_email,
              c.phone AS customer_phone, c.address AS customer_address, c.city AS customer_city,
              u.full_name AS created_by_name,
              COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip WHERE ip.invoice_id=b.id), 0) AS total_paid
       FROM invoices b
       LEFT JOIN customers c ON b.customer_id=c.id
       LEFT JOIN users u ON b.created_by=u.id
       WHERE b.id=$1`,
      [req.params.id]
    );
    if (!invoiceR.rows[0]) return res.status(404).json({ error: 'Invoice not found' });

    const inv      = invoiceR.rows[0];
    const itemsR   = await query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY line_order ASC', [req.params.id]);
    const paymentsR= await query(
      `SELECT ip.*, u.full_name AS by_name FROM invoice_payments ip LEFT JOIN users u ON u.id=ip.created_by WHERE ip.invoice_id=$1 ORDER BY ip.payment_date ASC`,
      [req.params.id]
    );

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    const fname = `Invoice-${inv.invoice_number}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fname}"`);
    doc.pipe(res);

    // ── Colour palette ───────────────────────────────────────────────────────
    const BRAND   = '#1e40af';  // dark blue
    const MUTED   = '#64748b';
    const BLACK   = '#0f172a';
    const WHITE   = '#ffffff';
    const LIGHT   = '#f1f5f9';
    const LINE    = '#e2e8f0';

    const fmtDate  = (d) => d ? new Date(d).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'2-digit' }) : '—';
    const fmtMoney = (v) => `$${Number(v||0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}`;

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const L = 50, R = pageW - 50;

    // ── Header band ──────────────────────────────────────────────────────────
    doc.rect(0, 0, pageW, 90).fill(BRAND);

    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(22)
       .text('NUWACO', L, 22);
    doc.fillColor('rgba(255,255,255,0.7)').font('Helvetica').fontSize(9)
       .text('National Urban Water Company', L, 47);

    // Status badge in header
    const STATUS_COLOR = { paid:'#10b981', pending:'#f59e0b', overdue:'#ef4444', cancelled:'#94a3b8' };
    const badgeColor = STATUS_COLOR[inv.status] || '#94a3b8';
    const badgeLabel = (inv.status || 'unknown').toUpperCase();
    const badgeW = 70, badgeH = 20, badgeX = R - badgeW, badgeY = 35;
    doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 10).fill(badgeColor);
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(8)
       .text(badgeLabel, badgeX, badgeY + 6, { width: badgeW, align: 'center' });

    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(16)
       .text('TAX INVOICE', R - 130, 22, { width: 130, align: 'right' });

    // ── Invoice meta grid ────────────────────────────────────────────────────
    const metaY = 110;
    const col2  = pageW / 2 + 20;

    // Left: Bill To
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5)
       .text('BILL TO', L, metaY);
    doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(11)
       .text(inv.customer_name || '—', L, metaY + 12);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
       .text(`Customer #: ${inv.customer_number || '—'}`, L, metaY + 26)
       .text(inv.customer_email || '', L, metaY + 38)
       .text(inv.customer_phone || '', L, metaY + 50)
       .text([inv.customer_address, inv.customer_city].filter(Boolean).join(', '), L, metaY + 62, { width: 220 });

    // Right: Invoice details
    const detailRows = [
      ['Invoice Number', inv.invoice_number],
      ['Issue Date',     fmtDate(inv.issue_date)],
      ['Due Date',       fmtDate(inv.due_date)],
      ['Tariff Type',    inv.tariff_type ? inv.tariff_type.charAt(0).toUpperCase() + inv.tariff_type.slice(1) : '—'],
    ];
    let dy = metaY;
    for (const [label, val] of detailRows) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(label, col2, dy, { width: 110 });
      doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(8.5).text(String(val), col2 + 115, dy, { width: 120, align: 'right' });
      dy += 16;
    }
    if (inv.odoo_id) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(8).text('Odoo ID', col2, dy, { width: 110 });
      doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(String(inv.odoo_id), col2 + 115, dy, { width: 120, align: 'right' });
    }

    // ── Divider ──────────────────────────────────────────────────────────────
    const tableY = metaY + 100;
    doc.moveTo(L, tableY - 10).lineTo(R, tableY - 10).strokeColor(LINE).lineWidth(1).stroke();

    // ── Line items table ──────────────────────────────────────────────────────
    const colDesc   = L;
    const colQty    = R - 220;
    const colUnit   = R - 150;
    const colTotal  = R - 60;

    // Table header
    doc.rect(L, tableY, R - L, 20).fill(LIGHT);
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5)
       .text('DESCRIPTION',  colDesc  + 4,  tableY + 6)
       .text('QTY',          colQty,         tableY + 6, { width: 50, align: 'right' })
       .text('UNIT PRICE',   colUnit  - 10,  tableY + 6, { width: 70, align: 'right' })
       .text('AMOUNT',       colTotal - 10,  tableY + 6, { width: 70, align: 'right' });

    let rowY = tableY + 20;
    const items = itemsR.rows;
    let subtotal = 0;

    for (const item of items) {
      const lineTotal = parseFloat(item.quantity || 0) * parseFloat(item.unit_price || 0);
      subtotal += lineTotal;
      const descLines = doc.heightOfString(item.description || '', { width: colQty - colDesc - 10 });
      const rowH = Math.max(20, descLines + 10);

      if (rowY + rowH > pageH - 160) {
        doc.addPage();
        rowY = 50;
      }

      doc.fillColor(BLACK).font('Helvetica').fontSize(9)
         .text(item.description || '', colDesc + 4, rowY + 5, { width: colQty - colDesc - 10 })
         .text(String(Number(item.quantity || 0).toFixed(2)), colQty, rowY + 5, { width: 50, align: 'right' })
         .text(fmtMoney(item.unit_price), colUnit - 10, rowY + 5, { width: 70, align: 'right' })
         .text(fmtMoney(lineTotal), colTotal - 10, rowY + 5, { width: 70, align: 'right' });

      rowY += rowH;
      doc.moveTo(L, rowY).lineTo(R, rowY).strokeColor(LINE).lineWidth(0.5).stroke();
    }

    if (!items.length) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(9)
         .text('No line items', colDesc + 4, rowY + 5);
      rowY += 20;
    }

    // ── Totals box ────────────────────────────────────────────────────────────
    rowY += 10;
    const totalsX = R - 220;
    const totalsW = 220;
    const totalPaid    = parseFloat(inv.total_paid || 0);
    const balanceDue   = parseFloat(inv.total_amount || 0) - totalPaid;

    const totLines = [
      ['Subtotal',     fmtMoney(inv.total_amount)],
      ['Amount Paid',  fmtMoney(totalPaid)],
    ];

    doc.rect(totalsX, rowY, totalsW, 16 * totLines.length + 32).fill(LIGHT);

    let ty = rowY + 8;
    for (const [label, val] of totLines) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(label, totalsX + 10, ty, { width: 110 });
      doc.fillColor(BLACK).font('Helvetica').fontSize(8.5).text(val, totalsX + 120, ty, { width: 90, align: 'right' });
      ty += 16;
    }
    // Balance Due (bold, larger)
    doc.rect(totalsX, ty, totalsW, 28).fill(BRAND);
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(9).text('BALANCE DUE', totalsX + 10, ty + 9, { width: 110 });
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(11).text(fmtMoney(balanceDue), totalsX + 120, ty + 8, { width: 90, align: 'right' });
    ty += 28;

    // ── Payment history ───────────────────────────────────────────────────────
    const payments = paymentsR.rows;
    if (payments.length) {
      ty += 16;
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5).text('PAYMENT HISTORY', L, ty);
      ty += 12;

      doc.rect(L, ty, R - L, 16).fill(LIGHT);
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5)
         .text('DATE',       L + 4,       ty + 4)
         .text('METHOD',     L + 100,     ty + 4)
         .text('REFERENCE',  L + 180,     ty + 4)
         .text('AMOUNT',     R - 80,      ty + 4, { width: 80, align: 'right' });
      ty += 16;

      for (const p of payments) {
        doc.fillColor(BLACK).font('Helvetica').fontSize(8.5)
           .text(fmtDate(p.payment_date), L + 4,   ty)
           .text(p.method || '—',          L + 100, ty)
           .text(p.reference || '—',       L + 180, ty, { width: 120 })
           .text(fmtMoney(p.amount),       R - 80,  ty, { width: 80, align: 'right' });
        ty += 14;
        doc.moveTo(L, ty).lineTo(R, ty).strokeColor(LINE).lineWidth(0.5).stroke();
      }
    }

    // ── Notes ──────────────────────────────────────────────────────────────────
    if (inv.notes) {
      ty += 16;
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5).text('NOTES', L, ty);
      ty += 10;
      doc.fillColor(BLACK).font('Helvetica').fontSize(8.5).text(inv.notes, L, ty, { width: R - L });
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    const footY = pageH - 45;
    doc.moveTo(L, footY).lineTo(R, footY).strokeColor(LINE).lineWidth(1).stroke();
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
       .text(`Generated by NUWACO WMS · ${new Date().toUTCString()}`, L, footY + 8, { width: R - L, align: 'center' });
    if (inv.created_by_name) {
      doc.text(`Issued by: ${inv.created_by_name}`, L, footY + 20, { width: R - L, align: 'center' });
    }

    doc.end();
  } catch (err) {
    console.error('PDF generation error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

router.post('/:id/payment', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const { amount, method, reference, note } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Payment amount must be positive' });
    const payment = await recordPayment(req.params.id, amount, method || 'cash', reference, note, req.user.id);
    res.json(payment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to record payment' });
  }
});

module.exports = router;
