require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors({
  origin: [process.env.FRONTEND_URL || 'http://localhost:3000', 'http://localhost:80', 'http://localhost'],
  credentials: true
}));
app.use(compression());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500, message: { error: 'Too many requests' } });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many login attempts' } });
app.use('/api/', limiter);
app.use('/api/auth/login', authLimiter);

// Serve static report files
const REPORTS_DIR = process.env.REPORTS_DIR || path.join(__dirname, '../reports');
app.use('/reports', express.static(REPORTS_DIR));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/products', require('./routes/products'));
app.use('/api/meters', require('./routes/meters'));
app.use('/api/alarms', require('./routes/alarms'));
app.use('/api/downlinks', require('./routes/downlinks'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/webhook', require('./routes/webhook'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/billing-cycles', require('./routes/billingCycles'));
app.use('/api/tanker', require('./routes/tanker'));
app.use('/api/realtime', require('./routes/realtime'));
app.use('/api/odoo', require('./routes/odoo'));

// Health check
app.get('/health', async (req, res) => {
  try {
    const { pool } = require('./config/database');
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', db: 'connected', uptime: process.uptime(), timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', db: 'disconnected', error: err.message });
  }
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found', path: req.originalUrl });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// Start
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 GEEDSAN WMS API running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`💾 Database: ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
  console.log(`🌐 CORS allowed: ${process.env.FRONTEND_URL}`);

  // Start background scheduler
  try {
    const { startScheduler } = require('./services/scheduler');
    startScheduler();
  } catch (err) {
    console.warn('Scheduler error:', err.message);
  }

  // Start MQTT service for LoRaWAN integration
  try {
    const mqttService = require('./services/mqttService');
    mqttService.connect();
  } catch (err) {
    console.warn('MQTT service error:', err.message);
  }
});

module.exports = app;
