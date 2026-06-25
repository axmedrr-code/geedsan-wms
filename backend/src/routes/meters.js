const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  try {
    const { page=1, limit=50, status, search, customer_id } = req.query;
    const offset = (page-1)*limit;
    let conditions=['1=1'], params=[], pi=1;
    if(status){conditions.push(`m.status=$${pi++}`);params.push(status);}
    if(customer_id){conditions.push(`m.customer_id=$${pi++}`);params.push(customer_id);}
    if(search){conditions.push(`(m.device_eui ILIKE $${pi} OR m.meter_number ILIKE $${pi} OR c.full_name ILIKE $${pi})`);params.push(`%${search}%`);pi++;}
    const where=conditions.join(' AND ');
    const countR=await query(`SELECT COUNT(*) FROM meters m LEFT JOIN customers c ON m.customer_id=c.id WHERE ${where}`,params);
    const r=await query(`SELECT m.*,c.full_name AS customer_name,c.customer_number,(SELECT COUNT(*) FROM alarms a WHERE a.meter_id=m.id AND a.status='active') AS active_alarms FROM meters m LEFT JOIN customers c ON m.customer_id=c.id WHERE ${where} ORDER BY m.last_seen DESC NULLS LAST,m.meter_number ASC LIMIT $${pi} OFFSET $${pi+1}`,[...params,limit,offset]);
    res.json({data:r.rows,pagination:{total:parseInt(countR.rows[0].count),page:parseInt(page),limit:parseInt(limit),pages:Math.ceil(countR.rows[0].count/limit)}});
  } catch(err){res.status(500).json({error:'Failed to fetch meters'});}
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const r=await query(`SELECT m.*,c.full_name AS customer_name,c.customer_number,c.phone AS customer_phone,c.email AS customer_email FROM meters m LEFT JOIN customers c ON m.customer_id=c.id WHERE m.id=$1 OR m.device_eui=$1`,[req.params.id]);
    if(!r.rows[0]) return res.status(404).json({error:'Meter not found'});
    const meter=r.rows[0];
    const [readings,alarms,commands]=await Promise.all([
      query(`SELECT * FROM meter_readings WHERE meter_id=$1 ORDER BY timestamp DESC LIMIT 100`,[meter.id]),
      query(`SELECT * FROM alarms WHERE meter_id=$1 ORDER BY triggered_at DESC LIMIT 20`,[meter.id]),
      query(`SELECT dc.*,u.full_name AS sent_by_name FROM downlink_commands dc LEFT JOIN users u ON dc.sent_by=u.id WHERE dc.meter_id=$1 ORDER BY dc.created_at DESC LIMIT 10`,[meter.id])
    ]);
    res.json({meter,readings:readings.rows,alarms:alarms.rows,commands:commands.rows});
  } catch(err){res.status(500).json({error:'Failed to fetch meter'});}
});

router.post('/', authenticate, authorize('admin','operator'), async (req,res) => {
  try {
    const {device_eui,meter_number,customer_id,application_id,latitude,longitude,installation_address,firmware_version,notes}=req.body;
    if(!device_eui||!meter_number) return res.status(400).json({error:'Device EUI and meter number required'});
    const r=await query(`INSERT INTO meters(device_eui,meter_number,customer_id,application_id,latitude,longitude,installation_address,firmware_version,notes,installed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING *`,[device_eui.toUpperCase(),meter_number,customer_id,application_id,latitude,longitude,installation_address,firmware_version,notes]);
    res.status(201).json(r.rows[0]);
  } catch(err){
    if(err.code==='23505') return res.status(409).json({error:'Device EUI or meter number already exists'});
    res.status(500).json({error:'Failed to create meter'});
  }
});

router.put('/:id', authenticate, authorize('admin','operator'), async (req,res) => {
  try {
    const {meter_number,customer_id,application_id,latitude,longitude,installation_address,firmware_version,notes,status}=req.body;
    const r=await query(`UPDATE meters SET meter_number=COALESCE($1,meter_number),customer_id=COALESCE($2,customer_id),application_id=COALESCE($3,application_id),latitude=COALESCE($4,latitude),longitude=COALESCE($5,longitude),installation_address=COALESCE($6,installation_address),firmware_version=COALESCE($7,firmware_version),notes=COALESCE($8,notes),status=COALESCE($9,status),updated_at=NOW() WHERE id=$10 RETURNING *`,[meter_number,customer_id,application_id,latitude,longitude,installation_address,firmware_version,notes,status,req.params.id]);
    if(!r.rows[0]) return res.status(404).json({error:'Meter not found'});
    res.json(r.rows[0]);
  } catch(err){res.status(500).json({error:'Failed to update meter'});}
});

router.delete('/:id', authenticate, authorize('admin'), async (req,res) => {
  const r=await query('DELETE FROM meters WHERE id=$1 RETURNING id',[req.params.id]);
  if(!r.rows[0]) return res.status(404).json({error:'Meter not found'});
  res.json({message:'Meter deleted'});
});

router.get('/:id/readings', authenticate, async (req,res) => {
  try {
    const {from,to,interval='hour',limit=200}=req.query;
    let params=[req.params.id], tf='';
    if(from){params.push(from);tf+=` AND timestamp>=$${params.length}`;}
    if(to){params.push(to);tf+=` AND timestamp<=$${params.length}`;}
    const r=await query(`SELECT date_trunc($${params.length+1},timestamp) AS period,AVG(current_flow) AS avg_flow,MAX(total_consumption)-MIN(total_consumption) AS consumption,AVG(battery_voltage) AS battery_voltage,AVG(rssi) AS rssi,COUNT(*) AS reading_count FROM meter_readings WHERE meter_id=$1 ${tf} GROUP BY period ORDER BY period ASC LIMIT ${parseInt(limit)}`,[...params,interval]);
    res.json(r.rows);
  } catch(err){res.status(500).json({error:'Failed to fetch readings'});}
});

module.exports = router;
