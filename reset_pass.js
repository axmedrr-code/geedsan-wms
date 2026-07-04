const bcrypt = require('bcryptjs');
const db = require('./src/config/database');

async function reset() {
  const users = [
    { username: 'admin', password: 'admin123' },
    { username: 'operator1', password: 'operator1' },
    { username: 'viewer1', password: 'viewer1' }
  ];
  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 12);
    await db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [hash, u.username]);
    console.log('Updated:', u.username);
  }
  process.exit(0);
}
reset().catch(e => { console.error(e.message); process.exit(1); });
