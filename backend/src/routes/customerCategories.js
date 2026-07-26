const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /customer-categories — list; optional ?active=true filter
router.get('/', authenticate, async (req, res) => {
  try {
    const { active } = req.query;
    const params = [];
    const where = active === 'true' ? (params.push(true), 'WHERE is_active = $1') : '';
    const r = await query(`SELECT * FROM customer_categories ${where} ORDER BY name`, params);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /customer-categories/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const r = await query('SELECT * FROM customer_categories WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Customer category not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /customer-categories — admin only
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { code, name, description } = req.body;
    if (!code?.trim() || !name?.trim()) {
      return res.status(400).json({ error: 'code and name are required' });
    }
    const r = await query(
      `INSERT INTO customer_categories (code, name, description) VALUES ($1,$2,$3) RETURNING *`,
      [code.trim().toLowerCase(), name.trim(), description || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `Customer category code '${req.body.code}' already exists` });
    res.status(500).json({ error: err.message });
  }
});

// PUT /customer-categories/:id — admin only. Soft-deactivate via
// is_active rather than hard delete — customers/invoices/water_tariffs
// reference this table by FK (on customers.tariff_type etc.).
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { name, description, is_active } = req.body;
    const r = await query(
      `UPDATE customer_categories SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         is_active   = COALESCE($3, is_active),
         updated_at  = NOW()
       WHERE id = $4 RETURNING *`,
      [name || null, description ?? null, is_active, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Customer category not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
