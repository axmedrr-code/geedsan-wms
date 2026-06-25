const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    let where = '1=1', params = [];
    if (search) { params.push(`%${search}%`); where += ` AND (c.full_name ILIKE $1 OR c.customer_number ILIKE $1 OR c.email ILIKE $1)`; }
    const r = await query(`SELECT c.*, COUNT(m.id) AS meter_count FROM customers c LEFT JOIN meters m ON c.id=m.customer_id AND m.status='active' WHERE ${where} GROUP BY c.id ORDER BY c.full_name LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]);
    res.json({ data: r.rows });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch customers' }); }
});

router.get('/:id', authenticate, async (req, res) => {
  const r = await query('SELECT c.*, COUNT(m.id) AS meter_count, SUM(m.total_consumption) AS total_consumption FROM customers c LEFT JOIN meters m ON c.id=m.customer_id WHERE c.id=$1 GROUP BY c.id', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Customer not found' });
  const meters = await query('SELECT * FROM meters WHERE customer_id=$1', [req.params.id]);
  res.json({ customer: r.rows[0], meters: meters.rows });
});

router.post('/', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const { customer_number, full_name, email, phone, address, city, district, tariff_type } = req.body;
    const r = await query('INSERT INTO customers (customer_number,full_name,email,phone,address,city,district,tariff_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [customer_number, full_name, email, phone, address, city, district, tariff_type || 'residential']);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Customer number already exists' });
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

router.put('/:id', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const { full_name, email, phone, address, city, district, tariff_type, account_status } = req.body;
    const r = await query('UPDATE customers SET full_name=COALESCE($1,full_name),email=COALESCE($2,email),phone=COALESCE($3,phone),address=COALESCE($4,address),city=COALESCE($5,city),district=COALESCE($6,district),tariff_type=COALESCE($7,tariff_type),account_status=COALESCE($8,account_status),updated_at=NOW() WHERE id=$9 RETURNING *', [full_name, email, phone, address, city, district, tariff_type, account_status, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Customer not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Failed to update customer' }); }
});

module.exports = router;
