const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host:     process.env.DB_HOST || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'geedsan_wms',
  user:     process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  // 2000 ms was too short: the first connection attempt from node-postgres
  // can exceed 2 s during Docker container warmup even after pg_isready
  // passes (the healthcheck condition). 10 s gives the pool enough headroom
  // without masking a genuinely unreachable database.
  connectionTimeoutMillis: 10000,
  ssl: false,
});

const query = async (text, params) => {
  try {
    return await pool.query(text, params);
  } catch (error) {
    console.error('Query error:', error.message);
    throw error;
  }
};

module.exports = { pool, query, getClient: () => pool.connect() };
