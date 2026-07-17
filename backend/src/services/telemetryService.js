const { query } = require('../config/database');
const { processAlarms, checkContinuousFlow } = require('./alarmService');
const { sendNotification } = require('./notificationService');
const realtimeService = require('./realtimeService');
const { enqueueOdooSync } = require('./odooService');

// Gateways self-register from real traffic — no manual provisioning step
// needed before a gateway's uplinks start showing up in /api/gateways.
const upsertGateway = async (gatewayEui, rssi, snr) => {
  await query(
    `INSERT INTO gateways (gateway_eui, is_online, last_seen, last_rssi, last_snr, uplink_count)
     VALUES ($1, true, NOW(), $2, $3, 1)
     ON CONFLICT (gateway_eui) DO UPDATE SET
       is_online = true, last_seen = NOW(), last_rssi = $2, last_snr = $3,
       uplink_count = gateways.uplink_count + 1, updated_at = NOW()`,
    [gatewayEui, rssi, snr]
  );
};

const persistHistoricalFlow = async (meter, historicalFlow) => {
  const { intervalMinutes, points } = historicalFlow;
  if (!points.length) return;
  const now = Date.now();
  const lastOffset = points[points.length - 1].offsetMinutes;

  for (const point of points) {
    const recordedAt = new Date(now - (lastOffset - point.offsetMinutes) * 60 * 1000);
    await query(
      `INSERT INTO meter_flow_history (meter_id, device_eui, recorded_at, interval_minutes, consumption_pulses) VALUES ($1,$2,$3,$4,$5)`,
      [meter.id, meter.device_eui, recordedAt, intervalMinutes, point.value]
    );
  }
};

const ingestTelemetry = async (meter, decoded, meta = {}) => {
  const { rssi = null, snr = null, fPort = null, fCnt = null, rawPayload = null, gatewayEui = null } = meta;

  // Pulse count + pulse constant -> consumption (m³). The constant is usually
  // configured once on the device, not resent every report, so fall back to
  // the meter's last known pulse_constant_liters when this frame omits it.
  let totalConsumption = decoded.totalConsumption;
  if (totalConsumption === null && decoded.pulseCount !== null) {
    const constant = decoded.pulseConstantLiters ?? Number(meter.pulse_constant_liters ?? 100);
    totalConsumption = (decoded.pulseCount * constant) / 1000;
  }

  const readingInsert = await query(
    `INSERT INTO meter_readings (
      meter_id, device_eui, timestamp, total_consumption, current_flow,
      battery_voltage, pressure, rssi, snr, pulse_count, status_word_1, status_word_2,
      trigger_source, f_port, f_cnt, raw_payload, alarm_flags, gateway_eui, created_at
    ) VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
    RETURNING id`,
    [meter.id, meter.device_eui, totalConsumption, decoded.currentFlow, decoded.batteryVoltage,
      decoded.pressure, rssi, snr, decoded.pulseCount, decoded.statusWord1, decoded.statusWord2,
      decoded.triggerSource, fPort, fCnt, rawPayload, JSON.stringify(decoded.alarmFlags || {}), gatewayEui]
  );
  enqueueOdooSync('reading', readingInsert.rows[0].id).catch(err =>
    console.error('[odoo] failed to enqueue reading sync:', err.message)
  );

  if (gatewayEui) await upsertGateway(gatewayEui, rssi, snr);

  let upQ = `UPDATE meters SET is_online=true,last_seen=NOW(),updated_at=NOW()`;
  const upP = [];
  let pi = 1;
  if (totalConsumption !== null) { upQ += `,total_consumption=$${pi++}`; upP.push(totalConsumption); }
  if (decoded.currentFlow !== null) { upQ += `,current_flow=$${pi++}`; upP.push(decoded.currentFlow); }
  if (decoded.batteryVoltage !== null) { upQ += `,battery_voltage=$${pi++}`; upP.push(decoded.batteryVoltage); }
  if (decoded.pressure !== null) { upQ += `,pressure=$${pi++}`; upP.push(decoded.pressure); }
  if (rssi !== null) { upQ += `,rssi=$${pi++}`; upP.push(rssi); }
  if (snr !== null) { upQ += `,snr=$${pi++}`; upP.push(snr); }
  if (decoded.pulseCount !== null) { upQ += `,pulse_count=$${pi++}`; upP.push(decoded.pulseCount); }
  if (decoded.pulseConstantLiters !== null) { upQ += `,pulse_constant_liters=$${pi++}`; upP.push(decoded.pulseConstantLiters); }
  if (decoded.statusWord1 !== null) { upQ += `,status_word_1=$${pi++}`; upP.push(decoded.statusWord1); }
  if (decoded.statusWord2 !== null) { upQ += `,status_word_2=$${pi++}`; upP.push(decoded.statusWord2); }
  if (decoded.triggerSource !== null) { upQ += `,trigger_source=$${pi++}`; upP.push(decoded.triggerSource); }
  if (decoded.meterSerial !== null) { upQ += `,meter_serial=$${pi++}`; upP.push(decoded.meterSerial); }
  if (decoded.valveStatus) { upQ += `,valve_status=$${pi++}`; upP.push(decoded.valveStatus); }
  upQ += ` WHERE id=$${pi}`; upP.push(meter.id);
  await query(upQ, upP);

  if (decoded.historicalFlow) await persistHistoricalFlow(meter, decoded.historicalFlow);

  realtimeService.publish('telemetry', { meterId: meter.id, deviceEui: meter.device_eui, decoded });

  const newAlarms = await processAlarms(meter, decoded);
  const leakAlarm = await checkContinuousFlow(meter);
  if (leakAlarm) newAlarms.push({ ...leakAlarm, meter });

  for (const alarm of newAlarms) {
    await sendNotification(alarm, meter);
    realtimeService.publish('alarm', { meterId: meter.id, deviceEui: meter.device_eui, alarm });
  }

  return { newAlarms };
};

module.exports = { ingestTelemetry };
