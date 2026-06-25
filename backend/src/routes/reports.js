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

router.get('/', authenticate, async (req, res) => {
  const r = await query('SELECT r.*,u.full_name AS generated_by_name FROM reports r LEFT JOIN users u ON r.generated_by=u.id ORDER BY r.created_at DESC LIMIT 50');
  res.json(r.rows);
});

const getReportData = async (reportType, params) => {
  const { from, to } = params;
  const fromDate = from || new Date(Date.now()-30*86400000).toISOString().split('T')[0];
  const toDate = to || new Date().toISOString().split('T')[0];
  if (reportType === 'daily_consumption' || reportType === 'weekly_consumption' || reportType === 'monthly_consumption') {
    const r = await query(`SELECT DATE(mr.timestamp) AS date,m.meter_number,m.device_eui,c.full_name AS customer_name,MAX(mr.total_consumption)-MIN(mr.total_consumption) AS daily_consumption,AVG(mr.current_flow) AS avg_flow,COUNT(*) AS reading_count FROM meter_readings mr JOIN meters m ON mr.meter_id=m.id LEFT JOIN customers c ON m.customer_id=c.id WHERE DATE(mr.timestamp) BETWEEN $1 AND $2 GROUP BY DATE(mr.timestamp),m.id,m.meter_number,m.device_eui,c.full_name ORDER BY date DESC,m.meter_number`, [fromDate, toDate]);
    return r.rows;
  }
  if (reportType === 'customer_usage') {
    const r = await query(`SELECT c.customer_number,c.full_name AS customer_name,c.email,c.phone,COUNT(DISTINCT m.id) AS meter_count,SUM(m.total_consumption) AS total_consumption,AVG(m.current_flow) AS avg_flow FROM customers c LEFT JOIN meters m ON c.id=m.customer_id AND m.status='active' WHERE c.account_status='active' GROUP BY c.id,c.customer_number,c.full_name,c.email,c.phone ORDER BY total_consumption DESC`);
    return r.rows;
  }
  return [];
};

router.post('/generate', authenticate, async (req, res) => {
  try {
    const { report_type, from, to, file_type='pdf', title } = req.body;
    const data = await getReportData(report_type, { from, to });
    const reportTitle = title || `${report_type.replace(/_/g,' ').toUpperCase()} Report`;
    const filename = `${report_type}_${Date.now()}.${file_type}`;
    const filePath = path.join(REPORTS_DIR, filename);

    if (file_type === 'pdf') {
      await new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);
        doc.rect(0,0,doc.page.width,70).fill('#42A5F5');
        doc.fillColor('white').fontSize(20).font('Helvetica-Bold').text('GEEDSAN', 40, 15);
        doc.fontSize(11).font('Helvetica').text('Water Meter Management System', 40, 40);
        doc.fontSize(14).text(reportTitle, 200, 25, { align:'center' });
        doc.fillColor('#333').fontSize(10).moveDown(2);
        doc.text(`Generated: ${new Date().toLocaleString()} | Period: ${from||'N/A'} to ${to||'Today'}`);
        doc.moveDown();
        const headers = report_type==='customer_usage' ? ['Customer No.','Name','Phone','Meters','Total m³','Avg Flow'] : ['Date','Meter','Customer','Consumption m³','Avg Flow','Readings'];
        const colW = [90,150,120,80,90,70];
        let x=40, hy=doc.y;
        doc.rect(40,hy-5,doc.page.width-80,20).fill('#1976D2');
        headers.forEach((h,i)=>{ doc.fillColor('white').fontSize(8).font('Helvetica-Bold').text(h,x+2,hy,{width:colW[i]}); x+=colW[i]; });
        doc.moveDown(0.5);
        data.slice(0,100).forEach((row,ri)=>{
          const ry=doc.y;
          if(ri%2===0) doc.rect(40,ry-3,doc.page.width-80,16).fill('#f8f9fa');
          x=40;
          const vals = report_type==='customer_usage' ? [row.customer_number,row.customer_name,row.phone||'—',row.meter_count,Number(row.total_consumption||0).toFixed(2),Number(row.avg_flow||0).toFixed(2)] : [row.date,row.meter_number,row.customer_name||'—',Number(row.daily_consumption||0).toFixed(3),Number(row.avg_flow||0).toFixed(2),row.reading_count];
          vals.forEach((v,i)=>{ doc.fillColor('#333').fontSize(7).font('Helvetica').text(String(v||'-'),x+2,ry,{width:colW[i]-4}); x+=colW[i]; });
          doc.moveDown(0.2);
          if(doc.y>doc.page.height-50) doc.addPage();
        });
        doc.fontSize(7).fillColor('#999').text(`GEEDSAN WMS | ${data.length} records`,40,doc.page.height-25,{align:'center'});
        doc.end();
        stream.on('finish',resolve); stream.on('error',reject);
      });
    } else {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(reportTitle.substring(0,30));
      ws.mergeCells('A1:G1');
      const tc = ws.getCell('A1'); tc.value=`GEEDSAN - ${reportTitle}`; tc.font={bold:true,size:14,color:{argb:'FFFFFF'}}; tc.fill={type:'pattern',pattern:'solid',fgColor:{argb:'42A5F5'}}; tc.alignment={horizontal:'center'};
      ws.getRow(1).height=28;
      const headers = report_type==='customer_usage' ? ['Customer No.','Name','Email','Phone','Meters','Total Consumption (m³)','Avg Flow (L/min)'] : ['Date','Meter Number','Device EUI','Customer','Consumption (m³)','Avg Flow (L/min)','Readings'];
      const hr=ws.addRow(headers); hr.eachCell(c=>{c.font={bold:true,color:{argb:'FFFFFF'}};c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'1976D2'}};});
      data.forEach((row,i)=>{
        const vals = report_type==='customer_usage' ? [row.customer_number,row.customer_name,row.email||'',row.phone||'',parseInt(row.meter_count),parseFloat(row.total_consumption||0),parseFloat(row.avg_flow||0)] : [row.date,row.meter_number,row.device_eui,row.customer_name||'',parseFloat(row.daily_consumption||0),parseFloat(row.avg_flow||0),parseInt(row.reading_count)];
        const dr=ws.addRow(vals); if(i%2===0) dr.eachCell(c=>{c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'F8F9FA'}};});
      });
      ws.columns.forEach(c=>{c.width=20;});
      await wb.xlsx.writeFile(filePath);
    }

    const stats = fs.statSync(filePath);
    const r = await query(`INSERT INTO reports(report_type,title,period_start,period_end,parameters,status,file_path,file_type,file_size,generated_by,generated_at) VALUES($1,$2,$3,$4,$5,'completed',$6,$7,$8,$9,NOW()) RETURNING *`, [report_type, reportTitle, from, to, JSON.stringify({}), filename, file_type, stats.size, req.user.id]);
    res.json({ report: r.rows[0], downloadUrl: `/reports/${filename}` });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to generate report', details: err.message }); }
});

router.get('/:id/download', authenticate, async (req, res) => {
  const r = await query('SELECT * FROM reports WHERE id=$1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Report not found' });
  const filePath = path.join(REPORTS_DIR, r.rows[0].file_path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath, `${r.rows[0].title}.${r.rows[0].file_type}`);
});

module.exports = router;
