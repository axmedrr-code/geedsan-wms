const xmlrpc = require('xmlrpc');
const logger = require('./logger');

const ODOO_URL = process.env.ODOO_URL || 'http://odoo:8069';
const ODOO_DB = process.env.ODOO_DB || 'odoo';
const ODOO_USERNAME = process.env.ODOO_USERNAME || 'admin';
const ODOO_SECRET = process.env.ODOO_API_KEY || process.env.ODOO_PASSWORD || process.env.ADMIN_PASSWORD;

let uid = null;

const buildClient = (path) => {
  const url = new URL(ODOO_URL);
  const isSecure = url.protocol === 'https:';
  const opts = { host: url.hostname, port: url.port || (isSecure ? 443 : 80), path };
  return isSecure ? xmlrpc.createSecureClient(opts) : xmlrpc.createClient(opts);
};

const commonClient = buildClient('/xmlrpc/2/common');
const objectClient = buildClient('/xmlrpc/2/object');

const methodCall = (client, method, params) => new Promise((resolve, reject) => {
  client.methodCall(method, params, (err, value) => (err ? reject(err) : resolve(value)));
});

const authenticate = async (forceRefresh = false) => {
  if (uid && !forceRefresh) return uid;
  if (!ODOO_SECRET) throw new Error('Odoo credentials not configured (set ODOO_API_KEY or ODOO_PASSWORD)');
  uid = await methodCall(commonClient, 'authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_SECRET, {}]);
  if (!uid) throw new Error('Odoo authentication failed — check ODOO_USERNAME/ODOO_API_KEY');
  return uid;
};

// Matches Odoo's actual auth/session-failure exception shapes only —
// odoo.exceptions.AccessDenied ("Access Denied") and session-expiry faults.
// Deliberately does NOT match a bare "invalid" — that word also appears in
// unrelated Odoo ORM errors (e.g. "Invalid field 'x' on model 'y'" from
// odoo.osv.expression when a domain references a field that doesn't exist
// in the target Odoo database's schema, such as a custom module that was
// never installed/upgraded there). Matching on it caused every such error
// to be misreported as a stale session, retried against the identical
// broken call, and logged with no detail about the real exception — see
// the incident writeup for 2026-07-25/26 in docs/EMERGENCY_RECOVERY_GUIDE.md.
const AUTH_FAILURE_RE = /access\s*denied|session\s*expired/i;

// Executes an Odoo model method via execute_kw. Re-authenticates once and
// retries on an auth-shaped failure (e.g. uid expired/invalidated server-side).
const execute = async (model, method, args = [], kwargs = {}) => {
  const currentUid = await authenticate();
  try {
    return await methodCall(objectClient, 'execute_kw', [ODOO_DB, currentUid, ODOO_SECRET, model, method, args, kwargs]);
  } catch (err) {
    if (AUTH_FAILURE_RE.test(err.message || '')) {
      logger.warn('Odoo auth appears stale, re-authenticating once', { model, method, error: err.message });
      const freshUid = await authenticate(true);
      return methodCall(objectClient, 'execute_kw', [ODOO_DB, freshUid, ODOO_SECRET, model, method, args, kwargs]);
    }
    logger.error('Odoo execute_kw failed (non-auth error, not retried)', { model, method, error: err.message });
    throw err;
  }
};

const version = () => methodCall(commonClient, 'version', []);

module.exports = { execute, authenticate, version };
