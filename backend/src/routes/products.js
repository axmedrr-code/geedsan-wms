const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    let where = '1=1';
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      where += ` AND (p.name ILIKE $${params.length} OR p.product_code ILIKE $${params.length})`;
    }

    const countR = await query(`SELECT COUNT(*) FROM products p WHERE ${where}`, params);
    const r = await query(`SELECT p.* FROM products p WHERE ${where} ORDER BY p.name LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]);
    res.json({ data: r.rows, pagination: { total: parseInt(countR.rows[0].count, 10), page: parseInt(page, 10), limit: parseInt(limit, 10) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const r = await query('SELECT * FROM products WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Product not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

router.post('/', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const { product_code, name, description, unit, unit_price, status = 'active' } = req.body;
    if (!product_code || !name || !unit_price) {
      return res.status(400).json({ error: 'Missing product fields' });
    }
    const r = await query('INSERT INTO products (product_code,name,description,unit,unit_price,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW()) RETURNING *', [product_code, name, description, unit || 'unit', unit_price, status]);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Product code already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

router.put('/:id', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const { product_code, name, description, unit, unit_price, status } = req.body;
    const r = await query(
      'UPDATE products SET product_code=COALESCE($1,product_code), name=COALESCE($2,name), description=COALESCE($3,description), unit=COALESCE($4,unit), unit_price=COALESCE($5,unit_price), status=COALESCE($6,status), updated_at=NOW() WHERE id=$7 RETURNING *',
      [product_code, name, description, unit, unit_price, status, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Product not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

module.exports = router;
