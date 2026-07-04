const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { decodeMeterPayload } = require('../services/payloadDecoder');
const { ingestTelemetry } = require('../services/telemetryService');

router.post('/chirpstack', async (req, res) => {
  res.status(200).json({ received: true });
  try {
    const payload = req.body;
    const deviceEui = (payload.deviceInfo?.devEui || payload.devEui || payload.device_eui || '').toUpperCase();
    if (!deviceEui) return;
    const mr = await query('SELECT * FROM meters WHERE device_eui=$1', [deviceEui]);
    if (!mr.rows[0]) return;
    const meter = mr.rows[0];
    const rawData = payload.data || payload.rawPayload || '';
    const decoded = decodeMeterPayload(rawData);
    const rssi = payload.rxInfo?.[0]?.rssi ?? payload.rssi ?? null;
    const snr = payload.rxInfo?.[0]?.snr ?? payload.snr ?? null;
    const gatewayEui = (payload.rxInfo?.[0]?.gatewayId || '').toUpperCase() || null;
    await ingestTelemetry(meter, decoded, { rssi, snr, fPort: payload.fPort || 1, fCnt: payload.fCnt, rawPayload: rawData, gatewayEui });
  } catch (err) { console.error('Webhook error:', err.message); }
});

module.exports = router;
