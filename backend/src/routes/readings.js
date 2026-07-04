const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');

/**
 * @openapi
 * /readings:
 *   get:
 *     summary: Cross-meter reading feed (most recent readings across all meters)
 *     tags: [Readings]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: meter_id
 *         schema: { type: string }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100 }
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const { meter_id, from, to, limit = 100, page = 1 } = req.query;
    const params = [];
    let where = '1=1';
    if (meter_id) { params.push(meter_id); where += ` AND mr.meter_id=$${params.length}`; }
    if (from) { params.push(from); where += ` AND mr.timestamp>=$${params.length}`; }
    if (to) { params.push(to); where += ` AND mr.timestamp<=$${params.length}`; }
    const offset = (parseInt(page) - 1) * parseInt(limit);
    params.push(parseInt(limit), offset);
    const r = await query(
      `SELECT mr.*, m.meter_number, m.customer_id FROM meter_readings mr
       JOIN meters m ON m.id = mr.meter_id
       WHERE ${where} ORDER BY mr.timestamp DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: r.rows });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch readings' }); }
});

module.exports = router;
