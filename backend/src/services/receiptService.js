const { query } = require('../config/database');

// Fetch full receipt data for a transaction
const getReceiptData = async (transactionId) => {
  const r = await query(`
    SELECT
      pt.*,
      c.full_name, c.phone AS customer_phone, c.email AS customer_email,
      c.address AS customer_address, c.city AS customer_city,
      z.zone_code, z.zone_name,
      u.full_name AS cashier_name,
      ss_company.value  AS company_name,
      ss_address.value  AS company_address,
      ss_footer.value   AS receipt_footer
    FROM payment_transactions pt
    LEFT JOIN customers c   ON c.id = pt.customer_id
    LEFT JOIN zones z       ON z.id = c.zone_id
    LEFT JOIN users u       ON u.id = pt.created_by
    LEFT JOIN system_settings ss_company  ON ss_company.key  = 'receipt_company_name'
    LEFT JOIN system_settings ss_address  ON ss_address.key  = 'receipt_company_address'
    LEFT JOIN system_settings ss_footer   ON ss_footer.key   = 'receipt_footer'
    WHERE pt.id = $1
  `, [transactionId]);
  return r.rows[0] || null;
};

// Short SMS/WhatsApp receipt text
const formatReceiptText = (d) => {
  if (!d) return '';
  const date = new Date(d.processed_at || d.created_at);
  const dateStr = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const applied = Array.isArray(d.applied_invoices) ? d.applied_invoices : [];

  const lines = [
    `✅ NUWACO Payment Receipt`,
    `Receipt: ${d.receipt_number || '—'}`,
    `Date:    ${dateStr} ${timeStr}`,
    `House#:  ${d.house_number}`,
    `Name:    ${d.full_name || '—'}`,
    `Amount:  $${Number(d.amount).toFixed(2)} ${d.currency}`,
    `Via:     ${d.gateway.toUpperCase()}`,
  ];
  if (d.phone_number) lines.push(`Phone:   ${d.phone_number}`);
  if (applied.length > 0) {
    lines.push(`Invoices paid:`);
    applied.forEach(inv => lines.push(`  - ${inv.invoice_number} ($${Number(inv.amount).toFixed(2)}) ✓`));
  }
  if (Number(d.remaining_credit) > 0) {
    lines.push(`Credit:  $${Number(d.remaining_credit).toFixed(2)} (no pending invoice)`);
  }
  lines.push(``, `${d.receipt_footer || 'Thank you for your payment.'}`);
  return lines.join('\n');
};

// Printable HTML receipt
const formatReceiptHTML = (d) => {
  if (!d) return '<p>Receipt not found</p>';

  const date = new Date(d.processed_at || d.created_at);
  const dateStr = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const timeStr = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const applied = Array.isArray(d.applied_invoices) ? d.applied_invoices : [];

  const row = (label, value) => `
    <tr>
      <td class="label">${label}</td>
      <td class="value">${value ?? '—'}</td>
    </tr>`;

  const statusBadge = d.status === 'completed'
    ? '<span class="badge badge-success">PAID</span>'
    : `<span class="badge badge-fail">${(d.status || 'FAILED').toUpperCase()}</span>`;

  const invoiceRows = applied.map(inv =>
    `<tr><td>${inv.invoice_number}</td><td class="amount">$${Number(inv.amount).toFixed(2)}</td><td class="badge badge-success small">Paid</td></tr>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt ${d.receipt_number || d.id}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', Courier, monospace; background: #f8f8f8; color: #111; font-size: 13px; }
  .receipt { max-width: 420px; margin: 20px auto; background: #fff; border: 1px solid #ddd; border-radius: 8px; overflow: hidden; }
  .header { background: #0f172a; color: #fff; text-align: center; padding: 20px 16px; }
  .header h1 { font-size: 20px; letter-spacing: 2px; margin-bottom: 4px; }
  .header p  { font-size: 11px; color: #94a3b8; }
  .receipt-num { text-align: center; padding: 12px; background: #f1f5f9; border-bottom: 1px dashed #cbd5e1; }
  .receipt-num span { font-size: 18px; font-weight: bold; letter-spacing: 1px; color: #0f172a; }
  .status-row { text-align: center; padding: 10px; }
  .badge { display: inline-block; padding: 4px 14px; border-radius: 20px; font-size: 12px; font-weight: bold; letter-spacing: 1px; }
  .badge-success { background: #dcfce7; color: #166534; border: 1px solid #86efac; }
  .badge-fail    { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
  .badge.small { font-size: 10px; padding: 2px 8px; }
  .section { padding: 12px 16px; border-bottom: 1px dashed #e2e8f0; }
  .section-title { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #64748b; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 4px 0; vertical-align: top; }
  td.label { color: #64748b; width: 40%; }
  td.value { font-weight: 500; text-align: right; }
  td.amount { text-align: right; font-weight: bold; }
  .total-row { padding: 14px 16px; background: #f1f5f9; border-bottom: 1px dashed #e2e8f0; }
  .total-label { font-size: 12px; color: #64748b; }
  .total-amount { font-size: 28px; font-weight: bold; text-align: right; color: #0f172a; }
  .footer { text-align: center; padding: 14px 16px; font-size: 11px; color: #64748b; }
  .divider { border: none; border-top: 1px dashed #e2e8f0; margin: 8px 0; }
  @media print {
    body { background: #fff; }
    .receipt { border: none; max-width: 100%; margin: 0; border-radius: 0; }
    .no-print { display: none !important; }
  }
</style>
</head>
<body>
<div class="receipt">
  <div class="header">
    <h1>${d.company_name || 'NUWACO'}</h1>
    <p>${d.company_address || ''}</p>
    <p style="margin-top:4px; font-size:10px;">OFFICIAL PAYMENT RECEIPT</p>
  </div>

  <div class="receipt-num">
    <div style="font-size:10px; color:#64748b; margin-bottom:2px;">RECEIPT NUMBER</div>
    <span>${d.receipt_number || '—'}</span>
  </div>

  <div class="status-row">${statusBadge}</div>

  <div class="section">
    <div class="section-title">Transaction</div>
    <table>
      ${row('Date', dateStr)}
      ${row('Time', timeStr)}
      ${row('Ref #', d.transaction_ref)}
      ${row('Gateway', d.gateway.toUpperCase())}
      ${d.phone_number ? row('Phone', d.phone_number) : ''}
    </table>
  </div>

  <div class="section">
    <div class="section-title">Customer</div>
    <table>
      ${row('House No.', `<strong>${d.house_number}</strong>`)}
      ${row('Name', d.full_name || '—')}
      ${d.zone_code ? row('Zone', `${d.zone_code} — ${d.zone_name || ''}`) : ''}
      ${d.customer_phone ? row('Phone', d.customer_phone) : ''}
    </table>
  </div>

  <div class="total-row">
    <div class="total-label">AMOUNT PAID</div>
    <div class="total-amount">$${Number(d.amount).toFixed(2)}</div>
    <div style="font-size:11px; color:#64748b; text-align:right;">${d.currency}</div>
  </div>

  ${applied.length > 0 ? `
  <div class="section">
    <div class="section-title">Invoices Applied (${applied.length})</div>
    <table>
      <thead><tr><td>Invoice</td><td class="amount">Amount</td><td></td></tr></thead>
      <tbody>${invoiceRows}</tbody>
    </table>
  </div>` : ''}

  ${Number(d.remaining_credit) > 0 ? `
  <div class="section">
    <div class="section-title">Credit Balance</div>
    <p style="color:#d97706;">$${Number(d.remaining_credit).toFixed(2)} credit — no active invoice found. Will apply to next invoice.</p>
  </div>` : ''}

  <div class="footer">
    <hr class="divider">
    <p>${d.receipt_footer || 'Thank you for your payment.'}</p>
    <p style="margin-top:6px; font-size:10px; color:#94a3b8;">Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</p>
    ${d.cashier_name ? `<p style="font-size:10px; color:#94a3b8;">Processed by: ${d.cashier_name}</p>` : ''}
  </div>
</div>

<div class="no-print" style="text-align:center; margin: 16px; font-family: sans-serif;">
  <button onclick="window.print()" style="padding: 8px 24px; background: #0f172a; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">
    🖨️ Print Receipt
  </button>
</div>
</body>
</html>`;
};

module.exports = { getReceiptData, formatReceiptText, formatReceiptHTML };
