const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');

router.get('/settings', authenticate, async (req, res) => {
  const r = await query('SELECT * FROM notification_settings WHERE user_id=$1', [req.user.id]);
  res.json(r.rows);
});

router.post('/settings', authenticate, async (req, res) => {
  try {
    const { channel, recipient, enabled_alarms, is_active } = req.body;
    const r = await query(`INSERT INTO notification_settings (user_id,channel,recipient,enabled_alarms,is_active) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(user_id,channel) DO UPDATE SET recipient=EXCLUDED.recipient,enabled_alarms=EXCLUDED.enabled_alarms,is_active=EXCLUDED.is_active RETURNING *`, [req.user.id, channel, recipient, JSON.stringify(enabled_alarms), is_active !== false]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Failed to save notification settings' }); }
});

router.get('/history', authenticate, async (req, res) => {
  const r = await query(`SELECT n.*,a.alarm_type,m.meter_number FROM notifications n LEFT JOIN alarms a ON n.alarm_id=a.id LEFT JOIN meters m ON a.meter_id=m.id ORDER BY n.created_at DESC LIMIT 50`);
  res.json(r.rows);
});

module.exports = router;
