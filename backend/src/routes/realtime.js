const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { stream } = require('../services/realtimeService');

router.get('/events', authenticate, async (req, res) => {
  stream(req, res);
});

module.exports = router;
