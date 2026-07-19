const crypto = require('crypto');
const axios = require('axios');
const { query, getClient } = require('../config/database');
const { processPayment } = require('./paymentGatewayService');
const { initiateSahalPayment } = require('./sahalApiService');
const { initiateEvcPayment } = require('./evcApiService');
const logger = require('./logger');

// ── Payment provider implementations ─────────────────────────────────────────

const providers = {
  simulation: {
    label: 'Test / Simulation',
    available: () => true,
    async createCheckout({ sessionId, frontendUrl }) {
      return {
        checkoutUrl: `${frontendUrl}/pay/session/${sessionId}`,
        providerSessionId: `SIM-${sessionId.substring(0, 8).toUpperCase()}`,
      };
    },
  },

  bank_transfer: {
    label: 'Bank Transfer',
    available: () => true,
    async createCheckout({ sessionId, frontendUrl }) {
      return {
        checkoutUrl: `${frontendUrl}/pay/session/${sessionId}`,
        providerSessionId: `BANK-${sessionId.substring(0, 8).toUpperCase()}`,
      };
    },
  },

  stripe: {
    label: 'Card / Apple Pay / Google Pay (Stripe)',
    available: () => !!process.env.STRIPE_SECRET_KEY,
    async createCheckout({ sessionId, amount, currency, invoiceNumber, frontendUrl, customer }) {
      if (!process.env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
      const params = new URLSearchParams();
      params.append('payment_method_types[]', 'card');
      params.append('line_items[0][price_data][currency]', (currency || 'usd').toLowerCase());
      params.append('line_items[0][price_data][unit_amount]', Math.round(amount * 100));
      params.append('line_items[0][price_data][product_data][name]', `Water Bill — ${invoiceNumber || 'Invoice'}`);
      params.append('line_items[0][quantity]', '1');
      params.append('mode', 'payment');
      params.append('success_url', `${frontendUrl}/pay/session/${sessionId}?stripe_status=success`);
      params.append('cancel_url', `${frontendUrl}/pay/session/${sessionId}?stripe_status=cancelled`);
      params.append('metadata[session_id]', sessionId);
      if (customer?.email) params.append('customer_email', customer.email);
      const res = await axios.post(
        'https://api.stripe.com/v1/checkout/sessions',
        params.toString(),
        {
          auth: { username: process.env.STRIPE_SECRET_KEY, password: '' },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }
      );
      return { checkoutUrl: res.data.url, providerSessionId: res.data.id };
    },
  },

  paypal: {
    label: 'PayPal',
    available: () => !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
    async createCheckout() {
      throw new Error('PayPal is not yet configured (PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET missing)');
    },
  },

  sahal: {
    label: 'Sahal (Mobile Money)',
    available: () => true, // always listed; simulation mode when unconfigured
    async createCheckout({ sessionId, amount, currency, frontendUrl, customer, phone }) {
      if (!phone) throw new Error('Phone number is required for Sahal payment');
      const result = await initiateSahalPayment({
        phone, amount, currency, sessionId,
        houseNumber: customer.house_number,
      });
      return {
        checkoutUrl:       `${frontendUrl}/pay/session/${sessionId}`,
        providerSessionId: result.sahal_ref,
        metadata:          { sahal_session_ref: result.session_ref, sahal_mode: result.mode, phone },
      };
    },
  },

  evc: {
    label: 'EVC Plus (Mobile Money)',
    available: () => true,
    async createCheckout({ sessionId, amount, currency, frontendUrl, customer, phone }) {
      if (!phone) throw new Error('Phone number is required for EVC Plus payment');
      const result = await initiateEvcPayment({
        phone, amount, currency, sessionId,
        houseNumber: customer.house_number,
      });
      return {
        checkoutUrl:       `${frontendUrl}/pay/session/${sessionId}`,
        providerSessionId: result.evc_ref,
        metadata:          { evc_session_ref: result.session_ref, evc_mode: result.mode, phone },
      };
    },
  },
};

// ── Create checkout session ────────────────────────────────────────────────────

const createCheckoutSession = async ({ customerId, invoiceId, provider, amount, currency = 'USD', phone, ipAddress, userAgent }) => {
  if (!providers[provider]) throw new Error(`Unknown provider: ${provider}`);
  if (!providers[provider].available()) throw new Error(`Provider "${provider}" is not configured`);

  // Fetch customer (limited fields — portal is public)
  const custR = await query(
    'SELECT id, full_name, house_number, email FROM customers WHERE id=$1 AND account_status=\'active\'',
    [customerId]
  );
  if (!custR.rows[0]) throw new Error('Customer not found or inactive');
  const customer = custR.rows[0];

  // Resolve invoice
  let invoiceNumber = null;
  if (invoiceId) {
    const invR = await query(`
      SELECT i.id, i.invoice_number, i.total_amount, i.status,
             COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip WHERE ip.invoice_id=i.id), 0) AS paid_amount
      FROM invoices i
      WHERE i.id=$1 AND i.customer_id=$2
    `, [invoiceId, customerId]);
    if (!invR.rows[0]) throw new Error('Invoice not found');
    if (!['pending', 'overdue'].includes(invR.rows[0].status)) throw new Error('Invoice is not payable');
    invoiceNumber = invR.rows[0].invoice_number;
    amount = Math.max(0.01, Number(invR.rows[0].total_amount) - Number(invR.rows[0].paid_amount));
  }

  // When no specific invoice selected, compute total outstanding across all pending/overdue invoices
  if (!invoiceId && (!amount || amount <= 0)) {
    const balR = await query(`
      SELECT COALESCE(SUM(i.total_amount - COALESCE(paid.paid_amount, 0)), 0) AS outstanding
      FROM invoices i
      LEFT JOIN (
        SELECT invoice_id, SUM(amount) AS paid_amount
        FROM invoice_payments
        GROUP BY invoice_id
      ) paid ON paid.invoice_id = i.id
      WHERE i.customer_id = $1 AND i.status IN ('pending', 'overdue')
    `, [customerId]);
    amount = Number(balR.rows[0]?.outstanding || 0);
  }

  if (!amount || amount <= 0) throw new Error('No outstanding balance or invalid amount');

  // Insert pending session
  const sessionR = await query(`
    INSERT INTO payment_sessions
      (customer_id, invoice_id, provider, amount, currency, phone_number, ip_address, user_agent)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `, [customerId, invoiceId || null, provider, amount, currency, phone || null, ipAddress || null, userAgent || null]);
  const sessionId = sessionR.rows[0].id;

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const providerResult = await providers[provider].createCheckout({
    sessionId, amount, currency, invoiceNumber, frontendUrl, customer,
    phone: phone || null,
  });

  await query(`
    UPDATE payment_sessions
    SET checkout_url=$1, provider_session_id=$2,
        return_url=$3, cancel_url=$4,
        initiated_at=NOW(), updated_at=NOW(),
        metadata=COALESCE(metadata,'{}')::jsonb || $5::jsonb
    WHERE id=$6
  `, [
    providerResult.checkoutUrl,
    providerResult.providerSessionId || null,
    `${frontendUrl}/pay/session/${sessionId}?status=success`,
    `${frontendUrl}/pay/session/${sessionId}?status=cancelled`,
    JSON.stringify(providerResult.metadata || {}),
    sessionId,
  ]);

  return { sessionId, checkoutUrl: providerResult.checkoutUrl, amount };
};

// ── Get session (public — limited fields) ─────────────────────────────────────

const getSession = async (sessionId) => {
  const r = await query(`
    SELECT
      ps.id, ps.status, ps.provider, ps.amount, ps.currency,
      ps.checkout_url, ps.expires_at, ps.completed_at, ps.payment_reference,
      ps.phone_number, ps.metadata,
      c.full_name, c.house_number,
      i.invoice_number, i.issue_date, i.due_date, i.total_amount AS invoice_total,
      pt.receipt_number
    FROM payment_sessions ps
    JOIN customers c ON c.id = ps.customer_id
    LEFT JOIN invoices i ON i.id = ps.invoice_id
    LEFT JOIN payment_transactions pt ON pt.id = ps.payment_transaction_id
    WHERE ps.id = $1
  `, [sessionId]);
  return r.rows[0] || null;
};

// ── Confirm simulation / bank_transfer payment ────────────────────────────────

const confirmSessionPayment = async (sessionId, { ipAddress, userAgent } = {}) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const sessR = await client.query(
      `SELECT * FROM payment_sessions WHERE id=$1 AND status='pending' FOR UPDATE`,
      [sessionId]
    );
    if (!sessR.rows[0]) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Session not found or already processed' };
    }
    const session = sessR.rows[0];

    // simulation and bank_transfer use this endpoint always.
    // sahal and evc use it only when in simulation mode (metadata.sahal_mode='simulation')
    const isMobileMoney = ['sahal', 'evc'].includes(session.provider);
    const isSimMode = isMobileMoney && (session.metadata?.sahal_mode === 'simulation' || session.metadata?.evc_mode === 'simulation');
    const confirmable = ['simulation', 'bank_transfer'].includes(session.provider) || isSimMode;
    if (!confirmable) {
      await client.query('ROLLBACK');
      return { success: false, error: `Provider "${session.provider}" awaits callback confirmation — cannot confirm manually` };
    }

    if (new Date(session.expires_at) < new Date()) {
      await client.query(
        `UPDATE payment_sessions SET status='expired', updated_at=NOW() WHERE id=$1`,
        [sessionId]
      );
      await client.query('COMMIT');
      return { success: false, error: 'Payment session has expired' };
    }

    await client.query(
      `UPDATE payment_sessions SET status='processing', updated_at=NOW() WHERE id=$1`,
      [sessionId]
    );
    await client.query('COMMIT');
    client.release();

    // Resolve house_number
    const custR = await query('SELECT house_number FROM customers WHERE id=$1', [session.customer_id]);
    if (!custR.rows[0]) return { success: false, error: 'Customer not found' };
    const houseNumber = custR.rows[0].house_number;

    // Map provider to a valid gateway column value
    const gwMap = { bank_transfer: 'bank', sahal: 'sahal', evc: 'evc', simulation: 'other' };
    const gsMap = { bank_transfer: 'BANK_TRANSFER', sahal: 'SAHAL_MANUAL', evc: 'EVC_MANUAL', simulation: 'ONLINE_SIMULATION' };
    const gateway = gwMap[session.provider] || 'other';
    const gatewayStatus = gsMap[session.provider] || 'ONLINE_SIMULATION';
    const transRef = `ONLINE-${session.provider.toUpperCase()}-${sessionId.substring(0, 8).toUpperCase()}`;

    const result = await processPayment({
      transaction_ref: transRef,
      gateway,
      house_number: houseNumber,
      amount: Number(session.amount),
      currency: session.currency,
      gateway_status: gatewayStatus,
      gateway_response: { session_id: sessionId, provider: session.provider },
      notes: `Online payment via ${session.provider}${session.invoice_id ? `. Invoice session linked.` : ''}`,
      ip_address: ipAddress,
      user_agent: userAgent,
      payment_meta: { session_id: sessionId, provider: session.provider, online: true },
    });

    if (!result.success) {
      await query(
        `UPDATE payment_sessions SET status='failed', updated_at=NOW() WHERE id=$1`,
        [sessionId]
      );
      return { success: false, error: result.error || 'Payment processing failed' };
    }

    await query(`
      UPDATE payment_sessions
      SET status='completed', payment_transaction_id=$1,
          payment_reference=$2, completed_at=NOW(), updated_at=NOW()
      WHERE id=$3
    `, [result.transaction.id, result.receipt_number, sessionId]);

    return {
      success: true,
      receipt_number: result.receipt_number,
      applied_invoices: result.applied_invoices,
    };

  } catch (err) {
    try { client.release(); } catch {}
    logger.error('confirmSessionPayment failed', { error: err.message, sessionId });
    await query(
      `UPDATE payment_sessions SET status='failed', updated_at=NOW() WHERE id=$1`,
      [sessionId]
    );
    throw err;
  }
};

// ── Process Stripe webhook event ──────────────────────────────────────────────

const verifyStripeSignature = (rawBody, signature, secret) => {
  if (!signature || !secret) return null;
  const parts = signature.split(',').reduce((acc, item) => {
    const [k, v] = item.split('=');
    acc[k] = v;
    return acc;
  }, {});
  const timestamp = parts.t;
  const sig = parts.v1;
  if (!timestamp || !sig) return null;
  const payload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return JSON.parse(rawBody.toString());
};

const processStripeWebhook = async (rawBody, headers) => {
  const sig = headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const event = verifyStripeSignature(rawBody, sig, secret);
  if (!event && secret) {
    logger.warn('Stripe webhook: invalid signature');
    return { success: false, error: 'Invalid webhook signature' };
  }

  const parsed = event || (secret ? null : (() => {
    try { return JSON.parse(rawBody.toString()); } catch { return null; }
  })());
  if (!parsed) return { success: false, error: 'Could not parse webhook body' };

  if (parsed.type === 'checkout.session.completed') {
    const stripeSession = parsed.data.object;
    const sessionId = stripeSession.metadata?.session_id;
    if (!sessionId) return { success: false, error: 'No session_id in Stripe metadata' };

    const sessR = await query(
      `SELECT * FROM payment_sessions WHERE id=$1 AND status IN ('pending','processing')`,
      [sessionId]
    );
    if (!sessR.rows[0]) return { success: true, message: 'Session already processed' };
    const session = sessR.rows[0];

    const custR = await query('SELECT house_number FROM customers WHERE id=$1', [session.customer_id]);
    if (!custR.rows[0]) return { success: false, error: 'Customer not found' };

    await query(`UPDATE payment_sessions SET status='processing', updated_at=NOW() WHERE id=$1`, [sessionId]);

    const result = await processPayment({
      transaction_ref: `STRIPE-${stripeSession.payment_intent || stripeSession.id}`,
      gateway: 'stripe',
      house_number: custR.rows[0].house_number,
      amount: Number(session.amount),
      currency: session.currency,
      gateway_status: 'STRIPE_CHECKOUT',
      gateway_response: stripeSession,
      notes: `Online Stripe checkout. Session: ${sessionId}`,
      payment_meta: { session_id: sessionId, stripe_session_id: stripeSession.id, online: true },
    });

    if (result.success) {
      await query(`
        UPDATE payment_sessions
        SET status='completed', payment_transaction_id=$1,
            payment_reference=$2, completed_at=NOW(), updated_at=NOW()
        WHERE id=$3
      `, [result.transaction.id, result.receipt_number, sessionId]);
    } else {
      await query(`UPDATE payment_sessions SET status='failed', updated_at=NOW() WHERE id=$1`, [sessionId]);
    }
    return { success: result.success };
  }

  return { success: true, message: `Unhandled event type: ${parsed.type}` };
};

module.exports = {
  providers,
  createCheckoutSession,
  getSession,
  confirmSessionPayment,
  processStripeWebhook,
};
