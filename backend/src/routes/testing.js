// Admin-only endpoints for exercising the ingestion pipeline without real
// hardware. These build real Shengda protocol frames and push them through
// the exact same decode -> ingestTelemetry path a real MQTT uplink would
// use — not a shortcut that writes directly to the readings table.
const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const shengda = require('../services/shengdaProtocol');
const { decodeMeterPayload } = require('../services/payloadDecoder');
const { ingestTelemetry } = require('../services/telemetryService');

const u16be = (v) => [(v >> 8) & 0xFF, v & 0xFF];
const u32be = (v) => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];

// alarm_type -> { word1 bit, word2 bit } per Shengda Meter Status Word tables
const ALARM_BITS = {
  valve_fault: { word1: 0x80 },
  low_battery: { word1: 0x40 },
  magnetic_attack: { word1: 0x20 },
  battery_removed: { word1: 0x10 },
  metering_fault: { word1: 0x02 },
  water_inlet_alarm: { word2: 0x80 },
  water_return_alarm: { word2: 0x40 },
  flow_alarm: { word2: 0x20 },
  water_leakage: { word2: 0x08 },
  pipe_burst: { word2: 0x04 },
  reverse_flow: { word2: 0x02 }
};

/**
 * @openapi
 * /testing/seed-demo-meters:
 *   post:
 *     summary: Create demo meters for testing (no-op if they already exist)
 *     tags: [Testing]
 *     security: [{ bearerAuth: [] }]
 */
router.post('/seed-demo-meters', authenticate, authorize('admin'), async (req, res) => {
  try {
    const count = Math.min(parseInt(req.body?.count) || 3, 10);
    const created = [];
    for (let i = 1; i <= count; i++) {
      const deviceEui = `SIMTEST${String(i).padStart(9, '0')}`;
      const r = await query(
        `INSERT INTO meters(device_eui, meter_number, status) VALUES($1,$2,'active') ON CONFLICT DO NOTHING RETURNING device_eui`,
        [deviceEui, `SIM-METER-${String(i).padStart(3, '0')}`]
      );
      if (r.rows[0]) created.push(r.rows[0].device_eui);
    }
    res.json({ created, message: created.length ? `Created ${created.length} demo meter(s)` : 'Demo meters already exist' });
  } catch (err) { res.status(500).json({ error: 'Failed to seed demo meters' }); }
});

/**
 * @openapi
 * /testing/simulate-reading:
 *   post:
 *     summary: Inject one synthetic telemetry frame for a meter through the real decode/ingest pipeline
 *     tags: [Testing]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [device_eui]
 *             properties:
 *               device_eui: { type: string }
 *               pulse_count: { type: integer }
 *               battery_voltage: { type: number, description: "Volts, e.g. 3.6" }
 *               pressure: { type: number, description: "kPa" }
 *               alarm_type: { type: string, enum: [valve_fault, low_battery, magnetic_attack, battery_removed, metering_fault, water_inlet_alarm, water_return_alarm, flow_alarm, water_leakage, pipe_burst, reverse_flow] }
 */
router.post('/simulate-reading', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const { device_eui, pulse_count, battery_voltage, pressure, alarm_type } = req.body || {};
    if (!device_eui) return res.status(400).json({ error: 'device_eui is required' });

    const mr = await query('SELECT * FROM meters WHERE device_eui=$1', [device_eui.toUpperCase()]);
    if (!mr.rows[0]) return res.status(404).json({ error: 'Meter not found — seed it first via /testing/seed-demo-meters or create it via /api/meters' });
    const meter = mr.rows[0];

    if (alarm_type && !ALARM_BITS[alarm_type]) {
      return res.status(400).json({ error: `Unknown alarm_type. Valid: ${Object.keys(ALARM_BITS).join(', ')}` });
    }

    const pulseCount = pulse_count ?? Math.floor((meter.total_consumption || 0) * 1000 / Number(meter.pulse_constant_liters || 100));
    const batteryRaw = Math.round((battery_voltage ?? 3.6) * 16.4);
    const pressureVal = pressure ?? (meter.pressure ?? 300);

    let word1 = 0, word2 = 0;
    if (alarm_type) {
      const bits = ALARM_BITS[alarm_type];
      if (bits.word1) word1 |= bits.word1;
      if (bits.word2) word2 |= bits.word2;
    }

    const frame = shengda.buildReportFrame([
      { t: 0x0B, bytes: u32be(pulseCount) },
      { t: 0x14, bytes: [shengda.litersToPulseConstantCode(Number(meter.pulse_constant_liters) || 100)] },
      { t: 0x1A, bytes: u16be(batteryRaw) },
      { t: 0x40, bytes: u16be(Math.round(pressureVal)) },
      { t: 0x33, bytes: u16be((word1 << 8) | word2) },
      { t: 0x23, bytes: [0x01] }
    ]);

    const decoded = decodeMeterPayload(frame.toString('base64'));
    const { newAlarms } = await ingestTelemetry(meter, decoded, {
      rssi: -75, snr: 7.5, fPort: 2, fCnt: 0, rawPayload: frame.toString('base64'), gatewayEui: 'SIMGATEWAY00001A'
    });

    res.json({
      message: 'Synthetic reading ingested',
      decoded: { totalConsumption: decoded.totalConsumption, batteryVoltage: decoded.batteryVoltage, pressure: decoded.pressure },
      alarmsRaised: newAlarms.map(a => a.alarm_type)
    });
  } catch (err) { res.status(500).json({ error: 'Failed to simulate reading', details: err.message }); }
});

module.exports = router;
