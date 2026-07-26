const { query } = require('../config/database');
const logger = require('./logger');

const STATUS_THRESHOLDS = {
  healthy:  85,
  warning:  60,
  critical: 30,
};

function scoreStatus(score, isOnline) {
  if (!isOnline) return 'offline';
  if (score >= STATUS_THRESHOLDS.healthy)  return 'healthy';
  if (score >= STATUS_THRESHOLDS.warning)  return 'warning';
  if (score >= STATUS_THRESHOLDS.critical) return 'critical';
  return 'critical';
}

/**
 * Calculate comprehensive device health for a single meter.
 * Returns all metrics needed for the Device Health dashboard card and detail view.
 */
async function getDeviceHealth(meterId) {
  const [meterR, signalR, batteryR, packetR, tempR, gatewayR] = await Promise.all([

    // Current meter state
    query(
      `SELECT id, device_eui, meter_number, is_online, last_seen, valve_status,
              battery_voltage, rssi, snr, pressure, firmware_version, status
       FROM meters WHERE id = $1`,
      [meterId]
    ),

    // Signal trend over last 7 days (hourly buckets)
    query(
      `SELECT
         DATE_TRUNC('hour', timestamp)              AS hour,
         AVG(rssi)                                  AS avg_rssi,
         AVG(snr)                                   AS avg_snr,
         MIN(rssi)                                  AS min_rssi,
         MAX(rssi)                                  AS max_rssi,
         COUNT(*)                                   AS reading_count
       FROM meter_readings
       WHERE meter_id = $1
         AND timestamp >= NOW() - INTERVAL '7 days'
         AND rssi IS NOT NULL
       GROUP BY DATE_TRUNC('hour', timestamp)
       ORDER BY hour ASC`,
      [meterId]
    ),

    // Battery trend (last 30 readings)
    query(
      `SELECT timestamp, battery_voltage
       FROM meter_readings
       WHERE meter_id = $1 AND battery_voltage IS NOT NULL
       ORDER BY timestamp DESC LIMIT 30`,
      [meterId]
    ),

    // Packet success rate: compare actual readings vs expected (based on 15-min report interval assumption)
    query(
      `SELECT
         COUNT(*) FILTER (WHERE timestamp >= NOW() - INTERVAL '24 hours') AS readings_24h,
         COUNT(*) FILTER (WHERE timestamp >= NOW() - INTERVAL '7 days')   AS readings_7d,
         MIN(f_cnt) FILTER (WHERE timestamp >= NOW() - INTERVAL '24 hours' AND f_cnt IS NOT NULL) AS min_fcnt,
         MAX(f_cnt) FILTER (WHERE timestamp >= NOW() - INTERVAL '24 hours' AND f_cnt IS NOT NULL) AS max_fcnt
       FROM meter_readings
       WHERE meter_id = $1`,
      [meterId]
    ),

    // Device temperature (newest reading with temperature)
    query(
      `SELECT temperature, timestamp
       FROM meter_readings
       WHERE meter_id = $1 AND temperature IS NOT NULL
       ORDER BY timestamp DESC LIMIT 1`,
      [meterId]
    ),

    // Most recently used gateway
    query(
      `SELECT gateway_eui, COUNT(*) AS usage_count
       FROM meter_readings
       WHERE meter_id = $1
         AND gateway_eui IS NOT NULL
         AND timestamp >= NOW() - INTERVAL '24 hours'
       GROUP BY gateway_eui
       ORDER BY usage_count DESC LIMIT 1`,
      [meterId]
    ),
  ]);

  if (!meterR.rows[0]) return null;
  const meter = meterR.rows[0];

  // ── Battery health ────────────────────────────────────────────────────────────
  const battRows   = batteryR.rows;
  const latestBatt = battRows[0] ? parseFloat(battRows[0].battery_voltage) : null;
  // 3.6V = 100%, 2.8V = 0%, linear interpolation
  const batteryPct = latestBatt != null
    ? Math.max(0, Math.min(100, Math.round(((latestBatt - 2.8) / 0.8) * 100)))
    : null;

  // Battery slope: negative = draining (normal), steeply negative = fast drain
  let batteryTrend = 'stable';
  if (battRows.length >= 5) {
    const oldest = parseFloat(battRows[battRows.length - 1].battery_voltage);
    const newest = parseFloat(battRows[0].battery_voltage);
    const slope  = (newest - oldest) / battRows.length;
    if (slope < -0.005)       batteryTrend = 'fast_drain';
    else if (slope < -0.001)  batteryTrend = 'draining';
  }

  // ── Signal quality ─────────────────────────────────────────────────────────────
  const sigRows  = signalR.rows;
  const avgRssi  = sigRows.length ? sigRows.reduce((s, r) => s + parseFloat(r.avg_rssi), 0) / sigRows.length : null;
  const avgSnr   = sigRows.length ? sigRows.reduce((s, r) => s + parseFloat(r.avg_snr || 0), 0) / sigRows.length : null;
  const minRssi  = sigRows.length ? Math.min(...sigRows.map(r => parseFloat(r.min_rssi))) : null;
  const maxRssi  = sigRows.length ? Math.max(...sigRows.map(r => parseFloat(r.max_rssi))) : null;

  // Signal score: -70 dBm = 100%, -120 dBm = 0%
  const signalScore = avgRssi != null
    ? Math.max(0, Math.min(100, Math.round(((avgRssi + 120) / 50) * 100)))
    : 0;

  // RSSI trend: compare last 12h vs prior 12h
  const halfIdx   = Math.floor(sigRows.length / 2);
  const rssiRecent = halfIdx > 0 ? sigRows.slice(0, halfIdx).reduce((s, r) => s + parseFloat(r.avg_rssi), 0) / halfIdx : null;
  const rssiOlder  = halfIdx > 0 ? sigRows.slice(halfIdx).reduce((s, r) => s + parseFloat(r.avg_rssi), 0) / (sigRows.length - halfIdx) : null;
  const rssiTrend  = rssiRecent != null && rssiOlder != null
    ? (rssiRecent - rssiOlder > 3 ? 'improving' : rssiRecent - rssiOlder < -3 ? 'degrading' : 'stable')
    : 'insufficient_data';

  const snrRecent = halfIdx > 0 ? sigRows.slice(0, halfIdx).reduce((s, r) => s + parseFloat(r.avg_snr || 0), 0) / halfIdx : null;
  const snrOlder  = halfIdx > 0 ? sigRows.slice(halfIdx).reduce((s, r) => s + parseFloat(r.avg_snr || 0), 0) / (sigRows.length - halfIdx) : null;
  const snrTrend  = snrRecent != null && snrOlder != null
    ? (snrRecent - snrOlder > 2 ? 'improving' : snrRecent - snrOlder < -2 ? 'degrading' : 'stable')
    : 'insufficient_data';

  // ── Packet success rate ────────────────────────────────────────────────────────
  const pkt       = packetR.rows[0];
  const readings24h = parseInt(pkt.readings_24h || 0);
  // Expected: one reading per 15 minutes = 96 per day (most common config)
  const expectedPerDay = 96;
  const packetSuccessRate  = Math.min(100, Math.round((readings24h / expectedPerDay) * 100));
  const packetLoss         = 100 - packetSuccessRate;

  // f_cnt gap analysis: if max-min > readings count there are gaps
  const fcntSpan    = pkt.max_fcnt != null && pkt.min_fcnt != null ? parseInt(pkt.max_fcnt) - parseInt(pkt.min_fcnt) + 1 : null;
  const fcntLoss    = fcntSpan != null && fcntSpan > readings24h ? Math.round(((fcntSpan - readings24h) / fcntSpan) * 100) : 0;

  // ── Communication uptime ───────────────────────────────────────────────────────
  const readings7d      = parseInt(pkt.readings_7d || 0);
  const expectedWeek    = expectedPerDay * 7;
  const commUptimePct   = Math.min(100, Math.round((readings7d / expectedWeek) * 100));

  // ── Last communication ────────────────────────────────────────────────────────
  const lastSeen = meter.last_seen ? new Date(meter.last_seen) : null;
  const minutesSinceSeen = lastSeen ? (Date.now() - lastSeen.getTime()) / 60000 : null;

  // ── Overall health score ───────────────────────────────────────────────────────
  // Weights: signal 35%, connectivity 35%, battery 20%, temp 10%
  const battContrib = batteryPct != null ? batteryPct : 75;
  const rawScore    = (
    signalScore     * 0.35 +
    commUptimePct   * 0.35 +
    battContrib     * 0.20 +
    (meter.is_online ? 100 : 0) * 0.10
  );
  const overallScore = Math.max(0, Math.round(rawScore));

  return {
    meter_id:     meterId,
    device_eui:   meter.device_eui,
    meter_number: meter.meter_number,
    status:       scoreStatus(overallScore, meter.is_online),
    overall_score: overallScore,

    battery: {
      voltage:     latestBatt,
      health_pct:  batteryPct,
      trend:       batteryTrend,
    },

    signal: {
      avg_rssi_dbm:  avgRssi != null ? parseFloat(avgRssi.toFixed(1)) : null,
      avg_snr_db:    avgSnr  != null ? parseFloat(avgSnr.toFixed(1))  : null,
      min_rssi_dbm:  minRssi != null ? parseFloat(minRssi.toFixed(1)) : null,
      max_rssi_dbm:  maxRssi != null ? parseFloat(maxRssi.toFixed(1)) : null,
      score:         signalScore,
      rssi_trend:    rssiTrend,
      snr_trend:     snrTrend,
      history:       sigRows.slice(-24).map(r => ({
        hour:     r.hour,
        avg_rssi: parseFloat(parseFloat(r.avg_rssi).toFixed(1)),
        avg_snr:  r.avg_snr ? parseFloat(parseFloat(r.avg_snr).toFixed(1)) : null,
        count:    parseInt(r.reading_count),
      })),
    },

    connectivity: {
      readings_24h:       readings24h,
      expected_24h:       expectedPerDay,
      packet_success_pct: packetSuccessRate,
      packet_loss_pct:    packetLoss,
      fcnt_loss_pct:      fcntLoss,
      uptime_7d_pct:      commUptimePct,
      last_seen:          meter.last_seen,
      minutes_since_seen: minutesSinceSeen != null ? parseFloat(minutesSinceSeen.toFixed(1)) : null,
    },

    gateway: {
      last_gateway_eui:   gatewayR.rows[0]?.gateway_eui || null,
    },

    device: {
      firmware_version:   meter.firmware_version || null,
      temperature:        tempR.rows[0]?.temperature != null ? parseFloat(tempR.rows[0].temperature) : null,
      temperature_at:     tempR.rows[0]?.timestamp || null,
      valve_status:       meter.valve_status,
      pressure:           meter.pressure != null ? parseFloat(meter.pressure) : null,
    },
  };
}

/**
 * Returns a fleet-level health summary: count by status, avg score, alert list.
 */
// reading_mode='automatic' excludes manual/legacy meters — they have no
// radio at all, so without this filter every one of them would count as
// permanently "critical/offline" in fleet stats that are only meaningful
// for LoRaWAN devices.
async function getFleetHealth() {
  const r = await query(
    `SELECT
       COUNT(*) FILTER (WHERE is_online AND battery_voltage >= 3.2 AND rssi > -110) AS healthy,
       COUNT(*) FILTER (WHERE is_online AND (battery_voltage < 3.2 OR rssi <= -110)) AS warning,
       COUNT(*) FILTER (WHERE NOT is_online AND last_seen >= NOW() - INTERVAL '4 hours') AS critical,
       COUNT(*) FILTER (WHERE NOT is_online AND (last_seen < NOW() - INTERVAL '4 hours' OR last_seen IS NULL)) AS offline,
       COUNT(*) AS total,
       AVG(battery_voltage) FILTER (WHERE battery_voltage IS NOT NULL) AS avg_battery,
       AVG(rssi) FILTER (WHERE rssi IS NOT NULL AND is_online) AS avg_rssi
     FROM meters WHERE status = 'active' AND reading_mode = 'automatic'`
  );
  return r.rows[0];
}

module.exports = { getDeviceHealth, getFleetHealth };
