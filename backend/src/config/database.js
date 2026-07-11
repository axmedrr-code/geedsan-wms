const { Pool } = require('pg');

// dotenv is already loaded by index.js line 1 before any route or service
// requires this module. Calling it again here was a no-op in Docker (no
// /app/.env in the image) and a hazard in local dev if a backend/.env
// existed with stale values. Removed — rely on index.js to load dotenv.

let _pool = null;

// Lazy singleton: the Pool is not created until the first getPool() call.
// This prevents the pool from being instantiated at module-load time with
// env vars that haven't been set yet, and makes it easier to test.
const getPool = () => {
  if (_pool) return _pool;
  _pool = new Pool({
    host:     process.env.DB_HOST || 'postgres',
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'geedsan_wms',
    user:     process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    max: 20,
    idleTimeoutMillis: 30000,
    // 10 s gives the pool enough headroom during Docker warmup without
    // masking a genuinely unreachable database.
    connectionTimeoutMillis: 10000,
    ssl: false,
  });
  return _pool;
};

const query = async (text, params) => {
  try {
    return await getPool().query(text, params);
  } catch (error) {
    console.error('Query error:', error.message);
    throw error;
  }
};

// Used by index.js waitForDatabase() to test connectivity before running
// migrations — not a route, not exported as part of the public API.
const testConnection = async () => {
  const client = await getPool().connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
};

module.exports = {
  // Expose the lazy accessor rather than the pool directly so callers that
  // destructure { pool } at require() time still get the live instance.
  get pool() { return getPool(); },
  query,
  getClient: () => getPool().connect(),
  testConnection,
};
