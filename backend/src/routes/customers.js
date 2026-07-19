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
        OR c.house_number ILIKE $${n}
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
        z.zone_code,
        z.zone_name,
        (
          SELECT m_active.meter_number FROM meters m_active
          WHERE m_active.customer_id = c.id AND m_active.status = 'active'
          ORDER BY m_active.created_at ASC LIMIT 1
        ) AS primary_meter_number,
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
      LEFT JOIN zones z ON z.id = c.zone_id
      LEFT JOIN meters m ON m.customer_id = c.id
      LEFT JOIN meter_readings r ON r.meter_id = m.id
      WHERE ${where}
      GROUP BY c.id, z.zone_code, z.zone_name
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

// GET /customers/:id — full profile with zones + outstanding balance
router.get('/:id', authenticate, async (req, res) => {
  try {
    const cust = await query(`
      SELECT c.*,
        z.zone_code,
        z.zone_name,
        u.full_name AS created_by_name,
        (
          SELECT m_active.meter_number FROM meters m_active
          WHERE m_active.customer_id = c.id AND m_active.status = 'active'
          ORDER BY m_active.created_at ASC LIMIT 1
        ) AS primary_meter_number,
        COALESCE((
          SELECT SUM(i.total_amount - COALESCE(ip_sum.paid,0))
          FROM invoices i
          LEFT JOIN (
            SELECT invoice_id, SUM(amount) AS paid FROM invoice_payments GROUP BY invoice_id
          ) ip_sum ON ip_sum.invoice_id = i.id
          WHERE i.customer_id = c.id AND i.status IN ('pending','overdue')
        ), 0) AS outstanding_balance
      FROM customers c
      LEFT JOIN zones z ON z.id = c.zone_id
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
      ORDER BY
        CASE m.status WHEN 'active' THEN 0 WHEN 'replaced' THEN 1 ELSE 2 END,
        m.created_at DESC
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
      house_number: inputHN, full_name, email, phone, address, city, district,
      tariff_type, national_id, address_ref, zone_id, gps_lat, gps_lng,
      connection_date, notes,
      mobile_money_number, owner_name, preferred_payment_method, priority, account_status,
    } = req.body;

    if (!full_name?.trim()) return res.status(400).json({ error: 'full_name is required' });

    // Mode B: auto-generate house_number from zone sequence when input is empty
    let house_number = (inputHN || '').trim();
    if (!house_number && zone_id) {
      const modeR = await query("SELECT value FROM system_settings WHERE key='house_number_mode'");
      if (modeR.rows[0]?.value === 'auto') {
        const zoneR = await query(
          'UPDATE zones SET customer_seq = customer_seq + 1 WHERE id=$1 RETURNING customer_seq, zone_code',
          [zone_id]
        );
        if (!zoneR.rows[0]) return res.status(400).json({ error: 'Zone not found for auto-numbering' });
        const { customer_seq, zone_code } = zoneR.rows[0];
        house_number = `${zone_code}-${String(customer_seq).padStart(6, '0')}`;
      }
    }
    if (!house_number) return res.status(400).json({ error: 'house_number is required (or enable auto mode in System Settings)' });

    const r = await query(`
      INSERT INTO customers
        (house_number, full_name, email, phone, address, city, district, tariff_type,
         national_id, address_ref, zone_id, gps_lat, gps_lng, connection_date, notes,
         mobile_money_number, owner_name, preferred_payment_method, priority, account_status,
         created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *
    `, [
      house_number, full_name, email || null, phone || null,
      address || null, city || null, district || null,
      tariff_type || 'residential',
      national_id || null, address_ref || null,
      zone_id || null,
      gps_lat != null && gps_lat !== '' ? Number(gps_lat) : null,
      gps_lng != null && gps_lng !== '' ? Number(gps_lng) : null,
      connection_date || null, notes || null,
      mobile_money_number || null, owner_name || null,
      preferred_payment_method || 'cash',
      priority || 'normal',
      account_status || 'active',
      req.user?.id || null,
    ]);
    const newCustomer = r.rows[0];
    await recordAudit({
      userId:     req.user?.id,
      action:     'customer_created',
      entityType: 'customer',
      entityId:   newCustomer.id,
      newValues:  { house_number, full_name, email, phone, tariff_type: newCustomer.tariff_type },
      ipAddress:  req.ip,
      userAgent:  req.headers['user-agent'] || null,
    });
    res.status(201).json(newCustomer);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'House number already exists' });
    console.error('POST /customers error:', err);
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

// PUT /customers/:id — extended fields (house_number is NOT updatable — it is permanent)
router.put('/:id', authenticate, authorize('admin', 'operator', 'manager', 'customer_service'), async (req, res) => {
  try {
    const {
      full_name, email, phone, address, city, district, tariff_type, account_status,
      national_id, address_ref, zone_id, gps_lat, gps_lng, connection_date, notes,
      mobile_money_number, owner_name, preferred_payment_method, priority,
    } = req.body;
    const oldR = await query(
      `SELECT full_name, email, phone, address, city, tariff_type, account_status,
              national_id, address_ref, zone_id, gps_lat, gps_lng, connection_date,
              mobile_money_number, owner_name, preferred_payment_method, priority
       FROM customers WHERE id=$1`,
      [req.params.id]
    );
    const old = oldR.rows[0] || {};

    const r = await query(`
      UPDATE customers SET
        full_name                = COALESCE($1,  full_name),
        email                    = COALESCE($2,  email),
        phone                    = COALESCE($3,  phone),
        address                  = COALESCE($4,  address),
        city                     = COALESCE($5,  city),
        district                 = COALESCE($6,  district),
        tariff_type              = COALESCE($7,  tariff_type),
        account_status           = COALESCE($8,  account_status),
        national_id              = COALESCE($9,  national_id),
        address_ref              = COALESCE($10, address_ref),
        zone_id                  = COALESCE($11, zone_id),
        gps_lat                  = COALESCE($12, gps_lat),
        gps_lng                  = COALESCE($13, gps_lng),
        connection_date          = COALESCE($14, connection_date),
        notes                    = COALESCE($15, notes),
        mobile_money_number      = COALESCE($16, mobile_money_number),
        owner_name               = COALESCE($17, owner_name),
        preferred_payment_method = COALESCE($18, preferred_payment_method),
        priority                 = COALESCE($19, priority),
        updated_by               = $20,
        updated_at               = NOW()
      WHERE id = $21
      RETURNING *
    `, [
      full_name, email, phone, address, city, district, tariff_type, account_status,
      national_id, address_ref !== undefined ? (address_ref || null) : null,
      zone_id !== undefined ? (zone_id || null) : null,
      gps_lat !== undefined ? gps_lat : null,
      gps_lng !== undefined ? gps_lng : null,
      connection_date || null, notes,
      mobile_money_number !== undefined ? (mobile_money_number || null) : null,
      owner_name !== undefined ? (owner_name || null) : null,
      preferred_payment_method || null,
      priority || null,
      req.user?.id || null,
      req.params.id
    ]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Customer not found' });

    const updated = r.rows[0];
    const changed = {};
    const tracked = [
      'full_name','email','phone','address','city','tariff_type','account_status',
      'national_id','address_ref','zone_id','gps_lat','gps_lng','connection_date',
      'mobile_money_number','owner_name','preferred_payment_method','priority',
    ];
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

// GET /customers/:id/activity
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
