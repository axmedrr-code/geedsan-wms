const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { createBillingCycleForCustomer, postBillingCycleInvoice, recordPayment } = require('../services/billingService');

router.get('/', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const { customer_id, status, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    let where = '1=1';
    if (customer_id) { params.push(customer_id); where += ` AND customer_id=$${params.length}`; }
    if (status) { params.push(status); where += ` AND status=$${params.length}`; }
    const countR = await query(`SELECT COUNT(*) FROM billing_cycles WHERE ${where}`, params);
    const r = await query(`SELECT * FROM billing_cycles WHERE ${where} ORDER BY period_end DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]);
    res.json({ data: r.rows, pagination: { total: parseInt(countR.rows[0].count), page: parseInt(page), limit: parseInt(limit) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch billing cycles' });
  }
});

router.post('/', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const { customer_id, cycle_type, period_start, period_end, due_date, notes } = req.body;
    if (!customer_id || !period_start || !period_end || !due_date) {
      return res.status(400).json({ error: 'Missing billing cycle fields' });
    }
    const cycle = await createBillingCycleForCustomer(customer_id, cycle_type || 'monthly', period_start, period_end, due_date, req.user.id, notes);
    res.status(201).json(cycle);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to create billing cycle' });
  }
});

router.get('/:id', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const cycleR = await query(`SELECT bc.*, c.full_name AS customer_name, c.customer_number, c.email AS customer_email FROM billing_cycles bc LEFT JOIN customers c ON bc.customer_id=c.id WHERE bc.id=$1`, [req.params.id]);
    if (!cycleR.rows[0]) return res.status(404).json({ error: 'Billing cycle not found' });
    const billingCycle = cycleR.rows[0];
    let invoice = null;
    let payments = [];

    if (billingCycle.invoice_id) {
      const invoiceR = await query('SELECT * FROM invoices WHERE id=$1', [billingCycle.invoice_id]);
      invoice = invoiceR.rows[0] || null;
      if (invoice) {
        const paymentsR = await query('SELECT * FROM invoice_payments WHERE invoice_id=$1 ORDER BY payment_date DESC', [invoice.id]);
        payments = paymentsR.rows;
      }
    }

    res.json({ billingCycle, invoice, payments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to fetch billing cycle' });
  }
});

router.post('/:id/invoice', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const { invoice_number, note } = req.body;
    const invoice = await postBillingCycleInvoice(req.params.id, invoice_number, note, req.user.id);
    res.status(201).json(invoice);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to post invoice' });
  }
});

router.post('/:id/payment', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const { amount, method, reference, note } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Payment amount must be positive' });
    const cycle = await query('SELECT invoice_id FROM billing_cycles WHERE id=$1', [req.params.id]);
    if (!cycle.rows[0]) return res.status(404).json({ error: 'Billing cycle not found' });
    if (!cycle.rows[0].invoice_id) return res.status(400).json({ error: 'Billing cycle has no linked invoice yet' });
    const payment = await recordPayment(cycle.rows[0].invoice_id, amount, method || 'cash', reference, note, req.user.id);
    res.json(payment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to record payment' });
  }
});

module.exports = router;
