const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    let where = '1=1';
    const params = [];

    if (status) { params.push(status); where += ` AND t.status=$${params.length}`; }

    const countR = await query(`SELECT COUNT(*) FROM tanker_deliveries t WHERE ${where}`, params);
    const r = await query(`SELECT t.*, c.full_name AS customer_name, c.customer_number FROM tanker_deliveries t LEFT JOIN customers c ON t.customer_id=c.id WHERE ${where} ORDER BY t.scheduled_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]);
    res.json({ data: r.rows, pagination: { total: parseInt(countR.rows[0].count), page: parseInt(page), limit: parseInt(limit) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch deliveries' });
  }
});

router.get('/:id', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const r = await query('SELECT t.*, c.full_name AS customer_name, c.customer_number, c.phone AS customer_phone FROM tanker_deliveries t LEFT JOIN customers c ON t.customer_id=c.id WHERE t.id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Delivery not found' });
    res.json({ delivery: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch delivery' });
  }
});

router.post('/', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const { customer_id, vehicle_number, driver_name, scheduled_at, delivery_volume, delivery_address, status = 'scheduled', notes } = req.body;
    if (!customer_id || !vehicle_number || !driver_name || !scheduled_at || !delivery_volume) {
      return res.status(400).json({ error: 'Missing delivery fields' });
    }

    const r = await query('INSERT INTO tanker_deliveries (customer_id,vehicle_number,driver_name,scheduled_at,delivery_volume,delivery_address,status,notes,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING *', [customer_id, vehicle_number, driver_name, scheduled_at, delivery_volume, delivery_address, status, notes, req.user.id]);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create delivery' });
  }
});

router.put('/:id', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const { status, scheduled_at, delivery_volume, delivery_address, notes } = req.body;
    const r = await query('UPDATE tanker_deliveries SET status=COALESCE($1,status), scheduled_at=COALESCE($2,scheduled_at), delivery_volume=COALESCE($3,delivery_volume), delivery_address=COALESCE($4,delivery_address), notes=COALESCE($5,notes), updated_at=NOW() WHERE id=$6 RETURNING *', [status, scheduled_at, delivery_volume, delivery_address, notes, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Delivery not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update delivery' });
  }
});

module.exports = router;
