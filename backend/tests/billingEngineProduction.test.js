'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  getBillingSettings,
  updateBillingSettings,
  validateBillingPeriod,
  cancelBillingRun,
  runMonthlyAutoBilling,
} = require('../src/services/billingService');

// ── Mock helpers ──────────────────────────────────────────────────────────────

const makeQ = (...handlers) => {
  let call = 0;
  return async (sql, params = []) => {
    for (const [match, value] of handlers) {
      if (sql.includes(match)) {
        return { rows: typeof value === 'function' ? value(sql, params, call++) : (Array.isArray(value) ? value : [value]) };
      }
    }
    return { rows: [] };
  };
};

const noopAudit = async () => {};

// ── Settings ──────────────────────────────────────────────────────────────────

describe('getBillingSettings', () => {
  test('returns stored settings when row exists', async () => {
    const stored = { id: 1, billing_cycle: 'weekly', due_days: 30, default_tariff: 'commercial', currency: 'OMR', auto_post_invoice: false, auto_sync_odoo: true };
    const _query = makeQ(['SELECT * FROM billing_settings', [stored]]);
    const result = await getBillingSettings({ _query });
    assert.equal(result.billing_cycle, 'weekly');
    assert.equal(result.due_days, 30);
    assert.equal(result.currency, 'OMR');
  });

  test('returns defaults when table row is missing', async () => {
    const _query = makeQ(['SELECT * FROM billing_settings', []]);
    const result = await getBillingSettings({ _query });
    assert.equal(result.billing_cycle, 'monthly');
    assert.equal(result.due_days, 14);
    assert.equal(result.auto_post_invoice, true);
  });
});

describe('updateBillingSettings', () => {
  test('persists new settings and records audit', async () => {
    const saved = { id: 1, billing_cycle: 'monthly', due_days: 21, default_tariff: 'residential', currency: 'USD', auto_post_invoice: true, auto_sync_odoo: false };
    const sqlCalls = [];
    const auditCalls = [];
    const _query = async (sql, params) => { sqlCalls.push(sql); return { rows: [saved] }; };
    const _recordAudit = async (opts) => { auditCalls.push(opts); };

    const result = await updateBillingSettings(
      { billing_cycle: 'monthly', due_days: 21, default_tariff: 'residential', currency: 'USD', auto_post_invoice: true, auto_sync_odoo: false },
      'user-1',
      { _query, _recordAudit }
    );

    assert.equal(result.due_days, 21);
    assert.equal(result.auto_sync_odoo, false);
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0].action, 'update_billing_settings');
    assert.ok(sqlCalls[0].includes('INSERT INTO billing_settings'));
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe('validateBillingPeriod', () => {
  test('returns FUTURE_PERIOD error when period end is in the future', async () => {
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const _query = makeQ(['SELECT DISTINCT', []]);
    const result = await validateBillingPeriod({ periodStart: '2026-07-01', periodEnd: future }, { _query });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.code === 'FUTURE_PERIOD'));
  });

  test('returns INVALID_PERIOD error when end is before start', async () => {
    const _query = makeQ(['SELECT DISTINCT', []]);
    const result = await validateBillingPeriod({ periodStart: '2026-07-31', periodEnd: '2026-07-01' }, { _query });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.code === 'INVALID_PERIOD'));
  });

  test('returns NO_ACTIVE_CUSTOMERS error when no customers exist', async () => {
    const _query = makeQ(['SELECT DISTINCT', []]);
    const result = await validateBillingPeriod({ periodStart: '2026-06-01', periodEnd: '2026-06-30' }, { _query });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.code === 'NO_ACTIVE_CUSTOMERS'));
  });

  test('returns DUPLICATE_PERIOD warning and is still valid', async () => {
    const customer = { id: 'cust-1', customer_number: 'NUW-001', full_name: 'Ahmed Ali', tariff_type: 'residential' };
    let call = 0;
    const _query = async (sql) => {
      if (sql.includes('SELECT DISTINCT')) return { rows: [customer] };
      if (sql.includes('billing_cycles') && sql.includes('period_start')) return { rows: [{ id: 99 }] };
      return { rows: [] };
    };
    const result = await validateBillingPeriod({ periodStart: '2026-06-01', periodEnd: '2026-06-30' }, { _query });
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some(w => w.code === 'HAS_DUPLICATES'));
    assert.ok(result.customerIssues.some(i => i.code === 'DUPLICATE_PERIOD'));
    assert.equal(result.duplicateCount, 1);
  });

  test('returns MISSING_READING warning for meter with no readings', async () => {
    const customer = { id: 'cust-1', customer_number: 'NUW-001', full_name: 'Ahmed Ali', tariff_type: 'residential' };
    const _query = async (sql) => {
      if (sql.includes('SELECT DISTINCT'))                     return { rows: [customer] };
      if (sql.includes('billing_cycles'))                       return { rows: [] };
      if (sql.includes('SELECT id, meter_number FROM meters')) return { rows: [{ id: 'm1', meter_number: 'NUW-001' }] };
      if (sql.includes('meter_readings'))                       return { rows: [] };
      return { rows: [] };
    };
    const result = await validateBillingPeriod({ periodStart: '2026-06-01', periodEnd: '2026-06-30' }, { _query });
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some(w => w.code === 'HAS_MISSING_READINGS'));
    assert.equal(result.missingReadCount, 1);
  });

  test('returns NEGATIVE_CONSUMPTION warning when current < previous', async () => {
    const customer = { id: 'cust-1', customer_number: 'NUW-001', full_name: 'Ahmed Ali', tariff_type: 'residential' };
    let readingCall = 0;
    const _query = async (sql) => {
      if (sql.includes('SELECT DISTINCT'))                     return { rows: [customer] };
      if (sql.includes('billing_cycles'))                       return { rows: [] };
      if (sql.includes('SELECT id, meter_number FROM meters')) return { rows: [{ id: 'm1', meter_number: 'NUW-001' }] };
      if (sql.includes('meter_readings')) {
        readingCall++;
        return { rows: [{ total_consumption: readingCall === 1 ? '50' : '100' }] };
      }
      return { rows: [] };
    };
    const result = await validateBillingPeriod({ periodStart: '2026-06-01', periodEnd: '2026-06-30' }, { _query });
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some(w => w.code === 'HAS_NEGATIVE_CONSUMPTION'));
    assert.equal(result.negativeConsCount, 1);
  });

  test('returns MISSING_TARIFF warning for unknown tariff type', async () => {
    const customer = { id: 'cust-1', customer_number: 'NUW-001', full_name: 'Ahmed Ali', tariff_type: 'unknown_tariff' };
    const _query = async (sql) => {
      if (sql.includes('SELECT DISTINCT'))                     return { rows: [customer] };
      if (sql.includes('billing_cycles'))                       return { rows: [] };
      if (sql.includes('SELECT id, meter_number FROM meters')) return { rows: [{ id: 'm1', meter_number: 'NUW-001' }] };
      if (sql.includes('meter_readings'))                       return { rows: [{ total_consumption: '100' }] };
      return { rows: [] };
    };
    const result = await validateBillingPeriod({ periodStart: '2026-06-01', periodEnd: '2026-06-30' }, { _query });
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some(w => w.code === 'HAS_MISSING_TARIFF'));
    assert.equal(result.missingTariffCount, 1);
  });

  test('returns valid=true with no errors/warnings for a clean period', async () => {
    const customer = { id: 'cust-1', customer_number: 'NUW-001', full_name: 'Ahmed Ali', tariff_type: 'residential' };
    let readingCall = 0;
    const _query = async (sql) => {
      if (sql.includes('SELECT DISTINCT'))                     return { rows: [customer] };
      if (sql.includes('billing_cycles'))                       return { rows: [] };
      if (sql.includes('SELECT id, meter_number FROM meters')) return { rows: [{ id: 'm1', meter_number: 'NUW-001' }] };
      if (sql.includes('meter_readings')) {
        readingCall++;
        return { rows: [{ total_consumption: readingCall === 1 ? '150' : '100' }] };
      }
      return { rows: [] };
    };
    const result = await validateBillingPeriod({ periodStart: '2026-06-01', periodEnd: '2026-06-30' }, { _query });
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.length, 0);
  });
});

// ── Cancel ────────────────────────────────────────────────────────────────────

describe('cancelBillingRun', () => {
  test('cancels a running run and updates status', async () => {
    const runRow  = { id: 5, status: 'running' };
    const updates = [];
    const _query  = async (sql, params) => {
      if (sql.includes('SELECT * FROM billing_runs')) return { rows: [runRow] };
      if (sql.includes('UPDATE billing_runs'))        { updates.push(params); return { rows: [] }; }
      return { rows: [] };
    };
    const result = await cancelBillingRun(5, 'Test cancel', 'admin-1', { _query, _recordAudit: noopAudit });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.runId, 5);
    assert.ok(updates.length > 0);
  });

  test('deletes billing cycles when cancelling a pending_post run', async () => {
    const runRow   = { id: 7, status: 'pending_post' };
    const deleted  = [];
    const _query   = async (sql, params) => {
      if (sql.includes('SELECT * FROM billing_runs'))    return { rows: [runRow] };
      if (sql.includes('SELECT billing_cycle_id'))       return { rows: [{ billing_cycle_id: 42 }, { billing_cycle_id: 43 }] };
      if (sql.includes('DELETE FROM billing_cycles'))    { deleted.push(params[0]); return { rows: [] }; }
      return { rows: [] };
    };
    await cancelBillingRun(7, 'Rollback', 'admin-1', { _query, _recordAudit: noopAudit });
    assert.deepEqual(deleted.sort(), [42, 43].sort());
  });

  test('throws an error when trying to cancel a completed run', async () => {
    const _query = makeQ(['SELECT * FROM billing_runs', [{ id: 3, status: 'completed' }]]);
    await assert.rejects(
      () => cancelBillingRun(3, 'Oops', 'admin-1', { _query, _recordAudit: noopAudit }),
      /Cannot cancel/
    );
  });
});

// ── runMonthlyAutoBilling — settings integration ──────────────────────────────

describe('runMonthlyAutoBilling — settings integration', () => {
  test('respects auto_post_invoice=false → pending_post status', async () => {
    const customer = { id: 'cust-1', customer_number: 'NUW-001', full_name: 'Ahmed Ali' };
    const insertedStatuses = [];
    const runUpdates = [];

    const _query = async (sql, params) => {
      if (sql.includes('FROM billing_settings'))                                    return { rows: [{ due_days: 14, auto_post_invoice: false, auto_sync_odoo: true }] };
      if (sql.includes('INSERT INTO billing_runs'))                                 return { rows: [{ id: 10 }] };
      if (sql.includes('SELECT DISTINCT c.id'))                                    return { rows: [customer] };
      if (sql.includes('SELECT bc.id, i.invoice_number FROM billing_cycles'))      return { rows: [] };
      if (sql.includes('SELECT meter_number FROM meters'))                         return { rows: [{ meter_number: 'NUW-001' }] };
      if (sql.includes('INSERT INTO billing_run_items')) {
        const statusMatch = sql.match(/'(pending_post|success|skipped|failed)'/);
        if (statusMatch) insertedStatuses.push(statusMatch[1]);
        return { rows: [] };
      }
      if (sql.includes('UPDATE billing_runs')) {
        runUpdates.push(params);
        return { rows: [] };
      }
      if (sql.includes('SELECT tariff_type FROM customers')) return { rows: [{ tariff_type: 'residential' }] };
      return { rows: [] };
    };
    const _getSettings = async () => ({ due_days: 14, auto_post_invoice: false, auto_sync_odoo: true });
    const _calculateUsage = async () => 50.00;
    const _createCycle    = async () => ({ id: 99 });
    const _postCycleInvoice = async () => { throw new Error('Should not post invoice when auto_post=false'); };

    const result = await runMonthlyAutoBilling(
      { periodStart: '2026-06-01', periodEnd: '2026-06-30' },
      { _query, _calculateUsage, _createCycle, _postCycleInvoice, _getSettings }
    );

    assert.equal(result.status, 'pending_post');
    assert.ok(insertedStatuses.includes('pending_post'), `Expected pending_post in ${insertedStatuses}`);
  });

  test('reads due_days from settings and passes to cycle creation', async () => {
    const customer = { id: 'cust-1', customer_number: 'NUW-002', full_name: 'Test User' };
    let cycleArgs  = null;

    const _query = async (sql, params) => {
      if (sql.includes('INSERT INTO billing_runs'))                             return { rows: [{ id: 11 }] };
      if (sql.includes('SELECT DISTINCT c.id'))                                return { rows: [customer] };
      if (sql.includes('SELECT bc.id, i.invoice_number FROM billing_cycles'))  return { rows: [] };
      if (sql.includes('SELECT meter_number FROM meters'))                     return { rows: [{ meter_number: 'NUW-002' }] };
      if (sql.includes('SELECT tariff_type FROM customers'))                   return { rows: [{ tariff_type: 'residential' }] };
      return { rows: [] };
    };
    const _getSettings      = async () => ({ due_days: 30, auto_post_invoice: true, auto_sync_odoo: false });
    const _calculateUsage   = async () => 75.00;
    const _createCycle      = async (cid, type, start, end, dueDate, ...rest) => { cycleArgs = { start, end, dueDate }; return { id: 88 }; };
    const _postCycleInvoice = async () => ({});

    await runMonthlyAutoBilling(
      { periodStart: '2026-06-01', periodEnd: '2026-06-30' },
      { _query, _calculateUsage, _createCycle, _postCycleInvoice, _getSettings }
    );

    assert.ok(cycleArgs, 'createCycle was not called');
    const endDate = new Date('2026-06-30');
    const expectedDue = new Date(endDate.getTime() + 30 * 24 * 60 * 60 * 1000);
    const actualDue   = new Date(cycleArgs.dueDate);
    assert.equal(actualDue.toISOString().slice(0, 10), expectedDue.toISOString().slice(0, 10));
  });
});
