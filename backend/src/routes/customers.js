const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { recordAudit } = require('../services/auditService');

// GET /customers — rich list with filters, search, balance, last reading
router.get('/', authenticate, async (req, res) => {
  try {
    const {
      search, status, tariff, has_balance, no_meter, online_meter, offline_meter,
      page = 1, limit = 100
    } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = [];

    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      conditions.push(`(
        c.full_name ILIKE $${n}
        OR c.customer_number ILIKE $${n}
        OR c.email ILIKE $${n}
        OR c.phone ILIKE $${n}
        OR c.national_id ILIKE $${n}
        OR EXISTS (
          SELECT 1 FROM meters m2
          WHERE m2.customer_id = c.id
            AND (m2.meter_number ILIKE $${n} OR m2.device_eui ILIKE $${n})
        )
      )`);
    }

    if (status) {
      params.push(status);
      conditions.push(`c.account_status = $${params.length}`);
    }

    if (tariff) {
      params.push(tariff);
      conditions.push(`c.tariff_type = $${params.length}`);
    }

    if (has_balance === 'true') {
      conditions.push(`(
        SELECT COALESCE(SUM(i.total_amount - COALESCE(ip_sum.paid,0)),0)
        FROM invoices i
        LEFT JOIN (
          SELECT invoice_id, SUM(amount) AS paid FROM invoice_payments GROUP BY invoice_id
        ) ip_sum ON ip_sum.invoice_id = i.id
        WHERE i.customer_id = c.id AND i.status IN ('pending','overdue')
      ) > 0`);
    }

    if (no_meter === 'true') {
      conditions.push(`NOT EXISTS (SELECT 1 FROM meters m2 WHERE m2.customer_id = c.id AND m2.status='active')`);
    }

    if (online_meter === 'true') {
      conditions.push(`EXISTS (
        SELECT 1 FROM meters m2
        WHERE m2.customer_id = c.id AND m2.status='active'
          AND m2.last_seen > NOW() - INTERVAL '1 hour'
      )`);
    }

    if (offline_meter === 'true') {
      conditions.push(`EXISTS (
        SELECT 1 FROM meters m2
        WHERE m2.customer_id = c.id AND m2.status='active'
          AND (m2.last_seen IS NULL OR m2.last_seen <= NOW() - INTERVAL '1 hour')
      )`);
    }

    const where = conditions.length ? conditions.join(' AND ') : '1=1';

    const sql = `
      SELECT
        c.*,
        COUNT(DISTINCT m.id) FILTER (WHERE m.status='active')          AS meter_count,
        COUNT(DISTINCT m.id) FILTER (WHERE m.status='active' AND m.last_seen > NOW() - INTERVAL '1 hour') AS online_count,
        MAX(r.timestamp)                                                AS last_reading_date,
        COALESCE((
          SELECT SUM(i.total_amount - COALESCE(ip_sum.paid,0))
          FROM invoices i
          LEFT JOIN (
            SELECT invoice_id, SUM(amount) AS paid FROM invoice_payments GROUP BY invoice_id
          ) ip_sum ON ip_sum.invoice_id = i.id
          WHERE i.customer_id = c.id AND i.status IN ('pending','overdue')
        ), 0) AS outstanding_balance
      FROM customers c
      LEFT JOIN meters m ON m.customer_id = c.id
      LEFT JOIN meter_readings r ON r.meter_id = m.id
      WHERE ${where}
      GROUP BY c.id
      ORDER BY c.full_name
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const countSql = `SELECT COUNT(*) FROM customers c WHERE ${where}`;

    const [rows, countRow] = await Promise.all([
      query(sql, [...params, limit, offset]),
      query(countSql, params)
    ]);

    res.json({
      data: rows.rows,
      total: parseInt(countRow.rows[0].count, 10),
      page: parseInt(page, 10),
      limit: parseInt(limit, 10)
    });
  } catch (err) {
    console.error('GET /customers error:', err);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

// GET /customers/:id — full profile with new fields + outstanding balance
router.get('/:id', authenticate, async (req, res) => {
  try {
    const cust = await query(`
      SELECT c.*,
        u.full_name AS created_by_name,
        COALESCE((
          SELECT SUM(i.total_amount - COALESCE(ip_sum.paid,0))
          FROM invoices i
          LEFT JOIN (
            SELECT invoice_id, SUM(amount) AS paid FROM invoice_payments GROUP BY invoice_id
          ) ip_sum ON ip_sum.invoice_id = i.id
          WHERE i.customer_id = c.id AND i.status IN ('pending','overdue')
        ), 0) AS outstanding_balance
      FROM customers c
      LEFT JOIN users u ON u.id = c.created_by
      WHERE c.id = $1
    `, [req.params.id]);

    if (!cust.rows[0]) return res.status(404).json({ error: 'Customer not found' });

    const meters = await query(`
      SELECT m.*,
        r.total_consumption AS last_reading_value,
        r.reading_date      AS last_reading_date,
        r.battery_level     AS last_battery
      FROM meters m
      LEFT JOIN LATERAL (
        SELECT total_consumption, timestamp AS reading_date, battery_voltage AS battery_level
        FROM meter_readings
        WHERE meter_id = m.id
        ORDER BY timestamp DESC
        LIMIT 1
      ) r ON TRUE
      WHERE m.customer_id = $1
      ORDER BY m.meter_number
    `, [req.params.id]);

    res.json({ customer: cust.rows[0], meters: meters.rows });
  } catch (err) {
    console.error('GET /customers/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch customer' });
  }
});

// POST /customers
router.post('/', authenticate, authorize('admin', 'operator', 'manager'), async (req, res) => {
  try {
    const {
      customer_number, full_name, email, phone, address, city, district, tariff_type,
      national_id, house_number, gps_lat, gps_lng, connection_date, notes
    } = req.body;
    const r = await query(`
      INSERT INTO customers
        (customer_number, full_name, email, phone, address, city, district, tariff_type,
         national_id, house_number, gps_lat, gps_lng, connection_date, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `, [
      customer_number, full_name, email, phone, address, city, district,
      tariff_type || 'residential', national_id, house_number,
      gps_lat || null, gps_lng || null, connection_date || null, notes,
      req.user?.id || null
    ]);
    const newCustomer = r.rows[0];
    await recordAudit({
      userId:     req.user?.id,
      action:     'customer_created',
      entityType: 'customer',
      entityId:   newCustomer.id,
      newValues:  { customer_number, full_name, email, phone, tariff_type: newCustomer.tariff_type },
      ipAddress:  req.ip,
      userAgent:  req.headers['user-agent'] || null,
    });
    res.status(201).json(newCustomer);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Customer number already exists' });
    console.error('POST /customers error:', err);
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

// PUT /customers/:id — extended fields
router.put('/:id', authenticate, authorize('admin', 'operator', 'manager', 'customer_service'), async (req, res) => {
  try {
    const {
      full_name, email, phone, address, city, district, tariff_type, account_status,
      national_id, house_number, gps_lat, gps_lng, connection_date, notes
    } = req.body;
    // Snapshot old values before update for audit trail
    const oldR = await query(
      'SELECT full_name, email, phone, address, city, tariff_type, account_status, national_id, house_number, gps_lat, gps_lng, connection_date FROM customers WHERE id=$1',
      [req.params.id]
    );
    const old = oldR.rows[0] || {};

    const r = await query(`
      UPDATE customers SET
        full_name       = COALESCE($1,  full_name),
        email           = COALESCE($2,  email),
        phone           = COALESCE($3,  phone),
        address         = COALESCE($4,  address),
        city            = COALESCE($5,  city),
        district        = COALESCE($6,  district),
        tariff_type     = COALESCE($7,  tariff_type),
        account_status  = COALESCE($8,  account_status),
        national_id     = COALESCE($9,  national_id),
        house_number    = COALESCE($10, house_number),
        gps_lat         = COALESCE($11, gps_lat),
        gps_lng         = COALESCE($12, gps_lng),
        connection_date = COALESCE($13, connection_date),
        notes           = COALESCE($14, notes),
        updated_by      = $15,
        updated_at      = NOW()
      WHERE id = $16
      RETURNING *
    `, [
      full_name, email, phone, address, city, district, tariff_type, account_status,
      national_id, house_number,
      gps_lat !== undefined ? gps_lat : null,
      gps_lng !== undefined ? gps_lng : null,
      connection_date || null, notes,
      req.user?.id || null,
      req.params.id
    ]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Customer not found' });

    // Build diff — only log fields that actually changed
    const updated = r.rows[0];
    const changed = {};
    const tracked = ['full_name','email','phone','address','city','tariff_type','account_status','national_id','house_number','gps_lat','gps_lng','connection_date'];
    for (const f of tracked) {
      const before = old[f] == null ? null : String(old[f]);
      const after  = updated[f] == null ? null : String(updated[f]);
      if (before !== after) changed[f] = { from: old[f], to: updated[f] };
    }

    if (Object.keys(changed).length > 0) {
      await recordAudit({
        userId:     req.user?.id,
        action:     'customer_updated',
        entityType: 'customer',
        entityId:   req.params.id,
        oldValues:  old,
        newValues:  changed,
        ipAddress:  req.ip,
        userAgent:  req.headers['user-agent'] || null,
      });
    }

    res.json(updated);
  } catch (err) {
    console.error('PUT /customers/:id error:', err);
    if (err.code === '23514') return res.status(400).json({ error: 'Invalid value for tariff_type or account_status' });
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

// DELETE /customers/:id — admin only
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const r = await query('DELETE FROM customers WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Customer not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /customers/:id error:', err);
    res.status(500).json({ error: 'Failed to delete customer' });
  }
});

// GET /customers/:id/notes
router.get('/:id/notes', authenticate, async (req, res) => {
  try {
    const r = await query(`
      SELECT n.*, u.full_name AS user_name
      FROM customer_notes n
      LEFT JOIN users u ON u.id = n.user_id
      WHERE n.customer_id = $1
      ORDER BY n.created_at DESC
    `, [req.params.id]);
    res.json(r.rows);
  } catch (err) {
    console.error('GET /customers/:id/notes error:', err);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

// POST /customers/:id/notes
router.post(
  '/:id/notes',
  authenticate,
  authorize('admin', 'operator', 'manager', 'customer_service', 'finance', 'billing_officer'),
  async (req, res) => {
    try {
      const { note } = req.body;
      if (!note?.trim()) return res.status(400).json({ error: 'Note text is required' });
      const r = await query(`
        INSERT INTO customer_notes (customer_id, user_id, note)
        VALUES ($1, $2, $3)
        RETURNING *
      `, [req.params.id, req.user?.id || null, note.trim()]);

      const full = await query(`
        SELECT n.*, u.full_name AS user_name
        FROM customer_notes n
        LEFT JOIN users u ON u.id = n.user_id
        WHERE n.id = $1
      `, [r.rows[0].id]);

      res.status(201).json(full.rows[0]);
    } catch (err) {
      console.error('POST /customers/:id/notes error:', err);
      res.status(500).json({ error: 'Failed to add note' });
    }
  }
);

// GET /customers/:id/activity — timeline from audit_log + invoices + payments + meters
router.get('/:id/activity', authenticate, async (req, res) => {
  try {
    const id = req.params.id;

    const r = await query(`
      (
        SELECT
          al.created_at AS event_time,
          al.action     AS event_type,
          CASE al.action
            WHEN 'customer_created' THEN 'Customer profile created'
            WHEN 'customer_updated' THEN 'Customer profile updated'
            ELSE al.action
          END           AS description,
          u.full_name   AS actor,
          NULL::TEXT    AS ref_number,
          NULL::NUMERIC AS amount
        FROM audit_log al
        LEFT JOIN users u ON u.id = al.user_id
        WHERE al.entity_type = 'customer' AND al.entity_id = $1
      )
      UNION ALL
      (
        SELECT
          i.created_at                             AS event_time,
          'invoice_created'                        AS event_type,
          'Invoice ' || i.invoice_number || ' created — ' || i.total_amount::TEXT AS description,
          u.full_name                              AS actor,
          i.invoice_number                         AS ref_number,
          i.total_amount                           AS amount
        FROM invoices i
        LEFT JOIN users u ON u.id = i.created_by
        WHERE i.customer_id = $1
      )
      UNION ALL
      (
        SELECT
          ip.payment_date                                               AS event_time,
          'payment_received'                                            AS event_type,
          'Payment of ' || ip.amount::TEXT || ' recorded'              AS description,
          u.full_name                                                   AS actor,
          ip.reference                                                  AS ref_number,
          ip.amount                                                     AS amount
        FROM invoice_payments ip
        JOIN invoices i ON i.id = ip.invoice_id
        LEFT JOIN users u ON u.id = ip.created_by
        WHERE i.customer_id = $1
      )
      UNION ALL
      (
        SELECT
          m.created_at                                                  AS event_time,
          'meter_assigned'                                              AS event_type,
          'Meter ' || m.meter_number || ' assigned'                    AS description,
          NULL                                                          AS actor,
          m.meter_number                                                AS ref_number,
          NULL                                                          AS amount
        FROM meters m
        WHERE m.customer_id = $1
      )
      ORDER BY event_time DESC
      LIMIT 60
    `, [id]);

    res.json(r.rows);
  } catch (err) {
    console.error('GET /customers/:id/activity error:', err);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

module.exports = router;
