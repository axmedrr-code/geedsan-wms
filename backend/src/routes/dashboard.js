const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');

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

// ─── Billing dashboard endpoints ──────────────────────────────────────────────

/**
 * @openapi
 * /dashboard/billing-stats:
 *   get:
 *     summary: Billing KPI counters — revenue, outstanding, overdue, active customers
 *     tags: [Dashboard]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/billing-stats', authenticate, async (req, res) => {
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
        (SELECT COALESCE(SUM(i.total_amount),0)
           FROM invoices i
          WHERE i.status NOT IN ('paid','cancelled')) AS "outstandingBalance",
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
router.get('/revenue-chart', authenticate, async (req, res) => {
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
router.get('/top-customers', authenticate, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 5, 1), 50);
    const r = await query(`
      SELECT
        c.id AS customer_id,
        c.full_name AS customer_name,
        c.customer_number,
        c.tariff_type,
        COALESCE(SUM(ip.amount), 0) AS total_paid,
        COUNT(DISTINCT i.id)        AS invoice_count,
        COUNT(DISTINCT m.id)        AS meter_count
      FROM customers c
      LEFT JOIN invoices i        ON i.customer_id=c.id
      LEFT JOIN invoice_payments ip ON ip.invoice_id=i.id
      LEFT JOIN meters m          ON m.customer_id=c.id AND m.status='active'
      WHERE c.account_status='active'
      GROUP BY c.id, c.full_name, c.customer_number, c.tariff_type
      ORDER BY total_paid DESC
      LIMIT $1
    `, [limit]);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch top customers' }); }
});

module.exports = router;
