'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHARGE_CREDITS, monthOf, keysFor, invoiceSearch, invoiceBody,
  ensureInvoice, chargeAccount, main,
} = require('./platform-charge-job');

const ORG = '11111111-1111-4111-8111-111111111111';
const MONTH = '2026-11';
const account = {
  id: ORG,
  flexprice: { customerId: 'cust_1', walletId: 'wallet_1', conversionRate: '1' },
};

function clientFixture({ balance = 4000 } = {}) {
  const calls = [];
  let currentBalance = balance;
  let invoice = null;
  const debits = new Map();
  return {
    calls,
    debits,
    client: {
      walletTransactionsSearch: async (query) => {
        calls.push(['transactionSearch', query]);
        const key = query.filters && query.filters[0] && query.filters[0].value.string;
        return { items: debits.has(key) ? [debits.get(key)] : [] };
      },
      walletRealTimeBalance: async (walletId) => {
        calls.push(['balance', walletId]);
        return { real_time_credit_balance: String(currentBalance) };
      },
      searchInvoices: async (filter) => {
        calls.push(['search', filter]);
        return { items: invoice ? [invoice] : [] };
      },
      createInvoice: async (body, opts) => {
        calls.push(['invoice', body, opts]);
        invoice = { id: 'inv_1', ...body };
        return invoice;
      },
      debitWallet: async (walletId, body) => {
        calls.push(['debit', walletId, body]);
        if (debits.has(body.idempotencyKey)) return { alreadyExists: true };
        const debit = {
          id: 'txn_1',
          type: 'debit',
          transaction_reason: 'MANUAL_BALANCE_DEBIT',
          idempotency_key: body.idempotencyKey,
        };
        debits.set(body.idempotencyKey, debit);
        currentBalance -= Number(body.credits);
        return debit;
      },
    },
  };
}

const gateApi = { invalidated: [], invalidate(orgId) { this.invalidated.push(orgId); } };

test('month, keys and exact invoice search reject ambiguous input', () => {
  assert.equal(monthOf(new Date('2026-11-30T23:59:59Z')), MONTH);
  assert.deepEqual(keysFor(ORG, MONTH), {
    invoice: `platform-charge-invoice:${ORG}:${MONTH}`,
    debit: `platform-charge:${ORG}:${MONTH}`,
  });
  assert.deepEqual(invoiceSearch(`platform-charge-invoice:${ORG}:${MONTH}`), {
    filters: [{
      field: 'idempotency_key',
      operator: 'eq',
      data_type: 'string',
      value: { string: `platform-charge-invoice:${ORG}:${MONTH}` },
    }],
    limit: 2,
  });
  assert.throws(() => monthOf('not-a-date'), /valid date/);
  assert.throws(() => keysFor('__shared__', MONTH), /UUID/);
  assert.throws(() => keysFor(ORG, '2026-13'), /YYYY-MM/);
});

test('the statement shape is ₹3000, finalized and tax/payment free', () => {
  const body = invoiceBody({ orgId: ORG, customerId: 'cust_1', month: MONTH });
  assert.equal(CHARGE_CREDITS, 3000);
  assert.equal(body.customer_id, 'cust_1');
  assert.equal(body.invoice_type, 'ONE_OFF');
  assert.equal(body.billing_reason, 'MANUAL');
  assert.equal(body.invoice_status, 'FINALIZED');
  assert.equal(body.subtotal, '3000');
  assert.equal(body.total, '3000');
  assert.equal(body.amount_due, '3000');
  assert.equal(body.line_items[0].amount, '3000');
  assert.equal(body.metadata.auto_completed, 'true');
  for (const forbidden of ['external_customer_id', 'payment_status', 'amount_paid', 'subscription_id', 'tax_rates']) {
    assert.equal(Object.hasOwn(body, forbidden), false, forbidden);
  }
  assert.equal(Object.hasOwn(body.metadata, 'wallet_transaction_id'), false);
});

test('running twice creates one invoice identity and one idempotent debit', async () => {
  const fixture = clientFixture();
  gateApi.invalidated.length = 0;
  const options = { client: fixture.client, month: MONTH, dryRun: false, gateApi };
  const first = await chargeAccount(account, options);
  const second = await chargeAccount(account, options);
  assert.equal(first.status, 'charged');
  assert.equal(second.status, 'already_charged');
  assert.equal(fixture.calls.filter(([kind]) => kind === 'invoice').length, 1);
  assert.equal(fixture.calls.filter(([kind]) => kind === 'debit').length, 1);
  assert.equal(fixture.debits.size, 1);
  const debitSearch = fixture.calls.find(([kind]) => kind === 'transactionSearch')[1];
  assert.deepEqual(debitSearch, {
    id: 'wallet_1',
    type: 'debit',
    filters: [{
      field: 'idempotency_key',
      operator: 'eq',
      data_type: 'string',
      value: { string: `platform-charge:${ORG}:${MONTH}` },
    }],
    limit: 2,
  });
  const invoiceCall = fixture.calls.find(([kind]) => kind === 'invoice');
  assert.equal(invoiceCall[2].idempotencyKey, `platform-charge-invoice:${ORG}:${MONTH}`);
  const debit = fixture.calls.find(([kind]) => kind === 'debit')[2];
  assert.equal(debit.credits, '3000');
  assert.equal(debit.idempotencyKey, `platform-charge:${ORG}:${MONTH}`);
  assert.deepEqual(debit.metadata, { invoice_id: 'inv_1' });
  assert.equal(Object.hasOwn(debit.metadata, 'wallet_transaction_id'), false);
  assert.deepEqual(gateApi.invalidated, [ORG, ORG]);
});

test('a create race recovers the finalized invoice id before debit', async () => {
  let searches = 0;
  const fixture = clientFixture();
  fixture.client.searchInvoices = async () => {
    searches += 1;
    return { items: searches === 1 ? [] : [{ id: 'inv_raced' }] };
  };
  fixture.client.createInvoice = async () => ({ alreadyExists: true });
  const out = await ensureInvoice(fixture.client, {
    orgId: ORG, customerId: 'cust_1', month: MONTH, dryRun: false,
  });
  assert.equal(out.invoice.id, 'inv_raced');
  assert.equal(out.created, false);
});

test('insufficient balance and dry-run never create an invoice or debit', async () => {
  const poor = clientFixture({ balance: 2999.99 });
  const skipped = await chargeAccount(account, { client: poor.client, month: MONTH, dryRun: false, gateApi });
  assert.equal(skipped.status, 'insufficient_balance');
  assert.deepEqual(poor.calls.map(([kind]) => kind), ['transactionSearch', 'balance']);

  const dry = clientFixture();
  const due = await chargeAccount(account, { client: dry.client, month: MONTH, dryRun: true, gateApi });
  assert.equal(due.status, 'due');
  assert.deepEqual(dry.calls.map(([kind]) => kind), ['transactionSearch', 'balance', 'search']);
});

test('main isolates accounts with unresolved wallets and per-org failures', async () => {
  const fixture = clientFixture();
  fixture.client.searchInvoices = async () => { throw new Error('search unavailable'); };
  const lines = [];
  const summary = await main({
    env: { PLATFORM_CHARGE_MONTH: MONTH },
    initStoreImpl: async () => {},
    deps: {
      storeApi: { listBillingAccounts: () => [account, { id: '22222222-2222-4222-8222-222222222222' }, { id: '__shared__' }] },
      client: fixture.client,
      gateApi,
    },
    logImpl: { warn() {}, error() {} },
    write: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(summary.accounts, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.results.find((r) => r.orgId === ORG).status, 'failed');
  assert.equal(summary.results.find((r) => r.orgId !== ORG).status, 'wallet_unresolved');
  assert.equal(lines.length, 1);
});
