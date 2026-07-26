const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /water-types — list; optional ?active=true filter
router.get('/', authenticate, async (req, res) => {
  try {
    const { active } = req.query;
    const params = [];
    const where = active === 'true' ? (params.push(true), 'WHERE is_active = $1') : '';
    const r = await query(`SELECT * FROM water_types ${where} ORDER BY is_default DESC, name`, params);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /water-types/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const r = await query('SELECT * FROM water_types WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Water type not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /water-types — admin only
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { code, name, description, is_default = false } = req.body;
    if (!code?.trim() || !name?.trim()) {
      return res.status(400).json({ error: 'code and name are required' });
    }
    const r = await query(
      `INSERT INTO water_types (code, name, description, is_default) VALUES ($1,$2,$3,$4) RETURNING *`,
      [code.trim().toLowerCase(), name.trim(), description || null, !!is_default]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `Water type code '${req.body.code}' already exists` });
    res.status(500).json({ error: err.message });
  }
});

// PUT /water-types/:id — admin only. Soft-deactivate via is_active rather
// than hard delete — meters/water_tariffs reference this table by FK.
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { name, description, is_default, is_active } = req.body;
    const r = await query(
      `UPDATE water_types SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         is_default  = COALESCE($3, is_default),
         is_active   = COALESCE($4, is_active),
         updated_at  = NOW()
       WHERE id = $5 RETURNING *`,
      [name || null, description ?? null, is_default, is_active, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Water type not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
