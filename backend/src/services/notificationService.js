const nodemailer = require('nodemailer');
const axios = require('axios');
const { query } = require('../config/database');

const sendEmail = async (to, subject, htmlBody) => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return false;
  try {
    const transporter = nodemailer.createTransporter({ host: process.env.EMAIL_HOST||'smtp.gmail.com', port: parseInt(process.env.EMAIL_PORT)||587, secure: false, auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
    await transporter.sendMail({ from: process.env.EMAIL_FROM||'NUWACO WMS <noreply@nuwaco.com>', to, subject, html: htmlBody });
    return true;
  } catch (err) { console.error('Email error:', err.message); return false; }
};

const sendTelegram = async (chatId, message) => {
  if (!process.env.TELEGRAM_BOT_TOKEN) return false;
  try { await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: message, parse_mode: 'HTML' }); return true; } catch { return false; }
};

// Groundwork for a future WhatsApp/SMS provider (e.g. Twilio, Meta Business API):
// once WHATSAPP_API_URL/WHATSAPP_API_KEY are set, this just needs the request
// shape adjusted to match the chosen provider — no other code changes required.
const sendWhatsApp = async (recipient, message) => {
  if (!process.env.WHATSAPP_API_URL || !process.env.WHATSAPP_API_KEY) return false;
  try {
    await axios.post(process.env.WHATSAPP_API_URL, { to: recipient, message }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_API_KEY}` } });
    return true;
  } catch (err) { console.error('WhatsApp error:', err.message); return false; }
};

const sendNotification = async (alarm, meter) => {
  try {
    const settings = await query(`SELECT ns.*,u.email FROM notification_settings ns JOIN users u ON ns.user_id=u.id WHERE ns.is_active=true AND ns.enabled_alarms::jsonb ? $1`, [alarm.alarm_type]);
    const subject = `NUWACO WMS Alert: ${alarm.alarm_type.replace(/_/g,' ')} - Meter ${meter?.meter_number||alarm.device_eui}`;
    const message = `Alarm: ${alarm.alarm_type}\nSeverity: ${alarm.severity}\nMeter: ${meter?.meter_number||'N/A'}\nMessage: ${alarm.message}`;
    for (const s of settings.rows) {
      let success = false, errorMessage = null;
      try {
        if (s.channel==='email') success = await sendEmail(s.recipient, subject, `<p>${message.replace(/\n/g,'<br>')}</p>`);
        else if (s.channel==='telegram') success = await sendTelegram(s.recipient, message);
        else if (s.channel==='whatsapp') success = await sendWhatsApp(s.recipient, message);
      } catch (err) { errorMessage = err.message; }
      await query(`INSERT INTO notifications(alarm_id,channel,recipient,subject,message,status,sent_at,error_message) VALUES($1,$2,$3,$4,$5,$6,NOW(),$7)`, [alarm.id, s.channel, s.recipient, subject, message, success?'sent':'failed', errorMessage]);
    }
  } catch (err) { console.error('Notification error:', err.message); }
};

// System-level events (service restart, backup failure, etc.) reuse the same
// notification_settings channels as meter alarms, keyed by a pseudo alarm
// type (e.g. 'system_restart') instead of a real one — no schema change
// needed since enabled_alarms is just a JSONB array of strings.
const notifySystemEvent = async (eventType, subject, message) => {
  try {
    const settings = await query(`SELECT ns.* FROM notification_settings ns WHERE ns.is_active=true AND ns.enabled_alarms::jsonb ? $1`, [eventType]);
    for (const s of settings.rows) {
      let success = false, errorMessage = null;
      try {
        if (s.channel === 'email') success = await sendEmail(s.recipient, subject, `<p>${message.replace(/\n/g, '<br>')}</p>`);
        else if (s.channel === 'telegram') success = await sendTelegram(s.recipient, message);
        else if (s.channel === 'whatsapp') success = await sendWhatsApp(s.recipient, message);
      } catch (err) { errorMessage = err.message; }
      await query(`INSERT INTO notifications(alarm_id,channel,recipient,subject,message,status,sent_at,error_message) VALUES(NULL,$1,$2,$3,$4,$5,NOW(),$6)`, [s.channel, s.recipient, subject, message, success ? 'sent' : 'failed', errorMessage]);
    }
  } catch (err) { console.error('System notification error:', err.message); }
};

// ─── Billing Notifications ────────────────────────────────────────────────────
//
// Billing events are keyed by a pseudo-alarm type string stored in the
// notification_settings.enabled_alarms JSONB array — the same mechanism used
// for meter alarm types, so no schema change is required.  Callers opt in by
// adding e.g. 'invoice_created' to their enabled_alarms setting.
//
// Supported eventType values: 'invoice_created' | 'payment_received' | 'invoice_overdue'

const buildBillingMessage = (eventType, invoice, customer, payment) => {
  const name    = customer ? (customer.full_name || customer.name || 'Unknown') : 'Unknown';
  const invNo   = invoice ? (invoice.invoice_number || invoice.id) : 'N/A';
  const dueDate = invoice ? (invoice.due_date || 'N/A') : 'N/A';
  const total   = invoice ? Number(invoice.total_amount || 0).toFixed(2) : '0.00';

  switch (eventType) {
    case 'invoice_created':
      return {
        subject: `NUWACO WMS: New Invoice ${invNo} for ${name}`,
        text: `A new invoice has been created.\n\nCustomer: ${name}\nInvoice No: ${invNo}\nAmount: ${total}\nDue Date: ${dueDate}`,
      };
    case 'payment_received': {
      const paid   = payment ? Number(payment.amount || 0).toFixed(2) : '0.00';
      const method = payment ? (payment.method || payment.payment_method || 'N/A') : 'N/A';
      const ref    = payment ? (payment.reference || payment.reference_number || '') : '';
      return {
        subject: `NUWACO WMS: Payment Received – Invoice ${invNo}`,
        text: `A payment has been received.\n\nCustomer: ${name}\nInvoice No: ${invNo}\nPaid: ${paid}\nMethod: ${method}${ref ? `\nReference: ${ref}` : ''}`,
      };
    }
    case 'invoice_overdue':
      return {
        subject: `NUWACO WMS: Overdue Invoice ${invNo} – ${name}`,
        text: `An invoice is overdue.\n\nCustomer: ${name}\nInvoice No: ${invNo}\nAmount Due: ${total}\nDue Date: ${dueDate}`,
      };
    default:
      return {
        subject: `NUWACO WMS: Billing Event (${eventType})`,
        text:    `Billing event type: ${eventType}`,
      };
  }
};

// Shared dispatch helper — finds opted-in users, sends via each channel, logs.
const dispatchBillingNotification = async (eventType, invoice, customer, payment = null) => {
  try {
    const settings = await query(
      `SELECT ns.*, u.email
       FROM notification_settings ns
       JOIN users u ON ns.user_id=u.id
       WHERE ns.is_active=true AND ns.enabled_alarms::jsonb ? $1`,
      [eventType],
    );
    if (!settings.rows.length) return;

    const { subject, text } = buildBillingMessage(eventType, invoice, customer, payment);
    const htmlBody = `<p>${text.replace(/\n/g, '<br>')}</p>`;

    for (const s of settings.rows) {
      let success = false;
      let errorMessage = null;
      try {
        if (s.channel === 'email')     success = await sendEmail(s.recipient, subject, htmlBody);
        else if (s.channel === 'telegram')  success = await sendTelegram(s.recipient, text);
        else if (s.channel === 'whatsapp')  success = await sendWhatsApp(s.recipient, text);
      } catch (err) {
        errorMessage = err.message;
      }
      await query(
        `INSERT INTO notifications
           (alarm_id, channel, recipient, subject, message, status, sent_at, error_message)
         VALUES (NULL, $1, $2, $3, $4, $5, NOW(), $6)`,
        [s.channel, s.recipient, subject, text, success ? 'sent' : 'failed', errorMessage],
      );
    }
  } catch (err) {
    console.error(`Billing notification error [${eventType}]:`, err.message);
  }
};

/**
 * Notify opted-in users that a new invoice was created.
 * @param {object} invoice  — invoice row from DB (must have invoice_number, total_amount, due_date)
 * @param {object} customer — customer row from DB (must have full_name)
 */
const notifyInvoiceCreated = async (invoice, customer) => {
  return dispatchBillingNotification('invoice_created', invoice, customer, null);
};

/**
 * Notify opted-in users that a payment was received against an invoice.
 * @param {object} payment  — payment row from DB (amount, method, reference)
 * @param {object} invoice  — invoice row from DB
 * @param {object} customer — customer row from DB
 */
const notifyPaymentReceived = async (payment, invoice, customer) => {
  return dispatchBillingNotification('payment_received', invoice, customer, payment);
};

/**
 * Notify opted-in users that an invoice has become overdue.
 * @param {object} invoice  — invoice row from DB
 * @param {object} customer — customer row from DB
 */
const notifyInvoiceOverdue = async (invoice, customer) => {
  return dispatchBillingNotification('invoice_overdue', invoice, customer, null);
};

/**
 * Generic dispatcher — routes a billing event to the right handler.
 * @param {'invoice_created'|'payment_received'|'invoice_overdue'} eventType
 * @param {{ invoice, customer, payment? }} data
 */
const notifyBillingEvent = async (eventType, data) => {
  const { invoice, customer, payment } = data || {};
  switch (eventType) {
    case 'invoice_created':
      return notifyInvoiceCreated(invoice, customer);
    case 'payment_received':
      return notifyPaymentReceived(payment, invoice, customer);
    case 'invoice_overdue':
      return notifyInvoiceOverdue(invoice, customer);
    default:
      console.warn(`[notifyBillingEvent] Unknown event type: ${eventType}`);
  }
};

module.exports = {
  sendNotification,
  sendEmail,
  sendTelegram,
  sendWhatsApp,
  notifySystemEvent,
  notifyInvoiceCreated,
  notifyPaymentReceived,
  notifyInvoiceOverdue,
  notifyBillingEvent,
};
