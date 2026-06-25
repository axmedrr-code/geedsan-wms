const { query } = require('../config/database');

const ALARM_SEVERITY = { low_battery:'warning',valve_failure:'critical',magnetic_attack:'critical',water_leakage:'warning',reverse_flow:'warning',pipe_burst:'critical',no_flow:'info',communication_loss:'warning' };
const ALARM_MESSAGES = { low_battery:'Battery voltage is below threshold.',valve_failure:'Valve operation failure detected.',magnetic_attack:'Magnetic tampering detected.',water_leakage:'Continuous flow detected, possible leakage.',reverse_flow:'Reverse flow detected.',pipe_burst:'Abnormally high flow rate, possible pipe burst.',communication_loss:'Device has not reported for an extended period.' };

const processAlarms = async (meter, decoded) => {
  const newAlarms = [];
  for (const [alarmType, isActive] of Object.entries(decoded.alarmFlags || {})) {
    if (!isActive) continue;
    const existing = await query(`SELECT id FROM alarms WHERE meter_id=$1 AND alarm_type=$2 AND status IN('active','acknowledged')`, [meter.id, alarmType]);
    if (existing.rows.length > 0) continue;
    const r = await query(`INSERT INTO alarms(meter_id,device_eui,alarm_type,severity,message,status) VALUES($1,$2,$3,$4,$5,'active') RETURNING *`, [meter.id, meter.device_eui, alarmType, ALARM_SEVERITY[alarmType]||'warning', ALARM_MESSAGES[alarmType]||`${alarmType} alarm`]);
    newAlarms.push({ ...r.rows[0], meter });
  }
  return newAlarms;
};

const checkOfflineMeters = async () => {
  try {
    const r = await query(`UPDATE meters SET is_online=false,updated_at=NOW() WHERE is_online=true AND last_seen<NOW()-INTERVAL '2 hours' AND status='active' RETURNING id,device_eui`);
    for (const meter of r.rows) {
      const existing = await query(`SELECT id FROM alarms WHERE meter_id=$1 AND alarm_type='communication_loss' AND status='active'`, [meter.id]);
      if (!existing.rows.length) await query(`INSERT INTO alarms(meter_id,device_eui,alarm_type,severity,message) VALUES($1,$2,'communication_loss','warning',$3)`, [meter.id, meter.device_eui, ALARM_MESSAGES.communication_loss]);
    }
    if (r.rows.length > 0) console.log(`📡 ${r.rows.length} meters marked offline`);
  } catch (err) { console.error('Offline check error:', err.message); }
};

module.exports = { processAlarms, checkOfflineMeters };
