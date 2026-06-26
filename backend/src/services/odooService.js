const axios = require('axios');
const { query } = require('../config/database');
const logger = require('./logger');

const ODOO_BASE_URL = process.env.ODOO_API_BASE_URL || process.env.ODOO_URL;
const ODOO_API_KEY = process.env.ODOO_API_KEY;
const ODOO_USERNAME = process.env.ODOO_USERNAME;
const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

const getClient = () => {
  if (!ODOO_BASE_URL) {
    throw new Error('ODOO API base URL is not configured');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (ODOO_API_KEY) headers.Authorization = `Bearer ${ODOO_API_KEY}`;

  const config = { baseURL: ODOO_BASE_URL, timeout: 15000, headers };
  if (!ODOO_API_KEY && ODOO_USERNAME && ODOO_PASSWORD) {
    config.auth = { username: ODOO_USERNAME, password: ODOO_PASSWORD };
  }

  return axios.create(config);
};

const parseOdooResponseId = (data) => data?.id || data?.odoo_id || data?.external_id || null;

const buildCustomerPayload = (customer) => ({
  customer_number: customer.customer_number,
  name: customer.full_name,
  email: customer.email,
  phone: customer.phone,
  address: customer.address,
  city: customer.city,
  district: customer.district,
  tariff_type: customer.tariff_type,
  account_status: customer.account_status
});

const buildProductPayload = (product) => ({
  product_code: product.product_code,
  name: product.name,
  description: product.description,
  unit_price: Number(product.unit_price),
  unit: product.unit,
  status: product.status
});

const buildInvoicePayload = (invoice, customer, items) => ({
  invoice_number: invoice.invoice_number,
  issue_date: invoice.issue_date,
  due_date: invoice.due_date,
  status: invoice.status,
  total_amount: Number(invoice.total_amount),
  customer_id: customer.odoo_id,
  lines: items.map(item => ({
    description: item.description,
    quantity: Number(item.quantity),
    unit_price: Number(item.unit_price),
    product_code: item.product_code || null,
    product_name: item.product_name || null
  }))
});

const syncCustomerToOdoo = async (customerId) => {
  const customerResult = await query('SELECT * FROM customers WHERE id=$1', [customerId]);
  const customer = customerResult.rows[0];
  if (!customer) throw new Error('Customer not found');

  const client = getClient();
  const payload = buildCustomerPayload(customer);
  const endpoint = customer.odoo_id ? `/api/customers/${customer.odoo_id}` : '/api/customers';
  const method = customer.odoo_id ? 'put' : 'post';

  const response = await client[method](endpoint, payload);
  const odooId = parseOdooResponseId(response.data);
  if (odooId) {
    await query('UPDATE customers SET odoo_id=$1, updated_at=NOW() WHERE id=$2', [odooId, customerId]);
  }

  return { customerId, odooId, payload, response: response.data };
};

const syncProductToOdoo = async (productId) => {
  const productResult = await query('SELECT * FROM products WHERE id=$1', [productId]);
  const product = productResult.rows[0];
  if (!product) throw new Error('Product not found');

  const client = getClient();
  const payload = buildProductPayload(product);
  const endpoint = product.odoo_id ? `/api/products/${product.odoo_id}` : '/api/products';
  const method = product.odoo_id ? 'put' : 'post';

  const response = await client[method](endpoint, payload);
  const odooId = parseOdooResponseId(response.data);
  if (odooId) {
    await query('UPDATE products SET odoo_id=$1, updated_at=NOW() WHERE id=$2', [odooId, productId]);
  }

  return { productId, odooId, payload, response: response.data };
};

const syncInvoiceToOdoo = async (invoiceId) => {
  const invoiceR = await query('SELECT i.*, c.odoo_id AS customer_odoo_id FROM invoices i JOIN customers c ON i.customer_id=c.id WHERE i.id=$1', [invoiceId]);
  const invoice = invoiceR.rows[0];
  if (!invoice) throw new Error('Invoice not found');

  if (!invoice.customer_odoo_id) {
    const customerSync = await syncCustomerToOdoo(invoice.customer_id);
    invoice.customer_odoo_id = customerSync.odooId;
  }

  const itemsR = await query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY line_order ASC', [invoiceId]);
  const items = itemsR.rows;

  const client = getClient();
  const payload = buildInvoicePayload(invoice, { odoo_id: invoice.customer_odoo_id }, items);
  const endpoint = invoice.odoo_id ? `/api/invoices/${invoice.odoo_id}` : '/api/invoices';
  const method = invoice.odoo_id ? 'put' : 'post';

  const response = await client[method](endpoint, payload);
  const odooId = parseOdooResponseId(response.data);
  if (odooId) {
    await query('UPDATE invoices SET odoo_id=$1, updated_at=NOW() WHERE id=$2', [odooId, invoiceId]);
  }

  return { invoiceId, odooId, payload, response: response.data };
};

const enqueueOdooSync = async (entityType, entityId) => {
  const validTypes = ['customer', 'product', 'invoice'];
  if (!validTypes.includes(entityType)) throw new Error('Invalid Odoo entity type');

  const result = await query(
    `INSERT INTO odoo_sync_queue (entity_type, entity_id, payload, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES ($1, $2, NULL, 'pending', 0, NOW(), NOW(), NOW())
     ON CONFLICT (entity_type, entity_id)
     DO UPDATE SET status='pending', attempts=0, next_attempt_at=NOW(), updated_at=NOW()
     RETURNING *`,
    [entityType, entityId]
  );
  return result.rows[0];
};

const processRetryQueue = async () => {
  const queue = await query(
    `SELECT * FROM odoo_sync_queue WHERE status IN ('pending','retry') AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()) ORDER BY created_at ASC LIMIT 20`
  );
  if (!queue.rows.length) return 0;

  for (const item of queue.rows) {
    try {
      await query('UPDATE odoo_sync_queue SET status=$1, updated_at=NOW() WHERE id=$2', ['processing', item.id]);

      if (item.entity_type === 'customer') await syncCustomerToOdoo(item.entity_id);
      else if (item.entity_type === 'product') await syncProductToOdoo(item.entity_id);
      else if (item.entity_type === 'invoice') await syncInvoiceToOdoo(item.entity_id);
      else throw new Error(`Unknown sync type ${item.entity_type}`);

      await query('UPDATE odoo_sync_queue SET status=$1, attempts=$2, last_error=NULL, next_attempt_at=NULL, updated_at=NOW() WHERE id=$3', ['completed', item.attempts + 1, item.id]);
    } catch (err) {
      const attempts = item.attempts + 1;
      const nextAttemptMinutes = Math.min(60, 2 ** attempts);
      const nextAttemptAt = new Date(Date.now() + nextAttemptMinutes * 60 * 1000);
      const status = attempts >= 5 ? 'failed' : 'retry';

      await query(
        'UPDATE odoo_sync_queue SET status=$1, attempts=$2, last_error=$3, next_attempt_at=$4, updated_at=NOW() WHERE id=$5',
        [status, attempts, err.message, nextAttemptAt, item.id]
      );
      logger.error(`Odoo sync failed for ${item.entity_type}:${item.entity_id}`, { attempt: attempts, error: err.message });
    }
  }

  return queue.rows.length;
};

const getOdooQueue = async () => {
  const r = await query('SELECT * FROM odoo_sync_queue ORDER BY updated_at DESC LIMIT 100');
  return r.rows;
};

const getOdooStatus = async () => {
  try {
    const client = getClient();
    const response = await client.get('/api/health');
    return { ok: true, odoo: response.data };
  } catch (err) {
    logger.error('Odoo status check failed', { error: err.message });
    return { ok: false, error: err.message };
  }
};

module.exports = {
  syncCustomerToOdoo,
  syncProductToOdoo,
  syncInvoiceToOdoo,
  enqueueOdooSync,
  processRetryQueue,
  getOdooQueue,
  getOdooStatus
};
