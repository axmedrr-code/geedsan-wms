const axios = require('axios');
const logger = require('./logger');

// EVC Plus (Telesom/Hormuud joint mobile money) push-payment client.
// Mirrors the Sahal service pattern: live mode when EVC_API_URL / EVC_API_KEY /
// EVC_MERCHANT_ID are set, simulation mode otherwise.
//
// EVC callback arrives at: POST /api/payments/callback/evc
// Reference field echoed back: metadata.evc_session_ref

const initiateEvcPayment = async ({ phone, amount, currency = 'USD', sessionId, houseNumber }) => {
  const apiUrl     = process.env.EVC_API_URL;
  const apiKey     = process.env.EVC_API_KEY;
  const merchantId = process.env.EVC_MERCHANT_ID;

  const sessionRef = `WMS-${sessionId.substring(0, 8).toUpperCase()}`;

  if (!apiUrl || !apiKey || !merchantId) {
    logger.info('EVC: simulation mode (no credentials configured)', { sessionId });
    return {
      mode:        'simulation',
      success:     true,
      evc_ref:     `SIM-EVC-${sessionRef}`,
      session_ref: sessionRef,
      message:     'EVC Plus payment pending (simulation — use Confirm button to complete)',
    };
  }

  try {
    const res = await axios.post(
      `${apiUrl}/payment/initiate`,
      {
        merchantuid:  merchantId,
        apikey:       apiKey,
        phonenumber:  String(phone).replace(/[^0-9+]/g, ''),
        amount:       Number(amount),
        currency:     currency,
        reference:    sessionRef,
        description:  `Water bill payment — ${houseNumber}`,
        webhook_url:  `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/payments/callback/evc`,
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    const data = res.data;
    if (!data.success && data.status !== 'C' && data.status !== 'pending') {
      throw new Error(data.message || 'EVC API returned failure');
    }

    return {
      mode:        'live',
      success:     true,
      evc_ref:     data.reference_id || data.reference || data.transactionId,
      session_ref: sessionRef,
      message:     data.message || 'EVC Plus USSD push sent',
    };
  } catch (err) {
    logger.error('EVC API initiation failed', { error: err.message, sessionId });
    throw new Error(`EVC payment initiation failed: ${err.response?.data?.message || err.message}`);
  }
};

const linkEvcCallbackToSession = async ({ sessionRef, transactionId, receiptNumber, transactionDbId }) => {
  if (!sessionRef && !transactionId) return false;
  try {
    const { query } = require('../config/database');
    const r = await query(
      `SELECT id FROM payment_sessions
       WHERE provider='evc' AND status='pending'
         AND (
           provider_session_id = $1
           OR metadata->>'evc_session_ref' = $1
           OR metadata->>'evc_session_ref' = $2
         )
       LIMIT 1`,
      [sessionRef || '', transactionId || '']
    );
    if (!r.rows[0]) return false;
    await query(
      `UPDATE payment_sessions
       SET status='completed', payment_transaction_id=$1,
           payment_reference=$2, completed_at=NOW(), updated_at=NOW()
       WHERE id=$3`,
      [transactionDbId || null, receiptNumber || null, r.rows[0].id]
    );
    return true;
  } catch (err) {
    logger.warn('Failed to link EVC callback to session', { error: err.message });
    return false;
  }
};

module.exports = { initiateEvcPayment, linkEvcCallbackToSession };
