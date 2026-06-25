const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  try {
    const { status, alarm_type, severity, meter_id, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    let conditions = ['1=1'], params = [], idx = 1;
    if (status) { conditions.push(`a.status=$${idx++}`); params.push(status); }
    if (alarm_type) { conditions.push(`a.alarm_type=$${idx++}`); params.push(alarm_type); }
    if (severity) { conditions.push(`a.severity=$${idx++}`); params.push(severity); }
    if (meter_id) { conditions.push(`a.meter_id=$${idx++}`); params.push(meter_id); }
    const where = conditions.join(' AND ');
    const countR = await query(`SELECT COUNT(*) FROM alarms a WHERE ${where}`, params);
    const r = await query(`SELECT a.*,m.meter_number,m.device_eui,c.full_name AS customer_name,u1.full_name AS acknowledged_by_name,u2.full_name AS resolved_by_name FROM alarms a LEFT JOIN meters m ON a.meter_id=m.id LEFT JOIN customers c ON m.customer_id=c.id LEFT JOIN users u1 ON a.acknowledged_by=u1.id LEFT JOIN users u2 ON a.resolved_by=u2.id WHERE ${where} ORDER BY CASE a.status WHEN 'active' THEN 1 WHEN 'acknowledged' THEN 2 ELSE 3 END,CASE a.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,a.triggered_at DESC LIMIT $${idx} OFFSET $${idx+1}`, [...params, limit, offset]);
    res.json({ data: r.rows, pagination: { total: parseInt(countR.rows[0].count), page: parseInt(page), limit: parseInt(limit) } });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch alarms' }); }
});

router.post('/:id/acknowledge', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const r = await query(`UPDATE alarms SET status='acknowledged',acknowledged_at=NOW(),acknowledged_by=$1 WHERE id=$2 AND status='active' RETURNING *`, [req.user.id, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Alarm not found or already acknowledged' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Failed to acknowledge alarm' }); }
});

router.post('/:id/resolve', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const { resolution_notes } = req.body;
    const r = await query(`UPDATE alarms SET status='resolved',resolved_at=NOW(),resolved_by=$1,resolution_notes=$2 WHERE id=$3 AND status IN('active','acknowledged') RETURNING *`, [req.user.id, resolution_notes, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Alarm not found or already resolved' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Failed to resolve alarm' }); }
});

router.post('/', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const { meter_id, alarm_type, severity = 'warning', message } = req.body;
    const mr = await query('SELECT device_eui FROM meters WHERE id=$1', [meter_id]);
    if (!mr.rows[0]) return res.status(404).json({ error: 'Meter not found' });
    const r = await query(`INSERT INTO alarms (meter_id,device_eui,alarm_type,severity,message) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [meter_id, mr.rows[0].device_eui, alarm_type, severity, message]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Failed to create alarm' }); }
});

router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  await query('DELETE FROM alarms WHERE id=$1', [req.params.id]);
  res.json({ message: 'Alarm deleted' });
});

module.exports = router;
