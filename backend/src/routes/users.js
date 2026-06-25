const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', authenticate, authorize('admin'), async (req, res) => {
  const r = await query('SELECT id,username,email,full_name,role,is_active,last_login,created_at FROM users ORDER BY created_at DESC');
  res.json(r.rows);
});

router.post('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { username, email, password, full_name, role } = req.body;
    if (!username || !email || !password || !full_name) return res.status(400).json({ error: 'All fields required' });
    const hash = await bcrypt.hash(password, 12);
    const r = await query('INSERT INTO users (username,email,password_hash,full_name,role) VALUES ($1,$2,$3,$4,$5) RETURNING id,username,email,full_name,role', [username, email, hash, full_name, role || 'viewer']);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username or email already exists' });
    res.status(500).json({ error: 'Failed to create user' });
  }
});

router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { full_name, email, role, is_active } = req.body;
    const r = await query('UPDATE users SET full_name=COALESCE($1,full_name),email=COALESCE($2,email),role=COALESCE($3,role),is_active=COALESCE($4,is_active),updated_at=NOW() WHERE id=$5 RETURNING id,username,email,full_name,role,is_active', [full_name, email, role, is_active, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Failed to update user' }); }
});

router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  await query('UPDATE users SET is_active=false WHERE id=$1', [req.params.id]);
  res.json({ message: 'User deactivated' });
});

module.exports = router;
