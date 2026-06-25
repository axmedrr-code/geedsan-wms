const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const result = await query('SELECT * FROM users WHERE (username = $1 OR email = $1) AND is_active = true', [username]);
    const user = result.rows[0];
    if (!user || !await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
    await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    const accessToken = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
    const refreshToken = jwt.sign({ userId: user.id }, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ accessToken, refreshToken, user: { id: user.id, username: user.username, email: user.email, fullName: user.full_name, role: user.role } });
  } catch (err) { res.status(500).json({ error: 'Login failed' }); }
});

router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
    const result = await query('SELECT id, username, email, full_name, role FROM users WHERE id = $1 AND is_active = true', [decoded.userId]);
    if (!result.rows[0]) return res.status(401).json({ error: 'User not found' });
    const user = result.rows[0];
    const newAccessToken = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ accessToken: newAccessToken });
  } catch (err) { res.status(401).json({ error: 'Invalid refresh token' }); }
});

router.get('/me', authenticate, async (req, res) => {
  res.json({ user: { id: req.user.id, username: req.user.username, email: req.user.email, fullName: req.user.full_name, role: req.user.role } });
});

router.post('/logout', authenticate, async (req, res) => {
  await query('INSERT INTO audit_log (user_id, action, ip_address) VALUES ($1, $2, $3)', [req.user.id, 'logout', req.ip]);
  res.json({ message: 'Logged out successfully' });
});

router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!await bcrypt.compare(currentPassword, result.rows[0].password_hash)) return res.status(400).json({ error: 'Current password incorrect' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [await bcrypt.hash(newPassword, 12), req.user.id]);
    res.json({ message: 'Password changed successfully' });
  } catch (err) { res.status(500).json({ error: 'Failed to change password' }); }
});

module.exports = router;
