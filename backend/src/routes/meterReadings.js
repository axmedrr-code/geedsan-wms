const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { enqueueOdooSync } = require('../services/odooService');
const logger = require('../services/logger');

// GET /meter-readings — same filter shape as the existing cross-meter
// readings.js feed, extended with source/water_type for the Meter
// Readings page's list view. Kept as a separate file from readings.js
// (a pure telemetry viewer today) so this route can carry its own
// POST/manual-entry logic without touching that file's existing GET.
router.get('/', authenticate, async (req, res) => {
  try {
    const { meter_id, source, from, to, limit = 100, page = 1 } = req.query;
    const params = [];
    let where = '1=1';
    if (meter_id) { params.push(meter_id); where += ` AND mr.meter_id=$${params.length}`; }
    if (source)   { params.push(source);   where += ` AND mr.source=$${params.length}`; }
    if (from)     { params.push(from);     where += ` AND mr.timestamp>=$${params.length}`; }
    if (to)       { params.push(to);       where += ` AND mr.timestamp<=$${params.length}`; }
    const offset = (parseInt(page) - 1) * parseInt(limit);
    params.push(parseInt(limit), offset);
    const r = await query(
      `SELECT mr.*, m.meter_number, m.customer_id, wt.code AS water_type, u.full_name AS entered_by_name
       FROM meter_readings mr
       JOIN meters m ON m.id = mr.meter_id
       LEFT JOIN water_types wt ON wt.id = m.water_type_id
       LEFT JOIN users u ON u.id = mr.entered_by
       WHERE ${where} ORDER BY mr.timestamp DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /meter-readings — manual reading entry. Allowed against any meter
// (not restricted to reading_mode='manual') to cover a smart meter that's
// temporarily offline needing a catch-up reading — the source is always
// tagged 'manual' honestly regardless of the meter's own classification,
// so this never gets confused with real LoRaWAN telemetry.
router.post('/', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const { meter_id, reading_value, timestamp, notes } = req.body;
    if (!meter_id || reading_value === undefined || reading_value === null || isNaN(Number(reading_value))) {
      return res.status(400).json({ error: 'meter_id and a numeric reading_value are required' });
    }

    const meterR = await query('SELECT id, device_eui, total_consumption FROM meters WHERE id=$1', [meter_id]);
    if (!meterR.rows[0]) return res.status(404).json({ error: 'Meter not found' });
    const meter = meterR.rows[0];

    const readingValue = Number(reading_value);
    const ts = timestamp || new Date().toISOString();

    // Non-blocking sanity check — a manual entry lower than the last known
    // reading is unusual (meter rollback/replacement aside) but not
    // forbidden; surfaced back to the caller as a warning, not a 400.
    const lastR = await query(
      'SELECT total_consumption FROM meter_readings WHERE meter_id=$1 ORDER BY timestamp DESC LIMIT 1',
      [meter_id]
    );
    const lastValue = lastR.rows[0] ? Number(lastR.rows[0].total_consumption) : null;
    const warning = (lastValue !== null && readingValue < lastValue)
      ? `Entered value (${readingValue}) is lower than the last recorded reading (${lastValue}) for this meter.`
      : null;

    const r = await query(
      `INSERT INTO meter_readings (meter_id, device_eui, timestamp, total_consumption, source, entered_by, raw_payload)
       VALUES ($1,$2,$3,$4,'manual',$5,$6) RETURNING *`,
      [meter_id, meter.device_eui || null, ts, readingValue, req.user.id, notes || null]
    );

    // Keep the meter's own denormalized total_consumption in sync, same as
    // the LoRaWAN ingestion path already does on every uplink.
    await query('UPDATE meters SET total_consumption=$1, updated_at=NOW() WHERE id=$2', [readingValue, meter_id]);

    enqueueOdooSync('reading', r.rows[0].id).catch(e =>
      logger.warn('Odoo reading enqueue failed for manual entry', { error: e.message, readingId: r.rows[0].id })
    );

    res.status(201).json({ reading: r.rows[0], warning });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
