const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /zones — list zones; optional ?status=active filter
router.get('/', authenticate, async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    const where  = status ? (params.push(status), `WHERE z.status = $1`) : '';
    const r = await query(`
      SELECT z.*,
        COUNT(DISTINCT c.id) AS customer_count,
        COUNT(DISTINCT m.id) AS meter_count
      FROM zones z
      LEFT JOIN customers c ON c.zone_id = z.id
      LEFT JOIN meters m ON m.zone_id = z.id
      ${where}
      GROUP BY z.id
      ORDER BY z.zone_code
    `, params);
    res.json(r.rows);
  } catch (err) {
    console.error('GET /zones error:', err);
    res.status(500).json({ error: 'Failed to fetch zones' });
  }
});

// GET /zones/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const r = await query('SELECT * FROM zones WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Zone not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch zone' });
  }
});

// POST /zones — admin only
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { zone_code, zone_name, description, status = 'active' } = req.body;
    if (!zone_code?.trim() || !zone_name?.trim()) {
      return res.status(400).json({ error: 'zone_code and zone_name are required' });
    }
    const r = await query(`
      INSERT INTO zones (zone_code, zone_name, description, status)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [zone_code.trim().toUpperCase(), zone_name.trim(), description || null, status]);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Zone code already exists' });
    res.status(500).json({ error: 'Failed to create zone' });
  }
});

// PUT /zones/:id — admin only
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { zone_name, description, status } = req.body;
    const r = await query(`
      UPDATE zones SET
        zone_name   = COALESCE($1, zone_name),
        description = COALESCE($2, description),
        status      = COALESCE($3, status),
        updated_at  = NOW()
      WHERE id = $4
      RETURNING *
    `, [zone_name || null, description || null, status || null, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Zone not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update zone' });
  }
});

// DELETE /zones/:id — admin only
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const inUse = await query(
      `(SELECT 1 FROM customers WHERE zone_id=$1 LIMIT 1) UNION ALL (SELECT 1 FROM meters WHERE zone_id=$1 LIMIT 1)`,
      [req.params.id]
    );
    if (inUse.rows.length) {
      return res.status(409).json({ error: 'Zone is in use — reassign customers and meters before deleting' });
    }
    const r = await query('DELETE FROM zones WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Zone not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete zone' });
  }
});

module.exports = router;
