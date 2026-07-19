const { query } = require('../config/database');
const logger = require('./logger');

/**
 * Aggregate daily consumption from raw meter_readings into meter_consumption_daily.
 * Uses MAX(total_consumption) - MIN(total_consumption) per calendar day (cumulative
 * odometer model). A negative result (meter replacement / rollover) is stored as 0.
 */
async function aggregateDailyConsumption(meterId, targetDate) {
  const dateStr = targetDate instanceof Date
    ? targetDate.toISOString().slice(0, 10)
    : targetDate;

  const sql = `
    WITH day_readings AS (
      SELECT
        total_consumption,
        current_flow,
        timestamp
      FROM meter_readings
      WHERE meter_id = $1
        AND DATE(timestamp AT TIME ZONE 'UTC') = $2::date
        AND total_consumption IS NOT NULL
    ),
    night_readings AS (
      SELECT AVG(current_flow) AS avg, COUNT(*) AS cnt
      FROM meter_readings
      WHERE meter_id = $1
        AND DATE(timestamp AT TIME ZONE 'UTC') = $2::date
        AND EXTRACT(HOUR FROM timestamp AT TIME ZONE 'UTC') BETWEEN 1 AND 4
        AND current_flow IS NOT NULL
    )
    INSERT INTO meter_consumption_daily
      (meter_id, date, consumption_m3, avg_flow_lpm, peak_flow_lpm,
       min_reading_m3, max_reading_m3, reading_count,
       night_flow_avg_lpm, night_flow_duration, updated_at)
    SELECT
      $1,
      $2::date,
      GREATEST(0, MAX(d.total_consumption) - MIN(d.total_consumption)),
      AVG(d.current_flow),
      MAX(d.current_flow),
      MIN(d.total_consumption),
      MAX(d.total_consumption),
      COUNT(*),
      n.avg,
      n.cnt,
      NOW()
    FROM day_readings d, night_readings n
    WHERE COUNT(*) OVER () > 0
    GROUP BY n.avg, n.cnt
    ON CONFLICT (meter_id, date) DO UPDATE SET
      consumption_m3     = EXCLUDED.consumption_m3,
      avg_flow_lpm       = EXCLUDED.avg_flow_lpm,
      peak_flow_lpm      = EXCLUDED.peak_flow_lpm,
      min_reading_m3     = EXCLUDED.min_reading_m3,
      max_reading_m3     = EXCLUDED.max_reading_m3,
      reading_count      = EXCLUDED.reading_count,
      night_flow_avg_lpm = EXCLUDED.night_flow_avg_lpm,
      night_flow_duration= EXCLUDED.night_flow_duration,
      updated_at         = NOW()
    RETURNING id
  `;

  try {
    const r = await query(sql, [meterId, dateStr]);
    return r.rowCount > 0;
  } catch (err) {
    logger.error(`aggregateDailyConsumption error [${meterId} ${dateStr}]: ${err.message}`);
    return false;
  }
}

/**
 * Aggregate yesterday's consumption for ALL active meters.
 * Called by the nightly cron.
 */
async function aggregateYesterdayForAllMeters() {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10);

  const meters = await query(
    `SELECT id FROM meters WHERE status = 'active'`
  );

  let ok = 0, skipped = 0;
  for (const row of meters.rows) {
    const inserted = await aggregateDailyConsumption(row.id, dateStr);
    inserted ? ok++ : skipped++;
  }
  logger.info(`Daily consumption aggregation: ${ok} meters written, ${skipped} skipped (no readings)`);
  return { ok, skipped, date: dateStr };
}

/**
 * GET /api/meters/:id/consumption
 *
 * Returns time-series consumption data plus summary stats.
 * period: 'daily' | 'weekly' | 'monthly' | 'yearly'
 * from / to: ISO date strings
 */
async function getConsumption(meterId, { period = 'daily', from, to }) {
  const toDate   = to   ? new Date(to)   : new Date();
  const fromDate = from ? new Date(from) : _defaultFrom(period, toDate);

  const fromStr = fromDate.toISOString().slice(0, 10);
  const toStr   = toDate.toISOString().slice(0, 10);

  let sql, groupClause;
  if (period === 'daily') {
    sql = `
      SELECT
        date::text                          AS period,
        consumption_m3,
        avg_flow_lpm,
        peak_flow_lpm,
        night_flow_avg_lpm,
        reading_count
      FROM meter_consumption_daily
      WHERE meter_id = $1 AND date BETWEEN $2::date AND $3::date
      ORDER BY date
    `;
  } else if (period === 'weekly') {
    sql = `
      SELECT
        TO_CHAR(DATE_TRUNC('week', date), 'IYYY-"W"IW') AS period,
        SUM(consumption_m3)                              AS consumption_m3,
        AVG(avg_flow_lpm)                                AS avg_flow_lpm,
        MAX(peak_flow_lpm)                               AS peak_flow_lpm,
        AVG(night_flow_avg_lpm)                          AS night_flow_avg_lpm,
        SUM(reading_count)                               AS reading_count
      FROM meter_consumption_daily
      WHERE meter_id = $1 AND date BETWEEN $2::date AND $3::date
      GROUP BY DATE_TRUNC('week', date)
      ORDER BY DATE_TRUNC('week', date)
    `;
  } else if (period === 'monthly') {
    sql = `
      SELECT
        TO_CHAR(DATE_TRUNC('month', date), 'YYYY-MM') AS period,
        SUM(consumption_m3)                           AS consumption_m3,
        AVG(avg_flow_lpm)                             AS avg_flow_lpm,
        MAX(peak_flow_lpm)                            AS peak_flow_lpm,
        AVG(night_flow_avg_lpm)                       AS night_flow_avg_lpm,
        SUM(reading_count)                            AS reading_count
      FROM meter_consumption_daily
      WHERE meter_id = $1 AND date BETWEEN $2::date AND $3::date
      GROUP BY DATE_TRUNC('month', date)
      ORDER BY DATE_TRUNC('month', date)
    `;
  } else {
    // yearly
    sql = `
      SELECT
        EXTRACT(YEAR FROM date)::text AS period,
        SUM(consumption_m3)          AS consumption_m3,
        AVG(avg_flow_lpm)            AS avg_flow_lpm,
        MAX(peak_flow_lpm)           AS peak_flow_lpm,
        AVG(night_flow_avg_lpm)      AS night_flow_avg_lpm,
        SUM(reading_count)           AS reading_count
      FROM meter_consumption_daily
      WHERE meter_id = $1 AND date BETWEEN $2::date AND $3::date
      GROUP BY EXTRACT(YEAR FROM date)
      ORDER BY EXTRACT(YEAR FROM date)
    `;
  }

  const rows = (await query(sql, [meterId, fromStr, toStr])).rows;

  const total = rows.reduce((s, r) => s + parseFloat(r.consumption_m3 || 0), 0);
  const count = rows.length;

  const peak   = rows.reduce((best, r) => (!best || parseFloat(r.consumption_m3) > parseFloat(best.consumption_m3)) ? r : best, null);
  const lowest = rows.reduce((best, r) => (!best || parseFloat(r.consumption_m3) < parseFloat(best.consumption_m3)) ? r : best, null);

  const trend = _calcTrend(rows.map(r => parseFloat(r.consumption_m3 || 0)));

  return {
    period,
    from: fromStr,
    to: toStr,
    total_consumption_m3: parseFloat(total.toFixed(3)),
    average_per_period_m3: count ? parseFloat((total / count).toFixed(3)) : 0,
    peak_period:   peak   ? { period: peak.period,   consumption_m3: parseFloat(peak.consumption_m3) }   : null,
    lowest_period: lowest ? { period: lowest.period, consumption_m3: parseFloat(lowest.consumption_m3) } : null,
    trend,
    data: rows.map(r => ({
      period:            r.period,
      consumption_m3:    parseFloat(r.consumption_m3 || 0),
      avg_flow_lpm:      r.avg_flow_lpm    != null ? parseFloat(r.avg_flow_lpm)    : null,
      peak_flow_lpm:     r.peak_flow_lpm   != null ? parseFloat(r.peak_flow_lpm)   : null,
      night_flow_lpm:    r.night_flow_avg_lpm != null ? parseFloat(r.night_flow_avg_lpm) : null,
      reading_count:     parseInt(r.reading_count || 0),
    })),
  };
}

/**
 * GET /api/meters/:id/consumption/billing-period
 * Returns consumption for the current (or previous) billing period
 * aligned to calendar months with comparison to prior period.
 */
async function getBillingPeriodConsumption(meterId, { current = true } = {}) {
  const now = new Date();
  let periodStart, periodEnd, prevStart, prevEnd;

  if (current) {
    periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    periodEnd   = now;
    prevStart   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    prevEnd     = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  } else {
    periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    periodEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    prevStart   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
    prevEnd     = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 0));
  }

  const fmt = d => d.toISOString().slice(0, 10);

  const sumSql = `
    SELECT
      COALESCE(SUM(consumption_m3), 0) AS total,
      AVG(avg_flow_lpm)                AS avg_flow,
      MAX(peak_flow_lpm)               AS peak_flow,
      COUNT(*)                         AS days
    FROM meter_consumption_daily
    WHERE meter_id = $1 AND date BETWEEN $2::date AND $3::date
  `;

  const [curr, prev] = await Promise.all([
    query(sumSql, [meterId, fmt(periodStart), fmt(periodEnd)]),
    query(sumSql, [meterId, fmt(prevStart),   fmt(prevEnd)]),
  ]);

  const currTotal = parseFloat(curr.rows[0].total);
  const prevTotal = parseFloat(prev.rows[0].total);
  const days      = parseInt(curr.rows[0].days) || 1;
  const daysInMonth = _daysInMonth(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1);

  const dailyAvg  = currTotal / days;
  const projected = dailyAvg * daysInMonth;

  const changePct = prevTotal > 0
    ? parseFloat(((currTotal - prevTotal) / prevTotal * 100).toFixed(1))
    : null;

  return {
    billing_period_start:    fmt(periodStart),
    billing_period_end:      fmt(periodEnd),
    consumption_m3:          parseFloat(currTotal.toFixed(3)),
    previous_period_m3:      parseFloat(prevTotal.toFixed(3)),
    change_percent:          changePct,
    daily_average_m3:        parseFloat(dailyAvg.toFixed(3)),
    avg_flow_lpm:            curr.rows[0].avg_flow != null ? parseFloat(parseFloat(curr.rows[0].avg_flow).toFixed(3)) : null,
    peak_flow_lpm:           curr.rows[0].peak_flow != null ? parseFloat(parseFloat(curr.rows[0].peak_flow).toFixed(3)) : null,
    projected_month_total_m3: parseFloat(projected.toFixed(3)),
  };
}

function _defaultFrom(period, toDate) {
  const d = new Date(toDate);
  if (period === 'daily')   d.setUTCDate(d.getUTCDate() - 30);
  if (period === 'weekly')  d.setUTCDate(d.getUTCDate() - 90);
  if (period === 'monthly') d.setUTCMonth(d.getUTCMonth() - 12);
  if (period === 'yearly')  d.setUTCFullYear(d.getUTCFullYear() - 5);
  return d;
}

function _calcTrend(values) {
  if (values.length < 3) return 'insufficient_data';
  const half = Math.floor(values.length / 2);
  const first = values.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const last  = values.slice(-half).reduce((a, b) => a + b, 0) / half;
  const delta = last - first;
  if (Math.abs(delta) < 0.05 * first) return 'stable';
  return delta > 0 ? 'increasing' : 'decreasing';
}

function _daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

module.exports = {
  aggregateDailyConsumption,
  aggregateYesterdayForAllMeters,
  getConsumption,
  getBillingPeriodConsumption,
};
