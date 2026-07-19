const express = require('express');
const router = express.Router();
const { query, getClient } = require('../config/database');
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
    const r=await query(`SELECT m.*,c.full_name AS customer_name,c.house_number,(SELECT COUNT(*) FROM alarms a WHERE a.meter_id=m.id AND a.status='active') AS active_alarms FROM meters m LEFT JOIN customers c ON m.customer_id=c.id WHERE ${where} ORDER BY m.last_seen DESC NULLS LAST,m.meter_number ASC LIMIT $${pi} OFFSET $${pi+1}`,[...params,limit,offset]);
    res.json({data:r.rows,pagination:{total:parseInt(countR.rows[0].count),page:parseInt(page),limit:parseInt(limit),pages:Math.ceil(countR.rows[0].count/limit)}});
  } catch(err){res.status(500).json({error:'Failed to fetch meters'});}
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const r=await query(`SELECT m.*,c.full_name AS customer_name,c.house_number,c.phone AS customer_phone,c.email AS customer_email FROM meters m LEFT JOIN customers c ON m.customer_id=c.id WHERE m.id::text=$1 OR m.device_eui=$1`,[req.params.id]);
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
    const {device_eui,meter_number,customer_id,application_id,latitude,longitude,installation_address,firmware_version,notes,serial_number,zone_id}=req.body;
    if(!device_eui||!meter_number) return res.status(400).json({error:'Device EUI and meter number required'});
    const r=await query(`INSERT INTO meters(device_eui,meter_number,customer_id,application_id,latitude,longitude,installation_address,firmware_version,notes,serial_number,zone_id,installed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()) RETURNING *`,[device_eui.toUpperCase(),meter_number,customer_id,application_id,latitude,longitude,installation_address,firmware_version,notes,serial_number||null,zone_id||null]);
    res.status(201).json(r.rows[0]);
  } catch(err){
    if(err.code==='23505') return res.status(409).json({error:'Device EUI or meter number already exists'});
    res.status(500).json({error:'Failed to create meter'});
  }
});

router.put('/:id', authenticate, authorize('admin','operator'), async (req,res) => {
  try {
    const {meter_number,customer_id,application_id,latitude,longitude,installation_address,firmware_version,notes,status,serial_number,zone_id}=req.body;
    const r=await query(`UPDATE meters SET meter_number=COALESCE($1,meter_number),customer_id=COALESCE($2,customer_id),application_id=COALESCE($3,application_id),latitude=COALESCE($4,latitude),longitude=COALESCE($5,longitude),installation_address=COALESCE($6,installation_address),firmware_version=COALESCE($7,firmware_version),notes=COALESCE($8,notes),status=COALESCE($9,status),serial_number=COALESCE($10,serial_number),zone_id=COALESCE($11,zone_id),updated_at=NOW() WHERE id=$12 RETURNING *`,[meter_number,customer_id,application_id,latitude,longitude,installation_address,firmware_version,notes,status,serial_number||null,zone_id||null,req.params.id]);
    if(!r.rows[0]) return res.status(404).json({error:'Meter not found'});
    res.json(r.rows[0]);
  } catch(err){res.status(500).json({error:'Failed to update meter'});}
});

router.delete('/:id', authenticate, authorize('admin'), async (req,res) => {
  const r=await query('DELETE FROM meters WHERE id=$1 RETURNING id',[req.params.id]);
  if(!r.rows[0]) return res.status(404).json({error:'Meter not found'});
  res.json({message:'Meter deleted'});
});

// POST /meters/:id/replace — Replace Meter workflow
// Marks old meter as 'replaced', creates new meter as 'active', links them.
router.post('/:id/replace', authenticate, authorize('admin', 'operator'), async (req, res) => {
  const { new_meter_number, new_device_eui, new_serial_number, replacement_reason } = req.body;

  if (!new_meter_number?.trim() || !new_device_eui?.trim()) {
    return res.status(400).json({ error: 'new_meter_number and new_device_eui are required' });
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const oldR = await client.query('SELECT * FROM meters WHERE id=$1', [req.params.id]);
    if (!oldR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Meter not found' }); }
    const old = oldR.rows[0];

    if (!old.customer_id) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Meter has no assigned customer — assign it first' }); }
    if (old.status !== 'active') { await client.query('ROLLBACK'); return res.status(400).json({ error: `Only active meters can be replaced (current status: ${old.status})` }); }

    // Create new active meter (inherits customer, zone, and installation address from old)
    const newMeter = await client.query(`
      INSERT INTO meters
        (device_eui, meter_number, customer_id, serial_number, zone_id,
         installation_address, application_id, replacement_reason, installed_at, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),'active')
      RETURNING *
    `, [
      new_device_eui.trim().toUpperCase(),
      new_meter_number.trim(),
      old.customer_id,
      new_serial_number || null,
      old.zone_id,
      old.installation_address,
      old.application_id,
      replacement_reason || null,
    ]);

    // Mark old meter as replaced and link to new meter
    await client.query(`
      UPDATE meters SET
        status               = 'replaced',
        replacement_reason   = $1,
        replaced_at          = NOW(),
        replaced_by_meter_id = $2,
        updated_at           = NOW()
      WHERE id = $3
    `, [replacement_reason || null, newMeter.rows[0].id, old.id]);

    await client.query('COMMIT');

    res.status(201).json({
      old_meter: { id: old.id, meter_number: old.meter_number, status: 'replaced' },
      new_meter: newMeter.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'New meter number or device EUI already exists' });
    console.error('POST /meters/:id/replace error:', err);
    res.status(500).json({ error: 'Failed to replace meter' });
  } finally {
    client.release();
  }
});

router.get('/:id/readings', authenticate, async (req,res) => {
  try {
    const {from,to,interval='hour',limit=200}=req.query;
    let params=[req.params.id], tf='';
    if(from){params.push(from);tf+=` AND timestamp>=$${params.length}`;}
    if(to){params.push(to);tf+=` AND timestamp<=$${params.length}`;}
    const r=await query(`SELECT date_trunc($${params.length+1},timestamp) AS period,AVG(current_flow) AS avg_flow,MAX(total_consumption)-MIN(total_consumption) AS consumption,AVG(battery_voltage) AS battery_voltage,AVG(pressure) AS pressure,AVG(rssi) AS rssi,COUNT(*) AS reading_count FROM meter_readings WHERE meter_id=$1 ${tf} GROUP BY period ORDER BY period ASC LIMIT ${parseInt(limit)}`,[...params,interval]);
    res.json(r.rows);
  } catch(err){res.status(500).json({error:'Failed to fetch readings'});}
});

// Dense historical flow records decoded from the device's T=0x22/0xA2 block
router.get('/:id/flow-history', authenticate, async (req,res) => {
  try {
    const {from,to,limit=500}=req.query;
    let params=[req.params.id], tf='';
    if(from){params.push(from);tf+=` AND recorded_at>=$${params.length}`;}
    if(to){params.push(to);tf+=` AND recorded_at<=$${params.length}`;}
    params.push(parseInt(limit));
    const r=await query(`SELECT recorded_at,interval_minutes,consumption_pulses FROM meter_flow_history WHERE meter_id=$1 ${tf} ORDER BY recorded_at DESC LIMIT $${params.length}`,params);
    res.json(r.rows);
  } catch(err){res.status(500).json({error:'Failed to fetch flow history'});}
});

router.get('/:id/packets', authenticate, async (req,res) => {
  try {
    const {limit=100}=req.query;
    const r=await query(
      `SELECT timestamp,rssi,snr,gateway_eui,f_port,f_cnt,pulse_count,battery_voltage,pressure,status_word_1,status_word_2,trigger_source,raw_payload
       FROM meter_readings WHERE meter_id=$1 ORDER BY timestamp DESC LIMIT $2`,
      [req.params.id, parseInt(limit)]
    );
    res.json({ data: r.rows });
  } catch(err){res.status(500).json({error:'Failed to fetch packet history'});}
});

router.get('/:id/signal', authenticate, async (req,res) => {
  try {
    const {hours=72,limit=300}=req.query;
    const r=await query(
      `SELECT timestamp,rssi,snr,gateway_eui FROM meter_readings
       WHERE meter_id=$1 AND timestamp >= NOW() - INTERVAL '1 hour' * $2 AND rssi IS NOT NULL
       ORDER BY timestamp ASC LIMIT $3`,
      [req.params.id, parseInt(hours), parseInt(limit)]
    );
    res.json({ data: r.rows });
  } catch(err){res.status(500).json({error:'Failed to fetch signal history'});}
});

// ── Consumption endpoints ─────────────────────────────────────────────────────
const { getConsumption, getBillingPeriodConsumption } = require('../services/consumptionService');
const { getLeakEvents, updateLeakEvent, detectLeaks } = require('../services/leakDetectionService');

router.get('/:id/consumption', authenticate, async (req, res) => {
  try {
    const { period, from, to } = req.query;
    const data = await getConsumption(req.params.id, { period, from, to });
    res.json(data);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch consumption data' }); }
});

router.get('/:id/consumption/billing-period', authenticate, async (req, res) => {
  try {
    const current = req.query.current !== 'false';
    const data = await getBillingPeriodConsumption(req.params.id, { current });
    res.json(data);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch billing period consumption' }); }
});

// ── Leak detection endpoints ──────────────────────────────────────────────────
router.get('/:id/leaks', authenticate, async (req, res) => {
  try {
    const { status, limit, offset } = req.query;
    const data = await getLeakEvents(req.params.id, { status, limit, offset });
    res.json(data);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch leak events' }); }
});

router.post('/:id/leaks/detect', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const opened = await detectLeaks(req.params.id);
    res.json({ detected: opened });
  } catch (err) { res.status(500).json({ error: 'Leak detection failed' }); }
});

router.patch('/:id/leaks/:leakId', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const { status, notes } = req.body;
    const updated = await updateLeakEvent(req.params.leakId, { status, notes, resolvedBy: req.user.id });
    res.json(updated);
  } catch (err) {
    if (err.message === 'Leak event not found') return res.status(404).json({ error: err.message });
    if (err.message.startsWith('Invalid status')) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Failed to update leak event' });
  }
});

// ── Device health score ───────────────────────────────────────────────────────
const { getDeviceHealth } = require('../services/deviceHealthService');

router.get('/:id/health', authenticate, async (req, res) => {
  try {
    const health = await getDeviceHealth(req.params.id);
    if (!health) return res.status(404).json({ error: 'Meter not found' });
    res.json(health);
  } catch (err) { res.status(500).json({ error: 'Failed to compute health score' }); }
});

module.exports = router;
