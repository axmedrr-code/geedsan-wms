'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { syncInvoiceFromReadingToOdoo } = require('../src/services/odooService');

const READING_ID    = '13';
const METER_UUID    = 'd16dee21-eac7-4f69-8b8e-a04e0da805b6';
const CUSTOMER_UUID = '74ba6397-ff64-4007-b7f2-8be262fb0443';

// Base reading row as returned by the JOIN query
const baseReading = {
  id:                    READING_ID,
  meter_id:              METER_UUID,
  device_eui:            '70B3D57ED0051234',
  timestamp:             '2026-07-17T17:30:24.524Z',
  total_consumption:     '10.000',
  odoo_invoice_id:       null,
  customer_id:           CUSTOMER_UUID,
  meter_number:          'NUW-001',
  customer_tariff_type:  'residential',
  customer_odoo_id:      '47',
};

const basePrevReading = { total_consumption: '7.000' }; // consumption = 3.000 m³

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeQuery = ({ reading = baseReading, prev = basePrevReading } = {}) =>
  async (sql) => {
    if (/FROM meter_readings mr\s+JOIN meters/.test(sql))  return { rows: reading ? [reading] : [] };
    if (/WHERE meter_id.*timestamp < /.test(sql))          return { rows: prev ? [prev] : [] };
    return { rows: [] }; // UPDATE
  };

const makeOdoo = ({ searchReadResult = [], createId = 77, postThrows = false } = {}) => {
  const calls = [];
  return {
    calls,
    execute: async (model, method, args, kwargs) => {
      calls.push({ model, method, args, kwargs });
      if (method === 'search_read') return searchReadResult;
      if (method === 'create')      return createId;
      if (method === 'write')       return true;
      if (method === 'action_post') {
        if (postThrows) throw new Error('Journal entry cannot be posted');
        return true;
      }
      return null;
    },
  };
};

const alreadySyncedCustomer = async () => ({ odooId: 47 });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('syncInvoiceFromReadingToOdoo', () => {

  // ── Fast path: already synced ──────────────────────────────────────────────
  test('odoo_invoice_id already set — returns early, status=already_synced, no Odoo calls', async () => {
    const mock = makeOdoo();
    const result = await syncInvoiceFromReadingToOdoo(READING_ID, {
      _query:        makeQuery({ reading: { ...baseReading, odoo_invoice_id: '77' } }),
      _odoo:         mock,
      _syncCustomer: () => { throw new Error('must not be called'); },
    });

    assert.equal(result.status,        'already_synced');
    assert.equal(result.readingId,     13);
    assert.equal(result.odooInvoiceId, 77);
    assert.equal(mock.calls.length,    0, 'zero Odoo XML-RPC calls on fast path');
  });

  // ── Reading not found ──────────────────────────────────────────────────────
  test('reading not in DB — throws "Reading not found"', async () => {
    await assert.rejects(
      () => syncInvoiceFromReadingToOdoo('9999', {
        _query:        makeQuery({ reading: null }),
        _odoo:         makeOdoo(),
        _syncCustomer: alreadySyncedCustomer,
      }),
      { message: 'Reading not found' }
    );
  });

  // ── Missing customer ───────────────────────────────────────────────────────
  test('meter has no customer_id — throws "meter is unassigned"', async () => {
    await assert.rejects(
      () => syncInvoiceFromReadingToOdoo(READING_ID, {
        _query:        makeQuery({ reading: { ...baseReading, customer_id: null } }),
        _odoo:         makeOdoo(),
        _syncCustomer: alreadySyncedCustomer,
      }),
      /meter is unassigned/
    );
  });

  // ── Zero consumption ───────────────────────────────────────────────────────
  test('zero consumption (current === previous) — throws, no invoice created', async () => {
    const mock = makeOdoo();
    await assert.rejects(
      () => syncInvoiceFromReadingToOdoo(READING_ID, {
        _query:        makeQuery({ reading: { ...baseReading, total_consumption: '7.000' }, prev: basePrevReading }),
        _odoo:         mock,
        _syncCustomer: alreadySyncedCustomer,
      }),
      /Zero consumption/
    );

    const createCall = mock.calls.find(c => c.method === 'create');
    assert.equal(createCall, undefined, 'must not create Odoo invoice for zero consumption');
  });

  // ── Negative consumption ───────────────────────────────────────────────────
  test('negative consumption (current < previous) — throws, no invoice created', async () => {
    const mock = makeOdoo();
    await assert.rejects(
      () => syncInvoiceFromReadingToOdoo(READING_ID, {
        _query:        makeQuery({ reading: { ...baseReading, total_consumption: '5.000' }, prev: basePrevReading }),
        _odoo:         mock,
        _syncCustomer: alreadySyncedCustomer,
      }),
      /Negative consumption/
    );

    const createCall = mock.calls.find(c => c.method === 'create');
    assert.equal(createCall, undefined, 'must not create Odoo invoice for negative consumption');
  });

  // ── Correct tariff calculation ─────────────────────────────────────────────
  test('residential tariff: consumption=3, unitPrice=1.2, amount=3.60', async () => {
    const mock = makeOdoo({ searchReadResult: [], createId: 77 });
    const result = await syncInvoiceFromReadingToOdoo(READING_ID, {
      _query:        makeQuery(),          // 10.000 - 7.000 = 3.000
      _odoo:         mock,
      _syncCustomer: alreadySyncedCustomer,
    });

    assert.equal(result.consumption, 3);
    assert.equal(result.tariffType,  'residential');
    assert.equal(result.unitPrice,   1.2);
    assert.equal(result.amount,      3.6);
  });

  test('commercial tariff: consumption=5, unitPrice=1.8, amount=9.00', async () => {
    const mock = makeOdoo({ searchReadResult: [], createId: 77 });
    const result = await syncInvoiceFromReadingToOdoo(READING_ID, {
      _query: makeQuery({
        reading: { ...baseReading, total_consumption: '12.000', customer_tariff_type: 'commercial' },
        prev:    { total_consumption: '7.000' },
      }),
      _odoo:         mock,
      _syncCustomer: alreadySyncedCustomer,
    });

    assert.equal(result.consumption, 5);
    assert.equal(result.tariffType,  'commercial');
    assert.equal(result.unitPrice,   1.8);
    assert.equal(result.amount,      9.0);
  });

  // ── No previous reading (first reading on meter) ───────────────────────────
  test('no previous reading — treats 0 as baseline, consumption = total_consumption', async () => {
    const mock = makeOdoo({ searchReadResult: [], createId: 77 });
    const result = await syncInvoiceFromReadingToOdoo(READING_ID, {
      _query: makeQuery({ prev: null }),   // no previous reading
      _odoo:  mock,
      _syncCustomer: alreadySyncedCustomer,
    });

    assert.equal(result.consumption, 10,  'when no prev reading, consumption = total_consumption');
    assert.equal(result.unitPrice,   1.2, 'default tariff residential');
  });

  // ── Customer auto-sync ─────────────────────────────────────────────────────
  test('customer not yet in Odoo — triggers customer sync, uses returned odooId', async () => {
    const mock = makeOdoo({ searchReadResult: [], createId: 77 });
    let syncedId;

    const result = await syncInvoiceFromReadingToOdoo(READING_ID, {
      _query: makeQuery(),
      _odoo:  mock,
      _syncCustomer: async (customerId) => {
        syncedId = customerId;
        return { odooId: 47 };
      },
    });

    assert.equal(syncedId,             CUSTOMER_UUID,  'customer sync called with correct ID');
    assert.equal(result.partnerId,     47,             'partnerId in return comes from customer sync');
    assert.equal(result.payload.partner_id, 47);
  });

  // ── Branch A (MISS) ────────────────────────────────────────────────────────
  test('Branch A (MISS) — creates and posts Odoo invoice, writes back odoo_invoice_id', async () => {
    const mock = makeOdoo({ searchReadResult: [], createId: 77 });
    const result = await syncInvoiceFromReadingToOdoo(READING_ID, {
      _query:        makeQuery(),
      _odoo:         mock,
      _syncCustomer: alreadySyncedCustomer,
    });

    assert.equal(result.branch,        'miss');
    assert.equal(result.odooInvoiceId, 77);
    assert.ok(result.payload,          'payload must be present in return');

    const createCall = mock.calls.find(c => c.method === 'create');
    assert.ok(createCall, 'create must be called on MISS branch');
    assert.equal(createCall.model,              'account.move');
    assert.equal(createCall.args[0].move_type,  'out_invoice');
    assert.equal(createCall.args[0].ref,        `READING-${READING_ID}`);
    assert.equal(createCall.args[0].partner_id, 47);

    const postCall = mock.calls.find(c => c.method === 'action_post');
    assert.ok(postCall,                    'action_post must be called');
    assert.deepEqual(postCall.args[0], [77]);
  });

  // ── Branch B (HIT Draft) ───────────────────────────────────────────────────
  test('Branch B (HIT Draft) — updates existing draft, posts it', async () => {
    const mock = makeOdoo({ searchReadResult: [{ id: 55, state: 'draft' }] });
    const result = await syncInvoiceFromReadingToOdoo(READING_ID, {
      _query:        makeQuery(),
      _odoo:         mock,
      _syncCustomer: alreadySyncedCustomer,
    });

    assert.equal(result.branch,        'hit_draft');
    assert.equal(result.odooInvoiceId, 55);

    const createCall = mock.calls.find(c => c.method === 'create');
    assert.equal(createCall, undefined, 'create must NOT be called on Branch B');

    const writeCall = mock.calls.find(c => c.method === 'write');
    assert.ok(writeCall,                    'write must be called on Branch B');
    assert.deepEqual(writeCall.args[0], [55]);
    assert.equal(writeCall.args[1].invoice_line_ids[0][0], 5, 'ORM command 5 deletes existing lines');

    const postCall = mock.calls.find(c => c.method === 'action_post');
    assert.ok(postCall,                    'action_post must be called on Branch B');
    assert.deepEqual(postCall.args[0], [55]);
  });

  // ── Branch C (HIT Posted) ──────────────────────────────────────────────────
  test('Branch C (HIT Posted) — writes back odoo_invoice_id, returns skipped status', async () => {
    const mock = makeOdoo({ searchReadResult: [{ id: 55, state: 'posted' }] });
    const result = await syncInvoiceFromReadingToOdoo(READING_ID, {
      _query:        makeQuery(),
      _odoo:         mock,
      _syncCustomer: alreadySyncedCustomer,
    });

    assert.equal(result.branch,        'hit_posted');
    assert.equal(result.odooInvoiceId, 55);
    assert.equal(result.status,        'already posted in Odoo');

    const createCall = mock.calls.find(c => c.method === 'create');
    const postCall   = mock.calls.find(c => c.method === 'action_post');
    assert.equal(createCall, undefined, 'create must NOT be called on Branch C');
    assert.equal(postCall,   undefined, 'action_post must NOT be called on Branch C');
  });

  // ── action_post failure ────────────────────────────────────────────────────
  test('action_post failure — throws, odoo_invoice_id NOT written back', async () => {
    const updatedInvoiceIds = [];
    const trackingQuery = async (sql, params) => {
      if (/FROM meter_readings mr\s+JOIN meters/.test(sql))  return { rows: [baseReading] };
      if (/WHERE meter_id.*timestamp < /.test(sql))          return { rows: [basePrevReading] };
      if (/UPDATE meter_readings SET odoo_invoice_id/.test(sql)) updatedInvoiceIds.push(params[0]);
      return { rows: [] };
    };

    const mock = makeOdoo({ searchReadResult: [], createId: 77, postThrows: true });
    await assert.rejects(
      () => syncInvoiceFromReadingToOdoo(READING_ID, {
        _query:        trackingQuery,
        _odoo:         mock,
        _syncCustomer: alreadySyncedCustomer,
      }),
      /action_post failed/
    );

    assert.equal(updatedInvoiceIds.length, 0, 'odoo_invoice_id must NOT be written on action_post failure');
  });

  // ── Idempotency: second call after successful sync ─────────────────────────
  test('idempotent second call — odoo_invoice_id set, returns already_synced immediately', async () => {
    const mock = makeOdoo();
    const result = await syncInvoiceFromReadingToOdoo(READING_ID, {
      _query:        makeQuery({ reading: { ...baseReading, odoo_invoice_id: '77' } }),
      _odoo:         mock,
      _syncCustomer: alreadySyncedCustomer,
    });

    assert.equal(result.status,    'already_synced');
    assert.equal(result.readingId, 13);
    assert.equal(mock.calls.length, 0, 'no Odoo calls on idempotent re-run');
  });

  // ── Retry queue enqueue ────────────────────────────────────────────────────
  test('enqueueOdooSync accepts "reading-invoice" entity type without throwing', async () => {
    const { enqueueOdooSync } = require('../src/services/odooService');

    // Mock the internal query used by enqueueOdooSync
    // The function imports the real DB module, so we just verify it doesn't throw
    // on the entity-type validation step before hitting the DB.
    // We call it with a nonsense entity_id to trigger a DB error — but the key
    // thing is the validTypes check must pass without throwing.
    let caught;
    try {
      await enqueueOdooSync('reading-invoice', '13');
    } catch (err) {
      caught = err;
    }

    // Any error here comes from the real DB call, NOT from the validTypes guard.
    // If it said "Invalid Odoo entity type" the validTypes check is wrong.
    if (caught) {
      assert.notEqual(caught.message, 'Invalid Odoo entity type',
        '"reading-invoice" must be a valid entity type');
    }
  });

  // ── Line item payload structure ────────────────────────────────────────────
  test('line item name includes consumption, quantity=consumption, price_unit=tariff rate', async () => {
    const mock = makeOdoo({ searchReadResult: [], createId: 77 });
    const result = await syncInvoiceFromReadingToOdoo(READING_ID, {
      _query:        makeQuery(),
      _odoo:         mock,
      _syncCustomer: alreadySyncedCustomer,
    });

    const [cmd, _id, fields] = result.payload.invoice_line_ids[0];
    assert.equal(cmd,                   0,    'ORM command 0 = create new line');
    assert.equal(fields.quantity,        3,    'quantity = consumption');
    assert.equal(fields.price_unit,      1.2,  'price_unit = residential tariff rate');
    assert.ok(fields.name.includes('3.000'), 'line name must show the consumption value');
    assert.ok(fields.name.includes('residential'), 'line name must show the tariff type');
  });

  // ── Ref tag format ─────────────────────────────────────────────────────────
  test('idempotency ref tag is "READING-{readingId}"', async () => {
    const mock = makeOdoo({ searchReadResult: [], createId: 77 });
    await syncInvoiceFromReadingToOdoo(READING_ID, {
      _query:        makeQuery(),
      _odoo:         mock,
      _syncCustomer: alreadySyncedCustomer,
    });

    const createCall = mock.calls.find(c => c.method === 'create');
    assert.equal(createCall.args[0].ref, `READING-${READING_ID}`);

    const searchCall = mock.calls.find(c => c.method === 'search_read');
    const refFilter = searchCall.args[0].find(f => f[0] === 'ref');
    assert.equal(refFilter[2], `READING-${READING_ID}`);
  });
});
