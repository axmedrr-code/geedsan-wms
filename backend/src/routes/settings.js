const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { getBillingSettings, updateBillingSettings } = require('../services/billingService');
const { getOdooStatus } = require('../services/odooService');
const nodemailer = require('nodemailer');
const axios = require('axios');

const SENSITIVE_KEYS = ['email_password','chirpstack_api_key','telegram_bot_token','whatsapp_api_key','anthropic_api_key'];
const WRITE_ROLES   = ['admin', 'manager'];

// ── GET /settings — all authenticated users (read-only for non-admin/manager)
router.get('/', authenticate, async (req, res) => {
  try {
    const r = await query('SELECT key,value,description,updated_at FROM system_settings ORDER BY key');
    res.json(r.rows.map(s => ({
      ...s,
      value: SENSITIVE_KEYS.includes(s.key) && s.value ? '***' : s.value,
    })));
  } catch (err) {
    console.error('GET /settings error:', err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// ── GET /settings/billing — all authenticated (must be before /:key wildcard)
router.get('/billing', authenticate, async (req, res) => {
  try {
    res.json(await getBillingSettings());
  } catch (err) {
    console.error('GET /settings/billing error:', err);
    res.status(500).json({ error: 'Failed to fetch billing settings' });
  }
});

// ── PUT /settings/billing — admin + manager (must be before /:key wildcard)
router.put('/billing', authenticate, authorize(...WRITE_ROLES), async (req, res) => {
  try {
    const updated = await updateBillingSettings(req.body, req.user?.id);
    res.json(updated);
  } catch (err) {
    console.error('PUT /settings/billing error:', err);
    res.status(500).json({ error: 'Failed to update billing settings' });
  }
});

// ── PUT /settings — bulk update (admin + manager)
router.put('/', authenticate, authorize(...WRITE_ROLES), async (req, res) => {
  try {
    const { settings } = req.body;
    if (!Array.isArray(settings)) return res.status(400).json({ error: 'settings must be an array' });
    for (const { key, value } of settings) {
      await query(
        'INSERT INTO system_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()',
        [key, value]
      );
    }
    res.json({ message: 'Settings updated' });
  } catch (err) {
    console.error('PUT /settings error:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ── PUT /settings/:key — single key update (admin + manager)
router.put('/:key', authenticate, authorize(...WRITE_ROLES), async (req, res) => {
  try {
    await query(
      'INSERT INTO system_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()',
      [req.params.key, req.body.value]
    );
    res.json({ message: 'Setting updated' });
  } catch (err) {
    console.error('PUT /settings/:key error:', err);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// ── GET /settings/system-info — all authenticated
router.get('/system-info', authenticate, async (req, res) => {
  try {
    const [dbVerRow, dbSizeRow] = await Promise.all([
      query('SELECT version() AS ver'),
      query("SELECT pg_size_pretty(pg_database_size(current_database())) AS size"),
    ]);

    const backendVersion = (() => {
      try { return require('../../package.json').version; } catch { return '1.0.0'; }
    })();

    res.json({
      backend_version:  backendVersion,
      node_version:     process.version,
      db_version:       dbVerRow.rows[0]?.ver || 'unknown',
      db_size:          dbSizeRow.rows[0]?.size || 'unknown',
      backend_uptime_s: Math.floor(process.uptime()),
      platform:         process.platform,
      memory_rss_mb:    Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  } catch (err) {
    console.error('GET /settings/system-info error:', err);
    res.status(500).json({ error: 'Failed to fetch system info' });
  }
});

// ── POST /settings/test/email — admin + manager
router.post('/test/email', authenticate, authorize(...WRITE_ROLES), async (req, res) => {
  try {
    const r = await query("SELECT key,value FROM system_settings WHERE key IN ('email_smtp_host','email_smtp_port','email_username','email_password')");
    const cfg = Object.fromEntries(r.rows.map(row => [row.key, row.value]));
    const host = cfg.email_smtp_host;
    const user = cfg.email_username;
    const pass = cfg.email_password;

    if (!host || !user || !pass) {
      return res.status(400).json({ success: false, message: 'SMTP host, username and password are required' });
    }

    const transporter = nodemailer.createTransporter({
      host,
      port: parseInt(cfg.email_smtp_port || '587', 10),
      secure: false,
      auth: { user, pass },
    });

    await transporter.verify();
    res.json({ success: true, message: 'SMTP connection verified successfully' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── POST /settings/test/chirpstack — admin + manager
router.post('/test/chirpstack', authenticate, authorize(...WRITE_ROLES), async (req, res) => {
  try {
    const r = await query("SELECT key,value FROM system_settings WHERE key IN ('chirpstack_url','chirpstack_api_key')");
    const cfg = Object.fromEntries(r.rows.map(row => [row.key, row.value]));
    const url = cfg.chirpstack_url || 'http://postgres:8080';
    const apiKey = cfg.chirpstack_api_key;

    const response = await axios.get(`${url}/api/internal/login`, {
      headers: apiKey ? { 'Grpc-Metadata-Authorization': `Bearer ${apiKey}` } : {},
      timeout: 5000,
      validateStatus: s => s < 500,
    });

    res.json({ success: true, message: `ChirpStack reachable — HTTP ${response.status}` });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── POST /settings/test/odoo — admin + manager
router.post('/test/odoo', authenticate, authorize(...WRITE_ROLES), async (req, res) => {
  try {
    const status = await getOdooStatus();
    if (status?.connected) {
      res.json({ success: true, message: `Connected — Odoo ${status.version || ''}`, status });
    } else {
      res.json({ success: false, message: status?.error || 'Connection failed', status });
    }
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── POST /settings/backup — admin only
router.post('/backup', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { runDatabaseBackup } = require('../services/backupService');
    const result = await runDatabaseBackup('manual');
    if (!result.success) return res.status(500).json({ success: false, message: result.error });
    res.json({ success: true, message: 'Backup completed', file: result.file, size_bytes: result.size_bytes });
  } catch (err) {
    console.error('POST /settings/backup error:', err);
    res.status(500).json({ error: 'Backup failed' });
  }
});

// ── GET /settings/role-permissions — all authenticated
router.get('/role-permissions', authenticate, async (req, res) => {
  try {
    const r = await query('SELECT * FROM role_permissions ORDER BY role, module');
    const byRole = {};
    for (const row of r.rows) {
      if (!byRole[row.role]) byRole[row.role] = [];
      byRole[row.role].push(row);
    }
    res.json(byRole);
  } catch (err) {
    console.error('GET /settings/role-permissions error:', err);
    res.status(500).json({ error: 'Failed to fetch role permissions' });
  }
});

module.exports = router;
