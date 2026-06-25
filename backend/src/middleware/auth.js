const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await query('SELECT id, username, email, full_name, role, is_active FROM users WHERE id = $1', [decoded.userId]);
    if (!result.rows[0] || !result.rows[0].is_active) return res.status(401).json({ error: 'User not found or inactive' });
    req.user = result.rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token' });
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  next();
};

module.exports = { authenticate, authorize };
