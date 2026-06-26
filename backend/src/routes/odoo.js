const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { syncCustomerToOdoo, syncProductToOdoo, syncInvoiceToOdoo, enqueueOdooSync, getOdooQueue, getOdooStatus, processRetryQueue } = require('../services/odooService');

router.get('/status', authenticate, authorize('admin'), async (req, res) => {
  try {
    const status = await getOdooStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/queue', authenticate, authorize('admin'), async (req, res) => {
  try {
    const queue = await getOdooQueue();
    res.json({ queue });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync/customer/:id', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const result = await enqueueOdooSync('customer', req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync/product/:id', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const result = await enqueueOdooSync('product', req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync/invoice/:id', authenticate, authorize('admin','operator'), async (req, res) => {
  try {
    const result = await enqueueOdooSync('invoice', req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/process-queue', authenticate, authorize('admin'), async (req, res) => {
  try {
    const processed = await processRetryQueue();
    res.json({ processed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
