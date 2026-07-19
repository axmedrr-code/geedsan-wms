const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// Roles permitted to read financial KPIs (revenue, outstanding, collections)
const FINANCIAL_ROLES = ['admin', 'manager', 'finance', 'billing_officer', 'viewer'];

/**
 * @openapi
 * /dashboard/stats:
 *   get:
 *     summary: Top-level dashboard counters (meters, alarms, gateways, consumption)
 *     tags: [Dashboard]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/stats', authenticate, async (req, res) => {
  try {
    const r = await query(`SELECT (SELECT COUNT(*) FROM meters WHERE status='active') AS total_meters,(SELECT COUNT(*) FROM meters WHERE is_online=true AND status='active') AS online_meters,(SELECT COUNT(*) FROM meters WHERE is_online=false AND status='active') AS offline_meters,(SELECT COALESCE(SUM(total_consumption),0) FROM meters WHERE status='active') AS total_consumption,(SELECT COUNT(*) FROM alarms WHERE status='active') AS active_alarms,(SELECT COUNT(*) FROM meters WHERE battery_voltage<3.2 AND battery_voltage IS NOT NULL AND status='active') AS low_battery_count,(SELECT COUNT(*) FROM alarms WHERE status='active' AND severity='critical') AS critical_alarms,(SELECT COUNT(*) FROM customers WHERE account_status='active') AS total_customers,(SELECT COUNT(*) FROM gateways) AS total_gateways,(SELECT COUNT(*) FROM gateways WHERE is_online=true) AS online_gateways`);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch stats' }); }
});

router.get('/consumption-chart', authenticate, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const r = await query(`SELECT DATE(timestamp) AS date, SUM(CASE WHEN current_flow>0 THEN current_flow ELSE 0 END) AS total_flow, COUNT(DISTINCT meter_id) AS active_meters FROM meter_readings WHERE timestamp>=NOW()-INTERVAL '${parseInt(days)} days' GROUP BY DATE(timestamp) ORDER BY date ASC`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch chart' }); }
});

router.get('/alarm-summary', authenticate, async (req, res) => {
  try {
    const r = await query(`SELECT alarm_type,severity,COUNT(*) AS count,COUNT(*) FILTER(WHERE status='active') AS active_count FROM alarms WHERE triggered_at>=NOW()-INTERVAL '30 days' GROUP BY alarm_type,severity ORDER BY active_count DESC`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch alarm summary' }); }
});

router.get('/recent-alarms', authenticate, async (req, res) => {
  try {
    const r = await query(`SELECT a.*,m.meter_number,m.device_eui,c.full_name AS customer_name FROM alarms a LEFT JOIN meters m ON a.meter_id=m.id LEFT JOIN customers c ON m.customer_id=c.id WHERE a.status='active' ORDER BY a.triggered_at DESC LIMIT 10`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch recent alarms' }); }
});

router.get('/meter-distribution', authenticate, async (req, res) => {
  try {
    const [status, battery, valve] = await Promise.all([
      query(`SELECT status,COUNT(*) AS count FROM meters GROUP BY status`),
      query(`SELECT CASE WHEN battery_voltage IS NULL THEN 'unknown' WHEN battery_voltage<3.0 THEN 'critical' WHEN battery_voltage<3.2 THEN 'low' WHEN battery_voltage<3.6 THEN 'medium' ELSE 'good' END AS level,COUNT(*) AS count FROM meters WHERE status='active' GROUP BY level`),
      query(`SELECT valve_status,COUNT(*) AS count FROM meters WHERE status='active' GROUP BY valve_status`)
    ]);
    res.json({ status: status.rows, battery: battery.rows, valve: valve.rows });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch distribution' }); }
});

router.get('/top-consumers', authenticate, async (req, res) => {
  try {
    const r = await query(`SELECT m.id,m.meter_number,m.device_eui,m.total_consumption,m.current_flow,c.full_name AS customer_name FROM meters m LEFT JOIN customers c ON m.customer_id=c.id WHERE m.status='active' ORDER BY m.total_consumption DESC LIMIT 10`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch top consumers' }); }
});

// ─── Live Operations Dashboard (15 real-time cards) ──────────────────────────

// Simple in-memory TTL cache — 60 s
const _opsCache = { data: null, expiresAt: 0 };

router.get('/ops', authenticate, async (req, res) => {
  try {
    if (_opsCache.data && Date.now() < _opsCache.expiresAt) {
      return res.json({ ...(_opsCache.data), cached: true });
    }

    const [meters, readings, alarms, leaks, valves, nrw] = await Promise.all([

      // Online/offline + valve counts + averages (single scan over meters table)
      query(`
        SELECT
          COUNT(*) FILTER (WHERE is_online AND status='active')                              AS online_meters,
          COUNT(*) FILTER (WHERE NOT is_online AND status='active')                          AS offline_meters,
          COUNT(*) FILTER (WHERE valve_status='open'  AND status='active')                   AS open_valves,
          COUNT(*) FILTER (WHERE valve_status='closed' AND status='active')                  AS closed_valves,
          AVG(battery_voltage) FILTER (WHERE battery_voltage IS NOT NULL AND status='active') AS avg_battery_v,
          AVG(rssi)            FILTER (WHERE rssi IS NOT NULL AND is_online AND status='active') AS avg_rssi_dbm,
          AVG(pressure)        FILTER (WHERE pressure IS NOT NULL AND is_online AND status='active') AS avg_pressure_bar,
          SUM(current_flow)    FILTER (WHERE current_flow > 0 AND is_online AND status='active')     AS current_flow_total
        FROM meters
      `),

      // Meters that have reported in the last 25 hours
      query(`
        SELECT COUNT(DISTINCT meter_id) AS reporting_today
        FROM meter_readings
        WHERE timestamp >= NOW() - INTERVAL '25 hours'
      `),

      // Critical alarms today
      query(`
        SELECT COUNT(*) AS critical_alarms
        FROM alarms
        WHERE status='active' AND severity='critical'
      `),

      // Leaks opened today
      query(`
        SELECT COUNT(*) AS leaks_today
        FROM leak_events
        WHERE detected_at >= CURRENT_DATE AND status='active'
      `),

      // Communication success rate (last 24 h vs expected)
      query(`
        SELECT
          COUNT(*) AS actual_packets,
          COUNT(DISTINCT meter_id) AS active_meters_seen
        FROM meter_readings
        WHERE timestamp >= NOW() - INTERVAL '24 hours'
      `),

      // NRW: water produced (all meter consumption) vs water sold (customer meters only)
      query(`
        SELECT
          COALESCE(SUM(consumption_m3), 0) AS water_produced
        FROM meter_consumption_daily
        WHERE date = CURRENT_DATE - 1
      `),
    ]);

    const m  = meters.rows[0];
    const r  = readings.rows[0];
    const a  = alarms.rows[0];
    const l  = leaks.rows[0];
    const v  = valves.rows[0];
    const n  = nrw.rows[0];

    const totalActive   = parseInt(m.online_meters) + parseInt(m.offline_meters);
    const expectedPkts  = parseInt(v.active_meters_seen || 0) * 96;  // 96 per meter per day
    const commSuccessRate = expectedPkts > 0
      ? Math.min(100, Math.round((parseInt(v.actual_packets) / expectedPkts) * 100))
      : null;

    const waterProduced = parseFloat(n.water_produced || 0);
    // water_sold ≈ same figure when all meters are customer meters (approximation)
    const waterSold     = waterProduced;  // will diverge once bulk-supply meters are tagged separately
    const nrwPct        = waterProduced > 0
      ? parseFloat(((waterProduced - waterSold) / waterProduced * 100).toFixed(1))
      : 0;

    const avgBattPct = m.avg_battery_v
      ? Math.max(0, Math.min(100, Math.round(((parseFloat(m.avg_battery_v) - 2.8) / 0.8) * 100)))
      : null;

    const result = {
      online_meters:          parseInt(m.online_meters),
      offline_meters:         parseInt(m.offline_meters),
      meters_reporting_today: parseInt(r.reporting_today),
      avg_battery_pct:        avgBattPct,
      avg_rssi_dbm:           m.avg_rssi_dbm   ? parseFloat(parseFloat(m.avg_rssi_dbm).toFixed(1))   : null,
      avg_pressure_bar:       m.avg_pressure_bar ? parseFloat(parseFloat(m.avg_pressure_bar).toFixed(2)) : null,
      current_flow_lpm:       m.current_flow_total ? parseFloat(parseFloat(m.current_flow_total).toFixed(1)) : 0,
      open_valves:            parseInt(m.open_valves),
      closed_valves:          parseInt(m.closed_valves),
      leaks_today:            parseInt(l.leaks_today),
      critical_alarms:        parseInt(a.critical_alarms),
      comm_success_rate_pct:  commSuccessRate,
      water_produced_m3:      parseFloat(waterProduced.toFixed(3)),
      water_sold_m3:          parseFloat(waterSold.toFixed(3)),
      non_revenue_water_pct:  nrwPct,
      total_active_meters:    totalActive,
      as_of:                  new Date().toISOString(),
      cached: false,
    };

    _opsCache.data      = result;
    _opsCache.expiresAt = Date.now() + 60_000;

    res.json(result);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch ops stats' }); }
});

// ─── Billing dashboard endpoints ──────────────────────────────────────────────

/**
 * @openapi
 * /dashboard/billing-stats:
 *   get:
 *     summary: Billing KPI counters — revenue, outstanding, overdue, active customers
 *     tags: [Dashboard]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/billing-stats', authenticate, authorize(...FINANCIAL_ROLES), async (req, res) => {
  try {
    const r = await query(`
      SELECT
        (SELECT COALESCE(SUM(ip.amount),0)
           FROM invoice_payments ip
          WHERE DATE(ip.payment_date)=CURRENT_DATE) AS "revenueToday",
        (SELECT COALESCE(SUM(ip.amount),0)
           FROM invoice_payments ip
          WHERE DATE_TRUNC('month',ip.payment_date)=DATE_TRUNC('month',NOW())) AS "revenueThisMonth",
        (SELECT COALESCE(SUM(ip.amount),0)
           FROM invoice_payments ip
          WHERE EXTRACT(YEAR FROM ip.payment_date)=EXTRACT(YEAR FROM NOW())) AS "revenueThisYear",
        (SELECT COALESCE(SUM(i.total_amount - COALESCE(paid.total_paid,0)),0)
           FROM invoices i
           LEFT JOIN (
             SELECT invoice_id, SUM(amount) AS total_paid
             FROM invoice_payments GROUP BY invoice_id
           ) paid ON paid.invoice_id = i.id
          WHERE i.status IN ('pending','overdue')) AS "outstandingBalance",
        (SELECT COUNT(*)
           FROM invoices i
          WHERE DATE(i.created_at)=CURRENT_DATE) AS "invoicesToday",
        (SELECT COUNT(*)
           FROM invoice_payments ip
          WHERE DATE(ip.payment_date)=CURRENT_DATE) AS "paymentsToday",
        (SELECT COUNT(*) FROM invoices i WHERE i.status='overdue') AS "overdueCount",
        (SELECT COUNT(*) FROM customers WHERE account_status='active') AS "activeCustomers"
    `);
    const row = r.rows[0];
    res.json({
      revenueToday:       parseFloat(row.revenueToday),
      revenueThisMonth:   parseFloat(row.revenueThisMonth),
      revenueThisYear:    parseFloat(row.revenueThisYear),
      outstandingBalance: parseFloat(row.outstandingBalance),
      invoicesToday:      parseInt(row.invoicesToday),
      paymentsToday:      parseInt(row.paymentsToday),
      overdueCount:       parseInt(row.overdueCount),
      activeCustomers:    parseInt(row.activeCustomers),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch billing stats' }); }
});

/**
 * @openapi
 * /dashboard/revenue-chart:
 *   get:
 *     summary: Monthly revenue, invoiced and outstanding for the last N months
 *     tags: [Dashboard]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: months
 *         schema: { type: integer, default: 6 }
 */
router.get('/revenue-chart', authenticate, authorize(...FINANCIAL_ROLES), async (req, res) => {
  try {
    const months = Math.min(Math.max(parseInt(req.query.months) || 6, 1), 36);
    const r = await query(`
      WITH month_series AS (
        SELECT TO_CHAR(gs, 'YYYY-MM') AS month
        FROM generate_series(
          DATE_TRUNC('month', NOW()) - ($1::integer - 1) * INTERVAL '1 month',
          DATE_TRUNC('month', NOW()),
          INTERVAL '1 month'
        ) gs
      ),
      pay AS (
        SELECT TO_CHAR(DATE_TRUNC('month', payment_date), 'YYYY-MM') AS month,
               SUM(amount) AS revenue
        FROM invoice_payments GROUP BY 1
      ),
      inv AS (
        SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
               SUM(total_amount) AS invoiced,
               SUM(CASE WHEN status NOT IN ('paid','cancelled') THEN total_amount ELSE 0 END) AS outstanding
        FROM invoices GROUP BY 1
      )
      SELECT m.month,
             COALESCE(p.revenue, 0)     AS revenue,
             COALESCE(i.invoiced, 0)    AS invoiced,
             COALESCE(i.outstanding, 0) AS outstanding
      FROM month_series m
      LEFT JOIN pay p USING (month)
      LEFT JOIN inv i USING (month)
      ORDER BY m.month ASC
    `, [months]);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch revenue chart' }); }
});

/**
 * @openapi
 * /dashboard/top-customers:
 *   get:
 *     summary: Top customers by total payments received
 *     tags: [Dashboard]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 5 }
 */
router.get('/top-customers', authenticate, authorize(...FINANCIAL_ROLES), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 5, 1), 50);
    const r = await query(`
      SELECT
        c.id AS customer_id,
        c.full_name AS customer_name,
        c.house_number,
        c.tariff_type,
        COALESCE(SUM(ip.amount), 0) AS total_paid,
        COUNT(DISTINCT i.id)        AS invoice_count,
        COUNT(DISTINCT m.id)        AS meter_count
      FROM customers c
      LEFT JOIN invoices i        ON i.customer_id=c.id
      LEFT JOIN invoice_payments ip ON ip.invoice_id=i.id
      LEFT JOIN meters m          ON m.customer_id=c.id AND m.status='active'
      WHERE c.account_status='active'
      GROUP BY c.id, c.full_name, c.house_number, c.tariff_type
      ORDER BY total_paid DESC
      LIMIT $1
    `, [limit]);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch top customers' }); }
});

module.exports = router;
