// Fake MQTT payload simulator for testing without real hardware.
//
// Publishes real Shengda HAC-MLW protocol frames (not generic JSON) through
// the same MQTT topics ChirpStack would use, so it exercises the actual
// decoder/alarm/telemetry pipeline end to end — not a shortcut around it.
//
// Usage:
//   node scripts/simulateMqtt.js                 # loop every 30s until Ctrl+C
//   node scripts/simulateMqtt.js --once          # publish a single round and exit
//   node scripts/simulateMqtt.js --interval=10000
//   node scripts/simulateMqtt.js --count=5        # how many demo meters to seed if none exist
//
// Run from inside the backend container (so MQTT_BROKER resolves to
// mosquitto's in-network hostname): docker exec geedsan-backend node scripts/simulateMqtt.js

const mqtt = require('mqtt');
const { Pool } = require('pg');
require('dotenv').config({ path: `${__dirname}/../.env` });
const shengda = require('../src/services/shengdaProtocol');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const INTERVAL_MS = parseInt(args.interval) || 30000;
const SEED_COUNT = parseInt(args.count) || 3;
const SIM_GATEWAY_EUI = 'SIMGATEWAY00001A';
const APPLICATION_ID = '1';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'geedsan_wms',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD
});

const DEMO_METERS = [
  { device_eui: 'SIMTEST000000001', meter_number: 'SIM-METER-001' },
  { device_eui: 'SIMTEST000000002', meter_number: 'SIM-METER-002' },
  { device_eui: 'SIMTEST000000003', meter_number: 'SIM-METER-003' }
];

const ensureDemoMeters = async () => {
  const existing = await pool.query(`SELECT device_eui FROM meters WHERE device_eui LIKE 'SIMTEST%'`);
  if (existing.rows.length > 0) return existing.rows.map(r => r.device_eui);

  const toCreate = DEMO_METERS.slice(0, SEED_COUNT);
  for (const m of toCreate) {
    await pool.query(
      `INSERT INTO meters(device_eui, meter_number, status) VALUES($1,$2,'active') ON CONFLICT DO NOTHING`,
      [m.device_eui, m.meter_number]
    );
  }
  console.log(`🌱 Seeded ${toCreate.length} demo meter(s): ${toCreate.map(m => m.device_eui).join(', ')}`);
  return toCreate.map(m => m.device_eui);
};

// Per-meter simulated state, kept in memory across loop iterations so
// consumption/battery drift realistically instead of jumping randomly.
const state = new Map();

const initState = (deviceEui) => ({
  pulseCount: Math.floor(Math.random() * 5000),
  batteryRaw: 60, // 60/16.4 ≈ 3.66V
  pressure: 300 + Math.floor(Math.random() * 50),
  fCnt: 0
});

const buildFrame = (s) => {
  // Occasionally simulate a real-world condition for demo purposes.
  const roll = Math.random();
  let word1 = 0, word2 = 0;
  if (roll < 0.03) word2 |= 0x08; // leakage bit -> water_leakage alarm
  else if (roll < 0.05) word1 |= 0x80; // valve_fault bit
  if (s.batteryRaw < 40) word1 |= 0x40; // low_battery bit (under ~2.44V)

  const fields = [
    { t: 0x0B, bytes: u32be(s.pulseCount) },
    { t: 0x14, bytes: [shengda.litersToPulseConstantCode(100)] },
    { t: 0x1A, bytes: u16be(s.batteryRaw) },
    { t: 0x40, bytes: u16be(s.pressure) },
    { t: 0x33, bytes: u16be((word1 << 8) | word2) },
    { t: 0x23, bytes: [0x01] } // trigger source: routine reporting
  ];
  return shengda.buildReportFrame(fields);
};

const u16be = (v) => [(v >> 8) & 0xFF, v & 0xFF];
const u32be = (v) => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];

const advanceState = (s) => {
  s.pulseCount += Math.floor(Math.random() * 20); // a few liters' worth of pulses
  s.batteryRaw = Math.max(30, s.batteryRaw - (Math.random() < 0.1 ? 1 : 0)); // slow drain
  s.pressure = Math.max(0, s.pressure + Math.round((Math.random() - 0.5) * 10));
  s.fCnt += 1;
};

const publishOne = (client, deviceEui) => {
  if (!state.has(deviceEui)) state.set(deviceEui, initState(deviceEui));
  const s = state.get(deviceEui);
  advanceState(s);

  const frame = buildFrame(s);
  const topic = `application/${APPLICATION_ID}/device/${deviceEui}/event/up`;
  const payload = JSON.stringify({
    deviceInfo: { devEui: deviceEui },
    data: frame.toString('base64'),
    fPort: 2,
    fCnt: s.fCnt,
    rxInfo: [{ rssi: -70 - Math.floor(Math.random() * 30), snr: Math.round((Math.random() * 10 - 2) * 10) / 10, gatewayId: SIM_GATEWAY_EUI }]
  });

  client.publish(topic, payload);
  console.log(`📤 ${deviceEui}: pulses=${s.pulseCount} battery=${(s.batteryRaw / 16.4).toFixed(2)}V pressure=${s.pressure}kPa`);
};

(async () => {
  const deviceEuis = await ensureDemoMeters();
  const brokerUrl = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
  const client = mqtt.connect(brokerUrl, { clientId: `geedsan-simulator-${Date.now()}`, clean: true });

  client.on('connect', async () => {
    console.log(`✅ Simulator connected to ${brokerUrl}, simulating: ${deviceEuis.join(', ')}`);

    const tick = () => deviceEuis.forEach(eui => publishOne(client, eui));
    tick();

    if (args.once) {
      setTimeout(() => { client.end(); pool.end(); process.exit(0); }, 1000);
      return;
    }

    const interval = setInterval(tick, INTERVAL_MS);
    process.on('SIGINT', () => {
      clearInterval(interval);
      client.end();
      pool.end();
      console.log('\n👋 Simulator stopped');
      process.exit(0);
    });
  });

  client.on('error', (err) => console.error('MQTT error:', err.message));
})();
