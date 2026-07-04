const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { VALVE_COMMANDS, hexToBase64, sendDownlink } = require('../services/chirpstackService');
const shengda = require('../services/shengdaProtocol');

router.get('/commands', authenticate, (req, res) => {
  res.json(Object.entries(VALVE_COMMANDS).map(([key, val]) => ({
    type: key, description: val.description, hex: val.hex, base64: hexToBase64(val.hex)
  })));
});

// OTA/remote-configuration writes — only the protocol's documented RW fields
// that are safe to change remotely without risking the device's metering
// integrity (e.g. NOT exposing AppKey/NWK_SKEY rewrite or firmware upgrade
// here). Each entry encodes a value into the real Shengda T/V wire format.
const u32be = (v) => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];

const CONFIG_FIELDS = {
  report_interval: {
    t: 0x25, unit: 'seconds (600-86400)', description: 'Data report interval',
    encode: (v) => { const n = parseInt(v); if (n < 600 || n > 86400) throw new Error('report_interval must be 600-86400 seconds'); return u32be(n); }
  },
  pulse_constant: {
    t: 0x14, unit: 'liters/pulse (0.5,1,5,10,100,1000,10000)', description: 'Pulse constant',
    encode: (v) => [shengda.litersToPulseConstantCode(parseFloat(v))]
  },
  metering_mode: {
    t: 0x12, unit: '0-0x10 (see protocol §6)', description: 'Metering mode',
    encode: (v) => { const n = parseInt(v); if (n < 0 || n > 0x10) throw new Error('metering_mode must be 0-16'); return [n]; }
  },
  max_valve_control_time: {
    t: 0x24, unit: 'seconds (0-255)', description: 'Maximum valve control time',
    encode: (v) => { const n = parseInt(v); if (n < 0 || n > 255) throw new Error('max_valve_control_time must be 0-255'); return [n]; }
  }
};

/**
 * @openapi
 * /downlinks/config:
 *   post:
 *     summary: Send an OTA configuration write to a meter (report interval, pulse constant, metering mode, max valve control time)
 *     tags: [Downlinks]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/config-fields', authenticate, (req, res) => {
  res.json(Object.entries(CONFIG_FIELDS).map(([key, f]) => ({ field: key, description: f.description, unit: f.unit })));
});

router.post('/config', authenticate, authorize('admin', 'operator'), async (req, res) => {
  try {
    const { meter_id, field, value, f_port = 5 } = req.body;
    const def = CONFIG_FIELDS[field];
    if (!meter_id || !def) return res.status(400).json({ error: `Invalid request. Valid fields: ${Object.keys(CONFIG_FIELDS).join(', ')}` });

    const mr = await query('SELECT id,device_eui FROM meters WHERE id=$1', [meter_id]);
    if (!mr.rows[0]) return res.status(404).json({ error: 'Meter not found' });
    const meter = mr.rows[0];

    let valueBytes;
    try { valueBytes = def.encode(value); } catch (e) { return res.status(400).json({ error: e.message }); }

    const frame = shengda.buildCommand(def.t, valueBytes);
    const hex = frame.toString('hex').toUpperCase();
    const base64Data = frame.toString('base64');
    const commandType = `config_${field}`;

    const cmdR = await query(
      `INSERT INTO downlink_commands(meter_id,device_eui,command_type,command_hex,command_base64,f_port,status,sent_by,sent_at) VALUES($1,$2,$3,$4,$5,$6,'pending',$7,NOW()) RETURNING *`,
      [meter_id, meter.device_eui, commandType, hex, base64Data, f_port, req.user.id]
    );
    const { status: sendStatus, chirpstackId, errorMessage } = await sendDownlink(meter.device_eui, base64Data, f_port);
    await query('UPDATE downlink_commands SET status=$1,chirpstack_id=$2,error_message=$3,next_retry_at=$4 WHERE id=$5',
      [sendStatus, chirpstackId, errorMessage, sendStatus === 'failed' ? new Date(Date.now() + 5 * 60 * 1000) : null, cmdR.rows[0].id]);

    res.json({
      success: sendStatus === 'sent',
      command: { id: cmdR.rows[0].id, type: commandType, description: def.description, value, hex, base64: base64Data, fPort: f_port, status: sendStatus, deviceEui: meter.device_eui },
      error: errorMessage,
      note: 'The new value will only be confirmed once the device sends its next uplink with this field — there is no separate ack for config writes.'
    });
  } catch (err) { res.status(500).json({ error: 'Failed to send config command', details: err.message }); }
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
    const { status: sendStatus, chirpstackId, errorMessage } = await sendDownlink(meter.device_eui, base64Data, f_port);
    if (sendStatus === 'sent') {
      const newValveStatus = command_type === 'open_valve' ? 'open' : command_type === 'close_valve' ? 'closed' : 'unknown';
      await query('UPDATE meters SET valve_status=$1,updated_at=NOW() WHERE id=$2', [newValveStatus, meter_id]);
    }
    await query('UPDATE downlink_commands SET status=$1,chirpstack_id=$2,error_message=$3,next_retry_at=$4 WHERE id=$5', [sendStatus, chirpstackId, errorMessage, sendStatus === 'failed' ? new Date(Date.now() + 5 * 60 * 1000) : null, cmdR.rows[0].id]);
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
