// Codec for the Shengda LoRaWAN HAC-MLW Application Layer Protocol V2.1.
// Frame format: [header][T][V]...[T][V][CS]
//   - Uplink (report) frames use header 0x24; downlink (command) frames use 0x26.
//   - T = 1-byte field code, V = field value (fixed length per FIELD_TABLE, or
//     self-length-prefixed for variable-length fields like historical flow).
//   - CS = checksum = sum of all preceding bytes in the frame, truncated to 1 byte.

const REPORT_HEADER = 0x24;
const COMMAND_HEADER = 0x26;

// name, byte length (fixed fields only), and a decode(buf)->value for the V portion.
const FIELD_TABLE = {
  0x01: { name: 'coolingAmount', length: 4, decode: (b) => b.readUInt32BE(0) },
  0x02: { name: 'heatAmount', length: 4, decode: (b) => b.readUInt32BE(0) },
  0x03: { name: 'heatPower', length: 4, decode: (b) => b.readUInt32BE(0) },
  0x04: { name: 'instantaneousFlow', length: 4, decode: (b) => b.readUInt32BE(0) },
  0x05: { name: 'dataLength', length: 1, decode: (b) => b.readUInt8(0) },
  0x06: { name: 'supplyWaterTemp', length: 3, decode: (b) => readUIntBE(b, 3) * 0.01 },
  0x07: { name: 'returnWaterTemp', length: 3, decode: (b) => readUIntBE(b, 3) * 0.01 },
  0x08: { name: 'cumulativeWorkingTime', length: 3, decode: (b) => readUIntBE(b, 3) },
  0x09: { name: 'lorawanWorkingMode', length: 1, decode: (b) => b.readUInt8(0) },
  0x0A: { name: 'sensorVoltage', length: 2, decode: (b) => b.readUInt16BE(0) },
  0x0B: { name: 'pulseCount', length: 4, decode: (b) => b.readUInt32BE(0) },
  0x0C: { name: 'dailyAccumulatedFlow', length: 4, decode: (b) => b.readUInt32BE(0) },
  0x0D: { name: 'monthlyFrozenFlow', length: 4, decode: (b) => b.readUInt32BE(0) },
  0x0E: { name: 'yearlyFrozenFlow', length: 4, decode: (b) => b.readUInt32BE(0) },
  0x0F: { name: 'settlementDate', length: 1, decode: (b) => b.readUInt8(0) },
  0x10: { name: 'resetCount', length: 1, decode: (b) => b.readUInt8(0) },
  0x11: { name: 'classBDownlinkCycle', length: 1, decode: (b) => b.readUInt8(0) },
  0x12: { name: 'meteringMode', length: 1, decode: (b) => b.readUInt8(0) },
  0x13: { name: 'maxMeteringValue', length: 4, decode: (b) => b.readUInt32BE(0) },
  0x14: { name: 'pulseConstant', length: 1, decode: (b) => pulseConstantToLiters(b.readUInt8(0)) },
  0x15: { name: 'rssi', length: 1, decode: (b) => b.readInt8(0) },
  0x16: { name: 'deviceSerial', length: 4, decode: (b) => b.readUInt32BE(0) },
  0x17: { name: 'valveType', length: 1, decode: (b) => b.readUInt8(0) },
  0x19: { name: 'packetSequence', length: 1, decode: (b) => b.readUInt8(0) },
  0x1A: { name: 'batteryVoltage', length: 2, decode: (b) => b.readUInt16BE(0) / 16.4 },
  0x1B: { name: 'meterType', length: 1, decode: (b) => b.readUInt8(0) },
  0x1C: { name: 'moduleTime', length: 6, decode: decodeDateTime },
  0x1D: { name: 'frozenDataTime', length: 3, decode: (b) => ({ year: 2000 + b.readUInt8(0), month: b.readUInt8(1), day: b.readUInt8(2) }) },
  0x1E: { name: 'deviceEui', length: 8, decode: (b) => b.toString('hex').toUpperCase() },
  0x21: { name: 'reverseFlow', length: 4, decode: (b) => b.readUInt32BE(0) },
  0x23: { name: 'triggerSource', length: 1, decode: (b) => b.readUInt8(0) },
  0x24: { name: 'maxValveControlTime', length: 1, decode: (b) => b.readUInt8(0) },
  0x25: { name: 'reportInterval', length: 4, decode: (b) => b.readUInt32BE(0) },
  0x33: { name: 'statusWord', length: 2, decode: (b) => b.readUInt16BE(0) },
  0x40: { name: 'pressure', length: 2, decode: (b) => b.readUInt16BE(0) },
  0x49: { name: 'instantaneousVelocity', length: 4, decode: (b) => b.readUInt32BE(0) }
  // Remaining T codes from the spec are accepted as raw bytes by decodeFrame()
  // (see UNKNOWN_FIELD fallback) since they're parameter-setting fields not
  // needed for telemetry ingestion.
};

// Self-length-prefixed fields: T, then 1 byte length L, then L bytes of V.
const LENGTH_PREFIXED_FIELDS = new Set([0x18, 0x22, 0xA2, 0x90]);

function readUIntBE(buf, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf.readUInt8(i);
  return v;
}

function pulseConstantToLiters(pn) {
  const table = { 0x00: 0.5, 0x01: 1, 0x02: 10, 0x03: 100, 0x04: 1000, 0x05: 10000, 0x06: 5 };
  return table[pn] ?? 1;
}

function decodeDateTime(b) {
  return {
    year: 2000 + b.readUInt8(0),
    month: b.readUInt8(1),
    day: b.readUInt8(2),
    hour: b.readUInt8(3),
    minute: b.readUInt8(4),
    second: b.readUInt8(5)
  };
}

const computeChecksum = (bytes) => bytes.reduce((sum, b) => sum + b, 0) & 0xFF;

// Historical flow record block (T=0x22 or 0xA2): 1-byte storage cycle, 4-byte
// initial value, then N 2-byte signed deltas (high bit = negative).
const decodeHistoricalFlow = (v) => {
  const storageCycleRaw = v.readUInt8(0);
  const intervalMinutes = storageCycleRaw <= 0x90 ? storageCycleRaw * 5 : 0x90 * 5 + (storageCycleRaw - 0x90) * 10;
  const initialValue = v.readUInt32BE(1);
  const points = [{ offsetMinutes: 0, value: initialValue }];
  let running = initialValue;
  for (let i = 5; i + 2 <= v.length; i += 2) {
    const raw = v.readUInt16BE(i);
    const negative = !!(raw & 0x8000);
    const magnitude = raw & 0x7FFF;
    running += negative ? -magnitude : magnitude;
    points.push({ offsetMinutes: intervalMinutes * points.length, value: running });
  }
  return { intervalMinutes, points };
};

// Parses a full report frame into { fields: {name: value}, raw: {T: bytes}, checksumValid }.
const decodeFrame = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 2) return { fields: {}, raw: {}, checksumValid: false };

  const payloadEnd = buf.length - 1; // last byte is CS
  const expectedCs = buf.readUInt8(payloadEnd);
  const actualCs = computeChecksum(buf.subarray(0, payloadEnd));

  const fields = {};
  const raw = {};
  let i = 1; // skip frame header
  while (i < payloadEnd) {
    const t = buf.readUInt8(i);
    i += 1;
    let length;
    if (LENGTH_PREFIXED_FIELDS.has(t)) {
      length = buf.readUInt8(i);
      i += 1;
    } else if (FIELD_TABLE[t]) {
      length = FIELD_TABLE[t].length;
    } else {
      // Unknown/unsupported fixed-length field — can't safely continue
      // parsing past it without knowing its length, so stop here.
      break;
    }
    if (i + length > payloadEnd) break;
    const v = buf.subarray(i, i + length);
    raw[t] = v;

    if (t === 0x22 || t === 0xA2) {
      fields.historicalFlow = decodeHistoricalFlow(v);
    } else if (FIELD_TABLE[t]) {
      fields[FIELD_TABLE[t].name] = FIELD_TABLE[t].decode(v);
    }
    i += length;
  }

  return { fields, raw, checksumValid: expectedCs === actualCs };
};

// Meter Status Word 1/2 bit decoding (water meter variant, protocol section 3.1).
// T=0x33 "status word" is a single 2-byte field: high byte = Word 1, low byte
// = Word 2. Each word's bits are independently B7..B0 of its own byte.
const splitStatusWord = (statusWord) => ({ word1: (statusWord >> 8) & 0xFF, word2: statusWord & 0xFF });

const decodeStatusWord1 = (byte) => ({
  valve_fault: !!(byte & 0x80),
  low_battery: !!(byte & 0x40),
  magnetic_attack: !!(byte & 0x20),
  battery_removed: !!(byte & 0x10),
  der_error: !!(byte & 0x08),
  valve_closed: !!(byte & 0x04),
  metering_fault: !!(byte & 0x02)
  // B0 is reserved for word 1 per spec
});

const decodeStatusWord2 = (byte) => ({
  water_inlet_alarm: !!(byte & 0x80),
  water_return_alarm: !!(byte & 0x40),
  flow_alarm: !!(byte & 0x20),
  empty_pipe: !!(byte & 0x10),
  leakage: !!(byte & 0x08),
  tube_burst: !!(byte & 0x04),
  historical_magnetic_attack: !!(byte & 0x02),
  remote_data: !!(byte & 0x01)
});

// Builds a downlink command frame: [0x26][T][V...][CS]. `valueBytes` is an
// array of raw bytes for V (already in protocol order/units).
const buildCommand = (t, valueBytes = []) => {
  const bytes = [COMMAND_HEADER, t, ...valueBytes];
  bytes.push(computeChecksum(bytes));
  return Buffer.from(bytes);
};

// Builds a multi-field uplink report frame: [0x24][T][V]...[T][V][CS] — the
// inverse of decodeFrame, used by the MQTT simulator to generate frames that
// the real decoder can parse. `fields` is an array of { t, bytes }.
const buildReportFrame = (fields) => {
  const body = [REPORT_HEADER];
  for (const { t, bytes } of fields) body.push(t, ...bytes);
  body.push(computeChecksum(body));
  return Buffer.from(body);
};

// Reverse of pulseConstantToLiters — picks the closest matching PN code.
const litersToPulseConstantCode = (liters) => {
  const table = { 0.5: 0x00, 1: 0x01, 10: 0x02, 100: 0x03, 1000: 0x04, 10000: 0x05, 5: 0x06 };
  return table[liters] ?? 0x03;
};

// Read commands: per spec, reading a field is done by sending the field's T
// code with V filled with 0xFF bytes matching its declared length.
const buildReadCommand = (t) => {
  const def = FIELD_TABLE[t];
  const length = def ? def.length : 1;
  return buildCommand(t, new Array(length).fill(0xFF));
};

const VALVE_CONTROL_T = 0x1F;
const VALVE_COMMANDS = {
  open_valve: 0x00,
  close_valve: 0x01,
  dredge_valve: 0x02,
  regular_dredge_on: 0x03,
  regular_dredge_off: 0x04,
  auto_close_on_power_cut_on: 0x05,
  auto_close_on_power_cut_off: 0x06
};

const buildValveCommand = (commandType) => {
  const code = VALVE_COMMANDS[commandType];
  if (code === undefined) throw new Error(`Unknown valve command: ${commandType}`);
  return buildCommand(VALVE_CONTROL_T, [code]);
};

module.exports = {
  REPORT_HEADER,
  COMMAND_HEADER,
  FIELD_TABLE,
  VALVE_COMMANDS,
  decodeFrame,
  splitStatusWord,
  decodeStatusWord1,
  decodeStatusWord2,
  decodeHistoricalFlow,
  computeChecksum,
  buildCommand,
  buildReadCommand,
  buildValveCommand,
  buildReportFrame,
  litersToPulseConstantCode
};
