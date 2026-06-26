const { query } = require('../config/database');
const { publish } = require('./realtimeService');
const { recordAudit } = require('./auditService');
const pdf = require('pdfkit');
const fs = require('fs');
const path = require('path');

const INVOICE_DIR = process.env.REPORTS_DIR || path.join(__dirname, '../../reports');
if (!fs.existsSync(INVOICE_DIR)) fs.mkdirSync(INVOICE_DIR, { recursive: true });

const calculateUsageAmount = async (customerId, startDate, endDate) => {
  const meters = await query(`SELECT id, tariff_type FROM meters WHERE customer_id=$1 AND status='active'`, [customerId]);
  if (!meters.rows.length) return 0;

  const rates = { residential: 1.2, commercial: 1.8, industrial: 2.4, government: 1.0 };
  let total = 0;

  for (const meter of meters.rows) {
    const reading = await query(`SELECT MAX(total_consumption) AS max_total, MIN(total_consumption) AS min_total FROM meter_readings WHERE meter_id=$1 AND timestamp BETWEEN $2 AND $3`, [meter.id, startDate, endDate]);
    const maxTotal = parseFloat(reading.rows[0].max_total || 0);
    const minTotal = parseFloat(reading.rows[0].min_total || 0);
    const consumption = Math.max(0, maxTotal - minTotal);
    total += consumption * (rates[meter.tariff_type] || rates.residential);
  }

  return Number(total.toFixed(2));
};

const createInvoicePDF = async (invoice, items, customer) => {
  const filename = `invoice-${invoice.invoice_number}.pdf`;
  const filePath = path.join(INVOICE_DIR, filename);
  const issueDate = invoice.issue_date ? new Date(invoice.issue_date).toISOString().slice(0, 10) : '';
  const dueDate = invoice.due_date ? new Date(invoice.due_date).toISOString().slice(0, 10) : '';

  await new Promise((resolve, reject) => {
    const doc = new pdf({ size: 'A4', margin: 40 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fillColor('#0B2447').fontSize(20).text('NUWACO WMS', { align: 'left' });
    doc.fontSize(10).fillColor('#334155').text('Billing Invoice', { align: 'right' });
    doc.moveDown();

    doc.fontSize(12).text(`Invoice #: ${invoice.invoice_number}`);
    doc.text(`Issue Date: ${issueDate}`);
    doc.text(`Due Date: ${dueDate}`);
    doc.text(`Status: ${invoice.status}`);
    doc.moveDown();

    doc.fontSize(11).fillColor('#0F172A').text('Bill To:', { underline: true });
    doc.fontSize(10).text(customer.full_name);
    if (customer.address) doc.text(customer.address);
    if (customer.email) doc.text(customer.email);
    if (customer.phone) doc.text(customer.phone);
    doc.moveDown();

    doc.fontSize(11).text('Invoice Items:', { underline: true });
    const tableTop = doc.y + 10;

    doc.fontSize(10).text('Description', 40, tableTop);
    doc.text('Qty', 300, tableTop);
    doc.text('Unit Price', 360, tableTop);
    doc.text('Amount', 460, tableTop);
    doc.moveTo(40, tableTop + 15).lineTo(540, tableTop + 15).stroke();

    let position = tableTop + 25;
    items.forEach(item => {
      doc.text(item.description, 40, position);
      doc.text(item.quantity.toString(), 300, position);
      doc.text(`$${Number(item.unit_price).toFixed(2)}`, 360, position);
      doc.text(`$${(Number(item.quantity) * Number(item.unit_price)).toFixed(2)}`, 460, position);
      position += 20;
    });

    doc.moveTo(40, position).lineTo(540, position).stroke();
    position += 10;
    doc.fontSize(11).text(`Total: $${Number(invoice.total_amount).toFixed(2)}`, 400, position);

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return { filePath, filename };
};

const createBillingCycleForCustomer = async (customerId, cycleType, startDate, endDate, dueDate, generatedBy, notes) => {
  const amount = await calculateUsageAmount(customerId, startDate, endDate);
  const r = await query(`INSERT INTO billing_cycles (customer_id, cycle_type, period_start, period_end, due_date, amount, status, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8) RETURNING *`, [customerId, cycleType, startDate, endDate, dueDate, amount, notes || null, generatedBy]);
  return r.rows[0];
};

const postBillingCycleInvoice = async (billingCycleId, invoiceNumber, note, userId) => {
  const cycle = await query('SELECT * FROM billing_cycles WHERE id=$1', [billingCycleId]);
  if (!cycle.rows[0]) throw new Error('Billing cycle not found');
  const bc = cycle.rows[0];

  const existing = await query('SELECT id FROM invoices WHERE invoice_number=$1', [invoiceNumber]);
  if (existing.rows.length) throw new Error('Invoice number already exists');

  const customer = await query('SELECT * FROM customers WHERE id=$1', [bc.customer_id]);
  if (!customer.rows[0]) throw new Error('Customer not found');

  const tariffType = customer.rows[0].tariff_type || 'residential';
  const r = await query('INSERT INTO invoices (customer_id,invoice_number,issue_date,due_date,tariff_type,total_amount,status,notes,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING *', [bc.customer_id, invoiceNumber, bc.period_end, bc.due_date, tariffType, bc.amount, 'pending', note, userId]);
  const invoice = r.rows[0];

  await query('UPDATE billing_cycles SET invoice_id=$1,status=$2,updated_at=NOW() WHERE id=$3', [invoice.id, 'posted', billingCycleId]);

  const periodStart = bc.period_start ? new Date(bc.period_start).toISOString().slice(0, 10) : '';
  const periodEnd = bc.period_end ? new Date(bc.period_end).toISOString().slice(0, 10) : '';
  const invoiceItems = [{ description: `Water usage from ${periodStart} to ${periodEnd}`, quantity: 1, unit_price: bc.amount }];

  for (let i = 0; i < invoiceItems.length; i += 1) {
    const item = invoiceItems[i];
    await query('INSERT INTO invoice_items (invoice_id,description,quantity,unit_price,line_order) VALUES ($1,$2,$3,$4,$5)', [invoice.id, item.description, item.quantity, item.unit_price, i]);
  }

  const pdfMeta = await createInvoicePDF(invoice, invoiceItems, customer.rows[0]);
  await recordAudit({ userId, action: 'post_invoice', entityType: 'billing_cycle', entityId: billingCycleId, newValues: { invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, amount: bc.amount, dueDate: bc.due_date } });

  publish('invoice_created', { invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, customerId: invoice.customer_id, pdf: pdfMeta.filename, pdf_url: `/reports/${pdfMeta.filename}` });

  return { ...invoice, invoice_pdf: pdfMeta.filename, pdf_url: `/reports/${pdfMeta.filename}` };
};

const recordPayment = async (invoiceId, amount, method, reference, note, userId) => {
  const invoice = await query('SELECT * FROM invoices WHERE id=$1', [invoiceId]);
  if (!invoice.rows[0]) throw new Error('Invoice not found');

  await query('INSERT INTO invoice_payments (invoice_id, amount, payment_date, method, reference, note, created_by) VALUES ($1,$2,NOW(),$3,$4,$5,$6)', [invoiceId, amount, method, reference, note, userId]);

  const payments = await query('SELECT COALESCE(SUM(amount),0) AS total_paid FROM invoice_payments WHERE invoice_id=$1', [invoiceId]);
  const totalPaid = parseFloat(payments.rows[0].total_paid);
  const invoiceAmount = parseFloat(invoice.rows[0].total_amount);
  const invoiceDue = invoice.rows[0].due_date ? new Date(invoice.rows[0].due_date) : null;
  const newStatus = totalPaid >= invoiceAmount ? 'paid' : invoiceDue && invoiceDue < new Date() ? 'overdue' : 'pending';

  await query('UPDATE invoices SET status=$1, updated_at=NOW() WHERE id=$2', [newStatus, invoiceId]);

  const invoiceLink = await query('SELECT invoice_id FROM billing_cycles WHERE invoice_id=$1', [invoiceId]);
  if (invoiceLink.rows.length) {
    await query('UPDATE billing_cycles SET status=$1, updated_at=NOW() WHERE invoice_id=$2', [newStatus === 'paid' ? 'paid' : 'posted', invoiceId]);
  }

  await recordAudit({ userId, action: 'record_payment', entityType: 'invoice', entityId: invoiceId, newValues: { amount, method, reference, note, totalPaid, status: newStatus } });
  publish('invoice_payment', { invoiceId, totalPaid, status: newStatus, amount, method });

  return { invoiceId, totalPaid, newStatus };
};

const markOverdueInvoices = async () => {
  const r = await query(`UPDATE invoices SET status='overdue', updated_at=NOW() WHERE status='pending' AND due_date < NOW() RETURNING id, customer_id, invoice_number`);
  for (const invoice of r.rows) {
    await recordAudit({ action: 'mark_overdue', entityType: 'invoice', entityId: invoice.id, newValues: { status: 'overdue' } });
    publish('invoice_overdue', invoice);
  }
  return r.rows.length;
};

module.exports = { calculateUsageAmount, createInvoicePDF, createBillingCycleForCustomer, postBillingCycleInvoice, recordPayment, markOverdueInvoices };
