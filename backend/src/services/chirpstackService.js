const axios = require('axios');
const shengda = require('./shengdaProtocol');

// Hex codes generated from the real Shengda HAC-MLW protocol (valve control,
// T=0x1F) via shengdaProtocol.buildValveCommand — verified byte-for-byte
// against the protocol doc's own worked examples (frame + checksum match
// exactly: open=261F0045, close=261F0146, dredge=261F0247, etc.)
const VALVE_COMMANDS = {
  open_valve: { hex: shengda.buildCommand(0x1F, [shengda.VALVE_COMMANDS.open_valve]).toString('hex').toUpperCase(), description: 'Open Valve' },
  close_valve: { hex: shengda.buildCommand(0x1F, [shengda.VALVE_COMMANDS.close_valve]).toString('hex').toUpperCase(), description: 'Close Valve' },
  dredge_valve: { hex: shengda.buildCommand(0x1F, [shengda.VALVE_COMMANDS.dredge_valve]).toString('hex').toUpperCase(), description: 'Dredge Valve' },
  regular_dredge_on: { hex: shengda.buildCommand(0x1F, [shengda.VALVE_COMMANDS.regular_dredge_on]).toString('hex').toUpperCase(), description: 'Enable Regular Dredge' },
  regular_dredge_off: { hex: shengda.buildCommand(0x1F, [shengda.VALVE_COMMANDS.regular_dredge_off]).toString('hex').toUpperCase(), description: 'Disable Regular Dredge' },
  auto_close_on_power_cut_on: { hex: shengda.buildCommand(0x1F, [shengda.VALVE_COMMANDS.auto_close_on_power_cut_on]).toString('hex').toUpperCase(), description: 'Enable Auto-Close on Power Cut' },
  auto_close_on_power_cut_off: { hex: shengda.buildCommand(0x1F, [shengda.VALVE_COMMANDS.auto_close_on_power_cut_off]).toString('hex').toUpperCase(), description: 'Disable Auto-Close on Power Cut' }
};

const hexToBase64 = (hex) => Buffer.from(hex, 'hex').toString('base64');

// Sends a downlink to ChirpStack's device queue. Returns { status, chirpstackId, errorMessage }.
const sendDownlink = async (deviceEui, base64Data, fPort) => {
  const csUrl = process.env.CHIRPSTACK_URL;
  const apiKey = process.env.CHIRPSTACK_API_KEY;
  if (!apiKey) return { status: 'failed', chirpstackId: null, errorMessage: 'ChirpStack API key not configured' };
  try {
    const csRes = await axios.post(
      `${csUrl}/api/devices/${deviceEui}/queue`,
      { queueItem: { confirmed: true, data: base64Data, fPort } },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10000 }
    );
    return { status: 'sent', chirpstackId: csRes.data?.id || null, errorMessage: null };
  } catch (err) {
    return { status: 'failed', chirpstackId: null, errorMessage: err.message };
  }
};

module.exports = { VALVE_COMMANDS, hexToBase64, sendDownlink };
