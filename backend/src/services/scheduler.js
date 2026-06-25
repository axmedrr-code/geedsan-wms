const { CronJob } = require('cron');
const { checkOfflineMeters } = require('./alarmService');

const startScheduler = () => {
  new CronJob('*/15 * * * *', async () => {
    console.log('⏰ Running offline meter check...');
    await checkOfflineMeters();
  }, null, true);
  console.log('📅 Scheduler started');
};

module.exports = { startScheduler };
