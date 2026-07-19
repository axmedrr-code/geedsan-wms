const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');

const REPORTS_DIR = process.env.REPORTS_DIR || './reports';
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

// Whitelist: both values are interpolated into a filesystem path below.
// Path traversal is blocked by startsWith(reportsDirResolved) in the download
// route, but the whitelist is the first line of defence.
const VALID_REPORT_TYPES = [
  'daily_consumption', 'weekly_consumption', 'monthly_consumption', 'customer_usage',
  'revenue_daily', 'revenue_monthly', 'revenue_annual',
  'billing_summary', 'payment_collection', 'outstanding_balance',
  'consumption_summary', 'customer_statement', 'meter_reading_report',
  'gateway_activity', 'alarm_report', 'delivery_report',
  // Smart meter operations reports (Phase 5)
  'meter_history', 'leak_report', 'battery_report', 'pressure_report',
  'rssi_report', 'valve_operations', 'offline_meters', 'communication_report',
];
const VALID_FILE_TYPES = ['pdf', 'xlsx', 'csv'];

// Display columns for each report type (used by PDF, XLSX and CSV generators)
const REPORT_COLUMNS = {
  daily_consumption:    ['Date', 'Meter Number', 'Device EUI', 'Customer', 'Consumption (m³)', 'Avg Flow (L/min)', 'Readings'],
  weekly_consumption:   ['Date', 'Meter Number', 'Device EUI', 'Customer', 'Consumption (m³)', 'Avg Flow (L/min)', 'Readings'],
  monthly_consumption:  ['Date', 'Meter Number', 'Device EUI', 'Customer', 'Consumption (m³)', 'Avg Flow (L/min)', 'Readings'],
  customer_usage:       ['Customer No.', 'Name', 'Email', 'Phone', 'Meters', 'Total Consumption (m³)', 'Avg Flow (L/min)'],
  revenue_daily:        ['Date', 'Payment Count', 'Revenue'],
  revenue_monthly:      ['Month', 'Payment Count', 'Revenue'],
  revenue_annual:       ['Year', 'Payment Count', 'Revenue'],
  billing_summary:      ['Customer Name', 'Customer No.', 'Tariff', 'Invoices', 'Total Billed', 'Total Paid', 'Outstanding', 'Last Invoice'],
  payment_collection:   ['Date', 'Invoice No.', 'Customer Name', 'Customer No.', 'Amount', 'Method', 'Reference'],
  outstanding_balance:  ['Customer Name', 'Customer No.', 'Tariff', 'Invoice Count', 'Outstanding Amount', 'Oldest Due'],
  consumption_summary:  ['Meter No.', 'Customer Name', 'Customer No.', 'Consumption (m³)', 'Avg Flow', 'Readings'],
  customer_statement:   ['Date', 'Type', 'Description', 'Amount'],
  meter_reading_report: ['Meter No.', 'Customer Name', 'Timestamp', 'Total Consumption', 'Flow (L/min)', 'Battery (V)', 'Pressure', 'RSSI'],
  gateway_activity:     ['Gateway Name', 'Gateway EUI', 'Date', 'Readings', 'Unique Meters'],
  alarm_report:         ['Alarm Type', 'Severity', 'Status', 'Triggered At', 'Meter No.', 'Customer Name', 'AI Recommendation'],
  delivery_report:      ['Vehicle No.', 'Driver', 'Scheduled At', 'Volume (m³)', 'Status', 'Customer Name', 'Address'],
  // Phase 5 operations reports
  meter_history:        ['Timestamp', 'Meter No.', 'Customer', 'Total Consumption (m³)', 'Flow (L/min)', 'Battery (V)', 'Pressure (bar)', 'RSSI (dBm)', 'SNR (dB)', 'Gateway', 'Valve Status'],
  leak_report:          ['Detected At', 'Meter No.', 'Customer', 'Type', 'Severity', 'Status', 'AI Score', 'Resolved At'],
  battery_report:       ['Meter No.', 'Device EUI', 'Customer', 'Battery (V)', 'Battery (%)', 'Last Seen', 'Online'],
  pressure_report:      ['Date', 'Meter No.', 'Customer', 'Avg Pressure (bar)', 'Min Pressure', 'Max Pressure', 'Readings'],
  rssi_report:          ['Date', 'Meter No.', 'Customer', 'Avg RSSI (dBm)', 'Min RSSI', 'Avg SNR (dB)', 'Readings'],
  valve_operations:     ['Sent At', 'Meter No.', 'Device EUI', 'Command', 'Status', 'Operator', 'Executed At', 'Gateway'],
  offline_meters:       ['Meter No.', 'Device EUI', 'Customer', 'Last Seen', 'Hours Offline', 'Zone'],
  communication_report: ['Meter No.', 'Customer', 'Readings (24h)', 'Expected (24h)', 'Success Rate (%)', 'Packet Loss (%)', 'Last Seen'],
};

// Returns an ordered array of cell values for a DB row, matching REPORT_COLUMNS order.
const rowToValues = (type, row) => {
  switch (type) {
    case 'daily_consumption':
    case 'weekly_consumption':
    case 'monthly_consumption':
      return [
        row.date, row.meter_number, row.device_eui || '—', row.customer_name || '—',
        Number(row.daily_consumption || 0).toFixed(3),
        Number(row.avg_flow || 0).toFixed(2),
        row.reading_count,
      ];
    case 'customer_usage':
      return [
        row.customer_number, row.customer_name, row.email || '', row.phone || '',
        parseInt(row.meter_count || 0),
        parseFloat(row.total_consumption || 0),
        parseFloat(row.avg_flow || 0),
      ];
    case 'revenue_daily':
      return [row.date, row.payment_count, Number(row.revenue || 0).toFixed(2)];
    case 'revenue_monthly':
      return [row.month, row.payment_count, Number(row.revenue || 0).toFixed(2)];
    case 'revenue_annual':
      return [row.year, row.payment_count, Number(row.revenue || 0).toFixed(2)];
    case 'billing_summary':
      return [
        row.customer_name, row.customer_number, row.tariff_type, row.invoice_count,
        Number(row.total_billed || 0).toFixed(2),
        Number(row.total_paid || 0).toFixed(2),
        Number(row.outstanding || 0).toFixed(2),
        row.last_invoice_date || '—',
      ];
    case 'payment_collection':
      return [
        row.payment_date, row.invoice_number, row.customer_name, row.customer_number,
        Number(row.amount || 0).toFixed(2), row.method || '—', row.reference || '—',
      ];
    case 'outstanding_balance':
      return [
        row.customer_name, row.customer_number, row.tariff_type, row.invoice_count,
        Number(row.outstanding_amount || 0).toFixed(2), row.oldest_due_date || '—',
      ];
    case 'consumption_summary':
      return [
        row.meter_number, row.customer_name || '—', row.customer_number || '—',
        Number(row.consumption || 0).toFixed(3),
        Number(row.avg_flow || 0).toFixed(2),
        row.reading_count,
      ];
    case 'customer_statement':
      return [row.date, row.type, row.description, Number(row.amount || 0).toFixed(2)];
    case 'meter_reading_report':
      return [
        row.meter_number, row.customer_name || '—', row.timestamp,
        Number(row.total_consumption || 0).toFixed(3),
        Number(row.current_flow || 0).toFixed(2),
        row.battery_voltage != null ? Number(row.battery_voltage).toFixed(2) : '—',
        row.pressure != null ? Number(row.pressure).toFixed(2) : '—',
        row.rssi != null ? row.rssi : '—',
      ];
    case 'gateway_activity':
      return [row.gateway_name || '—', row.gateway_eui, row.date, row.reading_count, row.unique_meters];
    case 'alarm_report':
      return [
        row.alarm_type, row.severity, row.status, row.triggered_at,
        row.meter_number || '—', row.customer_name || '—', row.ai_recommendation || '—',
      ];
    case 'delivery_report':
      return [
        row.vehicle_number || '—', row.driver_name || '—', row.scheduled_at,
        Number(row.delivery_volume || 0).toFixed(2),
        row.status, row.customer_name || '—', row.delivery_address || row.customer_address || '—',
      ];
    case 'meter_history':
      return [
        row.timestamp, row.meter_number, row.customer_name || '—',
        Number(row.total_consumption || 0).toFixed(3),
        Number(row.current_flow || 0).toFixed(2),
        row.battery_voltage != null ? Number(row.battery_voltage).toFixed(2) : '—',
        row.pressure != null ? Number(row.pressure).toFixed(2) : '—',
        row.rssi != null ? row.rssi : '—',
        row.snr  != null ? Number(row.snr).toFixed(1) : '—',
        row.gateway_eui || '—',
        row.valve_status || '—',
      ];
    case 'leak_report':
      return [
        row.detected_at, row.meter_number, row.customer_name || '—',
        (row.detection_type || '').replace(/_/g, ' '),
        row.severity, row.status,
        row.ai_score != null ? Number(row.ai_score).toFixed(2) : '—',
        row.resolved_at || '—',
      ];
    case 'battery_report':
      return [
        row.meter_number, row.device_eui || '—', row.customer_name || '—',
        row.battery_voltage != null ? Number(row.battery_voltage).toFixed(2) : '—',
        row.battery_pct     != null ? `${row.battery_pct}%` : '—',
        row.last_seen || '—',
        row.is_online ? 'Yes' : 'No',
      ];
    case 'pressure_report':
      return [
        row.date, row.meter_number, row.customer_name || '—',
        Number(row.avg_pressure || 0).toFixed(2),
        Number(row.min_pressure || 0).toFixed(2),
        Number(row.max_pressure || 0).toFixed(2),
        row.reading_count,
      ];
    case 'rssi_report':
      return [
        row.date, row.meter_number, row.customer_name || '—',
        Number(row.avg_rssi || 0).toFixed(1),
        Number(row.min_rssi || 0).toFixed(1),
        Number(row.avg_snr  || 0).toFixed(1),
        row.reading_count,
      ];
    case 'valve_operations':
      return [
        row.sent_at, row.meter_number || '—', row.device_eui || '—',
        row.command_type, row.status,
        row.sent_by_name || '—',
        row.executed_at || '—',
        row.gateway_eui || '—',
      ];
    case 'offline_meters':
      return [
        row.meter_number, row.device_eui || '—', row.customer_name || '—',
        row.last_seen || 'Never',
        row.hours_offline != null ? Number(row.hours_offline).toFixed(1) : '—',
        row.zone_name || '—',
      ];
    case 'communication_report':
      return [
        row.meter_number, row.customer_name || '—',
        row.readings_24h, row.expected_24h,
        `${row.success_rate}%`,
        `${row.packet_loss}%`,
        row.last_seen || '—',
      ];
    default:
      return Object.values(row).map(v => v == null ? '' : v);
  }
};

// Generates a UTF-8 BOM CSV string from column headers and row value arrays.
const generateCsvContent = (headers, valueRows) => {
  const BOM = '﻿';
  const escape = (val) => {
    const s = val == null ? '' : String(val);
    return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(escape).join(',')];
  for (const row of valueRows) {
    lines.push(row.map(escape).join(','));
  }
  return BOM + lines.join('\r\n');
};

// Returns the column letter for a 1-based column index (A=1, Z=26, AA=27 …).
const colLetter = (n) => {
  let result = '';
  while (n > 0) {
    result = String.fromCharCode(64 + ((n - 1) % 26 + 1)) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
};

// ─── Report data fetcher ─────────────────────────────────────────────────────

const getReportData = async (reportType, params) => {
  const { from, to, customer_id, meter_id, tariff, status } = params;
  const fromDate = from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const toDate   = to   || new Date().toISOString().split('T')[0];

  // ── Original types ────────────────────────────────────────────────────────

  if (['daily_consumption', 'weekly_consumption', 'monthly_consumption'].includes(reportType)) {
    const args = [fromDate, toDate];
    let extra = '';
    if (meter_id)    { args.push(meter_id);    extra += ` AND m.id=$${args.length}`; }
    if (customer_id) { args.push(customer_id); extra += ` AND m.customer_id=$${args.length}`; }
    const r = await query(
      `SELECT DATE(mr.timestamp) AS date, m.meter_number, m.device_eui,
              c.full_name AS customer_name,
              MAX(mr.total_consumption)-MIN(mr.total_consumption) AS daily_consumption,
              AVG(mr.current_flow) AS avg_flow, COUNT(*) AS reading_count
       FROM meter_readings mr
       JOIN meters m ON mr.meter_id=m.id
       LEFT JOIN customers c ON m.customer_id=c.id
       WHERE DATE(mr.timestamp) BETWEEN $1 AND $2${extra}
       GROUP BY DATE(mr.timestamp), m.id, m.meter_number, m.device_eui, c.full_name
       ORDER BY date DESC, m.meter_number`,
      args,
    );
    return r.rows;
  }

  if (reportType === 'customer_usage') {
    const r = await query(
      `SELECT c.customer_number, c.full_name AS customer_name, c.email, c.phone,
              COUNT(DISTINCT m.id) AS meter_count,
              SUM(m.total_consumption) AS total_consumption,
              AVG(m.current_flow) AS avg_flow
       FROM customers c
       LEFT JOIN meters m ON c.id=m.customer_id AND m.status='active'
       WHERE c.account_status='active'
       GROUP BY c.id, c.customer_number, c.full_name, c.email, c.phone
       ORDER BY total_consumption DESC`,
    );
    return r.rows;
  }

  // ── Revenue types ─────────────────────────────────────────────────────────

  if (reportType === 'revenue_daily') {
    const args = [fromDate, toDate];
    const extra = customer_id ? (args.push(customer_id), ` AND i.customer_id=$${args.length}`) : '';
    const r = await query(
      `SELECT DATE(ip.payment_date) AS date, COUNT(*) AS payment_count, SUM(ip.amount) AS revenue
       FROM invoice_payments ip JOIN invoices i ON i.id=ip.invoice_id
       WHERE DATE(ip.payment_date) BETWEEN $1 AND $2${extra}
       GROUP BY DATE(ip.payment_date) ORDER BY date ASC`,
      args,
    );
    return r.rows;
  }

  if (reportType === 'revenue_monthly') {
    const args = [fromDate, toDate];
    const extra = customer_id ? (args.push(customer_id), ` AND i.customer_id=$${args.length}`) : '';
    const r = await query(
      `SELECT TO_CHAR(ip.payment_date, 'YYYY-MM') AS month, COUNT(*) AS payment_count, SUM(ip.amount) AS revenue
       FROM invoice_payments ip JOIN invoices i ON i.id=ip.invoice_id
       WHERE DATE(ip.payment_date) BETWEEN $1 AND $2${extra}
       GROUP BY TO_CHAR(ip.payment_date, 'YYYY-MM') ORDER BY month ASC`,
      args,
    );
    return r.rows;
  }

  if (reportType === 'revenue_annual') {
    const args = [fromDate, toDate];
    const extra = customer_id ? (args.push(customer_id), ` AND i.customer_id=$${args.length}`) : '';
    const r = await query(
      `SELECT EXTRACT(YEAR FROM ip.payment_date)::int AS year, COUNT(*) AS payment_count, SUM(ip.amount) AS revenue
       FROM invoice_payments ip JOIN invoices i ON i.id=ip.invoice_id
       WHERE DATE(ip.payment_date) BETWEEN $1 AND $2${extra}
       GROUP BY EXTRACT(YEAR FROM ip.payment_date) ORDER BY year ASC`,
      args,
    );
    return r.rows;
  }

  // ── Billing types ─────────────────────────────────────────────────────────

  if (reportType === 'billing_summary') {
    const args = [];
    const extra = tariff ? (args.push(tariff), ` AND c.tariff_type=$${args.length}`) : '';
    const r = await query(
      `SELECT c.full_name AS customer_name, c.customer_number, c.tariff_type,
              COUNT(i.id) AS invoice_count,
              COALESCE(SUM(i.total_amount), 0) AS total_billed,
              COALESCE(SUM(ip_agg.paid), 0) AS total_paid,
              COALESCE(SUM(CASE WHEN i.status NOT IN ('paid','cancelled') THEN i.total_amount ELSE 0 END), 0) AS outstanding,
              MAX(i.created_at)::date AS last_invoice_date
       FROM customers c
       LEFT JOIN invoices i ON i.customer_id=c.id
       LEFT JOIN (
         SELECT invoice_id, SUM(amount) AS paid FROM invoice_payments GROUP BY invoice_id
       ) ip_agg ON ip_agg.invoice_id=i.id
       WHERE 1=1${extra}
       GROUP BY c.id, c.full_name, c.customer_number, c.tariff_type
       ORDER BY outstanding DESC`,
      args,
    );
    return r.rows;
  }

  if (reportType === 'payment_collection') {
    const args = [fromDate, toDate];
    const extra = customer_id ? (args.push(customer_id), ` AND i.customer_id=$${args.length}`) : '';
    const r = await query(
      `SELECT ip.payment_date, ip.amount, ip.method, ip.reference,
              i.invoice_number, c.full_name AS customer_name, c.customer_number
       FROM invoice_payments ip
       JOIN invoices i ON i.id=ip.invoice_id
       JOIN customers c ON c.id=i.customer_id
       WHERE DATE(ip.payment_date) BETWEEN $1 AND $2${extra}
       ORDER BY ip.payment_date DESC`,
      args,
    );
    return r.rows;
  }

  if (reportType === 'outstanding_balance') {
    const args = [];
    const extra = tariff ? (args.push(tariff), ` AND c.tariff_type=$${args.length}`) : '';
    const r = await query(
      `SELECT c.full_name AS customer_name, c.customer_number, c.tariff_type,
              COUNT(i.id) AS invoice_count,
              SUM(i.total_amount) AS outstanding_amount,
              MIN(i.due_date) AS oldest_due_date
       FROM customers c
       JOIN invoices i ON i.customer_id=c.id AND i.status NOT IN ('paid','cancelled')
       WHERE 1=1${extra}
       GROUP BY c.id, c.full_name, c.customer_number, c.tariff_type
       ORDER BY outstanding_amount DESC`,
      args,
    );
    return r.rows;
  }

  // ── Consumption / meter types ─────────────────────────────────────────────

  if (reportType === 'consumption_summary') {
    const args = [fromDate, toDate];
    let extra = '';
    if (meter_id)    { args.push(meter_id);    extra += ` AND m.id=$${args.length}`; }
    if (customer_id) { args.push(customer_id); extra += ` AND m.customer_id=$${args.length}`; }
    const r = await query(
      `SELECT m.meter_number, c.full_name AS customer_name, c.customer_number,
              MAX(mr.total_consumption)-MIN(mr.total_consumption) AS consumption,
              AVG(mr.current_flow) AS avg_flow, COUNT(mr.id) AS reading_count
       FROM meter_readings mr
       JOIN meters m ON mr.meter_id=m.id
       LEFT JOIN customers c ON m.customer_id=c.id
       WHERE DATE(mr.timestamp) BETWEEN $1 AND $2${extra}
       GROUP BY m.id, m.meter_number, c.full_name, c.customer_number
       ORDER BY consumption DESC`,
      args,
    );
    return r.rows;
  }

  if (reportType === 'customer_statement') {
    if (!customer_id) return [];
    const r = await query(
      `(SELECT i.created_at::date AS date, 'invoice' AS type,
               CONCAT('Invoice ', i.invoice_number) AS description,
               i.total_amount AS amount
        FROM invoices i
        WHERE i.customer_id=$1 AND i.created_at::date BETWEEN $2 AND $3)
       UNION ALL
       (SELECT ip.payment_date::date AS date, 'payment' AS type,
               CONCAT('Payment via ', ip.method, ' ref: ', COALESCE(ip.reference,'N/A')) AS description,
               ip.amount AS amount
        FROM invoice_payments ip JOIN invoices i2 ON i2.id=ip.invoice_id
        WHERE i2.customer_id=$1 AND ip.payment_date::date BETWEEN $2 AND $3)
       ORDER BY date ASC`,
      [customer_id, fromDate, toDate],
    );
    return r.rows;
  }

  if (reportType === 'meter_reading_report') {
    const args = [fromDate, toDate];
    let extra = '';
    if (meter_id)    { args.push(meter_id);    extra += ` AND m.id=$${args.length}`; }
    if (customer_id) { args.push(customer_id); extra += ` AND m.customer_id=$${args.length}`; }
    const r = await query(
      `SELECT m.meter_number, c.full_name AS customer_name,
              mr.timestamp, mr.total_consumption, mr.current_flow,
              mr.battery_voltage, mr.pressure, mr.rssi
       FROM meter_readings mr
       JOIN meters m ON mr.meter_id=m.id
       LEFT JOIN customers c ON m.customer_id=c.id
       WHERE DATE(mr.timestamp) BETWEEN $1 AND $2${extra}
       ORDER BY mr.timestamp DESC LIMIT 500`,
      args,
    );
    return r.rows;
  }

  if (reportType === 'gateway_activity') {
    const r = await query(
      `SELECT g.name AS gateway_name, g.gateway_eui, DATE(mr.timestamp) AS date,
              COUNT(mr.id) AS reading_count, COUNT(DISTINCT mr.meter_id) AS unique_meters
       FROM meter_readings mr
       JOIN gateways g ON mr.gateway_eui=g.gateway_eui
       WHERE DATE(mr.timestamp) BETWEEN $1 AND $2
       GROUP BY g.id, g.name, g.gateway_eui, DATE(mr.timestamp)
       ORDER BY date DESC, reading_count DESC`,
      [fromDate, toDate],
    );
    return r.rows;
  }

  if (reportType === 'alarm_report') {
    const args = [fromDate, toDate];
    const extra = status ? (args.push(status), ` AND a.status=$${args.length}`) : '';
    const r = await query(
      `SELECT a.alarm_type, a.severity, a.status, a.triggered_at,
              m.meter_number, c.full_name AS customer_name, a.ai_recommendation
       FROM alarms a
       LEFT JOIN meters m ON a.meter_id=m.id
       LEFT JOIN customers c ON m.customer_id=c.id
       WHERE DATE(a.triggered_at) BETWEEN $1 AND $2${extra}
       ORDER BY a.triggered_at DESC`,
      args,
    );
    return r.rows;
  }

  if (reportType === 'delivery_report') {
    const args = [fromDate, toDate];
    let extra = '';
    if (customer_id) { args.push(customer_id); extra += ` AND td.customer_id=$${args.length}`; }
    if (status)      { args.push(status);       extra += ` AND td.status=$${args.length}`; }
    const r = await query(
      `SELECT td.vehicle_number, td.driver_name, td.scheduled_at,
              td.delivery_volume, td.status,
              c.full_name AS customer_name, td.delivery_address
       FROM tanker_deliveries td
       LEFT JOIN customers c ON td.customer_id=c.id
       WHERE DATE(td.scheduled_at) BETWEEN $1 AND $2${extra}
       ORDER BY td.scheduled_at DESC`,
      args,
    );
    return r.rows;
  }

  // ── Phase 5 operations report types ──────────────────────────────────────────

  if (reportType === 'meter_history') {
    const args = [fromDate, toDate];
    let extra = '';
    if (meter_id)    { args.push(meter_id);    extra += ` AND mr.meter_id=$${args.length}`; }
    if (customer_id) { args.push(customer_id); extra += ` AND m.customer_id=$${args.length}`; }
    const r = await query(
      `SELECT mr.timestamp, m.meter_number, c.full_name AS customer_name,
              mr.total_consumption, mr.current_flow, mr.battery_voltage,
              mr.pressure, mr.rssi, mr.snr, mr.gateway_eui, mr.valve_status
       FROM meter_readings mr
       JOIN meters m ON mr.meter_id = m.id
       LEFT JOIN customers c ON m.customer_id = c.id
       WHERE DATE(mr.timestamp) BETWEEN $1 AND $2${extra}
       ORDER BY mr.timestamp DESC LIMIT 5000`,
      args,
    );
    return r.rows;
  }

  if (reportType === 'leak_report') {
    const args = [fromDate, toDate];
    let extra = '';
    if (meter_id)    { args.push(meter_id);    extra += ` AND le.meter_id=$${args.length}`; }
    if (customer_id) { args.push(customer_id); extra += ` AND m.customer_id=$${args.length}`; }
    if (status)      { args.push(status);       extra += ` AND le.status=$${args.length}`; }
    const r = await query(
      `SELECT le.detected_at, m.meter_number, c.full_name AS customer_name,
              le.detection_type, le.severity, le.status, le.ai_score, le.resolved_at
       FROM leak_events le
       JOIN meters m ON le.meter_id = m.id
       LEFT JOIN customers c ON m.customer_id = c.id
       WHERE DATE(le.detected_at) BETWEEN $1 AND $2${extra}
       ORDER BY le.detected_at DESC`,
      args,
    );
    return r.rows;
  }

  if (reportType === 'battery_report') {
    const args = [];
    let extra = '';
    if (customer_id) { args.push(customer_id); extra += ` AND m.customer_id=$${args.length}`; }
    const r = await query(
      `SELECT m.meter_number, m.device_eui, c.full_name AS customer_name,
              m.battery_voltage,
              GREATEST(0, LEAST(100, ROUND(((m.battery_voltage - 2.8) / 0.8) * 100))) AS battery_pct,
              m.last_seen, m.is_online
       FROM meters m
       LEFT JOIN customers c ON m.customer_id = c.id
       WHERE m.status = 'active'${extra}
       ORDER BY m.battery_voltage ASC NULLS LAST`,
      args,
    );
    return r.rows;
  }

  if (reportType === 'pressure_report') {
    const args = [fromDate, toDate];
    let extra = '';
    if (meter_id)    { args.push(meter_id);    extra += ` AND mr.meter_id=$${args.length}`; }
    if (customer_id) { args.push(customer_id); extra += ` AND m.customer_id=$${args.length}`; }
    const r = await query(
      `SELECT DATE(mr.timestamp) AS date, m.meter_number, c.full_name AS customer_name,
              AVG(mr.pressure) AS avg_pressure,
              MIN(mr.pressure) AS min_pressure,
              MAX(mr.pressure) AS max_pressure,
              COUNT(*) AS reading_count
       FROM meter_readings mr
       JOIN meters m ON mr.meter_id = m.id
       LEFT JOIN customers c ON m.customer_id = c.id
       WHERE DATE(mr.timestamp) BETWEEN $1 AND $2
         AND mr.pressure IS NOT NULL${extra}
       GROUP BY DATE(mr.timestamp), m.id, m.meter_number, c.full_name
       ORDER BY date DESC, m.meter_number`,
      args,
    );
    return r.rows;
  }

  if (reportType === 'rssi_report') {
    const args = [fromDate, toDate];
    let extra = '';
    if (meter_id)    { args.push(meter_id);    extra += ` AND mr.meter_id=$${args.length}`; }
    if (customer_id) { args.push(customer_id); extra += ` AND m.customer_id=$${args.length}`; }
    const r = await query(
      `SELECT DATE(mr.timestamp) AS date, m.meter_number, c.full_name AS customer_name,
              AVG(mr.rssi) AS avg_rssi,
              MIN(mr.rssi) AS min_rssi,
              AVG(mr.snr)  AS avg_snr,
              COUNT(*)     AS reading_count
       FROM meter_readings mr
       JOIN meters m ON mr.meter_id = m.id
       LEFT JOIN customers c ON m.customer_id = c.id
       WHERE DATE(mr.timestamp) BETWEEN $1 AND $2
         AND mr.rssi IS NOT NULL${extra}
       GROUP BY DATE(mr.timestamp), m.id, m.meter_number, c.full_name
       ORDER BY date DESC, avg_rssi ASC`,
      args,
    );
    return r.rows;
  }

  if (reportType === 'valve_operations') {
    const args = [fromDate, toDate];
    let extra = '';
    if (meter_id)    { args.push(meter_id);    extra += ` AND dc.meter_id=$${args.length}`; }
    if (customer_id) { args.push(customer_id); extra += ` AND m.customer_id=$${args.length}`; }
    const r = await query(
      `SELECT dc.sent_at, m.meter_number, dc.device_eui,
              dc.command_type, dc.status,
              u.full_name AS sent_by_name,
              dc.executed_at,
              (dc.lifecycle_log->-1->>'gateway_eui') AS gateway_eui
       FROM downlink_commands dc
       LEFT JOIN meters m ON dc.meter_id = m.id
       LEFT JOIN users u  ON dc.sent_by = u.id
       WHERE dc.command_type IN ('open_valve','close_valve')
         AND DATE(dc.sent_at) BETWEEN $1 AND $2${extra}
       ORDER BY dc.sent_at DESC`,
      args,
    );
    return r.rows;
  }

  if (reportType === 'offline_meters') {
    const args = [];
    let extra = '';
    if (customer_id) { args.push(customer_id); extra += ` AND m.customer_id=$${args.length}`; }
    const r = await query(
      `SELECT m.meter_number, m.device_eui, c.full_name AS customer_name,
              m.last_seen,
              ROUND(EXTRACT(EPOCH FROM (NOW() - m.last_seen)) / 3600, 1) AS hours_offline,
              z.zone_name AS zone_name
       FROM meters m
       LEFT JOIN customers c ON m.customer_id = c.id
       LEFT JOIN zones z     ON m.zone_id = z.id
       WHERE m.status = 'active' AND m.is_online = false${extra}
       ORDER BY m.last_seen ASC NULLS FIRST`,
      args,
    );
    return r.rows;
  }

  if (reportType === 'communication_report') {
    const args = [];
    let extra = '';
    if (customer_id) { args.push(customer_id); extra += ` AND m.customer_id=$${args.length}`; }
    const r = await query(
      `SELECT m.meter_number, c.full_name AS customer_name,
              COUNT(mr.id) FILTER (WHERE mr.timestamp >= NOW() - INTERVAL '24 hours') AS readings_24h,
              96 AS expected_24h,
              LEAST(100, ROUND(COUNT(mr.id) FILTER (WHERE mr.timestamp >= NOW() - INTERVAL '24 hours') * 100.0 / 96)) AS success_rate,
              GREATEST(0, 100 - LEAST(100, ROUND(COUNT(mr.id) FILTER (WHERE mr.timestamp >= NOW() - INTERVAL '24 hours') * 100.0 / 96))) AS packet_loss,
              m.last_seen
       FROM meters m
       LEFT JOIN customers c ON m.customer_id = c.id
       LEFT JOIN meter_readings mr ON mr.meter_id = m.id
       WHERE m.status = 'active'${extra}
       GROUP BY m.id, m.meter_number, c.full_name, m.last_seen
       ORDER BY success_rate ASC`,
      args,
    );
    return r.rows;
  }

  return [];
};

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET / — list recent reports
router.get('/', authenticate, async (req, res) => {
  try {
    const r = await query(
      `SELECT r.*, u.full_name AS generated_by_name
       FROM reports r LEFT JOIN users u ON r.generated_by=u.id
       ORDER BY r.created_at DESC LIMIT 50`,
    );
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to list reports' }); }
});

// GET /summary — billing KPI summary (JSON only, no file generation)
router.get('/summary', authenticate, async (req, res) => {
  try {
    const r = await query(`
      SELECT
        (SELECT COALESCE(SUM(amount),0)
           FROM invoice_payments) AS "totalRevenue",
        (SELECT COALESCE(SUM(amount),0)
           FROM invoice_payments
          WHERE DATE_TRUNC('month', payment_date)=DATE_TRUNC('month', NOW())) AS "revenueThisMonth",
        (SELECT COALESCE(SUM(amount),0)
           FROM invoice_payments
          WHERE DATE(payment_date)=CURRENT_DATE) AS "revenueToday",
        (SELECT COALESCE(SUM(total_amount),0)
           FROM invoices
          WHERE status NOT IN ('paid','cancelled')) AS "totalOutstanding",
        (SELECT COUNT(*) FROM invoices) AS "invoiceCount",
        (SELECT COUNT(*) FROM invoices WHERE status='paid')    AS "paidCount",
        (SELECT COUNT(*) FROM invoices WHERE status='overdue') AS "overdueCount",
        (SELECT COUNT(*) FROM invoices WHERE status='pending') AS "pendingCount"
    `);
    const row = r.rows[0];
    res.json({
      totalRevenue:      parseFloat(row.totalRevenue),
      revenueThisMonth:  parseFloat(row.revenueThisMonth),
      revenueToday:      parseFloat(row.revenueToday),
      totalOutstanding:  parseFloat(row.totalOutstanding),
      totalCollected:    parseFloat(row.totalRevenue),   // alias kept for client convenience
      invoiceCount:      parseInt(row.invoiceCount),
      paidCount:         parseInt(row.paidCount),
      overdueCount:      parseInt(row.overdueCount),
      pendingCount:      parseInt(row.pendingCount),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch summary' }); }
});

// GET /data — flexible JSON data endpoint for any report type
router.get('/data', authenticate, async (req, res) => {
  try {
    const { type, from, to, customer_id, meter_id, tariff, status } = req.query;
    if (!type || !VALID_REPORT_TYPES.includes(type)) {
      return res.status(400).json({ error: `Invalid type. Valid: ${VALID_REPORT_TYPES.join(', ')}` });
    }
    const data = await getReportData(type, { from, to, customer_id, meter_id, tariff, status });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch report data', details: err.message });
  }
});

// POST /generate — generate and persist a PDF, XLSX or CSV file
router.post('/generate', authenticate, async (req, res) => {
  try {
    const { report_type, from, to, file_type = 'pdf', title, customer_id, meter_id, tariff, status } = req.body;

    if (!VALID_REPORT_TYPES.includes(report_type)) {
      return res.status(400).json({ error: `Invalid report_type. Valid: ${VALID_REPORT_TYPES.join(', ')}` });
    }
    if (!VALID_FILE_TYPES.includes(file_type)) {
      return res.status(400).json({ error: `Invalid file_type. Valid: ${VALID_FILE_TYPES.join(', ')}` });
    }

    const data = await getReportData(report_type, { from, to, customer_id, meter_id, tariff, status });
    const reportTitle = title || `${report_type.replace(/_/g, ' ').toUpperCase()} Report`;
    const filename  = `${report_type}_${Date.now()}.${file_type}`;
    const filePath  = path.join(REPORTS_DIR, filename);
    const headers   = REPORT_COLUMNS[report_type] || (data[0] ? Object.keys(data[0]) : []);

    if (file_type === 'pdf') {
      await new Promise((resolve, reject) => {
        const doc    = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);

        // Header banner
        doc.rect(0, 0, doc.page.width, 70).fill('#42A5F5');
        doc.fillColor('white').fontSize(20).font('Helvetica-Bold').text('NUWACO', 40, 15);
        doc.fontSize(11).font('Helvetica').text('Water Utility Management System', 40, 40);
        doc.fontSize(14).text(reportTitle, 200, 25, { align: 'center' });
        doc.fillColor('#333').fontSize(10).moveDown(2);
        doc.text(`Generated: ${new Date().toLocaleString()} | Period: ${from || 'N/A'} to ${to || 'Today'}`);
        doc.moveDown();

        // Column header row
        const contentWidth = doc.page.width - 80;
        const colW = Math.floor(contentWidth / headers.length);
        let x = 40;
        const hy = doc.y;
        doc.rect(40, hy - 5, contentWidth, 20).fill('#1976D2');
        headers.forEach((h) => {
          doc.fillColor('white').fontSize(8).font('Helvetica-Bold').text(h, x + 2, hy, { width: colW });
          x += colW;
        });
        doc.moveDown(0.5);

        // Data rows (cap at 200 to keep PDF manageable)
        data.slice(0, 200).forEach((row, ri) => {
          const ry = doc.y;
          if (ri % 2 === 0) doc.rect(40, ry - 3, contentWidth, 16).fill('#f8f9fa');
          x = 40;
          const vals = rowToValues(report_type, row);
          vals.forEach((v) => {
            doc.fillColor('#333').fontSize(7).font('Helvetica')
               .text(String(v == null ? '-' : v), x + 2, ry, { width: colW - 4 });
            x += colW;
          });
          doc.moveDown(0.2);
          if (doc.y > doc.page.height - 50) doc.addPage();
        });

        doc.fontSize(7).fillColor('#999')
           .text(`NUWACO WMS | ${data.length} records`, 40, doc.page.height - 25, { align: 'center' });
        doc.end();
        stream.on('finish', resolve);
        stream.on('error', reject);
      });
    } else if (file_type === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(reportTitle.substring(0, 31));

      // Title row spanning all columns
      ws.mergeCells(`A1:${colLetter(headers.length)}1`);
      const tc = ws.getCell('A1');
      tc.value     = `NUWACO WMS - ${reportTitle}`;
      tc.font      = { bold: true, size: 14, color: { argb: 'FFFFFF' } };
      tc.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: '42A5F5' } };
      tc.alignment = { horizontal: 'center' };
      ws.getRow(1).height = 28;

      // Header row
      const hr = ws.addRow(headers);
      hr.eachCell(c => {
        c.font = { bold: true, color: { argb: 'FFFFFF' } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1976D2' } };
      });

      // Data rows
      data.forEach((row, i) => {
        const vals = rowToValues(report_type, row);
        const dr = ws.addRow(vals);
        if (i % 2 === 0) {
          dr.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F8F9FA' } }; });
        }
      });

      ws.columns.forEach(c => { c.width = 20; });
      await wb.xlsx.writeFile(filePath);
    } else {
      // CSV
      const valueRows = data.map(row => rowToValues(report_type, row));
      const csvContent = generateCsvContent(headers, valueRows);
      fs.writeFileSync(filePath, csvContent, 'utf8');
    }

    const stats = fs.statSync(filePath);
    const r = await query(
      `INSERT INTO reports
         (report_type, title, period_start, period_end, parameters, status,
          file_path, file_type, file_size, generated_by, generated_at)
       VALUES ($1,$2,$3,$4,$5,'completed',$6,$7,$8,$9,NOW())
       RETURNING *`,
      [report_type, reportTitle, from, to, JSON.stringify({ customer_id, meter_id, tariff, status }),
       filename, file_type, stats.size, req.user.id],
    );
    res.json({ report: r.rows[0], downloadUrl: `/reports/${filename}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate report', details: err.message });
  }
});

// GET /:id/download — stream a previously generated report file
router.get('/:id/download', authenticate, async (req, res) => {
  try {
    const r = await query('SELECT * FROM reports WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Report not found' });

    const reportsDirResolved = path.resolve(REPORTS_DIR);
    const filePath = path.resolve(REPORTS_DIR, r.rows[0].file_path);

    // Defense in depth: refuse to serve anything that resolves outside REPORTS_DIR,
    // regardless of how the path ended up in the table.
    if (!filePath.startsWith(reportsDirResolved + path.sep)) {
      return res.status(400).json({ error: 'Invalid report file path' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    res.download(filePath, `${r.rows[0].title}.${r.rows[0].file_type}`);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to download report' });
  }
});

module.exports = router;
