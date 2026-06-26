const { query } = require('../config/database');

const recordAudit = async ({ userId, action, entityType, entityId, oldValues, newValues, ipAddress, userAgent }) => {
  await query(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
    userId,
    action,
    entityType,
    entityId,
    oldValues ? JSON.stringify(oldValues) : null,
    newValues ? JSON.stringify(newValues) : null,
    ipAddress || null,
    userAgent || null
  ]);
};

module.exports = { recordAudit };
