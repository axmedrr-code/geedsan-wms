const bcrypt = require('bcryptjs');
const { query } = require('./database');
const logger = require('../services/logger');

const DEMO_USERS = [
  { username: 'admin', email: 'admin@geedsan.com', password: 'admin123', full_name: 'System Administrator', role: 'admin' },
  { username: 'operator1', email: 'operator@geedsan.com', password: 'operator1', full_name: 'Field Operator', role: 'operator' },
  { username: 'viewer1', email: 'viewer@geedsan.com', password: 'viewer1', full_name: 'Report Viewer', role: 'viewer' }
];

// Only seeds when the users table is empty, so it never overwrites real
// passwords on an already-running system — just self-heals a fresh/restored DB.
const seedDemoUsers = async () => {
  const { rows } = await query('SELECT COUNT(*) FROM users');
  if (parseInt(rows[0].count, 10) > 0) return;

  for (const u of DEMO_USERS) {
    const hash = await bcrypt.hash(u.password, 12);
    await query(
      'INSERT INTO users(username,email,password_hash,full_name,role) VALUES($1,$2,$3,$4,$5) ON CONFLICT(username) DO NOTHING',
      [u.username, u.email, hash, u.full_name, u.role]
    );
  }
  logger.info('✅ Seeded default demo users (admin, operator1, viewer1)');
};

module.exports = { seedDemoUsers };
