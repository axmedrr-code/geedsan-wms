const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { recordPayment } = require('../services/billingService');

router.get('/', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const { customer_id, status, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    let where = '1=1';
    const params = [];

    if (customer_id) { params.push(customer_id); where += ` AND b.customer_id=$${params.length}`; }
    if (status) { params.push(status); where += ` AND b.status=$${params.length}`; }

    const countR = await query(`SELECT COUNT(*) FROM invoices b WHERE ${where}`, params);
    const r = await query(`SELECT b.*, c.full_name AS customer_name, c.customer_number FROM invoices b LEFT JOIN customers c ON b.customer_id=c.id WHERE ${where} ORDER BY b.due_date DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]);

    res.json({ data: r.rows, pagination: { total: parseInt(countR.rows[0].count), page: parseInt(page), limit: parseInt(limit) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

router.get('/:id', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const invoiceR = await query('SELECT b.*, c.full_name AS customer_name, c.customer_number, c.email AS customer_email FROM invoices b LEFT JOIN customers c ON b.customer_id=c.id WHERE b.id=$1', [req.params.id]);
    if (!invoiceR.rows[0]) return res.status(404).json({ error: 'Invoice not found' });
    const itemsR = await query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY line_order ASC', [req.params.id]);
    res.json({ invoice: invoiceR.rows[0], items: itemsR.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

router.post('/', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const { customer_id, invoice_number, issue_date, due_date, tariff_type, line_items, notes, status = 'pending' } = req.body;
    if (!customer_id || !invoice_number || !issue_date || !due_date || !Array.isArray(line_items) || !line_items.length) {
      return res.status(400).json({ error: 'Missing invoice fields' });
    }

    const total_amount = line_items.reduce((sum, item) => sum + parseFloat(item.unit_price || 0) * parseFloat(item.quantity || 0), 0);
    const r = await query('INSERT INTO invoices (customer_id,invoice_number,issue_date,due_date,tariff_type,total_amount,status,notes,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING *', [customer_id, invoice_number, issue_date, due_date, tariff_type, total_amount, status, notes, req.user.id]);

    const invoiceId = r.rows[0].id;
    for (let i = 0; i < line_items.length; i++) {
      const item = line_items[i];
      await query('INSERT INTO invoice_items (invoice_id,description,quantity,unit_price,line_order) VALUES ($1,$2,$3,$4,$5)', [invoiceId, item.description, item.quantity, item.unit_price, i]);
    }

    await query('INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_values, ip_address, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      req.user.id,
      'create_invoice',
      'invoice',
      invoiceId,
      JSON.stringify({ customer_id, invoice_number, issue_date, due_date, tariff_type, total_amount, status, notes }),
      req.ip,
      req.headers['user-agent'] || null
    ]);

    res.status(201).json({ invoice: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

router.put('/:id', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const { status, due_date, notes } = req.body;
    const r = await query('UPDATE invoices SET status=COALESCE($1,status), due_date=COALESCE($2,due_date), notes=COALESCE($3,notes), updated_at=NOW() WHERE id=$4 RETURNING *', [status, due_date, notes, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Invoice not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

router.post('/:id/payment', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const { amount, method, reference, note } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Payment amount must be positive' });
    const payment = await recordPayment(req.params.id, amount, method || 'cash', reference, note, req.user.id);
    res.json(payment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to record payment' });
  }
});

module.exports = router;
