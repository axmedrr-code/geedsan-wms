'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { syncInvoiceToOdoo } = require('../src/services/odooService');

const INVOICE_UUID  = 'c2802a76-35f8-4f39-a5f2-959f52d700ac';
const CUSTOMER_UUID = '74ba6397-ff64-4007-b7f2-8be262fb0443';

const baseInvoice = {
  id:             INVOICE_UUID,
  customer_id:    CUSTOMER_UUID,
  invoice_number: 'TEST-POSTFAIL-001',
  issue_date:     '2026-07-17',
  due_date:       '2026-07-31',
  total_amount:   '150.00',
  status:         'pending',
  odoo_id:        null,
};

const baseItem = {
  id:          '1',
  invoice_id:  INVOICE_UUID,
  description: 'Water usage 2026-07-01 to 2026-07-17',
  quantity:    '1.00',
  unit_price:  '150.00',
  line_order:  1,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeQuery = ({ invoice = baseInvoice, items = [baseItem] } = {}) =>
  async (sql) => {
    if (/FROM invoices/.test(sql))       return { rows: invoice ? [invoice] : [] };
    if (/FROM invoice_items/.test(sql))  return { rows: items };
    return { rows: [] }; // UPDATE — no return value needed
  };

const makeOdoo = ({ searchReadResult = [], createId = 99, postThrows = false } = {}) => {
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
const noopCustomer          = async () => { throw new Error('customer sync must not be called'); };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('syncInvoiceToOdoo', () => {

  // ── Fast path: already synced ──────────────────────────────────────────────
  test('invoice with odoo_id set — returns early, no Odoo calls', async () => {
    const mock = makeOdoo();
    const result = await syncInvoiceToOdoo(INVOICE_UUID, {
      _query:        makeQuery({ invoice: { ...baseInvoice, odoo_id: '7' } }),
      _odoo:         mock,
      _syncCustomer: noopCustomer,
    });

    assert.equal(result.skipped,       'already synced');
    assert.equal(result.odooId,        7);
    assert.equal(result.invoiceNumber, 'TEST-POSTFAIL-001');
    assert.equal(result.customerId,    CUSTOMER_UUID);
    assert.equal(mock.calls.length,    0, 'zero Odoo XML-RPC calls on fast path');
  });

  // ── Invoice not found ──────────────────────────────────────────────────────
  test('invoice not found in DB — throws descriptive error', async () => {
    const mock = makeOdoo();
    await assert.rejects(
      () => syncInvoiceToOdoo('nonexistent-id', {
        _query:        makeQuery({ invoice: null }),
        _odoo:         mock,
        _syncCustomer: noopCustomer,
      }),
      { message: 'Invoice not found' }
    );
  });

  // ── No line items ──────────────────────────────────────────────────────────
  test('invoice with no line items — throws before touching Odoo', async () => {
    const mock = makeOdoo();
    await assert.rejects(
      () => syncInvoiceToOdoo(INVOICE_UUID, {
        _query:        makeQuery({ items: [] }),
        _odoo:         mock,
        _syncCustomer: alreadySyncedCustomer,
      }),
      { message: 'Invoice has no line items to sync' }
    );

    const createCall = mock.calls.find(c => c.method === 'create');
    assert.equal(createCall, undefined, 'create must not be called when items list is empty');
  });

  // ── Branch A: MISS ─────────────────────────────────────────────────────────
  test('Branch A (MISS) — no existing move in Odoo: creates, posts, writes back odoo_id', async () => {
    const mock = makeOdoo({ searchReadResult: [], createId: 42 });
    const result = await syncInvoiceToOdoo(INVOICE_UUID, {
      _query:        makeQuery(),
      _odoo:         mock,
      _syncCustomer: alreadySyncedCustomer,
    });

    assert.equal(result.branch,        'miss');
    assert.equal(result.odooId,        42);
    assert.equal(result.invoiceNumber, 'TEST-POSTFAIL-001');
    assert.equal(result.customerId,    CUSTOMER_UUID);
    assert.equal(result.partnerId,     47);
    assert.ok(result.payload,          'payload must be present');

    const createCall = mock.calls.find(c => c.method === 'create');
    assert.ok(createCall, 'create must be called on MISS branch');
    assert.equal(createCall.model,      'account.move');
    assert.equal(createCall.args[0].move_type,  'out_invoice');
    assert.equal(createCall.args[0].partner_id, 47);
    assert.equal(createCall.args[0].ref,        'TEST-POSTFAIL-001');

    const postCall = mock.calls.find(c => c.method === 'action_post');
    assert.ok(postCall, 'action_post must be called after create');
    assert.deepEqual(postCall.args[0], [42], 'action_post must target the new move id');
  });

  // ── Branch A: idempotency search (ref + move_type) ────────────────────────
  test('Branch A — idempotency search uses invoice_number as ref and move_type=out_invoice', async () => {
    const mock = makeOdoo({ searchReadResult: [], createId: 42 });
    await syncInvoiceToOdoo(INVOICE_UUID, {
      _query:        makeQuery(),
      _odoo:         mock,
      _syncCustomer: alreadySyncedCustomer,
    });

    const searchCall = mock.calls.find(c => c.method === 'search_read');
    assert.ok(searchCall, 'search_read must be called before create');
    const domain = searchCall.args[0];
    const refFilter      = domain.find(f => f[0] === 'ref');
    const moveTypeFilter = domain.find(f => f[0] === 'move_type');
    assert.ok(refFilter,                            'domain must include ref filter');
    assert.equal(refFilter[2],      'TEST-POSTFAIL-001');
    assert.ok(moveTypeFilter,                       'domain must include move_type filter');
    assert.equal(moveTypeFilter[2], 'out_invoice');
  });

  // ── Branch B: HIT Draft ────────────────────────────────────────────────────
  test('Branch B (HIT Draft) — existing draft move: updates, posts, writes back odoo_id', async () => {
    const mock = makeOdoo({ searchReadResult: [{ id: 7, state: 'draft' }] });
    const result = await syncInvoiceToOdoo(INVOICE_UUID, {
      _query:        makeQuery(),
      _odoo:         mock,
      _syncCustomer: alreadySyncedCustomer,
    });

    assert.equal(result.branch,    'hit_draft');
    assert.equal(result.odooId,    7);
    assert.ok(result.payload,      'payload must be present');

    const createCall = mock.calls.find(c => c.method === 'create');
    assert.equal(createCall, undefined, 'create must NOT be called on Branch B');

    const writeCall = mock.calls.find(c => c.method === 'write');
    assert.ok(writeCall, 'write must be called on Branch B');
    assert.equal(writeCall.model,   'account.move');
    assert.deepEqual(writeCall.args[0], [7], 'write must target the existing move');

    const lines = writeCall.args[1].invoice_line_ids;
    assert.ok(Array.isArray(lines),           'invoice_line_ids must be in write payload');
    assert.equal(lines[0][0], 5,              'first ORM command must be 5 (delete all)');

    const postCall = mock.calls.find(c => c.method === 'action_post');
    assert.ok(postCall, 'action_post must be called after write');
    assert.deepEqual(postCall.args[0], [7]);
  });

  // ── Branch C: HIT Posted ───────────────────────────────────────────────────
  test('Branch C (HIT Posted) — already posted in Odoo: writes back odoo_id, skipped flag set', async () => {
    const mock = makeOdoo({ searchReadResult: [{ id: 7, state: 'posted' }] });
    const result = await syncInvoiceToOdoo(INVOICE_UUID, {
      _query:        makeQuery(),
      _odoo:         mock,
      _syncCustomer: alreadySyncedCustomer,
    });

    assert.equal(result.branch,  'hit_posted');
    assert.equal(result.odooId,  7);
    assert.equal(result.skipped, 'already posted in Odoo');

    const createCall = mock.calls.find(c => c.method === 'create');
    const writeCall  = mock.calls.find(c => c.method === 'write');
    const postCall   = mock.calls.find(c => c.method === 'action_post');
    assert.equal(createCall, undefined, 'create must NOT be called on Branch C');
    assert.equal(writeCall,  undefined, 'write must NOT be called on Branch C');
    assert.equal(postCall,   undefined, 'action_post must NOT be called on Branch C');
  });

  // ── action_post failure ────────────────────────────────────────────────────
  test('action_post failure — throws, odoo_id NOT written back to WMS DB', async () => {
    const updatedIds = [];
    const trackingQuery = async (sql, params) => {
      if (/FROM invoices/.test(sql))       return { rows: [baseInvoice] };
      if (/FROM invoice_items/.test(sql))  return { rows: [baseItem] };
      if (/UPDATE invoices/.test(sql))     updatedIds.push(params[0]); // params[0] = odoo_id
      return { rows: [] };
    };

    const mock = makeOdoo({ searchReadResult: [], createId: 42, postThrows: true });
    await assert.rejects(
      () => syncInvoiceToOdoo(INVOICE_UUID, {
        _query:        trackingQuery,
        _odoo:         mock,
        _syncCustomer: alreadySyncedCustomer,
      }),
      /action_post failed/
    );

    assert.equal(updatedIds.length, 0, 'odoo_id must NOT be written back when action_post fails');
  });

  // ── Customer auto-sync ─────────────────────────────────────────────────────
  test('customer not yet in Odoo — triggers customer sync, uses returned odooId as partner_id', async () => {
    const mock = makeOdoo({ searchReadResult: [], createId: 99 });
    let syncedCustomerId;

    await syncInvoiceToOdoo(INVOICE_UUID, {
      _query: makeQuery(),
      _odoo:  mock,
      _syncCustomer: async (customerId) => {
        syncedCustomerId = customerId;
        return { odooId: 47 };
      },
    });

    assert.equal(syncedCustomerId, CUSTOMER_UUID, 'customer sync must be called with the invoice customer_id');

    const createCall = mock.calls.find(c => c.method === 'create');
    assert.equal(createCall.args[0].partner_id, 47,
      'partner_id in move payload must come from the customer sync result');
  });

  // ── Line item payload ──────────────────────────────────────────────────────
  test('line items mapped correctly — name, quantity, price_unit are present and typed', async () => {
    const mock = makeOdoo({ searchReadResult: [], createId: 99 });
    const result = await syncInvoiceToOdoo(INVOICE_UUID, {
      _query:        makeQuery(),
      _odoo:         mock,
      _syncCustomer: alreadySyncedCustomer,
    });

    const lines = result.payload.invoice_line_ids;
    assert.ok(Array.isArray(lines),    'invoice_line_ids must be an array');
    assert.equal(lines.length, 1,      'one line item for the test invoice');

    const [cmd, _id, fields] = lines[0];
    assert.equal(cmd, 0,               'ORM command 0 means create a new line');
    assert.equal(fields.name,       'Water usage 2026-07-01 to 2026-07-17');
    assert.equal(fields.quantity,    1,     'quantity must be numeric 1');
    assert.equal(fields.price_unit,  150,   'price_unit must be numeric 150');
    assert.equal(typeof fields.quantity,   'number', 'quantity must be number, not string');
    assert.equal(typeof fields.price_unit, 'number', 'price_unit must be number, not string');
  });

  test('multiple line items all appear in payload', async () => {
    const items = [
      { ...baseItem, id: '1', description: 'Water charge', quantity: '1.00', unit_price: '120.00', line_order: 1 },
      { ...baseItem, id: '2', description: 'Service fee',  quantity: '1.00', unit_price: '30.00',  line_order: 2 },
    ];
    const mock = makeOdoo({ searchReadResult: [], createId: 99 });
    const result = await syncInvoiceToOdoo(INVOICE_UUID, {
      _query:        makeQuery({ items }),
      _odoo:         mock,
      _syncCustomer: alreadySyncedCustomer,
    });

    const lines = result.payload.invoice_line_ids;
    assert.equal(lines.length, 2);
    assert.equal(lines[0][2].price_unit, 120);
    assert.equal(lines[1][2].price_unit, 30);
  });

  // ── Move payload structure ─────────────────────────────────────────────────
  test('move payload contains all required Odoo fields', async () => {
    const mock = makeOdoo({ searchReadResult: [], createId: 99 });
    const result = await syncInvoiceToOdoo(INVOICE_UUID, {
      _query:        makeQuery(),
      _odoo:         mock,
      _syncCustomer: alreadySyncedCustomer,
    });

    const p = result.payload;
    assert.equal(p.move_type,        'out_invoice');
    assert.equal(p.partner_id,       47);
    assert.equal(p.ref,              'TEST-POSTFAIL-001');
    assert.ok(p.invoice_date,        'invoice_date must be present');
    assert.ok(p.invoice_date_due,    'invoice_date_due must be present');
    assert.ok(p.invoice_line_ids,    'invoice_line_ids must be present');
  });

  // ── Idempotency: second call after successful first sync ───────────────────
  test('idempotent second call — odoo_id written back, second sync returns skipped immediately', async () => {
    const mock = makeOdoo();
    const result = await syncInvoiceToOdoo(INVOICE_UUID, {
      _query:        makeQuery({ invoice: { ...baseInvoice, odoo_id: '42' } }),
      _odoo:         mock,
      _syncCustomer: noopCustomer,
    });

    assert.equal(result.skipped,       'already synced');
    assert.equal(result.odooId,        42);
    assert.equal(result.invoiceNumber, 'TEST-POSTFAIL-001');
    assert.equal(result.customerId,    CUSTOMER_UUID);
    assert.equal(mock.calls.length,    0, 'zero Odoo calls on idempotent re-run');
  });
});
