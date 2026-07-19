'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { syncMeterToOdoo } = require('../src/services/odooService');

const METER_UUID    = 'd16dee21-eac7-4f69-8b8e-a04e0da805b6';
const CUSTOMER_UUID = '74ba6397-ff64-4007-b7f2-8be262fb0443';

const baseMeter = {
  id:                   METER_UUID,
  meter_number:         'NUW-001',
  device_eui:           '70B3D57ED0051234',
  meter_serial:         null,
  customer_id:          CUSTOMER_UUID,
  customer_odoo_id:     '47',     // customer already in Odoo
  tariff_type:          'residential',
  status:               'active',
  total_consumption:    '0.000',
  current_flow:         '0.000',
  battery_voltage:      '3.60',
  is_online:            false,
  valve_status:         'open',
  latitude:             '8.4060000',
  longitude:            '48.4820000',
  installation_address: 'Garowe Puntland',
  installed_at:         '2026-06-28T11:44:47.902Z',
  last_seen:            '2026-07-17T17:37:50.166Z',
  odoo_id:              null,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeQuery = (meter) => async (sql) => {
  if (/^SELECT/.test(sql.trim())) return { rows: [meter] };
  return { rows: [] };
};

const makeOdoo = (searchResult = [], createId = 99) => {
  const calls = [];
  return {
    calls,
    execute: async (model, method, args) => {
      calls.push({ model, method, args });
      if (method === 'search')  return searchResult;
      if (method === 'create')  return createId;
      if (method === 'write')   return true;
      return null;
    },
  };
};

// Injected in tests where customer sync must be skipped (customer already in Odoo)
const noopCustomerSync = async () => { throw new Error('customer sync must not be called'); };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('syncMeterToOdoo', () => {

  // ── Branch 1: meter already has odoo_id → straight write, no search ────────
  test('meter with odoo_id set — skips search, writes to existing Odoo record', async () => {
    const mock = makeOdoo();
    const result = await syncMeterToOdoo(METER_UUID, {
      _query:        makeQuery({ ...baseMeter, odoo_id: '2' }),
      _odoo:         mock,
      _syncCustomer: noopCustomerSync,
    });

    assert.equal(result.odooId, 2);

    const searchCall = mock.calls.find(c => c.method === 'search');
    assert.equal(searchCall, undefined, 'search must NOT be called when odoo_id is set');

    const writeCall = mock.calls.find(c => c.method === 'write');
    assert.ok(writeCall, 'write must be called');
    assert.deepEqual(writeCall.args[0], [2], 'write must target the stored odoo_id');
    assert.equal(writeCall.args[0][0], 2);
  });

  // ── Branch 2: no odoo_id, not yet in Odoo → create ────────────────────────
  test('no odoo_id, meter not in Odoo — creates new nuwaco.meter record', async () => {
    const mock = makeOdoo([], 99);
    const result = await syncMeterToOdoo(METER_UUID, {
      _query:        makeQuery({ ...baseMeter, odoo_id: null }),
      _odoo:         mock,
      _syncCustomer: noopCustomerSync,
    });

    assert.equal(result.odooId, 99);

    const searchCall = mock.calls.find(c => c.method === 'search');
    assert.ok(searchCall, 'search must be called when odoo_id is null');
    assert.deepEqual(searchCall.args, [[['wms_meter_id', '=', METER_UUID]]],
      'search must use wms_meter_id = meter UUID');

    const createCall = mock.calls.find(c => c.method === 'create');
    assert.ok(createCall, 'create must be called when search returns nothing');
    assert.equal(createCall.args[0].wms_meter_id, METER_UUID);
  });

  // ── Branch 3: no odoo_id, already in Odoo (idempotent update) ─────────────
  test('no odoo_id, meter already in Odoo — idempotent: writes to found record, no duplicate create', async () => {
    const mock = makeOdoo([2]); // search returns existing nuwaco.meter id=2
    const result = await syncMeterToOdoo(METER_UUID, {
      _query:        makeQuery({ ...baseMeter, odoo_id: null }),
      _odoo:         mock,
      _syncCustomer: noopCustomerSync,
    });

    assert.equal(result.odooId, 2);

    const writeCall = mock.calls.find(c => c.method === 'write');
    assert.ok(writeCall, 'write must be called when search finds the record');
    assert.deepEqual(writeCall.args[0], [2]);

    const createCall = mock.calls.find(c => c.method === 'create');
    assert.equal(createCall, undefined, 'create must NOT be called when record already exists');
  });

  // ── Branch 4: customer not yet in Odoo → auto-syncs customer first ─────────
  test('customer not yet in Odoo — triggers customer sync and uses returned partnerId', async () => {
    const mock = makeOdoo([], 99);
    let customerSyncCalled = false;

    const result = await syncMeterToOdoo(METER_UUID, {
      _query: makeQuery({ ...baseMeter, odoo_id: null, customer_odoo_id: null }),
      _odoo:  mock,
      _syncCustomer: async (customerId) => {
        assert.equal(customerId, CUSTOMER_UUID);
        customerSyncCalled = true;
        return { odooId: 47 };
      },
    });

    assert.ok(customerSyncCalled, 'customer sync must have been triggered');
    assert.equal(result.payload.partner_id, 47);
  });

  // ── Payload: name fallback chain ───────────────────────────────────────────
  test('meter_number present — used as Odoo name', async () => {
    const mock = makeOdoo([], 99);
    const result = await syncMeterToOdoo(METER_UUID, {
      _query:        makeQuery({ ...baseMeter, meter_number: 'NUW-001', device_eui: '70B3D57ED0051234', odoo_id: null }),
      _odoo:         mock,
      _syncCustomer: noopCustomerSync,
    });
    assert.equal(result.payload.name, 'NUW-001');
  });

  test('meter_number null — falls back to device_eui as Odoo name', async () => {
    const mock = makeOdoo([], 99);
    const result = await syncMeterToOdoo(METER_UUID, {
      _query:        makeQuery({ ...baseMeter, meter_number: null, device_eui: '70B3D57ED0051234', odoo_id: null }),
      _odoo:         mock,
      _syncCustomer: noopCustomerSync,
    });
    assert.equal(result.payload.name, '70B3D57ED0051234');
  });

  test('meter_number empty string — falls back to device_eui as Odoo name', async () => {
    const mock = makeOdoo([], 99);
    const result = await syncMeterToOdoo(METER_UUID, {
      _query:        makeQuery({ ...baseMeter, meter_number: '', device_eui: '70B3D57ED0051234', odoo_id: null }),
      _odoo:         mock,
      _syncCustomer: noopCustomerSync,
    });
    assert.equal(result.payload.name, '70B3D57ED0051234');
  });

  test('meter_number and device_eui both null — falls back to meter UUID as Odoo name', async () => {
    const mock = makeOdoo([], 99);
    const result = await syncMeterToOdoo(METER_UUID, {
      _query:        makeQuery({ ...baseMeter, meter_number: null, device_eui: null, odoo_id: null }),
      _odoo:         mock,
      _syncCustomer: noopCustomerSync,
    });
    assert.equal(result.payload.name, METER_UUID, 'name must never be falsy');
    assert.ok(result.payload.name.length > 0, 'name must not be empty');
  });

  // ── Idempotency: wms_meter_id is always the stable UUID ───────────────────
  test('wms_meter_id in search and payload always equals the meter UUID', async () => {
    const mock = makeOdoo([], 99);
    const result = await syncMeterToOdoo(METER_UUID, {
      _query:        makeQuery({ ...baseMeter, odoo_id: null }),
      _odoo:         mock,
      _syncCustomer: noopCustomerSync,
    });

    assert.equal(result.payload.wms_meter_id, METER_UUID);

    const searchCall = mock.calls.find(c => c.method === 'search');
    assert.equal(searchCall.args[0][0][2], METER_UUID);
  });

  // ── Idempotency: second call (odoo_id written back) is a safe update ───────
  test('idempotent second call — second sync with odoo_id written back calls write not create', async () => {
    // Simulate: first sync happened, odoo_id=2 is now in DB
    const mock = makeOdoo();
    await syncMeterToOdoo(METER_UUID, {
      _query:        makeQuery({ ...baseMeter, odoo_id: '2' }),
      _odoo:         mock,
      _syncCustomer: noopCustomerSync,
    });

    const createCall = mock.calls.find(c => c.method === 'create');
    const writeCall  = mock.calls.find(c => c.method === 'write');

    assert.equal(createCall, undefined, 'second call must not create a duplicate');
    assert.ok(writeCall,               'second call must update the existing record');
    assert.deepEqual(writeCall.args[0], [2]);
  });
});
