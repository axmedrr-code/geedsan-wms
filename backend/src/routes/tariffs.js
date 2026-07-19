const express  = require('express');
const router   = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { getTariff } = require('../services/billingService');
const { recordAudit } = require('../services/auditService');

// GET /api/tariffs
router.get('/', authenticate, async (req, res) => {
  try {
    let r;
    try {
      r = await query('SELECT * FROM water_tariffs ORDER BY tariff_code');
    } catch {
      // Table not yet created — return fallback set
      const fallback = [
        { tariff_code: 'residential', name: 'Residential', price_per_m3: 1.20, min_charge: 2.00, service_fee: 1.50, vat_rate: 0, penalty_rate: 0, discount_rate: 0, is_active: true, source: 'fallback' },
        { tariff_code: 'commercial',  name: 'Commercial',  price_per_m3: 1.80, min_charge: 5.00, service_fee: 3.00, vat_rate: 0, penalty_rate: 0, discount_rate: 0, is_active: true, source: 'fallback' },
        { tariff_code: 'industrial',  name: 'Industrial',  price_per_m3: 2.40, min_charge:10.00, service_fee: 5.00, vat_rate: 0, penalty_rate: 0, discount_rate: 0, is_active: true, source: 'fallback' },
        { tariff_code: 'government',  name: 'Government',  price_per_m3: 1.00, min_charge: 3.00, service_fee: 2.00, vat_rate: 0, penalty_rate: 0, discount_rate: 0, is_active: true, source: 'fallback' },
        { tariff_code: 'bulk_water',  name: 'Bulk Water',  price_per_m3: 0.80, min_charge:15.00, service_fee: 0.00, vat_rate: 0, penalty_rate: 0, discount_rate: 0, is_active: true, source: 'fallback' },
        { tariff_code: 'custom',      name: 'Custom',      price_per_m3: 1.00, min_charge: 0.00, service_fee: 0.00, vat_rate: 0, penalty_rate: 0, discount_rate: 0, is_active: true, source: 'fallback' },
      ];
      return res.json(fallback);
    }
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tariffs/:code
router.get('/:code', authenticate, async (req, res) => {
  try {
    const tariff = await getTariff(req.params.code);
    res.json(tariff);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tariffs — create custom tariff
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { tariff_code, name, description, min_charge, price_per_m3, service_fee, vat_rate, penalty_rate, discount_rate } = req.body;
    if (!tariff_code || !name) return res.status(400).json({ error: 'tariff_code and name are required' });

    const r = await query(
      `INSERT INTO water_tariffs (tariff_code, name, description, min_charge, price_per_m3, service_fee, vat_rate, penalty_rate, discount_rate, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [tariff_code, name, description || null, min_charge || 0, price_per_m3 || 0, service_fee || 0, vat_rate || 0, penalty_rate || 0, discount_rate || 0, req.user.userId]
    );
    await recordAudit({ userId: req.user.userId, action: 'create_tariff', entityType: 'water_tariff', entityId: r.rows[0].id, newValues: req.body });
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `Tariff code '${req.body.tariff_code}' already exists` });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/tariffs/:code — update tariff
router.put('/:code', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { name, description, min_charge, price_per_m3, service_fee, vat_rate, penalty_rate, discount_rate, is_active } = req.body;
    const r = await query(
      `UPDATE water_tariffs SET
         name          = COALESCE($1, name),
         description   = COALESCE($2, description),
         min_charge    = COALESCE($3, min_charge),
         price_per_m3  = COALESCE($4, price_per_m3),
         service_fee   = COALESCE($5, service_fee),
         vat_rate      = COALESCE($6, vat_rate),
         penalty_rate  = COALESCE($7, penalty_rate),
         discount_rate = COALESCE($8, discount_rate),
         is_active     = COALESCE($9, is_active),
         updated_at    = NOW()
       WHERE tariff_code = $10 RETURNING *`,
      [name, description, min_charge, price_per_m3, service_fee, vat_rate, penalty_rate, discount_rate, is_active, req.params.code]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Tariff not found' });
    await recordAudit({ userId: req.user.userId, action: 'update_tariff', entityType: 'water_tariff', entityId: r.rows[0].id, newValues: req.body });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
