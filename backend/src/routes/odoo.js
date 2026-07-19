const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const {
  syncCustomerToOdoo, syncProductToOdoo, syncInvoiceToOdoo, syncPaymentToOdoo,
  syncMeterToOdoo, syncReadingToOdoo, syncAlarmToOdoo, syncInvoiceFromReadingToOdoo,
  registerPaymentOnOdooMove,
  enqueueOdooSync, getOdooQueue, getOdooStatus, processRetryQueue,
  verifySyncedCustomers,
} = require('../services/odooService');

router.get('/status', authenticate, authorize('admin'), async (req, res) => {
  try { res.json(await getOdooStatus()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/queue', authenticate, authorize('admin'), async (req, res) => {
  try { res.json({ queue: await getOdooQueue() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/process-queue', authenticate, authorize('admin'), async (req, res) => {
  try { res.json({ processed: await processRetryQueue() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Immediate sync endpoints (admin/operator) ──────────────────────────────

const makeSyncRoute = (handler) => async (req, res) => {
  try { res.json(await handler(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
};

router.post('/sync/customer/:id',               authenticate, authorize('admin', 'operator'), makeSyncRoute(syncCustomerToOdoo));
router.post('/sync/product/:id',                authenticate, authorize('admin', 'operator'), makeSyncRoute(syncProductToOdoo));
router.post('/sync/invoice/:id',                authenticate, authorize('admin', 'operator'), makeSyncRoute(syncInvoiceToOdoo));
router.post('/sync/payment/:id',                authenticate, authorize('admin', 'operator'), makeSyncRoute(syncPaymentToOdoo));
router.post('/sync/meter/:id',                  authenticate, authorize('admin', 'operator'), makeSyncRoute(syncMeterToOdoo));
router.post('/sync/reading/:id',                authenticate, authorize('admin', 'operator'), makeSyncRoute(syncReadingToOdoo));
router.post('/sync/alarm/:id',                  authenticate, authorize('admin', 'operator'), makeSyncRoute(syncAlarmToOdoo));
router.post('/sync/invoice-from-reading/:id',   authenticate, authorize('admin', 'operator'), makeSyncRoute(syncInvoiceFromReadingToOdoo));

// Register a payment against a posted Odoo invoice by Odoo move ID.
// Optional body: { "amount": 50.00 } for partial payment; omit to pay full residual.
router.post('/sync/register-payment/:id', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const opts = req.body && req.body.amount ? { amount: Number(req.body.amount) } : {};
    res.json(await registerPaymentOnOdooMove(req.params.id, opts));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Queue-based (enqueue then let cron pick up) ────────────────────────────

const makeEnqueueRoute = (type) => async (req, res) => {
  try { res.json(await enqueueOdooSync(type, req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
};

router.post('/queue/customer/:id', authenticate, authorize('admin', 'operator'), makeEnqueueRoute('customer'));
router.post('/queue/meter/:id',    authenticate, authorize('admin', 'operator'), makeEnqueueRoute('meter'));
router.post('/queue/invoice/:id',  authenticate, authorize('admin', 'operator'), makeEnqueueRoute('invoice'));
router.post('/queue/payment/:id',  authenticate, authorize('admin', 'operator'), makeEnqueueRoute('payment'));
router.post('/queue/alarm/:id',    authenticate, authorize('admin', 'operator'), makeEnqueueRoute('alarm'));

// Field-level verification report: compares every WMS customer against its Odoo partner.
// Returns { summary, customers: [{wms_id, odoo_id, status, checks: {field: {pass,wms,odoo}}}] }
router.get('/verify-customers', authenticate, authorize('admin'), async (req, res) => {
  try { res.json(await verifySyncedCustomers()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
