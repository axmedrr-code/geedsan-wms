const nodemailer = require('nodemailer');
const axios = require('axios');
const { query } = require('../config/database');

const sendEmail = async (to, subject, htmlBody) => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return false;
  try {
    const transporter = nodemailer.createTransporter({ host: process.env.EMAIL_HOST||'smtp.gmail.com', port: parseInt(process.env.EMAIL_PORT)||587, secure: false, auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
    await transporter.sendMail({ from: process.env.EMAIL_FROM||'GEEDSAN WMS <noreply@geedsan.com>', to, subject, html: htmlBody });
    return true;
  } catch (err) { console.error('Email error:', err.message); return false; }
};

const sendTelegram = async (chatId, message) => {
  if (!process.env.TELEGRAM_BOT_TOKEN) return false;
  try { await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: message, parse_mode: 'HTML' }); return true; } catch { return false; }
};

const sendNotification = async (alarm, meter) => {
  try {
    const settings = await query(`SELECT ns.*,u.email FROM notification_settings ns JOIN users u ON ns.user_id=u.id WHERE ns.is_active=true AND ns.enabled_alarms::jsonb ? $1`, [alarm.alarm_type]);
    const subject = `GEEDSAN Alert: ${alarm.alarm_type.replace(/_/g,' ')} - Meter ${meter?.meter_number||alarm.device_eui}`;
    const message = `Alarm: ${alarm.alarm_type}\nSeverity: ${alarm.severity}\nMeter: ${meter?.meter_number||'N/A'}\nMessage: ${alarm.message}`;
    for (const s of settings.rows) {
      let success = false, errorMessage = null;
      try {
        if (s.channel==='email') success = await sendEmail(s.recipient, subject, `<p>${message.replace(/\n/g,'<br>')}</p>`);
        else if (s.channel==='telegram') success = await sendTelegram(s.recipient, message);
      } catch (err) { errorMessage = err.message; }
      await query(`INSERT INTO notifications(alarm_id,channel,recipient,subject,message,status,sent_at,error_message) VALUES($1,$2,$3,$4,$5,$6,NOW(),$7)`, [alarm.id, s.channel, s.recipient, subject, message, success?'sent':'failed', errorMessage]);
    }
  } catch (err) { console.error('Notification error:', err.message); }
};

module.exports = { sendNotification, sendEmail, sendTelegram };
