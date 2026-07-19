const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { adapters, verifySignature, getGatewaySecret, processPayment } = require('../services/paymentGatewayService');
const { linkSahalCallbackToSession } = require('../services/sahalApiService');
const { linkEvcCallbackToSession }   = require('../services/evcApiService');

const FINANCIAL_ROLES = ['admin', 'manager', 'finance', 'billing_officer', 'viewer'];
const { getReceiptData, formatReceiptText, formatReceiptHTML } = require('../services/receiptService');
const logger = require('../services/logger');

// ── Gateway callback helper ───────────────────────────────────────────────────
// Always returns 200 to prevent gateway retries. Errors are logged to the
// payment_transactions table with status='failed'.

async function handleCallback(req, res, gateway) {
  try {
    const body = req.body;
    const signature = req.headers['x-signature'] || req.headers['x-hash'] || req.headers['x-hmac'] || '';

    // Signature verification
    const secret = await getGatewaySecret(gateway);
    if (!verifySignature(body, signature, secret)) {
      logger.warn(`${gateway} callback: invalid signature`, { ip: req.ip });
      return res.status(200).json({ status: 'rejected', message: 'Invalid signature' });
    }

    // Normalize body using gateway adapter
    const adapter = adapters[gateway];
    if (!adapter) return res.status(200).json({ status: 'error', message: 'Unknown gateway' });

    const normalized = adapter(body);

    if (!normalized.transaction_ref) {
      logger.warn(`${gateway} callback: missing transaction_ref`, { body });
      return res.status(200).json({ status: 'error', message: 'Missing transaction reference' });
    }
    if (!normalized.house_number) {
      logger.warn(`${gateway} callback: missing house_number`, { body });
      return res.status(200).json({ status: 'error', message: 'Missing account reference (house number)' });
    }
    if (!normalized.amount || normalized.amount <= 0) {
      return res.status(200).json({ status: 'error', message: 'Invalid amount' });
    }

    const result = await processPayment({
      ...normalized,
      gateway,
      gateway_response: body,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'] || null,
    });

    if (result.duplicate) {
      return res.status(200).json({ status: 'duplicate', message: 'Already processed', receipt: result.transaction?.receipt_number });
    }

    if (result.success && result.status === 'completed') {
      logger.info(`${gateway} payment processed: ${normalized.house_number} $${normalized.amount} → ${result.receipt_number}`);

      // Link to any pending portal payment_session (non-fatal)
      try {
        const sessionRef = body.reference || body.receiverRef || body.merchantRef || null;
        if (gateway === 'sahal') {
          await linkSahalCallbackToSession({
            sessionRef,
            transactionId: normalized.transaction_ref,
            receiptNumber: result.receipt_number,
            transactionDbId: result.transaction?.id,
          });
        } else if (gateway === 'evc') {
          await linkEvcCallbackToSession({
            sessionRef,
            transactionId: normalized.transaction_ref,
            receiptNumber: result.receipt_number,
            transactionDbId: result.transaction?.id,
          });
        }
      } catch (linkErr) {
        logger.warn(`${gateway} callback session link failed`, { error: linkErr.message });
      }

      return res.status(200).json({
        status: 'success',
        receipt:  result.receipt_number,
        message:  `Payment of $${normalized.amount} applied. Receipt: ${result.receipt_number}`,
      });
    }

    if (result.status === 'no_invoice') {
      logger.info(`${gateway} payment received but no invoice: ${normalized.house_number} $${normalized.amount}`);
      return res.status(200).json({ status: 'no_invoice', message: 'Payment received — no pending invoice found' });
    }

    return res.status(200).json({ status: 'failed', message: result.error || 'Processing failed' });

  } catch (err) {
    logger.error(`${gateway} callback error`, { error: err.message, body: req.body });
    return res.status(200).json({ status: 'error', message: 'Internal error — payment queued for review' });
  }
}

// ── Sahal callback ────────────────────────────────────────────────────────────
router.post('/callback/sahal', (req, res) => handleCallback(req, res, 'sahal'));

// ── EVC Plus callback ─────────────────────────────────────────────────────────
router.post('/callback/evc',   (req, res) => handleCallback(req, res, 'evc'));

const VALID_MANUAL_GATEWAYS = ['cash', 'sahal', 'evc', 'bank', 'pos', 'cheque', 'adjustment', 'other'];

const GATEWAY_STATUS_MAP = {
  cash:       'CASH',
  sahal:      'SAHAL_MANUAL',
  evc:        'EVC_MANUAL',
  bank:       'BANK_TRANSFER',
  pos:        'POS_CARD',
  cheque:     'CHEQUE',
  adjustment: 'ADJUSTMENT',
  other:      'MANUAL',
};

// ── Manual payment — authenticated ───────────────────────────────────────────
router.post('/manual', authenticate, authorize('admin', 'operator', 'manager', 'finance', 'billing_officer'), async (req, res) => {
  try {
    const {
      house_number, amount, gateway = 'cash',
      notes, phone_number, currency = 'USD',
      payment_meta,
    } = req.body;

    if (!house_number?.trim()) return res.status(400).json({ error: 'house_number is required' });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'amount must be > 0' });
    if (!VALID_MANUAL_GATEWAYS.includes(gateway)) {
      return res.status(400).json({ error: `gateway must be one of: ${VALID_MANUAL_GATEWAYS.join(', ')}` });
    }

    // Adjustment requires admin or finance
    if (gateway === 'adjustment' && !['admin', 'finance'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Adjustment payments require admin or finance role.' });
    }

    // Build transaction_ref from method-specific meta fields
    let transaction_ref;
    if (payment_meta?.transaction_id?.trim()) {
      transaction_ref = payment_meta.transaction_id.trim();
    } else if (payment_meta?.transfer_reference?.trim()) {
      transaction_ref = payment_meta.transfer_reference.trim();
    } else if (payment_meta?.cheque_number?.trim()) {
      transaction_ref = `CHQ-${payment_meta.cheque_number.trim()}`;
    } else if (payment_meta?.approval_code?.trim()) {
      transaction_ref = `POS-${payment_meta.approval_code.trim()}`;
    }
    if (!transaction_ref) {
      transaction_ref = `${gateway.toUpperCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    }

    const result = await processPayment({
      transaction_ref,
      house_number: String(house_number).trim(),
      amount: Number(amount),
      currency,
      gateway,
      gateway_status: GATEWAY_STATUS_MAP[gateway] || 'MANUAL',
      gateway_response: req.body,
      phone_number: phone_number || payment_meta?.phone_number || null,
      notes: notes || null,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'] || null,
      created_by: req.user?.id || null,
      payment_meta: payment_meta || null,
    });

    if (result.duplicate) {
      return res.status(409).json({ error: 'Duplicate reference number — payment already recorded' });
    }
    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Payment failed' });
    }

    return res.status(201).json({
      transaction:      result.transaction,
      receipt_number:   result.receipt_number,
      applied_invoices: result.applied_invoices,
      remaining_credit: result.remaining_credit,
      customer:         result.customer,
    });
  } catch (err) {
    logger.error('Manual payment error', { error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'Duplicate transaction reference' });
    res.status(500).json({ error: 'Failed to process payment' });
  }
});

// ── GET /payments/stats — dashboard payment stats ─────────────────────────────
router.get('/stats', authenticate, authorize(...FINANCIAL_ROLES), async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    const [todayR, monthlyR, failedR, pendingR, avgPaymentR] = await Promise.all([
      // Today's completed payments
      query(`
        SELECT COUNT(*)::INT AS count, COALESCE(SUM(amount),0) AS revenue
        FROM payment_transactions
        WHERE status='completed' AND DATE(created_at)=$1
      `, [today]),

      // This month's completed payments
      query(`
        SELECT COUNT(*)::INT AS count, COALESCE(SUM(amount),0) AS revenue
        FROM payment_transactions
        WHERE status='completed'
          AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)
      `),

      // Failed payments today
      query(`
        SELECT COUNT(*)::INT AS count
        FROM payment_transactions
        WHERE status='failed' AND DATE(created_at)=$1
      `, [today]),

      // Pending / no_invoice transactions
      query(`
        SELECT COUNT(*)::INT AS count
        FROM payment_transactions
        WHERE status IN ('pending','processing','no_invoice')
      `),

      // Average payment amount this month
      query(`
        SELECT COALESCE(AVG(amount),0) AS avg_payment
        FROM payment_transactions
        WHERE status='completed'
          AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)
      `),
    ]);

    // Collection rate: this month paid / this month invoiced
    const invoicedMonthR = await query(`
      SELECT COALESCE(SUM(total_amount),0) AS invoiced
      FROM invoices
      WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)
        AND status != 'cancelled'
    `);
    const invoicedMonth = Number(invoicedMonthR.rows[0]?.invoiced || 0);
    const paidMonth = Number(monthlyR.rows[0]?.revenue || 0);
    const collectionRate = invoicedMonth > 0 ? +((paidMonth / invoicedMonth) * 100).toFixed(1) : 0;

    res.json({
      today_count:     todayR.rows[0].count,
      today_revenue:   Number(todayR.rows[0].revenue),
      monthly_count:   monthlyR.rows[0].count,
      monthly_revenue: Number(monthlyR.rows[0].revenue),
      collection_rate: collectionRate,
      failed_today:    failedR.rows[0].count,
      pending_count:   pendingR.rows[0].count,
      avg_payment:     Number(Number(avgPaymentR.rows[0].avg_payment).toFixed(2)),
    });
  } catch (err) {
    logger.error('Payment stats error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch payment stats' });
  }
});

// ── GET /payments — list transactions ────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const {
      search, gateway, status, date_from, date_to,
      page = 1, limit = 50
    } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = [];

    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      conditions.push(`(pt.house_number ILIKE $${n} OR pt.transaction_ref ILIKE $${n} OR pt.receipt_number ILIKE $${n} OR c.full_name ILIKE $${n})`);
    }
    if (gateway) { params.push(gateway); conditions.push(`pt.gateway=$${params.length}`); }
    if (status)  { params.push(status);  conditions.push(`pt.status=$${params.length}`); }
    if (date_from) { params.push(date_from); conditions.push(`DATE(pt.created_at) >= $${params.length}`); }
    if (date_to)   { params.push(date_to);   conditions.push(`DATE(pt.created_at) <= $${params.length}`); }

    const where = conditions.length ? conditions.join(' AND ') : 'TRUE';

    const [rows, countR] = await Promise.all([
      query(`
        SELECT
          pt.*,
          c.full_name,
          z.zone_code
        FROM payment_transactions pt
        LEFT JOIN customers c ON c.id = pt.customer_id
        LEFT JOIN zones z     ON z.id = c.zone_id
        WHERE ${where}
        ORDER BY pt.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `, [...params, limit, offset]),
      query(`SELECT COUNT(*) FROM payment_transactions pt LEFT JOIN customers c ON c.id=pt.customer_id WHERE ${where}`, params),
    ]);

    res.json({
      data:  rows.rows,
      total: parseInt(countR.rows[0].count, 10),
      page:  parseInt(page, 10),
      limit: parseInt(limit, 10),
    });
  } catch (err) {
    logger.error('GET /payments error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// ── GET /payments/:id — single transaction ────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const data = await getReceiptData(req.params.id);
    if (!data) return res.status(404).json({ error: 'Transaction not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch transaction' });
  }
});

// ── GET /payments/:id/receipt — JSON receipt ──────────────────────────────────
router.get('/:id/receipt', authenticate, async (req, res) => {
  try {
    const data = await getReceiptData(req.params.id);
    if (!data) return res.status(404).json({ error: 'Transaction not found' });
    const text = formatReceiptText(data);
    res.json({ ...data, receipt_text: text });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate receipt' });
  }
});

// ── GET /payments/:id/receipt.html — printable HTML receipt ──────────────────
router.get('/:id/receipt.html', authenticate, async (req, res) => {
  try {
    const data = await getReceiptData(req.params.id);
    if (!data) return res.status(404).send('<p>Transaction not found</p>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(formatReceiptHTML(data));
  } catch (err) {
    res.status(500).send('<p>Failed to generate receipt</p>');
  }
});

module.exports = router;
