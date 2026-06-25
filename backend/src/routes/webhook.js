const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { processAlarms } = require('../services/alarmService');
const { sendNotification } = require('../services/notificationService');

const decodeMeterPayload = (base64Data) => {
  try {
    const buf = Buffer.from(base64Data, 'base64');
    const result = { totalConsumption: null, currentFlow: null, batteryVoltage: null, alarmFlags: {}, valveStatus: null };
    if (buf.length >= 6) { result.totalConsumption = buf.readUInt32LE(0) * 0.001; result.currentFlow = buf.readUInt16LE(4) * 0.01; }
    if (buf.length >= 8) {
      result.batteryVoltage = 2.0 + buf.readUInt8(6) * 0.02;
      const alarm = buf.readUInt8(7);
      result.alarmFlags = { low_battery: !!(alarm&0x01), valve_failure: !!(alarm&0x02), magnetic_attack: !!(alarm&0x04), water_leakage: !!(alarm&0x08), reverse_flow: !!(alarm&0x10), pipe_burst: !!(alarm&0x20) };
    }
    if (buf.length >= 9) result.valveStatus = (buf.readUInt8(8) & 0x01) ? 'open' : 'closed';
    return result;
  } catch { return { totalConsumption: null, currentFlow: null, batteryVoltage: null, alarmFlags: {} }; }
};

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
    const rssi = payload.rxInfo?.[0]?.rssi || payload.rssi;
    const snr = payload.rxInfo?.[0]?.snr || payload.snr;
    await query(`INSERT INTO meter_readings(meter_id,device_eui,total_consumption,current_flow,battery_voltage,rssi,snr,raw_payload,f_port,f_cnt,alarm_flags) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [meter.id, deviceEui, decoded.totalConsumption, decoded.currentFlow, decoded.batteryVoltage, rssi, snr, rawData, payload.fPort||1, payload.fCnt, JSON.stringify(decoded.alarmFlags||{})]);
    let upQ = `UPDATE meters SET is_online=true,last_seen=NOW(),updated_at=NOW()`;
    const upP = [];
    let pi = 1;
    if (decoded.totalConsumption !== null) { upQ += `,total_consumption=$${pi++}`; upP.push(decoded.totalConsumption); }
    if (decoded.currentFlow !== null) { upQ += `,current_flow=$${pi++}`; upP.push(decoded.currentFlow); }
    if (decoded.batteryVoltage !== null) { upQ += `,battery_voltage=$${pi++}`; upP.push(decoded.batteryVoltage); }
    if (rssi !== undefined) { upQ += `,rssi=$${pi++}`; upP.push(rssi); }
    if (decoded.valveStatus) { upQ += `,valve_status=$${pi++}`; upP.push(decoded.valveStatus); }
    upQ += ` WHERE id=$${pi}`; upP.push(meter.id);
    await query(upQ, upP);
    if (decoded.alarmFlags) {
      const alarms = await processAlarms(meter, decoded);
      for (const alarm of alarms) await sendNotification(alarm, meter);
    }
  } catch (err) { console.error('Webhook error:', err.message); }
});

module.exports = router;
