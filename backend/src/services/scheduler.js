const { CronJob } = require('cron');
const { query } = require('../config/database');
const { checkOfflineMeters, checkOfflineGateways, checkAbnormalConsumption } = require('./alarmService');
const { markOverdueInvoices, runMonthlyAutoBilling } = require('./billingService');
const { processRetryQueue } = require('./odooService');
const { processFailedDownlinks } = require('./downlinkRetryService');
const { runDatabaseBackup } = require('./backupService');
const { aggregateYesterdayForAllMeters } = require('./consumptionService');
const { detectLeaksAllMeters } = require('./leakDetectionService');
const logger = require('./logger');

const startScheduler = () => {
  new CronJob('*/15 * * * *', async () => {
    logger.info('⏰ Running offline meter/gateway check...');
    await checkOfflineMeters();
    await checkOfflineGateways();
  }, null, true);

  new CronJob('*/30 * * * *', async () => {
    logger.info('⏰ Running abnormal consumption check...');
    await checkAbnormalConsumption();
  }, null, true);

  new CronJob('0 3 * * *', async () => {
    logger.info('⏰ Running overdue invoice check...');
    const count = await markOverdueInvoices();
    logger.info(`🔔 Marked ${count} overdue invoices.`);
  }, null, true);

  new CronJob('0 2 1 * *', async () => {
    logger.info('⏰ Running monthly auto-billing...');
    const result = await runMonthlyAutoBilling();
    logger.info(`🧾 Monthly billing run ${result.runId}: ${result.ok} invoiced, ${result.skipped} skipped, ${result.failed} failed — status: ${result.status}.`);
  }, null, true);

  new CronJob('*/10 * * * *', async () => {
    logger.info('⏰ Processing Odoo sync retry queue...');
    const processed = await processRetryQueue();
    logger.info(`🔁 Processed ${processed} Odoo sync records.`);
  }, null, true);

  new CronJob('*/5 * * * *', async () => {
    const processed = await processFailedDownlinks();
    if (processed > 0) logger.info(`🔁 Retried ${processed} failed downlink command(s).`);
  }, null, true);

  // Aggregate yesterday's consumption for all meters at 00:30 — raw readings are
  // already written; this job materialises the daily totals into meter_consumption_daily
  // so analytics and billing queries hit a pre-aggregated table rather than raw data.
  new CronJob('30 0 * * *', async () => {
    logger.info('⏰ Aggregating yesterday\'s consumption...');
    const result = await aggregateYesterdayForAllMeters();
    logger.info(`📊 Consumption aggregation: ${result.ok} meters, date=${result.date}`);
  }, null, true);

  // Every 10 minutes: expire valve commands that have been 'sent' past their timeout_at
  new CronJob('*/10 * * * *', async () => {
    const r = await query(
      `UPDATE downlink_commands
          SET status='timeout', lifecycle_log = lifecycle_log || '[{"state":"timeout"}]'::jsonb
        WHERE status='sent' AND timeout_at IS NOT NULL AND timeout_at < NOW()
        RETURNING id`
    );
    if (r.rows.length > 0) logger.warn(`⏱  Timed out ${r.rows.length} valve command(s)`);
  }, null, true);

  // Hourly leak detection sweep across all active meters.
  new CronJob('0 * * * *', async () => {
    logger.info('⏰ Running leak detection sweep...');
    const opened = await detectLeaksAllMeters();
    if (opened > 0) logger.info(`💧 Leak detection: ${opened} new event(s) opened`);
  }, null, true);

  // Daily database backup at 01:00 — runs before the overdue-invoice check (03:00)
  // and the monthly billing run (02:00 on the 1st).
  new CronJob('0 1 * * *', async () => {
    logger.info('⏰ Running scheduled database backup...');
    const result = await runDatabaseBackup('scheduled');
    if (result.success) {
      logger.info(`💾 Backup completed: ${result.file} (${result.size_bytes} bytes)`);
    } else {
      logger.error(`❌ Backup failed: ${result.error}`);
    }
  }, null, true);

  logger.info('📅 Scheduler started');
};

module.exports = { startScheduler };
