require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const logger = require('./services/logger');

// Crash safety: an uncaught exception leaves the process in an unknown
// state, so log it and exit (the container's `restart: unless-stopped`
// brings it back clean). An unhandled rejection is logged but doesn't crash
// the process — most of this codebase already catches promise rejections
// per-route, so one slipping through is a bug worth logging loudly, not a
// reason to take the whole API down.
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — exiting', { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { error: reason?.message || String(reason), stack: reason?.stack });
});

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
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));

// Stripe webhook must receive raw body (BEFORE express.json() consumes the stream)
const { stripeWebhookHandler } = require('./routes/paymentPortal');
app.post('/api/portal/webhook/stripe', express.raw({ type: 'application/json' }), stripeWebhookHandler);

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

// API documentation
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/api-docs.json', (req, res) => res.json(swaggerSpec));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/products', require('./routes/products'));
app.use('/api/meters', require('./routes/meters'));
app.use('/api/readings', require('./routes/readings'));
app.use('/api/gateways', require('./routes/gateways'));
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
app.use('/api/zones',    require('./routes/zones'));
app.use('/api/payments',        require('./routes/payments'));
app.use('/api/tariffs',         require('./routes/tariffs'));
app.use('/api/billing-reports', require('./routes/billingReports'));
app.use('/api/odoo',            require('./routes/odoo'));
app.use('/api/testing', require('./routes/testing'));
app.use('/api/system', require('./routes/system'));
app.use('/api/portal', require('./routes/paymentPortal').router);

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
  logger.error('Unhandled route error', {
    method: req.method,
    url: req.originalUrl,
    status: err.status || 500,
    error: err.message,
    stack: err.stack
  });
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// Notifies admins (via notification_settings entries opted into
// 'system_restart') whenever the backend boots — skipped on the very first
// ever boot (no prior recorded start) to avoid spamming on initial deploy.
const recordStartupAndNotify = async () => {
  const { query } = require('./config/database');
  const { notifySystemEvent } = require('./services/notificationService');
  try {
    const prev = await query(`SELECT value FROM system_settings WHERE key='backend_last_started_at'`);
    await query(
      `INSERT INTO system_settings(key, value, description) VALUES ('backend_last_started_at', $1, 'Last backend process start time')
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [new Date().toISOString()]
    );
    if (prev.rows[0]?.value) {
      await notifySystemEvent('system_restart', 'NUWACO WMS backend restarted',
        `The backend service restarted at ${new Date().toISOString()}. Previous recorded start: ${prev.rows[0].value}.`);
    }
  } catch (err) {
    logger.warn('Startup notification check failed', { error: err.message });
  }
};

// Retries the database connection indefinitely until it succeeds.
// Never throws — the backend process stays alive waiting for postgres rather
// than crash-looping. This covers two failure modes on reboot: (1) postgres
// still initialising, (2) Docker network not yet fully ready.
// 5 s between attempts; each attempt is logged for visibility in docker logs.
const waitForDatabase = async (delayMs = 5000) => {
  const { testConnection } = require('./config/database');
  for (let attempt = 1; ; attempt++) {
    try {
      await testConnection();
      logger.info(`✅ Database reachable (attempt ${attempt})`);
      return;
    } catch (err) {
      logger.warn(`⏳ Waiting for database — attempt ${attempt}: ${err.message}`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
};

// Start
const start = async () => {
  try {
    await waitForDatabase();
    const { runMigrations } = require('./config/migrate');
    await runMigrations();
    const { seedDemoUsers } = require('./config/seed');
    await seedDemoUsers();
    await recordStartupAndNotify();
  } catch (err) {
    logger.error('❌ Startup error, aborting', { error: err.message, stack: err.stack });
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`🚀 NUWACO WMS API running on port ${PORT}`);
    logger.info(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`💾 Database: ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
    logger.info(`🌐 CORS allowed: ${process.env.FRONTEND_URL}`);

    // Start background scheduler
    try {
      const { startScheduler } = require('./services/scheduler');
      startScheduler();
    } catch (err) {
      logger.warn('Scheduler error', { error: err.message });
    }

    // Start MQTT service for LoRaWAN integration
    try {
      const mqttService = require('./services/mqttService');
      mqttService.connect();
    } catch (err) {
      logger.warn('MQTT service error', { error: err.message });
    }
  });
};

start();

module.exports = app;
