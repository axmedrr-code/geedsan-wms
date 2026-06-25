const express = require('express');
const router = express.Router();
const axios = require('axios');
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

const VALVE_COMMANDS = {
  open_valve:   { hex: '261F0045', description: 'Open Valve' },
  close_valve:  { hex: '261F0146', description: 'Close Valve' },
  dredge_valve: { hex: '261F0247', description: 'Dredge Valve' }
};
const hexToBase64 = (hex) => Buffer.from(hex, 'hex').toString('base64');

router.get('/commands', authenticate, (req, res) => {
  res.json(Object.entries(VALVE_COMMANDS).map(([key, val]) => ({
    type: key, description: val.description, hex: val.hex, base64: hexToBase64(val.hex)
  })));
});

router.post('/valve', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const { meter_id, command_type, f_port = 5 } = req.body;
    if (!meter_id || !command_type || !VALVE_COMMANDS[command_type]) return res.status(400).json({ error: 'Invalid request' });
    const mr = await query('SELECT id,device_eui,meter_number FROM meters WHERE id=$1', [meter_id]);
    if (!mr.rows[0]) return res.status(404).json({ error: 'Meter not found' });
    const meter = mr.rows[0];
    const command = VALVE_COMMANDS[command_type];
    const base64Data = hexToBase64(command.hex);
    const cmdR = await query(`INSERT INTO downlink_commands(meter_id,device_eui,command_type,command_hex,command_base64,f_port,status,sent_by,sent_at) VALUES($1,$2,$3,$4,$5,$6,'pending',$7,NOW()) RETURNING *`, [meter_id, meter.device_eui, command_type, command.hex, base64Data, f_port, req.user.id]);
    let sendStatus = 'sent', errorMessage = null, chirpstackId = null;
    try {
      const csUrl = process.env.CHIRPSTACK_URL;
      const apiKey = process.env.CHIRPSTACK_API_KEY;
      if (apiKey) {
        const csRes = await axios.post(`${csUrl}/api/devices/${meter.device_eui}/queue`, { queueItem: { confirmed: true, data: base64Data, fPort: f_port } }, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10000 });
        chirpstackId = csRes.data?.id;
      } else { sendStatus = 'failed'; errorMessage = 'ChirpStack API key not configured'; }
      const newValveStatus = command_type === 'open_valve' ? 'open' : command_type === 'close_valve' ? 'closed' : 'unknown';
      await query('UPDATE meters SET valve_status=$1,updated_at=NOW() WHERE id=$2', [newValveStatus, meter_id]);
    } catch (csErr) { sendStatus = 'failed'; errorMessage = csErr.message; }
    await query('UPDATE downlink_commands SET status=$1,chirpstack_id=$2,error_message=$3 WHERE id=$4', [sendStatus, chirpstackId, errorMessage, cmdR.rows[0].id]);
    res.json({ success: sendStatus === 'sent', command: { id: cmdR.rows[0].id, type: command_type, description: command.description, hex: command.hex, base64: base64Data, fPort: f_port, status: sendStatus, deviceEui: meter.device_eui }, error: errorMessage });
  } catch (err) { res.status(500).json({ error: 'Failed to send command', details: err.message }); }
});

router.get('/', authenticate, async (req, res) => {
  try {
    const { meter_id, page = 1, limit = 20 } = req.query;
    let where = '1=1', params = [];
    if (meter_id) { params.push(meter_id); where += ` AND dc.meter_id=$${params.length}`; }
    const r = await query(`SELECT dc.*,m.meter_number,m.device_eui,u.full_name AS sent_by_name FROM downlink_commands dc LEFT JOIN meters m ON dc.meter_id=m.id LEFT JOIN users u ON dc.sent_by=u.id WHERE ${where} ORDER BY dc.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, (page-1)*limit]);
    res.json({ data: r.rows });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch commands' }); }
});

module.exports = router;
