'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { syncReadingToOdoo } = require('../src/services/odooService');

const METER_UUID   = 'd16dee21-eac7-4f69-8b8e-a04e0da805b6';
const READING_ID   = '13';   // BIGSERIAL — arrives as string from URL params / queue

const baseReading = {
  id:                READING_ID,
  meter_id:          METER_UUID,
  meter_uuid:        METER_UUID,   // joined from meters table
  meter_odoo_id:     '2',          // meter already synced
  timestamp:         '2026-07-17T17:30:24.524Z',
  total_consumption: '0.000',
  current_flow:      null,         // real reading has null flow
  battery_voltage:   '3.60',
  rssi:              -75,
  odoo_id:           null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeQuery = (reading) => async (sql) => {
  if (/^SELECT/.test(sql.trim())) return { rows: [reading] };
  return { rows: [] };
};

const makeOdoo = ({ searchResult = [], createId = 99 } = {}) => {
  const calls = [];
  return {
    calls,
    execute: async (model, method, args) => {
      calls.push({ model, method, args });
      if (method === 'search') return searchResult;
      if (method === 'create') return createId;
      if (method === 'write')  return true;
      return null;
    },
  };
};

const noopMeterSync = async () => { throw new Error('meter sync must not be called'); };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('syncReadingToOdoo', () => {

  // ── Fast path: already synced ──────────────────────────────────────────────
  test('reading with odoo_id set — returns early, skipped, no Odoo calls', async () => {
    const mock = makeOdoo();
    const result = await syncReadingToOdoo(READING_ID, {
      _query:     makeQuery({ ...baseReading, odoo_id: '2' }),
      _odoo:      mock,
      _syncMeter: noopMeterSync,
    });

    assert.equal(result.skipped, 'already synced');
    assert.equal(result.odooId, 2);
    assert.equal(mock.calls.length, 0, 'no Odoo XML-RPC calls must be made');
  });

  // ── Normal path: create ────────────────────────────────────────────────────
  test('no odoo_id, not in Odoo — creates nuwaco.reading and writes odoo_id back', async () => {
    const mock = makeOdoo({ searchResult: [], createId: 99 });
    const result = await syncReadingToOdoo(READING_ID, {
      _query:     makeQuery({ ...baseReading, odoo_id: null }),
      _odoo:      mock,
      _syncMeter: noopMeterSync,
    });

    assert.equal(result.odooId, 99);
    assert.equal(result.recovered, undefined, 'must not be flagged as recovered');

    const searchCall = mock.calls.find(c => c.method === 'search');
    assert.ok(searchCall, 'must search Odoo before creating');
    assert.deepEqual(searchCall.args, [[['wms_reading_id', '=', 13]]],
      'search must use numeric wms_reading_id');

    const createCall = mock.calls.find(c => c.method === 'create');
    assert.ok(createCall, 'create must be called when search returns nothing');
    assert.equal(createCall.args[0].wms_reading_id, 13);
    assert.equal(createCall.args[0].meter_id, 2);
  });

  // ── Idempotency: orphaned record recovery ──────────────────────────────────
  test('no odoo_id in WMS but record exists in Odoo — recovers without creating duplicate', async () => {
    const mock = makeOdoo({ searchResult: [5] }); // Odoo already has it
    const result = await syncReadingToOdoo(READING_ID, {
      _query:     makeQuery({ ...baseReading, odoo_id: null }),
      _odoo:      mock,
      _syncMeter: noopMeterSync,
    });

    assert.equal(result.odooId, 5);
    assert.equal(result.recovered, true);

    const createCall = mock.calls.find(c => c.method === 'create');
    assert.equal(createCall, undefined, 'create must NOT be called when record already exists in Odoo');
  });

  // ── Idempotency: second call after successful first sync ───────────────────
  test('idempotent second call — odoo_id written back, second call returns skipped', async () => {
    // Simulate DB state after first sync: odoo_id is now set
    const mock = makeOdoo();
    const result = await syncReadingToOdoo(READING_ID, {
      _query:     makeQuery({ ...baseReading, odoo_id: '99' }),
      _odoo:      mock,
      _syncMeter: noopMeterSync,
    });

    assert.equal(result.skipped, 'already synced');
    assert.equal(result.odooId, 99);
    assert.equal(mock.calls.length, 0, 'zero Odoo calls on idempotent re-run');
  });

  // ── Meter auto-sync ────────────────────────────────────────────────────────
  test('meter not yet in Odoo — triggers meter sync and links reading to the returned odooId', async () => {
    const mock = makeOdoo({ searchResult: [], createId: 99 });
    let meterSyncCalled = false;

    const result = await syncReadingToOdoo(READING_ID, {
      _query: makeQuery({ ...baseReading, meter_odoo_id: null, odoo_id: null }),
      _odoo:  mock,
      _syncMeter: async (meterId) => {
        assert.equal(meterId, METER_UUID);
        meterSyncCalled = true;
        return { odooId: 2 };
      },
    });

    assert.ok(meterSyncCalled, 'meter sync must have been triggered');
    assert.equal(result.payload.meter_id, 2);
  });

  // ── Meter relationship in payload ──────────────────────────────────────────
  test('meter_odoo_id already set — linked directly without calling meter sync', async () => {
    const mock = makeOdoo({ searchResult: [], createId: 99 });
    const result = await syncReadingToOdoo(READING_ID, {
      _query:     makeQuery({ ...baseReading, meter_odoo_id: '2', odoo_id: null }),
      _odoo:      mock,
      _syncMeter: noopMeterSync,  // must not be called
    });

    assert.equal(result.payload.meter_id, 2);
  });

  // ── Payload field mapping ──────────────────────────────────────────────────
  test('wms_reading_id is numeric even when id arrives as a string', async () => {
    const mock = makeOdoo({ searchResult: [], createId: 99 });
    const result = await syncReadingToOdoo('13', {  // string, as from URL params
      _query:     makeQuery({ ...baseReading, id: '13', odoo_id: null }),
      _odoo:      mock,
      _syncMeter: noopMeterSync,
    });

    assert.equal(typeof result.payload.wms_reading_id, 'number');
    assert.equal(result.payload.wms_reading_id, 13);
  });

  test('current_flow null — sent as 0 in payload', async () => {
    const mock = makeOdoo({ searchResult: [], createId: 99 });
    const result = await syncReadingToOdoo(READING_ID, {
      _query:     makeQuery({ ...baseReading, current_flow: null, odoo_id: null }),
      _odoo:      mock,
      _syncMeter: noopMeterSync,
    });

    assert.equal(result.payload.current_flow, 0);
  });

  test('battery_voltage null — sent as false in payload', async () => {
    const mock = makeOdoo({ searchResult: [], createId: 99 });
    const result = await syncReadingToOdoo(READING_ID, {
      _query:     makeQuery({ ...baseReading, battery_voltage: null, odoo_id: null }),
      _odoo:      mock,
      _syncMeter: noopMeterSync,
    });

    assert.equal(result.payload.battery_voltage, false);
  });

  test('rssi null — sent as false in payload', async () => {
    const mock = makeOdoo({ searchResult: [], createId: 99 });
    const result = await syncReadingToOdoo(READING_ID, {
      _query:     makeQuery({ ...baseReading, rssi: null, odoo_id: null }),
      _odoo:      mock,
      _syncMeter: noopMeterSync,
    });

    assert.equal(result.payload.rssi, false);
  });

  test('rssi present — converted to number in payload', async () => {
    const mock = makeOdoo({ searchResult: [], createId: 99 });
    const result = await syncReadingToOdoo(READING_ID, {
      _query:     makeQuery({ ...baseReading, rssi: -75, odoo_id: null }),
      _odoo:      mock,
      _syncMeter: noopMeterSync,
    });

    assert.equal(result.payload.rssi, -75);
  });

  // ── Reading not found ──────────────────────────────────────────────────────
  test('reading not found in DB — throws descriptive error', async () => {
    const mock = makeOdoo();
    await assert.rejects(
      () => syncReadingToOdoo('9999', {
        _query:     async () => ({ rows: [] }),
        _odoo:      mock,
        _syncMeter: noopMeterSync,
      }),
      { message: 'Reading not found' }
    );
  });
});
