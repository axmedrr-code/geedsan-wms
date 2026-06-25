const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');

router.get('/stats', authenticate, async (req, res) => {
  try {
    const r = await query(`SELECT (SELECT COUNT(*) FROM meters WHERE status='active') AS total_meters,(SELECT COUNT(*) FROM meters WHERE is_online=true AND status='active') AS online_meters,(SELECT COUNT(*) FROM meters WHERE is_online=false AND status='active') AS offline_meters,(SELECT COALESCE(SUM(total_consumption),0) FROM meters WHERE status='active') AS total_consumption,(SELECT COUNT(*) FROM alarms WHERE status='active') AS active_alarms,(SELECT COUNT(*) FROM meters WHERE battery_voltage<3.2 AND battery_voltage IS NOT NULL AND status='active') AS low_battery_count,(SELECT COUNT(*) FROM alarms WHERE status='active' AND severity='critical') AS critical_alarms,(SELECT COUNT(*) FROM customers WHERE account_status='active') AS total_customers`);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch stats' }); }
});

router.get('/consumption-chart', authenticate, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const r = await query(`SELECT DATE(timestamp) AS date, SUM(CASE WHEN current_flow>0 THEN current_flow ELSE 0 END) AS total_flow, COUNT(DISTINCT meter_id) AS active_meters FROM meter_readings WHERE timestamp>=NOW()-INTERVAL '${parseInt(days)} days' GROUP BY DATE(timestamp) ORDER BY date ASC`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch chart' }); }
});

router.get('/alarm-summary', authenticate, async (req, res) => {
  try {
    const r = await query(`SELECT alarm_type,severity,COUNT(*) AS count,COUNT(*) FILTER(WHERE status='active') AS active_count FROM alarms WHERE triggered_at>=NOW()-INTERVAL '30 days' GROUP BY alarm_type,severity ORDER BY active_count DESC`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch alarm summary' }); }
});

router.get('/recent-alarms', authenticate, async (req, res) => {
  try {
    const r = await query(`SELECT a.*,m.meter_number,m.device_eui,c.full_name AS customer_name FROM alarms a LEFT JOIN meters m ON a.meter_id=m.id LEFT JOIN customers c ON m.customer_id=c.id WHERE a.status='active' ORDER BY a.triggered_at DESC LIMIT 10`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch recent alarms' }); }
});

router.get('/meter-distribution', authenticate, async (req, res) => {
  try {
    const [status, battery, valve] = await Promise.all([
      query(`SELECT status,COUNT(*) AS count FROM meters GROUP BY status`),
      query(`SELECT CASE WHEN battery_voltage IS NULL THEN 'unknown' WHEN battery_voltage<3.0 THEN 'critical' WHEN battery_voltage<3.2 THEN 'low' WHEN battery_voltage<3.6 THEN 'medium' ELSE 'good' END AS level,COUNT(*) AS count FROM meters WHERE status='active' GROUP BY level`),
      query(`SELECT valve_status,COUNT(*) AS count FROM meters WHERE status='active' GROUP BY valve_status`)
    ]);
    res.json({ status: status.rows, battery: battery.rows, valve: valve.rows });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch distribution' }); }
});

router.get('/top-consumers', authenticate, async (req, res) => {
  try {
    const r = await query(`SELECT m.id,m.meter_number,m.device_eui,m.total_consumption,m.current_flow,c.full_name AS customer_name FROM meters m LEFT JOIN customers c ON m.customer_id=c.id WHERE m.status='active' ORDER BY m.total_consumption DESC LIMIT 10`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch top consumers' }); }
});

module.exports = router;
