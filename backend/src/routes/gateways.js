const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

/**
 * @openapi
 * /gateways:
 *   get:
 *     summary: List LoRaWAN gateways
 *     tags: [Gateways]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: List of gateways with uplink stats
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const r = await query(`SELECT g.*,(SELECT COUNT(*) FROM meter_readings mr WHERE mr.gateway_eui=g.gateway_eui AND mr.timestamp >= NOW()-INTERVAL '24 hours') AS readings_24h FROM gateways g ORDER BY g.last_seen DESC NULLS LAST`);
    res.json({ data: r.rows });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch gateways' }); }
});

/**
 * @openapi
 * /gateways/{id}:
 *   get:
 *     summary: Get a single gateway by id or EUI
 *     tags: [Gateways]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const r = await query(`SELECT * FROM gateways WHERE id::text=$1 OR gateway_eui=$1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Gateway not found' });
    const meters = await query(
      `SELECT DISTINCT m.id, m.meter_number, m.device_eui FROM meters m
       JOIN meter_readings mr ON mr.meter_id=m.id
       WHERE mr.gateway_eui=$1 AND mr.timestamp >= NOW()-INTERVAL '7 days'`,
      [r.rows[0].gateway_eui]
    );
    res.json({ gateway: r.rows[0], meters: meters.rows });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch gateway' }); }
});

/**
 * @openapi
 * /gateways:
 *   post:
 *     summary: Manually register a gateway (gateways also self-register from traffic)
 *     tags: [Gateways]
 *     security: [{ bearerAuth: [] }]
 */
router.post('/', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const { gateway_eui, name, description, latitude, longitude } = req.body;
    if (!gateway_eui) return res.status(400).json({ error: 'gateway_eui is required' });
    const r = await query(
      `INSERT INTO gateways(gateway_eui, name, description, latitude, longitude) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (gateway_eui) DO UPDATE SET name=$2, description=$3, latitude=$4, longitude=$5, updated_at=NOW()
       RETURNING *`,
      [gateway_eui.toUpperCase(), name, description, latitude, longitude]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Failed to register gateway' }); }
});

router.put('/:id', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const { name, description, latitude, longitude, status } = req.body;
    const r = await query(
      `UPDATE gateways SET name=COALESCE($1,name), description=COALESCE($2,description), latitude=COALESCE($3,latitude), longitude=COALESCE($4,longitude), status=COALESCE($5,status), updated_at=NOW() WHERE id=$6 RETURNING *`,
      [name, description, latitude, longitude, status, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Gateway not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Failed to update gateway' }); }
});

router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  const r = await query('DELETE FROM gateways WHERE id=$1 RETURNING id', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Gateway not found' });
  res.json({ message: 'Gateway deleted' });
});

module.exports = router;
