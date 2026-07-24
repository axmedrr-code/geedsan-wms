'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { registerPaymentOnOdooMove, syncPaymentToOdoo } = require('../src/services/odooService');

// ── Helpers ───────────────────────────────────────────────────────────────────

const MOVE_ID = 36;

const baseMove = {
  id:             MOVE_ID,
  name:           'INV/2026/00012',
  ref:            'READING-12',
  state:          'posted',
  payment_state:  'not_paid',
  amount_total:   148.15,
  amount_residual: 148.15,
  partner_id:     [47, 'Ahmed Ali'],
};

const baseJournal = { id: 3, name: 'Bank' };
const basePayment = { id: 22, name: 'BNK1/2026/00001', amount: 148.15, date: '2026-07-20', state: 'posted' };

// Flexible multi-method Odoo mock.
// `responses` maps "${model}.${method}" → value or function(args, kwargs) → value.
// If a key ends with an asterisk it is treated as a one-time call (unshifts from array).
const makeOdoo = (responses = {}) => {
  const calls = [];
  return {
    calls,
    execute: async (model, method, args, kwargs) => {
      calls.push({ model, method, args, kwargs });
      const key = `${model}.${method}`;
      const handler = responses[key];
      if (handler === undefined) return null;
      return typeof handler === 'function' ? handler(args, kwargs) : handler;
    },
  };
};

// Standard "happy path" Odoo responses — first move read = not_paid, second = paid.
const happyResponses = (moveOverride = {}) => {
  let moveCalls = 0;
  return {
    'account.move.read': (args) => {
      moveCalls++;
      if (moveCalls === 1) return [{ ...baseMove, ...moveOverride }];
      return [{ ...baseMove, ...moveOverride, payment_state: 'paid', amount_residual: 0 }];
    },
    'account.journal.search_read': () => [baseJournal],
    'account.payment.register.create': () => 99,
    'account.payment.register.action_create_payments': () => true,
    'account.payment.search_read': () => [basePayment],
  };
};

const makeQuery = ({ logRows = [] } = {}) => {
  const inserts = [];
  return Object.assign(
    async (sql) => {
      if (/FROM odoo_payment_log/.test(sql)) return { rows: logRows };
      if (/INSERT INTO odoo_payment_log/.test(sql)) { inserts.push(sql); return { rows: [{ id: 1 }] }; }
      return { rows: [] };
    },
    { inserts }
  );
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('registerPaymentOnOdooMove', () => {

  // ── Already paid (fast path) ───────────────────────────────────────────────
  test('invoice already paid — returns early with status=already_paid, no payment call', async () => {
    const mock = makeOdoo({
      'account.move.read': () => [{ ...baseMove, payment_state: 'paid', amount_residual: 0 }],
    });
    const result = await registerPaymentOnOdooMove(MOVE_ID, {
      _query: makeQuery(),
      _odoo:  mock,
    });

    assert.equal(result.status,            'already_paid');
    assert.equal(result.odooMoveId,        MOVE_ID);
    assert.equal(result.paymentStateBefore, 'paid');
    assert.equal(result.amountResidual,    0);

    const wizardCall = mock.calls.find(c => c.model === 'account.payment.register');
    assert.equal(wizardCall, undefined, 'wizard must NOT be called when invoice is already paid');
  });

  // ── Invoice not found ──────────────────────────────────────────────────────
  test('move not in Odoo — throws descriptive error', async () => {
    await assert.rejects(
      () => registerPaymentOnOdooMove(MOVE_ID, {
        _query: makeQuery(),
        _odoo:  makeOdoo({ 'account.move.read': () => [] }),
      }),
      /not found/i
    );
  });

  // ── Not posted ─────────────────────────────────────────────────────────────
  test('move in draft state — throws, no payment created', async () => {
    await assert.rejects(
      () => registerPaymentOnOdooMove(MOVE_ID, {
        _query: makeQuery(),
        _odoo:  makeOdoo({ 'account.move.read': () => [{ ...baseMove, state: 'draft' }] }),
      }),
      /only posted invoices/i
    );
  });

  // ── Invalid move ID ────────────────────────────────────────────────────────
  test('invalid move ID (NaN) — throws before any Odoo call', async () => {
    const mock = makeOdoo();
    await assert.rejects(
      () => registerPaymentOnOdooMove('not-a-number', { _query: makeQuery(), _odoo: mock }),
      /Invalid Odoo move ID/
    );
    assert.equal(mock.calls.length, 0, 'no Odoo calls should be made for an invalid ID');
  });

  // ── Full payment ───────────────────────────────────────────────────────────
  test('full payment — wizard called with full residual, result has correct fields', async () => {
    const q = makeQuery();
    const mock = makeOdoo(happyResponses());
    const result = await registerPaymentOnOdooMove(MOVE_ID, { _query: q, _odoo: mock });

    assert.equal(result.odooMoveId,          MOVE_ID);
    assert.equal(result.amount,              148.15);
    assert.equal(result.paymentStateBefore,  'not_paid');
    assert.equal(result.paymentStateAfter,   'paid');
    assert.equal(result.amountResidualAfter, 0);
    assert.equal(result.odooPaymentId,       22);
    assert.equal(result.invoiceName,         'INV/2026/00012');
    assert.equal(result.journalName,         'Bank');
    assert.equal(result.partnerId,           47);
    assert.equal(result.partnerName,         'Ahmed Ali');
    assert.equal(result.isPartial,           false);

    // Verify log was written
    assert.equal(q.inserts.length, 1, 'payment must be logged to odoo_payment_log');
  });

  // ── Wizard receives correct context ───────────────────────────────────────
  test('wizard context contains active_model and active_ids targeting the invoice', async () => {
    const mock = makeOdoo(happyResponses());
    await registerPaymentOnOdooMove(MOVE_ID, { _query: makeQuery(), _odoo: mock });

    const createCall = mock.calls.find(c => c.model === 'account.payment.register' && c.method === 'create');
    assert.ok(createCall, 'account.payment.register.create must be called');
    assert.equal(createCall.kwargs.context.active_model, 'account.move');
    assert.deepEqual(createCall.kwargs.context.active_ids, [MOVE_ID]);
    assert.equal(createCall.kwargs.context.active_id,   MOVE_ID);

    const actionCall = mock.calls.find(c => c.model === 'account.payment.register' && c.method === 'action_create_payments');
    assert.ok(actionCall, 'action_create_payments must be called');
    assert.deepEqual(actionCall.args[0], [99], 'action_create_payments must receive the wizard ID');
  });

  // ── Partial payment ────────────────────────────────────────────────────────
  test('partial payment — wizard receives partial amount, isPartial=true, invoice goes to partial state', async () => {
    let moveCalls = 0;
    const mock = makeOdoo({
      'account.move.read': () => {
        moveCalls++;
        if (moveCalls === 1) return [{ ...baseMove }]; // full residual = 148.15
        return [{ ...baseMove, payment_state: 'partial', amount_residual: 98.15 }]; // 50 paid
      },
      'account.journal.search_read':               () => [baseJournal],
      'account.payment.register.create':           () => 99,
      'account.payment.register.action_create_payments': () => true,
      'account.payment.search_read':               () => [{ ...basePayment, amount: 50 }],
    });

    const result = await registerPaymentOnOdooMove(MOVE_ID, {
      _query: makeQuery(),
      _odoo:  mock,
      amount: 50,
    });

    assert.equal(result.amount,              50);
    assert.equal(result.isPartial,           true);
    assert.equal(result.paymentStateAfter,   'partial');
    assert.equal(result.amountResidualAfter, 98.15);

    const createCall = mock.calls.find(c => c.model === 'account.payment.register' && c.method === 'create');
    assert.equal(createCall.args[0].amount, 50, 'wizard must receive the partial amount');
  });

  // ── Partial amount exceeds residual (rejected silently) ────────────────────
  test('amount > residual — clamps to full residual', async () => {
    const mock = makeOdoo(happyResponses());
    const result = await registerPaymentOnOdooMove(MOVE_ID, {
      _query: makeQuery(),
      _odoo:  mock,
      amount: 9999,  // more than the 148.15 residual
    });

    // Should have been clamped to full residual
    assert.equal(result.amount, 148.15, 'amount must be clamped to the residual');
    assert.equal(result.isPartial, false);
  });

  // ── Journal fallback ───────────────────────────────────────────────────────
  test('no bank journal — falls back to cash journal', async () => {
    let journalCalls = 0;
    const mock = makeOdoo({
      'account.move.read': () => [baseMove],
      'account.journal.search_read': () => {
        journalCalls++;
        if (journalCalls === 1) return [];               // no bank
        return [{ id: 7, name: 'Cash' }];              // cash fallback
      },
      'account.payment.register.create':                () => 99,
      'account.payment.register.action_create_payments': () => true,
      'account.move.read': () => {
        let c = 0;
        return () => { c++; return c === 1 ? [baseMove] : [{ ...baseMove, payment_state: 'paid', amount_residual: 0 }]; };
      },
    });
    // Simplified: just verify the cash fallback path is hit
    const mockSimple = makeOdoo({
      'account.move.read': (() => {
        let c = 0;
        return () => { c++; return c === 1 ? [baseMove] : [{ ...baseMove, payment_state: 'paid', amount_residual: 0 }]; };
      })(),
      'account.journal.search_read': (() => {
        let c = 0;
        return () => { c++; return c === 1 ? [] : [{ id: 7, name: 'Cash' }]; };
      })(),
      'account.payment.register.create':                () => 99,
      'account.payment.register.action_create_payments': () => true,
      'account.payment.search_read':                    () => [basePayment],
    });

    const result = await registerPaymentOnOdooMove(MOVE_ID, { _query: makeQuery(), _odoo: mockSimple });
    assert.equal(result.journalName, 'Cash', 'cash journal must be used when no bank journal exists');
  });

  // ── No journal at all ─────────────────────────────────────────────────────
  test('no bank or cash journal in Odoo — throws before creating wizard', async () => {
    const mock = makeOdoo({
      'account.move.read':            () => [baseMove],
      'account.journal.search_read':  () => [],
    });
    await assert.rejects(
      () => registerPaymentOnOdooMove(MOVE_ID, { _query: makeQuery(), _odoo: mock }),
      /No bank or cash journal/
    );

    const wizardCall = mock.calls.find(c => c.model === 'account.payment.register');
    assert.equal(wizardCall, undefined, 'wizard must NOT be called when no journal exists');
  });

  // ── XML-RPC failure ────────────────────────────────────────────────────────
  test('wizard XML-RPC failure — throws, nothing written to odoo_payment_log', async () => {
    const q = makeQuery();
    const mock = makeOdoo({
      'account.move.read':            () => [baseMove],
      'account.journal.search_read':  () => [baseJournal],
      'account.payment.register.create': () => { throw new Error('XML-RPC connection lost'); },
    });

    await assert.rejects(
      () => registerPaymentOnOdooMove(MOVE_ID, { _query: q, _odoo: mock }),
      /XML-RPC connection lost/
    );

    assert.equal(q.inserts.length, 0, 'odoo_payment_log must NOT be written on XML-RPC failure');
  });

  // ── Duplicate idempotency (second call when paid) ─────────────────────────
  test('second call after successful payment — already_paid returned immediately', async () => {
    // Simulate: first call paid the invoice, odoo_id now stored. Second call finds it paid.
    const mock = makeOdoo({
      'account.move.read': () => [{ ...baseMove, payment_state: 'paid', amount_residual: 0 }],
    });
    const result1 = await registerPaymentOnOdooMove(MOVE_ID, { _query: makeQuery(), _odoo: mock });
    const result2 = await registerPaymentOnOdooMove(MOVE_ID, { _query: makeQuery(), _odoo: mock });

    assert.equal(result1.status, 'already_paid');
    assert.equal(result2.status, 'already_paid');

    const wizardCalls = mock.calls.filter(c => c.model === 'account.payment.register');
    assert.equal(wizardCalls.length, 0, 'wizard must never be called for an already-paid invoice');
  });

  // ── Retry queue entity type ────────────────────────────────────────────────
  test('enqueueOdooSync accepts "register-payment" entity type', async () => {
    const { enqueueOdooSync } = require('../src/services/odooService');
    let caught;
    try {
      await enqueueOdooSync('register-payment', '36');
    } catch (err) {
      caught = err;
    }
    if (caught) {
      assert.notEqual(caught.message, 'Invalid Odoo entity type',
        '"register-payment" must pass the validTypes guard');
    }
  });
});

// ── BUG-018 fix verification ──────────────────────────────────────────────────
// Proves the specific failure this bug described: a payment whose Odoo-side
// registration already succeeded (move shows payment_state='paid') but whose
// WMS-side write-back never completed must now recover on retry instead of
// throwing forever.
describe('BUG-018 fix — recovering odooPaymentId on the already-paid path', () => {

  // Stateful mock DB for syncPaymentToOdoo: tracks invoice_payments.odoo_id
  // across calls so a simulated retry can be checked for real idempotency.
  const makeStatefulQuery = ({ paymentRow, invoiceRow }) => {
    let currentPayment = { ...paymentRow };
    const updates = [];
    const q = async (sql, params) => {
      if (/SELECT \* FROM invoice_payments WHERE id=\$1/.test(sql)) return { rows: [currentPayment] };
      if (/SELECT \* FROM invoices WHERE id=\$1/.test(sql))        return { rows: [invoiceRow] };
      if (/SELECT odoo_id FROM invoices WHERE id=\$1/.test(sql))   return { rows: [{ odoo_id: invoiceRow.odoo_id }] };
      if (/UPDATE invoice_payments SET odoo_id=\$1/.test(sql)) {
        updates.push(params);
        currentPayment = { ...currentPayment, odoo_id: params[0] };
        return { rows: [] };
      }
      if (/INSERT INTO odoo_payment_log/.test(sql)) return { rows: [{ id: 1 }] };
      return { rows: [] };
    };
    q.updates = updates;
    return q;
  };

  test('payment_state=paid + search_read finds a payment => registerPaymentOnOdooMove returns odooPaymentId', async () => {
    const mock = makeOdoo({
      'account.move.read':         () => [{ ...baseMove, payment_state: 'paid', amount_residual: 0 }],
      'account.payment.search_read': () => [basePayment],
    });
    const result = await registerPaymentOnOdooMove(MOVE_ID, { _query: makeQuery(), _odoo: mock, paymentId: 'wms-pay-1' });

    assert.equal(result.status, 'already_paid');
    assert.equal(result.odooPaymentId, basePayment.id, 'odooPaymentId must now be populated on the already_paid branch');
    const wizardCall = mock.calls.find(c => c.model === 'account.payment.register');
    assert.equal(wizardCall, undefined, 'wizard must still never be called for an already-paid invoice');
  });

  test('syncPaymentToOdoo writes invoice_payments.odoo_id when Odoo already shows the payment settled', async () => {
    const invoiceRow = { id: 'inv-1', odoo_id: String(MOVE_ID), invoice_number: 'INV-001' };
    const paymentRow = { id: 'pay-1', invoice_id: 'inv-1', odoo_id: null, amount: 148.15, method: 'cash', reference: null, note: null };
    const q = makeStatefulQuery({ paymentRow, invoiceRow });
    const mock = makeOdoo({
      'account.move.read':          () => [{ ...baseMove, payment_state: 'paid', amount_residual: 0 }],
      'account.payment.search_read': () => [basePayment],
    });

    const result = await syncPaymentToOdoo('pay-1', { _query: q, _odoo: mock });

    assert.equal(result.odooId, basePayment.id);
    assert.equal(q.updates.length, 1, 'invoice_payments.odoo_id must be written exactly once');
    assert.equal(q.updates[0][0], String(basePayment.id));
  });

  test('retry queue no longer repeats the same payment — second syncPaymentToOdoo call is a no-op against Odoo', async () => {
    const invoiceRow = { id: 'inv-1', odoo_id: String(MOVE_ID), invoice_number: 'INV-001' };
    const paymentRow = { id: 'pay-1', invoice_id: 'inv-1', odoo_id: null, amount: 148.15, method: 'cash', reference: null, note: null };
    const q = makeStatefulQuery({ paymentRow, invoiceRow });
    const mock = makeOdoo({
      'account.move.read':          () => [{ ...baseMove, payment_state: 'paid', amount_residual: 0 }],
      'account.payment.search_read': () => [basePayment],
    });

    await syncPaymentToOdoo('pay-1', { _query: q, _odoo: mock });               // first attempt — resolves the bug
    const callsAfterFirst = mock.calls.length;
    const result2 = await syncPaymentToOdoo('pay-1', { _query: q, _odoo: mock }); // simulated retry

    assert.equal(result2.skipped, 'already synced');
    assert.equal(mock.calls.length, callsAfterFirst, 'a retry after odoo_id is set must not call Odoo again at all');
  });

  test('search_read failure on the already-paid fast path logs a warning but does not throw', async () => {
    const mock = makeOdoo({
      'account.move.read':          () => [{ ...baseMove, payment_state: 'paid', amount_residual: 0 }],
      'account.payment.search_read': () => { throw new Error('XML-RPC timeout'); },
    });
    const result = await registerPaymentOnOdooMove(MOVE_ID, { _query: makeQuery(), _odoo: mock, paymentId: 'wms-pay-2' });

    assert.equal(result.status, 'already_paid');
    assert.equal(result.odooPaymentId, null, 'lookup failure degrades to null, matching pre-fix behavior — does not throw');
  });

  test('search_read returns multiple payments — the first (latest, per order:id desc) is selected', async () => {
    const mock = makeOdoo({
      'account.move.read':          () => [{ ...baseMove, payment_state: 'paid', amount_residual: 0 }],
      'account.payment.search_read': () => [
        { ...basePayment, id: 45, date: '2026-07-22' }, // latest — order:'id desc' places this first
        { ...basePayment, id: 22, date: '2026-07-20' }, // older
      ],
    });
    const result = await registerPaymentOnOdooMove(MOVE_ID, { _query: makeQuery(), _odoo: mock, paymentId: 'wms-pay-3' });

    assert.equal(result.odooPaymentId, 45, 'must select the first (latest) result, not an older match');
  });
});
