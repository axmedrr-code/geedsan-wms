const fs = require('fs');
const path = require('path');
const { pool, query } = require('./database');
const logger = require('../services/logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

const runMigrations = async () => {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(255) UNIQUE NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  if (!fs.existsSync(MIGRATIONS_DIR)) return;

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  const appliedR = await query('SELECT filename FROM schema_migrations');
  const applied = new Set(appliedR.rows.map(r => r.filename));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      logger.info(`✅ Applied migration: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`❌ Migration failed: ${file} — ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }
};

module.exports = { runMigrations };
