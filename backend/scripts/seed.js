const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config({ path: `${__dirname}/../.env` });

const pool = new Pool({ host: process.env.DB_HOST||'localhost', port: parseInt(process.env.DB_PORT)||5432, database: process.env.DB_NAME||'geedsan_wms', user: process.env.DB_USER||'postgres', password: process.env.DB_PASSWORD });

const users = [
  { username:'admin',     email:'admin@nuwaco.com',    password:'Admin@Nuwaco2024', full_name:'System Administrator', role:'admin' },
  { username:'operator1', email:'operator@nuwaco.com', password:'Operator@2024',     full_name:'Field Operator',       role:'operator' },
  { username:'viewer1',   email:'viewer@nuwaco.com',   password:'Viewer@2024',       full_name:'Report Viewer',        role:'viewer' }
];

(async () => {
  const c = await pool.connect();
  try {
    for (const u of users) {
      const h = await bcrypt.hash(u.password, 12);
      await c.query('INSERT INTO users(username,email,password_hash,full_name,role)VALUES($1,$2,$3,$4,$5)ON CONFLICT(username)DO UPDATE SET password_hash=$3',[u.username,u.email,h,u.full_name,u.role]);
      console.log(`✅ ${u.username} / ${u.password}`);
    }
    console.log('Seed complete!');
  } finally { c.release(); await pool.end(); }
})().catch(console.error);
