const { query } = require('../config/database');
const logger = require('./logger');
const { recordAudit } = require('./auditService');
const odoo = require('./odooXmlRpcClient');

const syncCustomerToOdoo = async (customerId) => {
  const customerResult = await query('SELECT * FROM customers WHERE id=$1', [customerId]);
  const customer = customerResult.rows[0];
  if (!customer) throw new Error('Customer not found');

  const payload = {
    name: customer.full_name,
    ref: customer.customer_number,
    email: customer.email || false,
    phone: customer.phone || false,
    street: customer.address || false,
    city: customer.city || false,
    is_company: false,
    customer_rank: 1
  };

  let odooId = customer.odoo_id ? parseInt(customer.odoo_id, 10) : null;
  if (odooId) {
    await odoo.execute('res.partner', 'write', [[odooId], payload]);
  } else {
    const existing = await odoo.execute('res.partner', 'search', [[['ref', '=', customer.customer_number]]]);
    if (existing.length) {
      odooId = existing[0];
      await odoo.execute('res.partner', 'write', [[odooId], payload]);
    } else {
      odooId = await odoo.execute('res.partner', 'create', [payload]);
    }
    await query('UPDATE customers SET odoo_id=$1, updated_at=NOW() WHERE id=$2', [String(odooId), customerId]);
  }

  return { customerId, odooId, payload };
};

const syncProductToOdoo = async (productId) => {
  const productResult = await query('SELECT * FROM products WHERE id=$1', [productId]);
  const product = productResult.rows[0];
  if (!product) throw new Error('Product not found');

  const payload = {
    name: product.name,
    default_code: product.product_code,
    list_price: Number(product.unit_price),
    sale_ok: true,
    purchase_ok: false,
    type: 'service'
  };

  let odooId = product.odoo_id ? parseInt(product.odoo_id, 10) : null;
  if (odooId) {
    await odoo.execute('product.product', 'write', [[odooId], payload]);
  } else {
    const existing = await odoo.execute('product.product', 'search', [[['default_code', '=', product.product_code]]]);
    if (existing.length) {
      odooId = existing[0];
      await odoo.execute('product.product', 'write', [[odooId], payload]);
    } else {
      odooId = await odoo.execute('product.product', 'create', [payload]);
    }
    await query('UPDATE products SET odoo_id=$1, updated_at=NOW() WHERE id=$2', [String(odooId), productId]);
  }

  return { productId, odooId, payload };
};

const syncInvoiceToOdoo = async (invoiceId) => {
  const invoiceR = await query('SELECT * FROM invoices WHERE id=$1', [invoiceId]);
  const invoice = invoiceR.rows[0];
  if (!invoice) throw new Error('Invoice not found');
  if (invoice.odoo_id) return { invoiceId, odooId: parseInt(invoice.odoo_id, 10), skipped: 'already synced' };

  const customerSync = await syncCustomerToOdoo(invoice.customer_id);

  const itemsR = await query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY line_order ASC', [invoiceId]);
  const items = itemsR.rows;
  if (!items.length) throw new Error('Invoice has no line items to sync');

  const invoiceLineIds = items.map(item => [0, 0, {
    name: item.description,
    quantity: Number(item.quantity),
    price_unit: Number(item.unit_price)
  }]);

  const moveId = await odoo.execute('account.move', 'create', [{
    move_type: 'out_invoice',
    partner_id: customerSync.odooId,
    invoice_date: invoice.issue_date,
    invoice_date_due: invoice.due_date,
    ref: invoice.invoice_number,
    invoice_line_ids: invoiceLineIds
  }]);

  await odoo.execute('account.move', 'action_post', [[moveId]]);
  await query('UPDATE invoices SET odoo_id=$1, updated_at=NOW() WHERE id=$2', [String(moveId), invoiceId]);

  return { invoiceId, odooId: moveId };
};

const syncPaymentToOdoo = async (paymentId) => {
  const paymentR = await query('SELECT * FROM invoice_payments WHERE id=$1', [paymentId]);
  const payment = paymentR.rows[0];
  if (!payment) throw new Error('Payment not found');
  if (payment.odoo_id) return { paymentId, odooId: parseInt(payment.odoo_id, 10), skipped: 'already synced' };

  const invoiceR = await query('SELECT * FROM invoices WHERE id=$1', [payment.invoice_id]);
  const invoice = invoiceR.rows[0];
  if (!invoice) throw new Error('Invoice not found for payment');
  if (!invoice.odoo_id) await syncInvoiceToOdoo(invoice.id);

  const refreshedInvoice = await query('SELECT odoo_id, customer_id FROM invoices WHERE id=$1', [invoice.id]);
  const moveId = parseInt(refreshedInvoice.rows[0].odoo_id, 10);
  const customer = await query('SELECT odoo_id FROM customers WHERE id=$1', [refreshedInvoice.rows[0].customer_id]);
  const partnerId = parseInt(customer.rows[0].odoo_id, 10);

  const journals = await odoo.execute('account.journal', 'search', [[['type', '=', 'bank']]], { limit: 1 });
  const journalId = journals[0];
  if (!journalId) throw new Error('No bank journal found in Odoo to record payment against');

  const paymentOdooId = await odoo.execute('account.payment', 'create', [{
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: partnerId,
    amount: Number(payment.amount),
    journal_id: journalId,
    ref: payment.reference || `Payment for ${invoice.invoice_number}`,
    invoice_ids: [[6, 0, [moveId]]]
  }]);

  await odoo.execute('account.payment', 'action_post', [[paymentOdooId]]);
  await query('UPDATE invoice_payments SET odoo_id=$1 WHERE id=$2', [String(paymentOdooId), paymentId]);

  return { paymentId, odooId: paymentOdooId };
};

const enqueueOdooSync = async (entityType, entityId) => {
  const validTypes = ['customer', 'product', 'invoice', 'payment'];
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

const SYNC_HANDLERS = {
  customer: syncCustomerToOdoo,
  product: syncProductToOdoo,
  invoice: syncInvoiceToOdoo,
  payment: syncPaymentToOdoo
};

const processRetryQueue = async () => {
  const queue = await query(
    `SELECT * FROM odoo_sync_queue WHERE status IN ('pending','retry') AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()) ORDER BY created_at ASC LIMIT 20`
  );
  if (!queue.rows.length) return 0;

  for (const item of queue.rows) {
    try {
      await query('UPDATE odoo_sync_queue SET status=$1, updated_at=NOW() WHERE id=$2', ['processing', item.id]);

      const handler = SYNC_HANDLERS[item.entity_type];
      if (!handler) throw new Error(`Unknown sync type ${item.entity_type}`);
      const result = await handler(item.entity_id);

      await query('UPDATE odoo_sync_queue SET status=$1, attempts=$2, last_error=NULL, next_attempt_at=NULL, updated_at=NOW() WHERE id=$3', ['completed', item.attempts + 1, item.id]);
      await recordAudit({ action: 'odoo_sync_success', entityType: item.entity_type, entityId: item.entity_id, newValues: result });
    } catch (err) {
      const attempts = item.attempts + 1;
      const nextAttemptMinutes = Math.min(60, 2 ** attempts);
      const nextAttemptAt = new Date(Date.now() + nextAttemptMinutes * 60 * 1000);
      const status = attempts >= 5 ? 'failed' : 'retry';

      await query(
        'UPDATE odoo_sync_queue SET status=$1, attempts=$2, last_error=$3, next_attempt_at=$4, updated_at=NOW() WHERE id=$5',
        [status, attempts, err.message, nextAttemptAt, item.id]
      );
      await recordAudit({ action: 'odoo_sync_failure', entityType: item.entity_type, entityId: item.entity_id, newValues: { error: err.message, attempts, status } });
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
    const info = await odoo.version();
    return { ok: true, odoo: info };
  } catch (err) {
    logger.error('Odoo status check failed', { error: err.message });
    return { ok: false, error: err.message };
  }
};

module.exports = {
  syncCustomerToOdoo,
  syncProductToOdoo,
  syncInvoiceToOdoo,
  syncPaymentToOdoo,
  enqueueOdooSync,
  processRetryQueue,
  getOdooQueue,
  getOdooStatus
};
