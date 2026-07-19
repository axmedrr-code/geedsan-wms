'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runMonthlyAutoBilling, previewMonthlyBilling } = require('../src/services/billingService');

// ── Helpers ───────────────────────────────────────────────────────────────────

const CUST_1 = { id: 'cust-uuid-001', customer_number: 'C001', full_name: 'Ahmed Ali',    customer_tariff_type: 'residential' };
const CUST_2 = { id: 'cust-uuid-002', customer_number: 'C002', full_name: 'Fadumo Omar', customer_tariff_type: 'commercial' };

const makeCycle  = (customerId, amount = 148.15) => ({ id: `cycle-${customerId}`, customer_id: customerId, amount });
const makeInvoice = (num) => ({ id: `inv-${num}`, invoice_number: num });

// SQL-pattern query mock.  handlers is an array of [substring, value|fn] pairs;
// first match wins.  Unmatched SQL returns { rows: [] }.
const makeQuery = (...handlers) => {
  const ops = [];
  return Object.assign(
    async (sql, params) => {
      ops.push({ sql, params });
      for (const [pat, result] of handlers) {
        if (sql.includes(pat)) {
          return typeof result === 'function' ? result(sql, params) : result;
        }
      }
      return { rows: [] };
    },
    { ops }
  );
};

// Shorthand mocks for _createCycle and _postCycleInvoice.
const mockCreateCycle = (amountOverride = null) => {
  const calls = [];
  return Object.assign(
    async (customerId, type, start, end, due, by, notes, amount) => {
      calls.push({ customerId, amount });
      return makeCycle(customerId, amountOverride !== null ? amountOverride : amount);
    },
    { calls }
  );
};

const mockPostInvoice = () => {
  const calls = [];
  return Object.assign(
    async (cycleId, invoiceNumber, note, userId) => {
      calls.push({ cycleId, invoiceNumber });
      return makeInvoice(invoiceNumber);
    },
    { calls }
  );
};

// Standard query mock for a run over the given customers list.
// idempotencyMap: { [customerId]: true } → pretend billing cycle already exists
const makeRunQuery = (customers, { idempotencyMap = {}, runId = 1 } = {}) =>
  makeQuery(
    ['INSERT INTO billing_runs',   { rows: [{ id: runId }] }],
    ['SELECT DISTINCT c.id, c.customer_number', { rows: customers }],
    ['FROM billing_cycles bc\n       LEFT JOIN invoices', (sql, params) => ({
      rows: idempotencyMap[params[0]] ? [{ id: 'existing-cycle', invoice_number: 'OLD-INV' }] : [],
    })],
    ['INSERT INTO billing_run_items', { rows: [] }],
    ['UPDATE billing_runs SET status',  { rows: [] }]
  );

// ── runMonthlyAutoBilling tests ───────────────────────────────────────────────

describe('runMonthlyAutoBilling', () => {

  // ── Happy path: all customers billed ────────────────────────────────────────
  test('two active customers with valid readings — both billed, status=completed', async () => {
    const q = makeRunQuery([CUST_1, CUST_2]);
    const createCycle  = mockCreateCycle();
    const postInvoice  = mockPostInvoice();

    const result = await runMonthlyAutoBilling(
      {},
      {
        _query:            q,
        _calculateUsage:   async () => 148.15,
        _createCycle:      createCycle,
        _postCycleInvoice: postInvoice,
      }
    );

    assert.equal(result.total,   2);
    assert.equal(result.ok,      2);
    assert.equal(result.skipped, 0);
    assert.equal(result.failed,  0);
    assert.equal(result.status,  'completed');
    assert.equal(createCycle.calls.length,  2, '_createCycle must be called once per customer');
    assert.equal(postInvoice.calls.length,  2, '_postCycleInvoice must be called once per customer');

    // billing_run_items rows must have been inserted (status is SQL literal, not a param)
    const itemInserts = q.ops.filter(o => o.sql.includes('INSERT INTO billing_run_items'));
    assert.equal(itemInserts.length, 2);
    assert.ok(itemInserts[0].sql.includes("'success'"), 'success status must appear in SQL');
  });

  // ── Idempotency: already billed this month ───────────────────────────────────
  test('customer already has billing cycle for period — skipped, no invoice created', async () => {
    const q = makeRunQuery([CUST_1], { idempotencyMap: { 'cust-uuid-001': true } });
    const createCycle = mockCreateCycle();
    const postInvoice = mockPostInvoice();

    const result = await runMonthlyAutoBilling(
      {},
      { _query: q, _calculateUsage: async () => 148.15, _createCycle: createCycle, _postCycleInvoice: postInvoice }
    );

    assert.equal(result.ok,      0);
    assert.equal(result.skipped, 1);
    assert.equal(result.status,  'completed');
    assert.equal(createCycle.calls.length, 0, '_createCycle must NOT be called for a skipped customer');
  });

  // ── Zero consumption (missing / flat reading) ────────────────────────────────
  test('calculateUsage returns 0 — customer skipped, no invoice, item logged as skipped', async () => {
    const q = makeRunQuery([CUST_1]);
    const createCycle = mockCreateCycle();

    const result = await runMonthlyAutoBilling(
      {},
      { _query: q, _calculateUsage: async () => 0, _createCycle: createCycle, _postCycleInvoice: mockPostInvoice() }
    );

    assert.equal(result.skipped, 1);
    assert.equal(result.ok,      0);
    assert.equal(createCycle.calls.length, 0, 'must not create a $0 billing cycle');

    const skipItem = q.ops.find(o => o.sql.includes('INSERT INTO billing_run_items') && o.sql.includes('Zero consumption for period'));
    assert.ok(skipItem, 'zero-consumption skip reason must be recorded in billing_run_items');
  });

  // ── Negative consumption (clamped by calculateUsageAmount → same as 0) ───────
  test('usage calculation that returns negative-clamped 0 is treated as zero consumption', async () => {
    // calculateUsageAmount uses Math.max(0, ...) so it returns 0 for reversed meters.
    // The engine must skip $0 invoices regardless of why amount is 0.
    const q = makeRunQuery([CUST_1]);

    const result = await runMonthlyAutoBilling(
      {},
      { _query: q, _calculateUsage: async () => 0, _createCycle: mockCreateCycle(), _postCycleInvoice: mockPostInvoice() }
    );

    assert.equal(result.skipped, 1);
    assert.equal(result.ok,      0);
  });

  // ── Missing reading (calculateUsage throws) ──────────────────────────────────
  test('usage calculation throws (missing reading / meter error) — customer logged as failed', async () => {
    const q = makeRunQuery([CUST_1]);

    const result = await runMonthlyAutoBilling(
      {},
      {
        _query:           q,
        _calculateUsage:  async () => { throw new Error('No readings found for meter'); },
        _createCycle:     mockCreateCycle(),
        _postCycleInvoice: mockPostInvoice(),
      }
    );

    assert.equal(result.failed,  1);
    assert.equal(result.ok,      0);
    assert.equal(result.status,  'failed');

    const failItem = q.ops.find(o => o.sql.includes("'failed'") && o.params.includes('No readings found for meter'));
    assert.ok(failItem, 'error message must be stored in billing_run_items');
  });

  // ── Partial failure ──────────────────────────────────────────────────────────
  test('one customer succeeds, one fails — status=partial, counts correct', async () => {
    const q = makeRunQuery([CUST_1, CUST_2]);

    let callCount = 0;
    const unstableUsage = async () => {
      callCount++;
      if (callCount === 2) throw new Error('DB timeout');
      return 100;
    };

    const result = await runMonthlyAutoBilling(
      {},
      { _query: q, _calculateUsage: unstableUsage, _createCycle: mockCreateCycle(), _postCycleInvoice: mockPostInvoice() }
    );

    assert.equal(result.ok,     1);
    assert.equal(result.failed, 1);
    assert.equal(result.status, 'partial');
  });

  // ── All fail ─────────────────────────────────────────────────────────────────
  test('all customers fail — status=failed', async () => {
    const q = makeRunQuery([CUST_1, CUST_2]);

    const result = await runMonthlyAutoBilling(
      {},
      {
        _query:            q,
        _calculateUsage:   async () => { throw new Error('Meter error'); },
        _createCycle:      mockCreateCycle(),
        _postCycleInvoice: mockPostInvoice(),
      }
    );

    assert.equal(result.ok,     0);
    assert.equal(result.failed, 2);
    assert.equal(result.status, 'failed');
  });

  // ── No active customers ──────────────────────────────────────────────────────
  test('no active customers returned — run completes immediately with 0 counts', async () => {
    const q = makeRunQuery([]);

    const result = await runMonthlyAutoBilling(
      {},
      { _query: q, _calculateUsage: async () => 0, _createCycle: mockCreateCycle(), _postCycleInvoice: mockPostInvoice() }
    );

    assert.equal(result.total,  0);
    assert.equal(result.ok,     0);
    assert.equal(result.status, 'completed');
  });

  // ── Custom period ─────────────────────────────────────────────────────────────
  test('opts.periodStart / periodEnd override the default previous-month computation', async () => {
    const q = makeRunQuery([CUST_1]);
    const createCycle = mockCreateCycle();

    await runMonthlyAutoBilling(
      { periodStart: '2026-01-01', periodEnd: '2026-01-31', triggeredBy: 'manual' },
      { _query: q, _calculateUsage: async () => 50, _createCycle: createCycle, _postCycleInvoice: mockPostInvoice() }
    );

    // billing_runs INSERT must have the custom period
    const runInsert = q.ops.find(o => o.sql.includes('INSERT INTO billing_runs'));
    assert.ok(runInsert.params.includes('2026-01-01'), 'period_start must match opts');
    assert.ok(runInsert.params.includes('2026-01-31'), 'period_end must match opts');
    assert.ok(runInsert.params.includes('manual'),     'triggered_by must match opts');
  });

  // ── Retry implicit: failed customer retried on next run ──────────────────────
  test('failed customer has no billing_cycle — next run retries automatically', async () => {
    // First run: usage calculation throws → customer fails, no cycle created.
    const q1 = makeRunQuery([CUST_1]);
    const result1 = await runMonthlyAutoBilling(
      {},
      { _query: q1, _calculateUsage: async () => { throw new Error('timeout'); }, _createCycle: mockCreateCycle(), _postCycleInvoice: mockPostInvoice() }
    );
    assert.equal(result1.failed, 1);

    // Second run (retry): idempotency check finds no cycle (it was never created)
    // → customer is re-processed and now succeeds.
    const q2 = makeRunQuery([CUST_1]);
    const createCycle = mockCreateCycle();
    const result2 = await runMonthlyAutoBilling(
      {},
      { _query: q2, _calculateUsage: async () => 120, _createCycle: createCycle, _postCycleInvoice: mockPostInvoice() }
    );
    assert.equal(result2.ok, 1, 'customer must succeed on the retry run');
    assert.equal(createCycle.calls.length, 1, '_createCycle must be called on the retry');
  });

  // ── billing_run_items carry billing_period_start/end ────────────────────────
  test('billing_run_items are inserted with billing_period_start and billing_period_end', async () => {
    const q = makeRunQuery([CUST_1]);
    await runMonthlyAutoBilling(
      { periodStart: '2026-05-01', periodEnd: '2026-05-31' },
      { _query: q, _calculateUsage: async () => 80, _createCycle: mockCreateCycle(), _postCycleInvoice: mockPostInvoice() }
    );

    const itemInsert = q.ops.find(o => o.sql.includes('INSERT INTO billing_run_items') && o.sql.includes("'success'"));
    assert.ok(itemInsert, 'a success item must be inserted');
    assert.ok(itemInsert.params.includes('2026-05-01'), 'billing_period_start must be in item row');
    assert.ok(itemInsert.params.includes('2026-05-31'), 'billing_period_end must be in item row');
  });
});

// ── previewMonthlyBilling tests ───────────────────────────────────────────────

// Builds a _query mock for previewMonthlyBilling.
// alreadyBilled: customer IDs whose billing cycle already exists.
// meterRows: per-customer meter list (defaults to one residential meter).
// currentConsumption / previousConsumption: totals returned for readings queries.
const makePreviewQuery = (customers, {
  alreadyBilled        = {},
  meterRows            = {},
  currentConsumption   = 200,
  previousConsumption  = 50,
} = {}) => {
  const defaultMeter = { id: 'meter-001', meter_number: 'MET001' };
  const ops = [];
  return Object.assign(
    async (sql, params) => {
      ops.push({ sql, params });
      if (sql.includes('SELECT DISTINCT c.id, c.customer_number, c.full_name, c.tariff_type'))
        return { rows: customers };
      if (sql.includes('FROM billing_cycles bc'))
        return { rows: alreadyBilled[params[0]] ? [{ id: 'existing-cycle' }] : [] };
      if (sql.includes('FROM meters'))
        return { rows: meterRows[params[0]] || [defaultMeter] };
      if (sql.includes('FROM meter_readings') && sql.includes('::date <='))
        return { rows: [{ total_consumption: String(currentConsumption), timestamp: '2026-06-30T12:00:00Z' }] };
      if (sql.includes('FROM meter_readings') && sql.includes('::date <'))
        return { rows: previousConsumption != null ? [{ total_consumption: String(previousConsumption), timestamp: '2026-05-31T12:00:00Z' }] : [] };
      return { rows: [] };
    },
    { ops }
  );
};

describe('previewMonthlyBilling', () => {

  // ── Billable customers shown with per-meter detail ───────────────────────────
  test('two active customers — both shown as billable with estimatedAmount and meter detail', async () => {
    const q = makePreviewQuery([CUST_1, CUST_2]);

    const result = await previewMonthlyBilling({}, { _query: q });

    assert.equal(result.totalCustomers, 2);
    assert.equal(result.willBill,       2);
    assert.equal(result.willSkip,       0);
    assert.equal(result.preview.length, 2);

    const c1 = result.preview[0];
    assert.equal(c1.wouldSkip,   false);
    assert.equal(c1.skipReason,  null);
    // consumption = 200 - 50 = 150 m³ × $1.2 (residential) = $180
    assert.equal(c1.estimatedAmount, 180);
    assert.equal(c1.meters.length, 1);
    assert.equal(c1.meters[0].previousReading, 50);
    assert.equal(c1.meters[0].currentReading,  200);
    assert.equal(c1.meters[0].consumption,     150);
    assert.equal(c1.meters[0].unitPrice,       1.2);
    assert.equal(c1.meters[0].tariff,          'residential');
    assert.ok(result.totalEstimatedRevenue > 0, 'total revenue must be positive');
  });

  // ── Already-billed customers shown as wouldSkip ──────────────────────────────
  test('customer with existing billing cycle — wouldSkip=true, estimatedAmount=null', async () => {
    const q = makePreviewQuery([CUST_1], { alreadyBilled: { 'cust-uuid-001': true } });

    const result = await previewMonthlyBilling({}, { _query: q });

    assert.equal(result.willSkip, 1);
    assert.equal(result.willBill, 0);
    const item = result.preview[0];
    assert.ok(item.wouldSkip,                              'must be flagged as wouldSkip');
    assert.ok(item.skipReason.includes('already exists'),  'skipReason must explain why');
    assert.equal(item.estimatedAmount, null);
    assert.deepEqual(item.meters, [],                      'meters array must be empty for skipped customer');
  });

  // ── Zero consumption previewed as skip ───────────────────────────────────────
  test('current reading equals previous reading — zero consumption, customer skipped', async () => {
    // current = previous = 200 → consumption = 0
    const q = makePreviewQuery([CUST_1], { currentConsumption: 200, previousConsumption: 200 });

    const result = await previewMonthlyBilling({}, { _query: q });

    const item = result.preview[0];
    assert.equal(item.wouldSkip, true);
    assert.ok(item.skipReason.includes('Zero consumption'));
    assert.equal(item.estimatedAmount, null);
    assert.equal(result.totalEstimatedRevenue, 0);
  });
});

// ── Scheduler registration ────────────────────────────────────────────────────

describe('scheduler', () => {
  test('monthly cron (0 2 1 * *) and runMonthlyAutoBilling are wired in scheduler.js', () => {
    const fs   = require('fs');
    const path = require('path');
    const src  = fs.readFileSync(path.join(__dirname, '../src/services/scheduler.js'), 'utf8');
    assert.ok(src.includes('0 2 1 * *'),            'monthly cron pattern must exist');
    assert.ok(src.includes('runMonthlyAutoBilling'), 'scheduler must reference runMonthlyAutoBilling');
  });
});
