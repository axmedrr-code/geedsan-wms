// Production monitoring — deliberately built WITHOUT mounting the Docker
// socket into this container. Docker-socket access would let this app
// control every other container on the host (root-equivalent), which is a
// real privilege escalation, not a small convenience. Instead this checks
// service health the same way any client would: DB connection, the
// backend's own MQTT client state, and plain HTTP pings to the other
// in-network services. This covers "is the thing actually working" for
// every service without the security tradeoff. True container-level restart
// tracking for ALL services would need either the Docker socket or an
// external tool (cAdvisor/Prometheus, Watchtower) — flagged, not silently
// built, since it's a real risk decision, not an implementation detail.
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const mqttService = require('../services/mqttService');

const pingHttp = async (url, timeout = 3000) => {
  const start = Date.now();
  try {
    await axios.get(url, { timeout, validateStatus: () => true });
    return { status: 'up', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'down', error: err.code || err.message };
  }
};

/**
 * @openapi
 * /system/health:
 *   get:
 *     summary: Aggregated service health — database, MQTT, backend, and HTTP pings to frontend/odoo/chirpstack, plus backup status
 *     tags: [System]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/health', authenticate, authorize('admin'), async (req, res) => {
  const services = {};

  try {
    const start = Date.now();
    await query('SELECT 1');
    services.database = { status: 'up', latencyMs: Date.now() - start };
  } catch (err) {
    services.database = { status: 'down', error: err.message };
  }

  services.mqtt = { status: mqttService.isConnected() ? 'up' : 'down', broker: process.env.MQTT_BROKER };
  services.backend = { status: 'up', uptimeSeconds: Math.round(process.uptime()) };

  const [frontend, odoo, chirpstack] = await Promise.all([
    pingHttp('http://frontend:3000/login'),
    pingHttp('http://odoo:8069/web/login'),
    // chirpstack runs with network_mode: service:postgres (see docker-compose.yml)
    // so it has no network identity of its own — it's reachable at postgres's
    // hostname, since postgres's container IS the actual network endpoint.
    pingHttp('http://postgres:8080/')
  ]);
  services.frontend = frontend;
  services.odoo = odoo;
  services.chirpstack = chirpstack;

  let backups = [];
  try {
    const r = await query(
      `SELECT DISTINCT ON (database_name) database_name, status, file_size_bytes, error_message, created_at
       FROM backup_log ORDER BY database_name, created_at DESC`
    );
    backups = r.rows.map(b => ({
      ...b,
      hoursAgo: (Date.now() - new Date(b.created_at).getTime()) / 3600000,
      overdue: (Date.now() - new Date(b.created_at).getTime()) / 3600000 > 26 // expects daily backups
    }));
  } catch (err) { /* backup_log not migrated yet on very old installs */ }

  const overallStatus = Object.values(services).every(s => s.status === 'up') ? 'healthy' : 'degraded';

  res.json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    services,
    backups,
    backupsConfigured: backups.length > 0
  });
});

module.exports = router;
