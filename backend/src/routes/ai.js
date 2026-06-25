const express = require('express');
const router = express.Router();
const axios = require('axios');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');

const callClaude = async (prompt) => {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('AI not configured');
  const r = await axios.post('https://api.anthropic.com/v1/messages', { model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } });
  return r.data.content[0].text;
};

router.post('/leak-detection', authenticate, async (req, res) => {
  try {
    const { meter_id } = req.body;
    const mr = await query('SELECT m.*,c.full_name AS customer_name FROM meters m LEFT JOIN customers c ON m.customer_id=c.id WHERE m.id=$1', [meter_id]);
    if (!mr.rows[0]) return res.status(404).json({ error: 'Meter not found' });
    const meter = mr.rows[0];
    const readings = await query(`SELECT date_trunc('hour',timestamp) AS hour,AVG(current_flow) AS avg_flow,MAX(total_consumption)-MIN(total_consumption) AS consumption FROM meter_readings WHERE meter_id=$1 AND timestamp>=NOW()-INTERVAL '7 days' GROUP BY hour ORDER BY hour ASC`, [meter_id]);
    const data = readings.rows;
    const nightFlows = data.filter(r => { const h=new Date(r.hour).getHours(); return h>=1&&h<=5&&parseFloat(r.avg_flow)>0.5; });
    const avg = data.reduce((s,r)=>s+parseFloat(r.consumption||0),0)/Math.max(data.length,1);
    const highPeriods = data.filter(r=>parseFloat(r.consumption||0)>avg*3);
    let riskLevel='low', indicators=[];
    if(nightFlows.length>3){riskLevel='medium';indicators.push(`Night-time flow in ${nightFlows.length} hours`);}
    if(highPeriods.length>2){riskLevel=riskLevel==='medium'?'high':'medium';indicators.push(`${highPeriods.length} abnormally high consumption periods`);}
    if(meter.current_flow>10){riskLevel='high';indicators.push(`High current flow: ${meter.current_flow} L/min`);}
    let analysis=null;
    try { analysis=await callClaude(`Analyze meter ${meter.meter_number} for water leaks. Night flow events: ${nightFlows.length}. High consumption periods: ${highPeriods.length}. Current flow: ${meter.current_flow} L/min. Risk: ${riskLevel}. Provide brief 2-3 sentence analysis.`); } catch { analysis=`Risk level: ${riskLevel}. ${indicators.join('. ')}`; }
    res.json({ meterId: meter_id, meterNumber: meter.meter_number, riskLevel, indicators, analysis, nightFlowCount: nightFlows.length, highConsumptionPeriods: highPeriods.length, avgHourlyConsumption: avg.toFixed(4), dataPoints: data.length });
  } catch (err) { res.status(500).json({ error: 'Leak detection failed', details: err.message }); }
});

router.post('/consumption-forecast', authenticate, async (req, res) => {
  try {
    const { meter_id, days=7 } = req.body;
    const readings = await query(`SELECT DATE(timestamp) AS date, SUM(current_flow)*0.0167 AS daily_consumption FROM meter_readings WHERE meter_id=$1 AND timestamp>=NOW()-INTERVAL '30 days' GROUP BY DATE(timestamp) ORDER BY date ASC`, [meter_id]);
    const data = readings.rows;
    if (data.length < 3) return res.json({ forecast: [], message: 'Insufficient data' });
    const values = data.map(r=>parseFloat(r.daily_consumption));
    const wn = Math.min(7, values.length);
    const avg = values.slice(-wn).reduce((a,b)=>a+b,0)/wn;
    const forecast = Array.from({length:parseInt(days)},(_,i)=>{
      const d=new Date(); d.setDate(d.getDate()+i+1);
      const v=(Math.random()-0.5)*0.1;
      return {date:d.toISOString().split('T')[0],predicted:Math.max(0,avg*(1+v)).toFixed(4),lower:Math.max(0,avg*0.85).toFixed(4),upper:(avg*1.15).toFixed(4)};
    });
    res.json({ meterId: meter_id, historicalData: data, forecast, avgDailyConsumption: avg.toFixed(4) });
  } catch (err) { res.status(500).json({ error: 'Forecast failed' }); }
});

router.post('/analyze-alarm', authenticate, async (req, res) => {
  try {
    const { alarm_id } = req.body;
    const r = await query(`SELECT a.*,m.meter_number,m.current_flow,m.battery_voltage,m.valve_status,c.full_name AS customer_name FROM alarms a LEFT JOIN meters m ON a.meter_id=m.id LEFT JOIN customers c ON m.customer_id=c.id WHERE a.id=$1`, [alarm_id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Alarm not found' });
    const alarm = r.rows[0];
    let analysis = `${alarm.alarm_type} detected on meter ${alarm.meter_number}.`, recommendation = 'Contact field technician.';
    try {
      const ai = await callClaude(`Analyze this water meter alarm: Type=${alarm.alarm_type}, Severity=${alarm.severity}, Meter=${alarm.meter_number}, Flow=${alarm.current_flow}L/min, Battery=${alarm.battery_voltage}V. Respond with JSON: {"analysis":"2 sentences","recommendation":"action","urgency":"immediate|within_24h|monitor"}`);
      const parsed = JSON.parse(ai.replace(/```json|```/g,'').trim());
      analysis = parsed.analysis; recommendation = `[${parsed.urgency?.toUpperCase()}] ${parsed.recommendation}`;
      await query('UPDATE alarms SET ai_analysis=$1,ai_recommendation=$2 WHERE id=$3', [analysis, recommendation, alarm_id]);
    } catch {}
    res.json({ alarm_id, analysis, recommendation });
  } catch (err) { res.status(500).json({ error: 'Analysis failed' }); }
});

router.get('/anomalies', authenticate, async (req, res) => {
  try {
    const r = await query(`WITH meter_stats AS (SELECT meter_id,AVG(current_flow) AS avg_flow,STDDEV(current_flow) AS std_flow FROM meter_readings WHERE timestamp>=NOW()-INTERVAL '7 days' GROUP BY meter_id HAVING COUNT(*)>10) SELECT m.id,m.meter_number,m.device_eui,m.current_flow,ms.avg_flow,ms.std_flow,c.full_name AS customer_name,CASE WHEN m.current_flow>ms.avg_flow+3*ms.std_flow THEN 'high' WHEN m.current_flow<0 THEN 'reverse' ELSE 'elevated' END AS anomaly_type FROM meters m JOIN meter_stats ms ON m.id=ms.meter_id LEFT JOIN customers c ON m.customer_id=c.id WHERE m.current_flow>ms.avg_flow+2*ms.std_flow OR m.current_flow<0 ORDER BY (m.current_flow-ms.avg_flow)/NULLIF(ms.std_flow,0) DESC LIMIT 20`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Anomaly detection failed' }); }
});

module.exports = router;
