const { query } = require('../config/database');
const logger = require('./logger');

// Minimum AI confidence to open a leak event
const SCORE_THRESHOLD = 0.40;

// Severity bands by AI score
function scoreSeverity(score) {
  if (score >= 0.90) return 'critical';
  if (score >= 0.70) return 'high';
  if (score >= 0.50) return 'medium';
  return 'low';
}

/**
 * Run all 6 leak detection algorithms for a single meter and persist findings.
 * Called by the scheduler (hourly) and can be triggered from the API.
 */
async function detectLeaks(meterId) {
  const results = await Promise.allSettled([
    _checkContinuousFlow(meterId),
    _checkNightFlow(meterId),
    _checkAbnormalConsumption(meterId),
    _checkReverseFlow(meterId),
    _checkBurstPipe(meterId),
    _checkPressureDrop(meterId),
  ]);

  let opened = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) opened++;
    if (r.status === 'rejected') logger.warn(`Leak detection error [${meterId}]: ${r.reason?.message}`);
  }
  return opened;
}

/**
 * Run leak detection for every active meter.
 */
async function detectLeaksAllMeters() {
  const meters = await query(`SELECT id FROM meters WHERE status = 'active'`);
  let total = 0;
  for (const row of meters.rows) {
    total += await detectLeaks(row.id);
  }
  logger.info(`Leak detection: ${total} new event(s) across ${meters.rows.length} meters`);
  return total;
}

// ── 1. Continuous flow (≥4 h with every reading > 2 L/h) ─────────────────────
async function _checkContinuousFlow(meterId) {
  const r = await query(`
    SELECT
      COUNT(*)                AS cnt,
      MIN(current_flow)       AS min_flow,
      AVG(current_flow)       AS avg_flow,
      MIN(timestamp)          AS first_ts,
      MAX(timestamp)          AS last_ts
    FROM meter_readings
    WHERE meter_id = $1
      AND timestamp >= NOW() - INTERVAL '6 hours'
      AND current_flow IS NOT NULL
  `, [meterId]);

  const { cnt, min_flow, avg_flow, first_ts, last_ts } = r.rows[0];
  if (parseInt(cnt) < 6) return false;
  if (parseFloat(min_flow) <= 2) return false;

  const durationH = (new Date(last_ts) - new Date(first_ts)) / 3600000;
  if (durationH < 4) return false;

  const score = Math.min(0.95, 0.50 + (durationH / 24) * 0.45);
  return _openEvent(meterId, 'continuous_flow', score, {
    avg_flow_lpm: parseFloat(parseFloat(avg_flow).toFixed(2)),
    min_flow_lpm: parseFloat(parseFloat(min_flow).toFixed(2)),
    duration_hours: parseFloat(durationH.toFixed(1)),
    reading_count: parseInt(cnt),
    window_start: first_ts,
    window_end:   last_ts,
  }, `Continuous flow detected: avg ${parseFloat(avg_flow).toFixed(1)} L/h for ${durationH.toFixed(1)} hours with no interruption.`);
}

// ── 2. Night flow (01:00-04:00 UTC, avg > 5 L/h, ≥3 readings) ───────────────
async function _checkNightFlow(meterId) {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10);

  const r = await query(`
    SELECT
      COUNT(*)          AS cnt,
      AVG(current_flow) AS avg_flow,
      MAX(current_flow) AS max_flow
    FROM meter_readings
    WHERE meter_id = $1
      AND DATE(timestamp AT TIME ZONE 'UTC') = $2::date
      AND EXTRACT(HOUR FROM timestamp AT TIME ZONE 'UTC') BETWEEN 1 AND 4
      AND current_flow IS NOT NULL
  `, [meterId, dateStr]);

  const { cnt, avg_flow, max_flow } = r.rows[0];
  if (parseInt(cnt) < 3) return false;
  if (parseFloat(avg_flow) <= 5) return false;

  // Don't open a duplicate event for the same night
  const dup = await query(`
    SELECT id FROM leak_events
    WHERE meter_id = $1
      AND detection_type = 'night_flow'
      AND status = 'active'
      AND detected_at >= NOW() - INTERVAL '30 hours'
    LIMIT 1
  `, [meterId]);
  if (dup.rows.length > 0) return false;

  const score = Math.min(0.90, 0.45 + (parseFloat(avg_flow) / 50) * 0.45);
  return _openEvent(meterId, 'night_flow', score, {
    date: dateStr,
    avg_night_flow_lpm: parseFloat(parseFloat(avg_flow).toFixed(2)),
    max_night_flow_lpm: parseFloat(parseFloat(max_flow).toFixed(2)),
    reading_count: parseInt(cnt),
  }, `Night-time flow on ${dateStr}: avg ${parseFloat(avg_flow).toFixed(1)} L/h between 01:00-04:00 UTC.`);
}

// ── 3. Abnormal consumption (>3σ above 7-day mean) ───────────────────────────
async function _checkAbnormalConsumption(meterId) {
  const r = await query(`
    SELECT
      AVG(consumption_m3)    AS mean,
      STDDEV(consumption_m3) AS stddev,
      MAX(date)              AS latest_date
    FROM meter_consumption_daily
    WHERE meter_id = $1
      AND date BETWEEN CURRENT_DATE - INTERVAL '7 days' AND CURRENT_DATE - INTERVAL '1 day'
  `, [meterId]);

  if (!r.rows[0].mean) return false;

  const mean   = parseFloat(r.rows[0].mean);
  const stddev = parseFloat(r.rows[0].stddev || 0);
  if (mean <= 0 || stddev <= 0) return false;

  const today = await query(`
    SELECT consumption_m3 FROM meter_consumption_daily
    WHERE meter_id = $1 AND date = CURRENT_DATE - INTERVAL '1 day'
  `, [meterId]);

  if (!today.rows.length) return false;
  const todayVal = parseFloat(today.rows[0].consumption_m3);
  const zScore   = (todayVal - mean) / stddev;
  if (zScore <= 3) return false;

  const score = Math.min(0.92, 0.50 + (zScore - 3) * 0.07);
  return _openEvent(meterId, 'abnormal_consumption', score, {
    yesterday_m3: parseFloat(todayVal.toFixed(3)),
    week_mean_m3: parseFloat(mean.toFixed(3)),
    week_stddev_m3: parseFloat(stddev.toFixed(3)),
    z_score: parseFloat(zScore.toFixed(2)),
  }, `Consumption ${todayVal.toFixed(2)} m³ is ${zScore.toFixed(1)}σ above 7-day mean (${mean.toFixed(2)} m³).`);
}

// ── 4. Reverse flow (negative current_flow in readings) ──────────────────────
async function _checkReverseFlow(meterId) {
  const r = await query(`
    SELECT COUNT(*) AS cnt, MIN(current_flow) AS min_flow
    FROM meter_readings
    WHERE meter_id = $1
      AND timestamp >= NOW() - INTERVAL '2 hours'
      AND current_flow < -0.5
  `, [meterId]);

  if (parseInt(r.rows[0].cnt) < 2) return false;

  const dup = await query(`
    SELECT id FROM leak_events
    WHERE meter_id = $1 AND detection_type = 'reverse_flow'
      AND status = 'active' AND detected_at >= NOW() - INTERVAL '4 hours'
    LIMIT 1
  `, [meterId]);
  if (dup.rows.length > 0) return false;

  const score = 0.85;
  return _openEvent(meterId, 'reverse_flow', score, {
    reverse_count: parseInt(r.rows[0].cnt),
    min_flow_lpm: parseFloat(parseFloat(r.rows[0].min_flow).toFixed(2)),
  }, `Reverse flow detected: ${r.rows[0].cnt} readings with negative flow in last 2 hours.`);
}

// ── 5. Burst pipe (flow spike > 10× 24h average) ─────────────────────────────
async function _checkBurstPipe(meterId) {
  const baseline = await query(`
    SELECT AVG(current_flow) AS avg_flow
    FROM meter_readings
    WHERE meter_id = $1
      AND timestamp BETWEEN NOW() - INTERVAL '24 hours' AND NOW() - INTERVAL '1 hour'
      AND current_flow > 0
  `, [meterId]);

  const baseAvg = parseFloat(baseline.rows[0].avg_flow || 0);
  if (baseAvg <= 0) return false;

  const recent = await query(`
    SELECT MAX(current_flow) AS max_flow, COUNT(*) AS cnt
    FROM meter_readings
    WHERE meter_id = $1
      AND timestamp >= NOW() - INTERVAL '30 minutes'
      AND current_flow IS NOT NULL
  `, [meterId]);

  const maxFlow = parseFloat(recent.rows[0].max_flow || 0);
  if (maxFlow < baseAvg * 10) return false;

  const ratio = maxFlow / baseAvg;
  const score = Math.min(0.97, 0.70 + (ratio / 100) * 0.27);
  return _openEvent(meterId, 'burst_pipe', score, {
    spike_flow_lpm:   parseFloat(maxFlow.toFixed(2)),
    baseline_lpm:     parseFloat(baseAvg.toFixed(2)),
    ratio:            parseFloat(ratio.toFixed(1)),
    reading_count:    parseInt(recent.rows[0].cnt),
  }, `Flow spike: ${maxFlow.toFixed(1)} L/h is ${ratio.toFixed(0)}× the 24-hour baseline (${baseAvg.toFixed(1)} L/h).`);
}

// ── 6. Pressure drop (≥ 20% drop in last 30 minutes) ─────────────────────────
async function _checkPressureDrop(meterId) {
  const r = await query(`
    SELECT
      AVG(pressure) FILTER (WHERE timestamp < NOW() - INTERVAL '30 minutes') AS prev_pressure,
      AVG(pressure) FILTER (WHERE timestamp >= NOW() - INTERVAL '30 minutes') AS curr_pressure,
      COUNT(*) FILTER (WHERE pressure IS NOT NULL) AS total_cnt
    FROM meter_readings
    WHERE meter_id = $1 AND timestamp >= NOW() - INTERVAL '90 minutes'
  `, [meterId]);

  const prev = parseFloat(r.rows[0].prev_pressure || 0);
  const curr = parseFloat(r.rows[0].curr_pressure || 0);
  if (prev <= 0 || curr <= 0 || parseInt(r.rows[0].total_cnt) < 4) return false;

  const drop = (prev - curr) / prev;
  if (drop < 0.20) return false;

  const dup = await query(`
    SELECT id FROM leak_events
    WHERE meter_id = $1 AND detection_type = 'pressure_drop'
      AND status = 'active' AND detected_at >= NOW() - INTERVAL '2 hours'
    LIMIT 1
  `, [meterId]);
  if (dup.rows.length > 0) return false;

  const score = Math.min(0.88, 0.55 + drop * 0.33);
  return _openEvent(meterId, 'pressure_drop', score, {
    prev_pressure_bar: parseFloat(prev.toFixed(2)),
    curr_pressure_bar: parseFloat(curr.toFixed(2)),
    drop_percent:      parseFloat((drop * 100).toFixed(1)),
  }, `Pressure drop: ${(drop * 100).toFixed(0)}% decrease (${prev.toFixed(2)} → ${curr.toFixed(2)} bar) in 30 minutes.`);
}

// ── Persist a new leak event ──────────────────────────────────────────────────
async function _openEvent(meterId, type, score, evidence, analysis) {
  if (score < SCORE_THRESHOLD) return false;

  try {
    await query(`
      INSERT INTO leak_events
        (meter_id, detection_type, severity, ai_score, ai_analysis, evidence)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [meterId, type, scoreSeverity(score), parseFloat(score.toFixed(3)), analysis, JSON.stringify(evidence)]);
    logger.info(`Leak event opened [${type}] meter=${meterId} score=${score.toFixed(2)}`);
    return true;
  } catch (err) {
    logger.error(`Failed to open leak event [${type}] ${meterId}: ${err.message}`);
    return false;
  }
}

/**
 * GET /api/meters/:id/leaks  — list leak events for a meter
 */
async function getLeakEvents(meterId, { status, limit = 50, offset = 0 } = {}) {
  const params = [meterId, parseInt(limit), parseInt(offset)];
  let where = 'WHERE meter_id = $1';
  if (status) {
    where += ` AND status = $${params.length + 1}`;
    params.push(status);
  }

  const r = await query(`
    SELECT
      le.*,
      u.full_name AS resolved_by_name
    FROM leak_events le
    LEFT JOIN users u ON u.id = le.resolved_by
    ${where}
    ORDER BY detected_at DESC
    LIMIT $2 OFFSET $3
  `, params);

  const cnt = await query(
    `SELECT COUNT(*) FROM leak_events ${where}`,
    params.slice(0, params.length - 2)
  );

  return {
    data: r.rows,
    total: parseInt(cnt.rows[0].count),
    limit: parseInt(limit),
    offset: parseInt(offset),
  };
}

/**
 * PATCH /api/meters/:id/leaks/:leakId — resolve or mark false positive
 */
async function updateLeakEvent(leakId, { status, notes, resolvedBy }) {
  const allowed = ['resolved', 'false_positive'];
  if (!allowed.includes(status)) throw new Error(`Invalid status: ${status}`);

  const r = await query(`
    UPDATE leak_events
    SET status = $1, notes = COALESCE($2, notes),
        resolved_by = $3, resolved_at = NOW(), updated_at = NOW()
    WHERE id = $4
    RETURNING *
  `, [status, notes || null, resolvedBy || null, leakId]);

  if (!r.rows.length) throw new Error('Leak event not found');
  return r.rows[0];
}

module.exports = {
  detectLeaks,
  detectLeaksAllMeters,
  getLeakEvents,
  updateLeakEvent,
};
