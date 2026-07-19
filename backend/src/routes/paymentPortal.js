const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { query } = require('../config/database');
const {
  providers,
  createCheckoutSession,
  getSession,
  confirmSessionPayment,
  processStripeWebhook,
} = require('../services/checkoutService');
const { getReceiptData, formatReceiptHTML } = require('../services/receiptService');
const { authenticate, authorize } = require('../middleware/auth');
const logger = require('../services/logger');

const portalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: { error: 'Too many requests — please try again shortly' },
});

// ── GET /api/portal/providers — available payment providers ───────────────────
router.get('/providers', (req, res) => {
  const available = Object.entries(providers)
    .filter(([, p]) => p.available())
    .map(([key, p]) => ({ value: key, label: p.label }));
  res.json(available);
});

// ── GET /api/portal/lookup?house_number=XX — find customer ───────────────────
router.get('/lookup', portalLimiter, async (req, res) => {
  try {
    const hn = String(req.query.house_number || '').trim();
    if (!hn) return res.status(400).json({ error: 'house_number is required' });

    const r = await query(`
      SELECT
        c.id, c.full_name, c.house_number,
        z.zone_code, z.zone_name,
        COUNT(i.id) FILTER (WHERE i.status IN ('pending','overdue'))::INT AS pending_count,
        COALESCE(SUM(i.total_amount) FILTER (WHERE i.status IN ('pending','overdue')), 0) AS outstanding
      FROM customers c
      LEFT JOIN zones z    ON z.id = c.zone_id
      LEFT JOIN invoices i ON i.customer_id = c.id
      WHERE c.house_number=$1 AND c.account_status='active'
      GROUP BY c.id, c.full_name, c.house_number, z.zone_code, z.zone_name
    `, [hn]);

    if (!r.rows[0]) {
      return res.status(404).json({ error: 'No active customer found with this house number' });
    }

    const c = r.rows[0];
    res.json({
      id:               c.id,
      full_name:        c.full_name,
      house_number:     c.house_number,
      zone:             c.zone_code ? `${c.zone_code} - ${c.zone_name}` : null,
      pending_count:    c.pending_count,
      outstanding:      Number(c.outstanding),
    });
  } catch (err) {
    logger.error('Portal lookup error', { error: err.message });
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// ── GET /api/portal/invoices/:customerId — outstanding invoices ───────────────
router.get('/invoices/:customerId', portalLimiter, async (req, res) => {
  try {
    const r = await query(`
      SELECT
        i.id, i.invoice_number, i.issue_date, i.due_date,
        i.total_amount, i.status,
        COALESCE(SUM(ip.amount), 0) AS paid_amount
      FROM invoices i
      LEFT JOIN invoice_payments ip ON ip.invoice_id = i.id
      WHERE i.customer_id=$1 AND i.status IN ('pending','overdue')
      GROUP BY i.id
      ORDER BY i.issue_date ASC
    `, [req.params.customerId]);

    res.json(r.rows.map(inv => ({
      id:             inv.id,
      invoice_number: inv.invoice_number,
      issue_date:     inv.issue_date,
      due_date:       inv.due_date,
      total_amount:   Number(inv.total_amount),
      paid_amount:    Number(inv.paid_amount),
      outstanding:    Math.max(0, Number(inv.total_amount) - Number(inv.paid_amount)),
      status:         inv.status,
    })));
  } catch (err) {
    logger.error('Portal invoices error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// ── POST /api/portal/checkout — create payment session ───────────────────────
router.post('/checkout', portalLimiter, async (req, res) => {
  try {
    const { customer_id, invoice_id, provider } = req.body;
    if (!customer_id) return res.status(400).json({ error: 'customer_id is required' });
    if (!provider)    return res.status(400).json({ error: 'provider is required' });

    const { phone_number } = req.body;
    if (['sahal', 'evc'].includes(provider) && !phone_number?.trim()) {
      return res.status(400).json({ error: 'phone_number is required for Sahal/EVC payments' });
    }

    const result = await createCheckoutSession({
      customerId:  customer_id,
      invoiceId:   invoice_id || null,
      provider,
      phone:       phone_number?.trim() || null,
      ipAddress:   req.ip,
      userAgent:   req.headers['user-agent'],
    });

    res.status(201).json({
      session_id:   result.sessionId,
      checkout_url: result.checkoutUrl,
      amount:       result.amount,
    });
  } catch (err) {
    logger.error('Portal checkout error', { error: err.message });
    if (err.message.includes('not configured') || err.message.includes('not payable') || err.message.includes('not found')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ── GET /api/portal/session/:id — get session status ─────────────────────────
router.get('/session/:id', portalLimiter, async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  } catch (err) {
    logger.error('Portal session get error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

// ── POST /api/portal/session/:id/confirm — confirm simulation / bank payment ──
router.post('/session/:id/confirm', portalLimiter, async (req, res) => {
  try {
    const result = await confirmSessionPayment(req.params.id, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json({
      success:          true,
      receipt_number:   result.receipt_number,
      applied_invoices: result.applied_invoices,
    });
  } catch (err) {
    logger.error('Portal confirm error', { error: err.message });
    res.status(500).json({ error: 'Payment confirmation failed' });
  }
});

// ── GET /api/portal/receipt/:receiptNumber — public printable receipt ─────────
// Accessible by receipt number (non-sequential UUID-derived) without auth,
// so customers can print/share their own receipt.
router.get('/receipt/:receiptNumber', async (req, res) => {
  try {
    const r = await query(
      'SELECT id FROM payment_transactions WHERE receipt_number=$1',
      [req.params.receiptNumber]
    );
    if (!r.rows[0]) return res.status(404).send('<p>Receipt not found</p>');
    const data = await getReceiptData(r.rows[0].id);
    if (!data) return res.status(404).send('<p>Receipt not found</p>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(formatReceiptHTML(data));
  } catch (err) {
    logger.error('Portal receipt error', { error: err.message });
    res.status(500).send('<p>Failed to load receipt</p>');
  }
});

// ── Admin: GET /api/portal/sessions — list all sessions ──────────────────────
router.get('/sessions', authenticate, authorize('admin', 'manager', 'finance'), async (req, res) => {
  try {
    const { page = 1, limit = 50, status, provider } = req.query;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const params = [];
    const conditions = [];
    if (status)   { params.push(status);   conditions.push(`ps.status=$${params.length}`); }
    if (provider) { params.push(provider); conditions.push(`ps.provider=$${params.length}`); }
    const where = conditions.length ? conditions.join(' AND ') : 'TRUE';

    const [rows, countR] = await Promise.all([
      query(`
        SELECT
          ps.id, ps.status, ps.provider, ps.amount, ps.currency,
          ps.expires_at, ps.completed_at, ps.payment_reference, ps.created_at,
          c.full_name, c.house_number,
          i.invoice_number,
          pt.receipt_number
        FROM payment_sessions ps
        JOIN customers c ON c.id = ps.customer_id
        LEFT JOIN invoices i ON i.id = ps.invoice_id
        LEFT JOIN payment_transactions pt ON pt.id = ps.payment_transaction_id
        WHERE ${where}
        ORDER BY ps.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `, [...params, parseInt(limit, 10), offset]),
      query(`SELECT COUNT(*) FROM payment_sessions ps WHERE ${where}`, params),
    ]);

    res.json({
      data:  rows.rows,
      total: parseInt(countR.rows[0].count, 10),
      page:  parseInt(page, 10),
    });
  } catch (err) {
    logger.error('Admin sessions list error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// ── Stripe webhook — exported separately for raw-body mounting ────────────────
// Mounted in index.js BEFORE express.json() to preserve raw body
const stripeWebhookHandler = async (req, res) => {
  try {
    const result = await processStripeWebhook(req.body, req.headers);
    if (!result.success && result.error === 'Invalid webhook signature') {
      return res.status(400).json({ error: result.error });
    }
    res.json({ received: true, message: result.message });
  } catch (err) {
    logger.error('Stripe webhook handler error', { error: err.message });
    res.status(500).json({ error: 'Webhook processing failed' });
  }
};

module.exports = { router, stripeWebhookHandler };
