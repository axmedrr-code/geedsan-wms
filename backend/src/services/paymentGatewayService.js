const crypto = require('crypto');
const { query, getClient } = require('../config/database');
const { recordAudit } = require('./auditService');
const logger = require('./logger');

// ── Gateway adapters: normalize raw callback bodies → common format ────────────

const adapters = {
  sahal: (body) => ({
    transaction_ref: body.transactionId || body.transaction_id || body.txnId,
    house_number:    String(body.receiverRef || body.merchantRef || body.reference || body.accountRef || '').trim(),
    amount:          parseFloat(body.amount || 0),
    currency:        body.currency || 'USD',
    phone_number:    body.senderPhone || body.msisdn || body.from || null,
    gateway_status:  body.status || 'SUCCESS',
  }),
  evc: (body) => ({
    transaction_ref: body.reference_id || body.reference || body.transactionId || body.txId,
    house_number:    String(body.to || body.receiverRef || body.merchantRef || body.account || '').trim(),
    amount:          parseFloat(body.amount || 0),
    currency:        body.currency || 'USD',
    phone_number:    body.from || body.msisdn || body.senderPhone || null,
    gateway_status:  body.status || 'C',
  }),
  cash: (body) => ({
    transaction_ref: body.transaction_ref || `CASH-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`,
    house_number:    String(body.house_number || '').trim(),
    amount:          parseFloat(body.amount || 0),
    currency:        body.currency || 'USD',
    phone_number:    body.phone_number || null,
    gateway_status:  'CASH',
  }),
  bank: (body) => ({
    transaction_ref: body.transaction_ref || body.reference || `BANK-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`,
    house_number:    String(body.house_number || '').trim(),
    amount:          parseFloat(body.amount || 0),
    currency:        body.currency || 'USD',
    phone_number:    body.phone_number || null,
    gateway_status:  'BANK_TRANSFER',
  }),
  pos: (body) => ({
    transaction_ref: body.transaction_ref || (body.approval_code ? `POS-${body.approval_code}` : null) || `POS-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`,
    house_number:    String(body.house_number || '').trim(),
    amount:          parseFloat(body.amount || 0),
    currency:        body.currency || 'USD',
    phone_number:    body.phone_number || null,
    gateway_status:  'POS_CARD',
  }),
  cheque: (body) => ({
    transaction_ref: body.transaction_ref || (body.cheque_number ? `CHQ-${body.cheque_number}` : null) || `CHQ-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`,
    house_number:    String(body.house_number || '').trim(),
    amount:          parseFloat(body.amount || 0),
    currency:        body.currency || 'USD',
    phone_number:    body.phone_number || null,
    gateway_status:  'CHEQUE',
  }),
  adjustment: (body) => ({
    transaction_ref: body.transaction_ref || `ADJ-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`,
    house_number:    String(body.house_number || '').trim(),
    amount:          parseFloat(body.amount || 0),
    currency:        body.currency || 'USD',
    phone_number:    null,
    gateway_status:  'ADJUSTMENT',
  }),
};

// ── Signature verification ────────────────────────────────────────────────────

const verifySignature = (rawBody, signature, secret) => {
  if (!secret || !secret.trim()) return true;  // no secret = dev mode, accept all
  if (!signature) return false;
  const payload = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
};

// ── Receipt number (sequential, atomic inside caller's transaction) ───────────

const generateReceiptNumber = async (client) => {
  const r = await client.query(
    "UPDATE system_settings SET value=(CAST(value AS INTEGER)+1)::TEXT WHERE key='receipt_sequence' RETURNING value"
  );
  const seq = r.rows[0]?.value || String(Date.now());
  const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
  return `RCP-${date}-${String(seq).padStart(6, '0')}`;
};

// ── Get gateway secret from DB ────────────────────────────────────────────────

const getGatewaySecret = async (gateway) => {
  const key = `${gateway}_callback_secret`;
  const r = await query('SELECT value FROM system_settings WHERE key=$1', [key]);
  return r.rows[0]?.value || '';
};

// ── Core payment processing (atomic transaction) ──────────────────────────────

const processPayment = async ({
  transaction_ref,
  gateway,
  house_number,
  amount,
  currency = 'USD',
  phone_number = null,
  gateway_status = null,
  gateway_response = {},
  notes = null,
  ip_address = null,
  user_agent = null,
  created_by = null,
  payment_meta = null,
}) => {
  if (!transaction_ref || !house_number || !amount || amount <= 0) {
    return { success: false, error: 'transaction_ref, house_number, and amount are required' };
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // ── Idempotency: reject duplicate transaction_ref ───────────────────────
    const dupR = await client.query(
      'SELECT id, status, receipt_number FROM payment_transactions WHERE transaction_ref=$1',
      [transaction_ref]
    );
    if (dupR.rows[0]) {
      await client.query('ROLLBACK');
      return { duplicate: true, success: true, transaction: dupR.rows[0] };
    }

    // ── Find customer ────────────────────────────────────────────────────────
    const custR = await client.query(
      'SELECT id, full_name, house_number, phone FROM customers WHERE house_number=$1',
      [house_number]
    );
    if (!custR.rows[0]) {
      const errTx = await client.query(`
        INSERT INTO payment_transactions
          (transaction_ref, gateway, house_number, amount, currency, status,
           gateway_status, gateway_response, phone_number, notes, ip_address, user_agent, created_by)
        VALUES ($1,$2,$3,$4,$5,'failed',$6,$7,$8,$9,$10,$11,$12)
        RETURNING id, receipt_number
      `, [transaction_ref, gateway, house_number, amount, currency,
          gateway_status, JSON.stringify(gateway_response),
          phone_number, notes, ip_address, user_agent, created_by]);
      await client.query('COMMIT');
      logger.warn(`Payment for unknown house_number=${house_number} ref=${transaction_ref}`);
      return { success: false, error: `No customer found with house number ${house_number}`, transaction: errTx.rows[0] };
    }
    const customer = custR.rows[0];

    // ── Find unpaid invoices (oldest first) ──────────────────────────────────
    const invR = await client.query(`
      SELECT
        i.id, i.invoice_number, i.total_amount,
        COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip WHERE ip.invoice_id=i.id), 0) AS paid_amount
      FROM invoices i
      WHERE i.customer_id=$1
        AND i.status IN ('pending','overdue')
      ORDER BY i.issue_date ASC, i.created_at ASC
    `, [customer.id]);

    let remaining = amount;
    const appliedInvoices = [];
    let primaryInvoiceId = null;

    for (const inv of invR.rows) {
      if (remaining <= 0.001) break;  // floating point tolerance
      const outstanding = Number(inv.total_amount) - Number(inv.paid_amount);
      if (outstanding <= 0) continue;

      const payAmt = Math.min(remaining, outstanding);
      remaining = +(remaining - payAmt).toFixed(2);

      // Insert invoice payment
      const ipR = await client.query(
        'INSERT INTO invoice_payments (invoice_id, amount, payment_date, method, reference, note, created_by) VALUES ($1,$2,NOW(),$3,$4,$5,$6) RETURNING id',
        [inv.id, payAmt, gateway, transaction_ref, notes || null, created_by || null]
      );

      // Update invoice status
      const newTotalPaid = Number(inv.paid_amount) + payAmt;
      const newStatus = newTotalPaid >= Number(inv.total_amount) - 0.005 ? 'paid' : 'pending';
      await client.query('UPDATE invoices SET status=$1, updated_at=NOW() WHERE id=$2', [newStatus, inv.id]);

      if (!primaryInvoiceId) primaryInvoiceId = inv.id;
      appliedInvoices.push({
        invoice_id:         inv.id,
        invoice_payment_id: ipR.rows[0].id,
        invoice_number:     inv.invoice_number,
        amount:             payAmt,
        status:             newStatus,
      });
    }

    // ── Determine final status ───────────────────────────────────────────────
    const finalStatus = appliedInvoices.length > 0 ? 'completed' : 'no_invoice';
    const receiptNumber = finalStatus === 'completed' ? await generateReceiptNumber(client) : null;

    // ── Insert payment_transactions record ───────────────────────────────────
    const txR = await client.query(`
      INSERT INTO payment_transactions
        (transaction_ref, gateway, house_number, customer_id, invoice_id, amount, currency,
         status, gateway_status, gateway_response, phone_number, receipt_number,
         applied_invoices, remaining_credit, notes, processed_at,
         ip_address, user_agent, created_by, payment_meta)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),$16,$17,$18,$19)
      RETURNING *
    `, [
      transaction_ref, gateway, house_number,
      customer.id, primaryInvoiceId,
      amount, currency,
      finalStatus, gateway_status, JSON.stringify(gateway_response),
      phone_number, receiptNumber,
      JSON.stringify(appliedInvoices),
      remaining > 0 ? remaining : 0,
      notes,
      ip_address, user_agent, created_by,
      payment_meta ? JSON.stringify(payment_meta) : null,
    ]);

    await client.query('COMMIT');

    const transaction = txR.rows[0];

    // ── Audit log (non-fatal) ────────────────────────────────────────────────
    try {
      await recordAudit({
        userId:     created_by,
        action:     finalStatus === 'completed' ? 'payment_received' : 'payment_no_invoice',
        entityType: 'payment_transaction',
        entityId:   transaction.id,
        newValues: {
          gateway, amount, house_number, currency,
          receipt: receiptNumber,
          invoices_applied: appliedInvoices.length,
        },
        ipAddress: ip_address,
        userAgent: user_agent,
      });
    } catch (auditErr) {
      logger.warn('Audit log failed for payment', { error: auditErr.message });
    }

    // ── Queue Odoo sync for applied invoices (non-fatal) ────────────────────
    const autoSync = await query("SELECT value FROM system_settings WHERE key='payment_auto_odoo_sync'");
    if (autoSync.rows[0]?.value === 'true' && appliedInvoices.length > 0) {
      const { enqueueOdooSync } = require('./odooService');
      for (const inv of appliedInvoices) {
        try {
          await enqueueOdooSync('payment', inv.invoice_payment_id);
        } catch { /* non-fatal */ }
      }
    }

    return {
      success:         true,
      status:          finalStatus,
      transaction,
      customer,
      applied_invoices: appliedInvoices,
      remaining_credit: remaining > 0 ? remaining : 0,
      receipt_number:   receiptNumber,
    };

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Payment processing failed', { error: err.message, transaction_ref, house_number });
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { adapters, verifySignature, getGatewaySecret, processPayment };
