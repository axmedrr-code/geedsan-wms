const { CronJob } = require('cron');
const { checkOfflineMeters } = require('./alarmService');
const { markOverdueInvoices } = require('./billingService');
const { processRetryQueue } = require('./odooService');

const startScheduler = () => {
  new CronJob('*/15 * * * *', async () => {
    console.log('⏰ Running offline meter check...');
    await checkOfflineMeters();
  }, null, true);

  new CronJob('0 3 * * *', async () => {
    console.log('⏰ Running overdue invoice check...');
    const count = await markOverdueInvoices();
    console.log(`🔔 Marked ${count} overdue invoices.`);
  }, null, true);

  new CronJob('*/10 * * * *', async () => {
    console.log('⏰ Processing Odoo sync retry queue...');
    const processed = await processRetryQueue();
    console.log(`🔁 Processed ${processed} Odoo sync records.`);
  }, null, true);

  console.log('📅 Scheduler started');
};

module.exports = { startScheduler };
