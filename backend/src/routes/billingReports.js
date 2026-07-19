const express  = require('express');
const router   = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

const FINANCIAL_ROLES = ['admin', 'manager', 'finance', 'billing_officer', 'viewer'];

// GET /api/billing-reports/customer-statement/:customerId
router.get('/customer-statement/:customerId', authenticate, authorize(...FINANCIAL_ROLES), async (req, res) => {
  try {
    const { customerId } = req.params;
    const { from, to } = req.query;

    const custR = await query(
      `SELECT c.*, z.zone_name AS zone_name FROM customers c LEFT JOIN zones z ON z.id = c.zone_id WHERE c.id = $1`,
      [customerId]
    );
    if (!custR.rows[0]) return res.status(404).json({ error: 'Customer not found' });
    const customer = custR.rows[0];

    let invoiceQuery = `
      SELECT i.*, COALESCE(p.total_paid, 0) AS paid_amount,
             i.total_amount - COALESCE(p.total_paid, 0) AS balance
      FROM invoices i
      LEFT JOIN (SELECT invoice_id, SUM(amount) total_paid FROM invoice_payments GROUP BY invoice_id) p
        ON p.invoice_id = i.id
      WHERE i.customer_id = $1`;
    const params = [customerId];
    if (from) { params.push(from); invoiceQuery += ` AND i.issue_date >= $${params.length}`; }
    if (to)   { params.push(to);   invoiceQuery += ` AND i.issue_date <= $${params.length}`; }
    invoiceQuery += ' ORDER BY i.issue_date DESC';

    const invoicesR = await query(invoiceQuery, params);

    const payments = await query(
      `SELECT ip.*, i.invoice_number FROM invoice_payments ip
       JOIN invoices i ON i.id = ip.invoice_id
       WHERE i.customer_id = $1 ORDER BY ip.payment_date DESC`,
      [customerId]
    );

    const totalInvoiced = invoicesR.rows.reduce((s, r) => s + Number(r.total_amount), 0);
    const totalPaid     = invoicesR.rows.reduce((s, r) => s + Number(r.paid_amount), 0);
    const totalBalance  = invoicesR.rows.reduce((s, r) => s + Number(r.balance), 0);
    const overdueCount  = invoicesR.rows.filter(r => r.status === 'overdue').length;

    res.json({
      customer,
      summary: { total_invoiced: +totalInvoiced.toFixed(2), total_paid: +totalPaid.toFixed(2), total_balance: +totalBalance.toFixed(2), overdue_count: overdueCount },
      invoices: invoicesR.rows,
      payments: payments.rows,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing-reports/zone/:zoneId
router.get('/zone/:zoneId', authenticate, authorize(...FINANCIAL_ROLES), async (req, res) => {
  try {
    const { zoneId } = req.params;
    const { from, to } = req.query;

    const zoneR = await query('SELECT * FROM zones WHERE id=$1', [zoneId]);
    if (!zoneR.rows[0]) return res.status(404).json({ error: 'Zone not found' });

    let q = `
      SELECT c.id, c.house_number, c.full_name, c.tariff_type,
             COUNT(i.id)::INT                    AS invoice_count,
             COALESCE(SUM(i.total_amount), 0)    AS total_invoiced,
             COALESCE(SUM(COALESCE(p.paid, 0)), 0) AS total_paid,
             COALESCE(SUM(i.total_amount - COALESCE(p.paid, 0)), 0) AS outstanding,
             COUNT(CASE WHEN i.status = 'overdue' THEN 1 END)::INT  AS overdue_count
      FROM customers c
      LEFT JOIN invoices i ON i.customer_id = c.id`;
    const params = [zoneId];
    if (from) { params.push(from); q += ` AND i.issue_date >= $${params.length}`; }
    if (to)   { params.push(to);   q += ` AND i.issue_date <= $${params.length}`; }
    q += `
      LEFT JOIN (SELECT invoice_id, SUM(amount) paid FROM invoice_payments GROUP BY invoice_id) p
        ON p.invoice_id = i.id
      WHERE c.zone_id = $1
      GROUP BY c.id, c.house_number, c.full_name, c.tariff_type
      ORDER BY c.house_number`;

    const rows = await query(q, params);

    const totals = rows.rows.reduce((acc, r) => {
      acc.total_invoiced += Number(r.total_invoiced);
      acc.total_paid     += Number(r.total_paid);
      acc.outstanding    += Number(r.outstanding);
      acc.overdue_count  += Number(r.overdue_count);
      return acc;
    }, { total_invoiced: 0, total_paid: 0, outstanding: 0, overdue_count: 0 });

    res.json({
      zone: zoneR.rows[0],
      summary: { customer_count: rows.rows.length, total_invoiced: +totals.total_invoiced.toFixed(2), total_paid: +totals.total_paid.toFixed(2), outstanding: +totals.outstanding.toFixed(2), overdue_count: totals.overdue_count },
      customers: rows.rows,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing-reports/aging
router.get('/aging', authenticate, authorize(...FINANCIAL_ROLES), async (req, res) => {
  try {
    const today = new Date();
    const agingR = await query(`
      SELECT c.id, c.house_number, c.full_name, z.zone_name AS zone_name,
             SUM(CASE WHEN i.due_date >= NOW() THEN i.total_amount - COALESCE(p.paid,0) ELSE 0 END)                            AS current_balance,
             SUM(CASE WHEN i.due_date < NOW() AND i.due_date >= NOW() - INTERVAL '30 days' THEN i.total_amount - COALESCE(p.paid,0) ELSE 0 END) AS overdue_30,
             SUM(CASE WHEN i.due_date < NOW() - INTERVAL '30 days' AND i.due_date >= NOW() - INTERVAL '60 days' THEN i.total_amount - COALESCE(p.paid,0) ELSE 0 END) AS overdue_60,
             SUM(CASE WHEN i.due_date < NOW() - INTERVAL '60 days' AND i.due_date >= NOW() - INTERVAL '90 days' THEN i.total_amount - COALESCE(p.paid,0) ELSE 0 END) AS overdue_90,
             SUM(CASE WHEN i.due_date < NOW() - INTERVAL '90 days' THEN i.total_amount - COALESCE(p.paid,0) ELSE 0 END) AS overdue_90_plus,
             SUM(i.total_amount - COALESCE(p.paid,0)) AS total_outstanding
      FROM customers c
      JOIN invoices i ON i.customer_id = c.id
      LEFT JOIN zones z ON z.id = c.zone_id
      LEFT JOIN (SELECT invoice_id, SUM(amount) paid FROM invoice_payments GROUP BY invoice_id) p
        ON p.invoice_id = i.id
      WHERE i.status IN ('pending','overdue') AND i.total_amount - COALESCE(p.paid,0) > 0
      GROUP BY c.id, c.house_number, c.full_name, z.zone_name
      HAVING SUM(i.total_amount - COALESCE(p.paid,0)) > 0
      ORDER BY total_outstanding DESC`
    );

    const totals = agingR.rows.reduce((acc, r) => {
      acc.current_balance  += Number(r.current_balance  || 0);
      acc.overdue_30       += Number(r.overdue_30       || 0);
      acc.overdue_60       += Number(r.overdue_60       || 0);
      acc.overdue_90       += Number(r.overdue_90       || 0);
      acc.overdue_90_plus  += Number(r.overdue_90_plus  || 0);
      acc.total_outstanding+= Number(r.total_outstanding|| 0);
      return acc;
    }, { current_balance: 0, overdue_30: 0, overdue_60: 0, overdue_90: 0, overdue_90_plus: 0, total_outstanding: 0 });

    res.json({
      report_date: today.toISOString().slice(0, 10),
      summary: {
        customer_count:    agingR.rows.length,
        current_balance:   +totals.current_balance.toFixed(2),
        overdue_30:        +totals.overdue_30.toFixed(2),
        overdue_60:        +totals.overdue_60.toFixed(2),
        overdue_90:        +totals.overdue_90.toFixed(2),
        overdue_90_plus:   +totals.overdue_90_plus.toFixed(2),
        total_outstanding: +totals.total_outstanding.toFixed(2),
      },
      customers: agingR.rows,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing-reports/unpaid
router.get('/unpaid', authenticate, authorize(...FINANCIAL_ROLES), async (req, res) => {
  try {
    const { zone_id, tariff_type, overdue_only } = req.query;

    let q = `
      SELECT i.id, i.invoice_number, i.issue_date, i.due_date, i.status, i.tariff_type,
             i.total_amount, COALESCE(p.paid,0) AS paid_amount,
             i.total_amount - COALESCE(p.paid,0) AS balance,
             c.id AS customer_id, c.house_number, c.full_name, c.phone,
             z.zone_name AS zone_name,
             CASE WHEN i.due_date < NOW() THEN (NOW()::date - i.due_date::date)::INT ELSE 0 END AS days_overdue
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      LEFT JOIN zones z ON z.id = c.zone_id
      LEFT JOIN (SELECT invoice_id, SUM(amount) paid FROM invoice_payments GROUP BY invoice_id) p
        ON p.invoice_id = i.id
      WHERE i.status IN ('pending','overdue') AND i.total_amount - COALESCE(p.paid,0) > 0`;

    const params = [];
    if (overdue_only === 'true') { q += ` AND i.status = 'overdue'`; }
    if (zone_id)     { params.push(zone_id);     q += ` AND c.zone_id = $${params.length}`; }
    if (tariff_type) { params.push(tariff_type); q += ` AND i.tariff_type = $${params.length}`; }
    q += ' ORDER BY days_overdue DESC, i.due_date ASC';

    const r = await query(q, params);
    const totalBalance = r.rows.reduce((s, row) => s + Number(row.balance), 0);

    res.json({
      count: r.rows.length,
      total_balance: +totalBalance.toFixed(2),
      invoices: r.rows,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing-reports/consumption
router.get('/consumption', authenticate, authorize(...FINANCIAL_ROLES), async (req, res) => {
  try {
    const { from, to, zone_id } = req.query;
    const params = [];
    let filter = '';
    if (from) { params.push(from); filter += ` AND i.billing_period_start >= $${params.length}`; }
    if (to)   { params.push(to);   filter += ` AND i.billing_period_end   <= $${params.length}`; }
    if (zone_id) { params.push(zone_id); filter += ` AND c.zone_id = $${params.length}`; }

    const r = await query(`
      SELECT c.id AS customer_id, c.house_number, c.full_name, c.tariff_type, z.zone_name AS zone_name,
             COUNT(i.id)::INT                          AS invoice_count,
             COALESCE(SUM(i.consumption_m3), 0)        AS total_consumption_m3,
             COALESCE(SUM(i.total_amount), 0)          AS total_billed,
             CASE WHEN SUM(i.consumption_m3) > 0
                  THEN SUM(i.total_amount) / SUM(i.consumption_m3)
                  ELSE 0 END                           AS avg_rate_per_m3
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      LEFT JOIN zones z ON z.id = c.zone_id
      WHERE i.status != 'cancelled' ${filter}
      GROUP BY c.id, c.house_number, c.full_name, c.tariff_type, z.zone_name
      ORDER BY total_consumption_m3 DESC`, params);

    const totals = r.rows.reduce((acc, row) => {
      acc.total_consumption_m3 += Number(row.total_consumption_m3);
      acc.total_billed         += Number(row.total_billed);
      return acc;
    }, { total_consumption_m3: 0, total_billed: 0 });

    res.json({
      period: { from: from || null, to: to || null },
      summary: {
        customer_count:       r.rows.length,
        total_consumption_m3: +totals.total_consumption_m3.toFixed(3),
        total_billed:         +totals.total_billed.toFixed(2),
        avg_rate_per_m3:      totals.total_consumption_m3 > 0 ? +(totals.total_billed / totals.total_consumption_m3).toFixed(4) : 0,
      },
      customers: r.rows,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing-reports/revenue
router.get('/revenue', authenticate, authorize(...FINANCIAL_ROLES), async (req, res) => {
  try {
    const { from, to, group_by = 'month' } = req.query;
    const params = [];
    let filter = '';
    if (from) { params.push(from); filter += ` AND payment_date >= $${params.length}`; }
    if (to)   { params.push(to);   filter += ` AND payment_date <= $${params.length}`; }

    const dateTrunc = group_by === 'day' ? 'day' : group_by === 'year' ? 'year' : 'month';

    const revenueR = await query(`
      SELECT DATE_TRUNC('${dateTrunc}', ip.payment_date)::date AS period,
             COUNT(ip.id)::INT       AS payment_count,
             SUM(ip.amount)          AS revenue,
             COUNT(DISTINCT i.customer_id)::INT AS customer_count
      FROM invoice_payments ip
      JOIN invoices i ON i.id = ip.invoice_id
      WHERE 1=1 ${filter}
      GROUP BY DATE_TRUNC('${dateTrunc}', ip.payment_date)
      ORDER BY period`, params);

    const invoicedR = await query(`
      SELECT DATE_TRUNC('${dateTrunc}', issue_date)::date AS period,
             COUNT(id)::INT          AS invoice_count,
             SUM(total_amount)       AS invoiced
      FROM invoices
      WHERE status != 'cancelled' ${filter.replace(/payment_date/g, 'issue_date')}
      GROUP BY DATE_TRUNC('${dateTrunc}', issue_date)
      ORDER BY period`, params);

    const invoicedMap = {};
    invoicedR.rows.forEach(r => { invoicedMap[r.period] = r; });

    const combined = revenueR.rows.map(r => {
      const inv = invoicedMap[r.period] || { invoice_count: 0, invoiced: 0 };
      return {
        period: r.period,
        payment_count:  r.payment_count,
        revenue:        Number(r.revenue),
        customer_count: r.customer_count,
        invoice_count:  Number(inv.invoice_count),
        invoiced:       Number(inv.invoiced),
        collection_rate: Number(inv.invoiced) > 0 ? +((Number(r.revenue) / Number(inv.invoiced)) * 100).toFixed(1) : 0,
      };
    });

    const totalRevenue  = combined.reduce((s, r) => s + r.revenue, 0);
    const totalInvoiced = combined.reduce((s, r) => s + r.invoiced, 0);

    res.json({
      period:   { from: from || null, to: to || null },
      group_by: dateTrunc,
      summary: {
        total_revenue:   +totalRevenue.toFixed(2),
        total_invoiced:  +totalInvoiced.toFixed(2),
        collection_rate: totalInvoiced > 0 ? +((totalRevenue / totalInvoiced) * 100).toFixed(1) : 0,
        period_count:    combined.length,
      },
      periods: combined,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
