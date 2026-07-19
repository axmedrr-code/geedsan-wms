const { query } = require('../config/database');
const { sendNotification } = require('./notificationService');
const realtimeService = require('./realtimeService');
const logger = require('./logger');

const ALARM_SEVERITY = {
  low_battery: 'warning', valve_fault: 'critical', magnetic_attack: 'critical',
  battery_removed: 'critical', metering_fault: 'warning',
  water_leakage: 'warning', reverse_flow: 'warning', pipe_burst: 'critical',
  water_inlet_alarm: 'warning', water_return_alarm: 'warning', flow_alarm: 'warning',
  no_flow: 'info', communication_loss: 'warning', low_pressure: 'warning', high_pressure: 'critical',
  abnormal_consumption: 'warning',
  no_flow: 'info'
};
const ALARM_MESSAGES = {
  low_battery: 'Battery voltage is below threshold.',
  valve_fault: 'Valve fault detected (in-position switch fault, low control voltage, or valve not turning).',
  magnetic_attack: 'Magnetic tampering detected.',
  battery_removed: 'Meter battery has been removed.',
  metering_fault: 'Metering open-circuit fault (EE/dismantling fault).',
  water_leakage: 'Continuous flow detected, possible leakage.',
  reverse_flow: 'Historical magnetic attack / reverse flow detected.',
  pipe_burst: 'Tube burst detected.',
  water_inlet_alarm: 'Water inlet alarm.',
  water_return_alarm: 'Water return alarm.',
  flow_alarm: 'Flow alarm (over-range or historical dismantling).',
  communication_loss: 'Device has not reported for an extended period.',
  low_pressure: 'Pipeline pressure is below the safe threshold.',
  high_pressure: 'Pipeline pressure exceeds the safe threshold.',
  abnormal_consumption: 'Current flow is significantly above this meter\'s recent baseline.',
  no_flow: 'No flow detected for an extended period on an active meter.'
};

// Pressure (T=0x40) is reported in kPa per the Shengda protocol.
const LOW_PRESSURE_KPA = 100;
const HIGH_PRESSURE_KPA = 600;
const LEAK_MIN_FLOW = 2; // L/h
const LEAK_WINDOW_HOURS = 4;
const LEAK_MIN_READINGS = 6;

const raiseAlarm = async (meter, alarmType) => {
  const existing = await query(`SELECT id FROM alarms WHERE meter_id=$1 AND alarm_type=$2 AND status IN('active','acknowledged')`, [meter.id, alarmType]);
  if (existing.rows.length > 0) return null;
  const r = await query(`INSERT INTO alarms(meter_id,device_eui,alarm_type,severity,message,status) VALUES($1,$2,$3,$4,$5,'active') RETURNING *`, [meter.id, meter.device_eui, alarmType, ALARM_SEVERITY[alarmType]||'warning', ALARM_MESSAGES[alarmType]||`${alarmType} alarm`]);
  return { ...r.rows[0], meter };
};

const processAlarms = async (meter, decoded) => {
  const newAlarms = [];
  for (const [alarmType, isActive] of Object.entries(decoded.alarmFlags || {})) {
    if (!isActive) continue;
    const alarm = await raiseAlarm(meter, alarmType);
    if (alarm) newAlarms.push(alarm);
  }

  if (decoded.pressure !== null && decoded.pressure !== undefined) {
    if (decoded.pressure < LOW_PRESSURE_KPA) {
      const alarm = await raiseAlarm(meter, 'low_pressure');
      if (alarm) newAlarms.push(alarm);
    } else if (decoded.pressure > HIGH_PRESSURE_KPA) {
      const alarm = await raiseAlarm(meter, 'high_pressure');
      if (alarm) newAlarms.push(alarm);
    }
  }

  return newAlarms;
};

// Server-side backstop for devices without an onboard leak-detection bit:
// flags sustained non-zero flow over a rolling window as a possible leak.
const checkContinuousFlow = async (meter) => {
  const r = await query(
    `SELECT current_flow FROM meter_readings WHERE meter_id=$1 AND timestamp >= NOW() - INTERVAL '${LEAK_WINDOW_HOURS} hours' ORDER BY timestamp DESC`,
    [meter.id]
  );
  if (r.rows.length < LEAK_MIN_READINGS) return null;
  const allFlowing = r.rows.every(row => row.current_flow !== null && row.current_flow > LEAK_MIN_FLOW);
  if (!allFlowing) return null;
  return raiseAlarm(meter, 'water_leakage');
};

const checkOfflineMeters = async () => {
  try {
    const r = await query(`UPDATE meters SET is_online=false,updated_at=NOW() WHERE is_online=true AND last_seen<NOW()-INTERVAL '2 hours' AND status='active' RETURNING id,device_eui`);
    for (const meter of r.rows) {
      const existing = await query(`SELECT id FROM alarms WHERE meter_id=$1 AND alarm_type='communication_loss' AND status='active'`, [meter.id]);
      if (!existing.rows.length) {
        const ins = await query(`INSERT INTO alarms(meter_id,device_eui,alarm_type,severity,message) VALUES($1,$2,'communication_loss','warning',$3) RETURNING *`, [meter.id, meter.device_eui, ALARM_MESSAGES.communication_loss]);
        await sendNotification(ins.rows[0], meter);
      }
    }
    if (r.rows.length > 0) logger.info(`📡 ${r.rows.length} meters marked offline`);
  } catch (err) { logger.error('Offline meter check error', { error: err.message }); }
};

const checkOfflineGateways = async () => {
  try {
    const r = await query(`UPDATE gateways SET is_online=false,updated_at=NOW() WHERE is_online=true AND last_seen<NOW()-INTERVAL '2 hours' RETURNING id,gateway_eui`);
    if (r.rows.length > 0) logger.info(`📡 ${r.rows.length} gateway(s) marked offline`);
  } catch (err) { logger.error('Gateway offline check error', { error: err.message }); }
};

// Statistical backstop (mean + N*stddev over a trailing window) for sustained
// high flow that isn't necessarily a leak (device leak bit / continuous-flow
// check) but is still well outside this specific meter's normal pattern —
// e.g. a burst pipe downstream of the meter, or a stuck-open tap.
const ABNORMAL_FLOW_STDDEV_MULTIPLIER = 3;
const ABNORMAL_WINDOW_DAYS = 7;
const ABNORMAL_MIN_READINGS = 10;

const checkAbnormalConsumption = async () => {
  try {
    const r = await query(
      `WITH meter_stats AS (
         SELECT meter_id, AVG(current_flow) AS avg_flow, STDDEV(current_flow) AS std_flow
         FROM meter_readings WHERE timestamp >= NOW() - INTERVAL '${ABNORMAL_WINDOW_DAYS} days'
         GROUP BY meter_id HAVING COUNT(*) > ${ABNORMAL_MIN_READINGS}
       )
       SELECT m.id, m.device_eui FROM meters m
       JOIN meter_stats ms ON m.id = ms.meter_id
       WHERE m.status='active' AND ms.std_flow > 0
         AND m.current_flow > ms.avg_flow + ${ABNORMAL_FLOW_STDDEV_MULTIPLIER} * ms.std_flow`
    );

    const newAlarms = [];
    for (const meter of r.rows) {
      const alarm = await raiseAlarm(meter, 'abnormal_consumption');
      if (alarm) {
        await sendNotification(alarm, meter);
        realtimeService.publish('alarm', { meterId: meter.id, deviceEui: meter.device_eui, alarm });
        newAlarms.push(alarm);
      }
    }
    if (newAlarms.length) logger.info(`📈 ${newAlarms.length} abnormal consumption alarm(s) raised`);
    return newAlarms;
  } catch (err) { logger.error('Abnormal consumption check error', { error: err.message }); return []; }
};

module.exports = { processAlarms, checkOfflineMeters, checkContinuousFlow, checkOfflineGateways, checkAbnormalConsumption };
