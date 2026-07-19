const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { query } = require('../config/database');
const logger = require('./logger');

const BACKUP_DIR = process.env.BACKUP_DIR || '/app/backups';

const runDatabaseBackup = (label = 'scheduled') => new Promise((resolve) => {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `backup_${label}_${ts}.sql`);
  const db   = process.env.DB_NAME || 'geedsan_wms';

  const cmd = `pg_dump -U ${process.env.DB_USER} -h ${process.env.DB_HOST} -p ${process.env.DB_PORT || 5432} ${db}`;

  exec(cmd, {
    env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD },
    maxBuffer: 50 * 1024 * 1024,
  }, async (err, stdout) => {
    if (err) {
      logger.error(`Backup (${label}) failed: ${err.message}`);
      await query(
        'INSERT INTO backup_log (database_name, status, file_path, file_size_bytes, error_message) VALUES ($1,$2,$3,$4,$5)',
        [db, 'failed', file, 0, err.message]
      ).catch(() => {});
      return resolve({ success: false, error: err.message });
    }

    fs.writeFileSync(file, stdout);
    const size = fs.statSync(file).size;

    await query(
      'INSERT INTO backup_log (database_name, status, file_path, file_size_bytes) VALUES ($1,$2,$3,$4)',
      [db, 'success', path.basename(file), size]
    ).catch(() => {});

    logger.info(`Backup (${label}) completed: ${path.basename(file)} (${size} bytes)`);
    resolve({ success: true, file: path.basename(file), size_bytes: size });
  });
});

module.exports = { runDatabaseBackup };
