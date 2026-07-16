const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const {
  syncCustomerToOdoo, syncProductToOdoo, syncInvoiceToOdoo, syncPaymentToOdoo,
  syncMeterToOdoo, syncReadingToOdoo, syncAlarmToOdoo,
  enqueueOdooSync, getOdooQueue, getOdooStatus, processRetryQueue,
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

router.post('/sync/customer/:id', authenticate, authorize('admin', 'operator'), makeSyncRoute(syncCustomerToOdoo));
router.post('/sync/product/:id',  authenticate, authorize('admin', 'operator'), makeSyncRoute(syncProductToOdoo));
router.post('/sync/invoice/:id',  authenticate, authorize('admin', 'operator'), makeSyncRoute(syncInvoiceToOdoo));
router.post('/sync/payment/:id',  authenticate, authorize('admin', 'operator'), makeSyncRoute(syncPaymentToOdoo));
router.post('/sync/meter/:id',    authenticate, authorize('admin', 'operator'), makeSyncRoute(syncMeterToOdoo));
router.post('/sync/reading/:id',  authenticate, authorize('admin', 'operator'), makeSyncRoute(syncReadingToOdoo));
router.post('/sync/alarm/:id',    authenticate, authorize('admin', 'operator'), makeSyncRoute(syncAlarmToOdoo));

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

module.exports = router;
