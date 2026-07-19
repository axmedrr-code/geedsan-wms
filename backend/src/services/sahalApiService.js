const axios = require('axios');
const logger = require('./logger');

// Sahal mobile money push-payment client.
// When SAHAL_API_URL / SAHAL_API_KEY / SAHAL_MERCHANT_ID are set, initiates
// real USSD push payments. When unconfigured, runs in simulation mode: the
// session is created and marked as waiting, and the Sahal callback simulator
// at POST /api/portal/session/:id/confirm can fulfil it.
//
// Sahal callback arrives at: POST /api/payments/callback/sahal
// Reference field echoed back: metadata.sahal_session_ref

const initiateSahalPayment = async ({ phone, amount, currency = 'USD', sessionId, houseNumber }) => {
  const apiUrl      = process.env.SAHAL_API_URL;
  const apiKey      = process.env.SAHAL_API_KEY;
  const merchantId  = process.env.SAHAL_MERCHANT_ID;

  // Stable reference we send to Sahal and expect back in the callback's
  // receiverRef / merchantRef field, allowing us to link callback → session.
  const sessionRef = `WMS-${sessionId.substring(0, 8).toUpperCase()}`;

  if (!apiUrl || !apiKey || !merchantId) {
    logger.info('Sahal: simulation mode (no credentials configured)', { sessionId });
    return {
      mode:         'simulation',
      success:      true,
      sahal_ref:    `SIM-SAHAL-${sessionRef}`,
      session_ref:  sessionRef,
      message:      'Sahal payment pending (simulation — use Confirm button to complete)',
    };
  }

  try {
    const res = await axios.post(
      `${apiUrl}/merchant/push`,
      {
        merchant_id:  merchantId,
        phone:        String(phone).replace(/[^0-9+]/g, ''),
        amount:       Number(amount),
        currency:     currency,
        reference:    sessionRef,
        description:  `Water bill payment — ${houseNumber}`,
        callback_url: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/payments/callback/sahal`,
      },
      {
        headers: {
          Authorization:  `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    const data = res.data;
    if (!data.success && data.status !== 'pending' && data.status !== 'success') {
      throw new Error(data.message || 'Sahal API returned failure');
    }

    return {
      mode:        'live',
      success:     true,
      sahal_ref:   data.transaction_id || data.reference || data.transactionId,
      session_ref: sessionRef,
      message:     data.message || 'USSD push sent — customer will receive a prompt',
    };
  } catch (err) {
    logger.error('Sahal API initiation failed', { error: err.message, sessionId });
    throw new Error(`Sahal payment initiation failed: ${err.response?.data?.message || err.message}`);
  }
};

// Attempt to link an incoming Sahal callback to a pending payment_session
// by matching the session_ref that WMS sent in the original push request.
// Returns true if a session was found and updated; false otherwise.
const linkSahalCallbackToSession = async ({ sessionRef, transactionId, receiptNumber, transactionDbId }) => {
  if (!sessionRef && !transactionId) return false;
  try {
    const { query } = require('../config/database');
    const r = await query(
      `SELECT id FROM payment_sessions
       WHERE provider='sahal' AND status='pending'
         AND (
           provider_session_id = $1
           OR metadata->>'sahal_session_ref' = $1
           OR metadata->>'sahal_session_ref' = $2
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
    logger.warn('Failed to link Sahal callback to session', { error: err.message, sessionRef });
    return false;
  }
};

module.exports = { initiateSahalPayment, linkSahalCallbackToSession };
