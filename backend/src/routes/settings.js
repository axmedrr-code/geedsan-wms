const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', authenticate, authorize('admin'), async (req, res) => {
  const r = await query('SELECT key,value,description FROM system_settings ORDER BY key');
  const sensitive = ['email_password','chirpstack_api_key','telegram_bot_token','whatsapp_api_key','anthropic_api_key'];
  res.json(r.rows.map(s => ({ ...s, value: sensitive.includes(s.key) && s.value ? '***' : s.value })));
});

router.put('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { settings } = req.body;
    for (const { key, value } of settings) {
      await query('INSERT INTO system_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()', [key, value]);
    }
    res.json({ message: 'Settings updated' });
  } catch (err) { res.status(500).json({ error: 'Failed to update settings' }); }
});

router.put('/:key', authenticate, authorize('admin'), async (req, res) => {
  await query('INSERT INTO system_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()', [req.params.key, req.body.value]);
  res.json({ message: 'Setting updated' });
});

module.exports = router;
