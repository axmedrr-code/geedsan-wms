'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { effectiveRef, syncCustomerToOdoo } = require('../src/services/odooService');

const UUID = '74ba6397-ff64-4007-b7f2-8be262fb0443';
const EXPECTED_FALLBACK_REF = 'WMS-74BA6397'; // first 8 chars of UUID, uppercased

// ── effectiveRef: pure function tests (no mocks needed) ─────────────────────

describe('effectiveRef', () => {
  test('valid customer_number: returned as-is', () => {
    assert.equal(effectiveRef({ id: UUID, customer_number: 'CUST-001' }), 'CUST-001');
  });

  test('customer_number with surrounding whitespace: trimmed', () => {
    assert.equal(effectiveRef({ id: UUID, customer_number: '  CUST-001  ' }), 'CUST-001');
  });

  test('empty string: returns WMS-prefixed UUID slice', () => {
    assert.equal(effectiveRef({ id: UUID, customer_number: '' }), EXPECTED_FALLBACK_REF);
  });

  test('whitespace-only: returns WMS-prefixed UUID slice', () => {
    assert.equal(effectiveRef({ id: UUID, customer_number: '   ' }), EXPECTED_FALLBACK_REF);
  });

  test('null: returns WMS-prefixed UUID slice', () => {
    assert.equal(effectiveRef({ id: UUID, customer_number: null }), EXPECTED_FALLBACK_REF);
  });

  test('undefined: returns WMS-prefixed UUID slice', () => {
    assert.equal(effectiveRef({ id: UUID, customer_number: undefined }), EXPECTED_FALLBACK_REF);
  });

  test('fallback ref is always non-empty', () => {
    for (const cn of [null, undefined, '', '  ']) {
      const ref = effectiveRef({ id: UUID, customer_number: cn });
      assert.ok(ref.length > 0, `ref must not be empty for customer_number=${JSON.stringify(cn)}`);
    }
  });
});

// ── Helpers for syncCustomerToOdoo tests ─────────────────────────────────────

const baseCustomer = {
  id: UUID,
  full_name: 'Ahmed Ali',
  customer_number: 'CUST-001',
  email: 'ahmed@test.com',
  phone: '+252907727216',
  address: '123 Main St',
  city: 'Garowe',
  odoo_id: null,
};

// Minimal mock query: returns the given customer on SELECT, no-op on UPDATE.
const makeQuery = (customer) => async (sql) => {
  if (/^SELECT/.test(sql)) return { rows: [customer] };
  return { rows: [] };
};

// Records every call; search returns searchResult, create returns createId.
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

// ── syncCustomerToOdoo: behaviour tests ──────────────────────────────────────

describe('syncCustomerToOdoo', () => {
  // ── Case 1: valid customer_number, no existing Odoo record ────────────────
  test('valid customer_number — no existing Odoo record: creates partner with correct ref', async () => {
    const mock = makeOdoo([], 99);
    const result = await syncCustomerToOdoo(UUID, {
      _query: makeQuery({ ...baseCustomer, odoo_id: null }),
      _odoo: mock,
    });

    assert.equal(result.odooId, 99);
    assert.equal(result.payload.ref, 'CUST-001');

    const searchCall = mock.calls.find(c => c.method === 'search');
    assert.ok(searchCall, 'search must be called when odoo_id is null');
    assert.deepEqual(searchCall.args, [[['ref', '=', 'CUST-001']]]);

    const createCall = mock.calls.find(c => c.method === 'create');
    assert.ok(createCall, 'create must be called when search returns nothing');
  });

  // ── Case 2: empty string customer_number ──────────────────────────────────
  test('empty string customer_number — never searches by empty string', async () => {
    const mock = makeOdoo([], 99);
    const result = await syncCustomerToOdoo(UUID, {
      _query: makeQuery({ ...baseCustomer, customer_number: '', odoo_id: null }),
      _odoo: mock,
    });

    assert.equal(result.payload.ref, EXPECTED_FALLBACK_REF);

    const searchCall = mock.calls.find(c => c.method === 'search');
    const searchedRef = searchCall?.args?.[0]?.[0]?.[2];
    assert.ok(searchedRef, 'a search must still be performed');
    assert.notEqual(searchedRef, '', 'search ref must not be an empty string');
    assert.equal(searchedRef, EXPECTED_FALLBACK_REF);
  });

  // ── Case 3: null customer_number ──────────────────────────────────────────
  test('null customer_number — uses WMS-prefixed ref', async () => {
    const mock = makeOdoo([], 99);
    const result = await syncCustomerToOdoo(UUID, {
      _query: makeQuery({ ...baseCustomer, customer_number: null, odoo_id: null }),
      _odoo: mock,
    });

    assert.equal(result.payload.ref, EXPECTED_FALLBACK_REF);
  });

  // ── Case 4: undefined customer_number ─────────────────────────────────────
  test('undefined customer_number — uses WMS-prefixed ref', async () => {
    const mock = makeOdoo([], 99);
    const result = await syncCustomerToOdoo(UUID, {
      _query: makeQuery({ ...baseCustomer, customer_number: undefined, odoo_id: null }),
      _odoo: mock,
    });

    assert.equal(result.payload.ref, EXPECTED_FALLBACK_REF);
  });

  // ── Case 5: duplicate customer_number (partner already in Odoo) ───────────
  // When two WMS customers share a customer_number, or when the same customer
  // is synced twice before odoo_id is written back, the search finds an
  // existing partner. The function must call write (not create) and return
  // the found ID.
  test('duplicate customer_number — search finds existing partner: calls write not create', async () => {
    const mock = makeOdoo([47]); // search returns existing partner id=47
    const result = await syncCustomerToOdoo(UUID, {
      _query: makeQuery({ ...baseCustomer, odoo_id: null }),
      _odoo: mock,
    });

    assert.equal(result.odooId, 47);

    const writeCall = mock.calls.find(c => c.method === 'write');
    assert.ok(writeCall, 'write must be called when search returns a result');
    assert.deepEqual(writeCall.args[0], [47], 'write must target the found partner id');

    const createCall = mock.calls.find(c => c.method === 'create');
    assert.equal(createCall, undefined, 'create must NOT be called when partner already exists');
  });

  // ── Bonus: customer with odoo_id already set goes straight to write ────────
  test('customer already has odoo_id — skips search, goes straight to write', async () => {
    const mock = makeOdoo();
    await syncCustomerToOdoo(UUID, {
      _query: makeQuery({ ...baseCustomer, odoo_id: '47' }),
      _odoo: mock,
    });

    const searchCall = mock.calls.find(c => c.method === 'search');
    assert.equal(searchCall, undefined, 'search must NOT be called when odoo_id is already set');

    const writeCall = mock.calls.find(c => c.method === 'write');
    assert.ok(writeCall, 'write must be called');
    assert.deepEqual(writeCall.args[0], [47]);
  });
});
