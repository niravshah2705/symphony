'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_SEARCH_LIMIT,
  selectAccounts,
  pendingRows,
  main,
} = require('./credit-expiry-job');

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-13T12:00:00.000Z');

function account(id, walletId) {
  return { id, flexprice: { walletId } };
}

function runJob({ accounts, responses = {}, failures = {}, ...options }) {
  const calls = [];
  const warnings = [];
  const errors = [];
  let initialized = false;
  return main({
    now: NOW,
    graceMs: 60_000,
    searchLimit: 500,
    reportLimit: 2,
    initStoreImpl: async () => { initialized = true; },
    write() {},
    logImpl: {
      warn(event, value) { warnings.push([event, value]); },
      error(event, value) { errors.push([event, value]); },
    },
    deps: {
      storeApi: { listBillingAccounts: () => accounts },
      client: {
        walletTransactionsSearch: async (query) => {
          assert.equal(initialized, true, 'the store is initialized before wallet reads');
          calls.push(query);
          if (failures[query.id]) throw failures[query.id];
          return responses[query.id] || { items: [] };
        },
      },
    },
    ...options,
  }).then((summary) => ({ summary, calls, warnings, errors }));
}

test('selects only UUID accounts with a cached wallet and never the shared pseudo-org', () => {
  const selected = selectAccounts({
    listBillingAccounts: () => [
      account('__shared__', 'wallet_shared'),
      account(ORG_B, 'wallet_b'),
      account(ORG_A, 'wallet_a'),
      account('not-a-uuid', 'wallet_bad'),
      { id: '33333333-3333-4333-8333-333333333333', flexprice: {} },
    ],
  });
  assert.deepEqual(selected.map((item) => item.id), [ORG_A, ORG_B]);
});

test('searches each wallet with the exact bounded expiry query', async () => {
  const { summary, calls } = await runJob({ accounts: [account(ORG_A, 'wallet_a')] });

  assert.deepEqual(calls, [{
    id: 'wallet_a',
    type: 'credit',
    credits_available_gt: '0',
    expiry_date_before: NOW.toISOString(),
    limit: MAX_SEARCH_LIMIT,
  }]);
  assert.equal(summary.searchLimit, MAX_SEARCH_LIMIT);
  assert.equal(summary.pendingMaterialization, 0);
});

test('reports only positive expired rows older than grace as pending materialization', async () => {
  const response = {
    items: [
      { id: 'old_1', credits_available: '2.5', expiry_date: '2026-11-13T11:58:59.999Z' },
      { id: 'boundary', credits_available: '4', expiry_date: '2026-11-13T11:59:00.000Z' },
      { id: 'recent', credits_available: '3', expiry_date: '2026-11-13T11:59:30.000Z' },
      { id: 'empty', credits_available: '0', expiry_date: '2026-11-01T00:00:00.000Z' },
      { id: 'bad-credit', credits_available: 'not-a-number', expiry_date: '2026-11-01T00:00:00.000Z' },
      { id: 'bad-expiry', credits_available: '9', expiry_date: 'not-a-date' },
      { id: 'old_2', credits_available: '1', expiry_date: '2026-11-12T00:00:00.000Z' },
      { id: 'old_3', credits_available: '1', expiry_date: '2026-11-11T00:00:00.000Z' },
    ],
  };
  const { summary, warnings } = await runJob({
    accounts: [account(ORG_A, 'wallet_a')],
    responses: { wallet_a: response },
  });

  assert.equal(summary.pendingMaterialization, 3);
  assert.equal(summary.results[0].rows.length, 2, 'warning detail is bounded');
  assert.equal(summary.results[0].truncated, 1);
  assert.deepEqual(summary.results[0].rows.map((row) => row.transactionId), ['old_1', 'old_2']);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'credit_expiry_pending_temporal_materialization');
});

test('accepts rowsOf response shapes and bounds rows even if the server over-returns', () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    id: `row_${index}`,
    credits_available: '1',
    expiry_date: '2026-11-01T00:00:00.000Z',
  }));
  const result = pendingRows({ data: rows }, new Date('2026-11-13T11:59:00.000Z'), 2);
  assert.equal(result.count, 5);
  assert.equal(result.rows.length, 2);
  assert.equal(result.truncated, 3);
});

test('isolates wallet failures and continues checking other organizations', async () => {
  const { summary, calls, errors } = await runJob({
    accounts: [account(ORG_A, 'wallet_a'), account(ORG_B, 'wallet_b')],
    failures: { wallet_a: new Error('timeout') },
    responses: {
      wallet_b: [{ id: 'old', credits_available: '1', expiry_date: '2026-11-01T00:00:00.000Z' }],
    },
  });

  assert.deepEqual(calls.map((query) => query.id), ['wallet_a', 'wallet_b']);
  assert.equal(summary.failed, 1);
  assert.equal(summary.pendingMaterialization, 1);
  assert.equal(summary.results[0].status, 'failed');
  assert.equal(errors.length, 1);
});

test('rejects invalid now or grace before initializing the store', async () => {
  let initialized = false;
  const base = {
    initStoreImpl: async () => { initialized = true; },
    write() {},
    deps: {
      storeApi: { listBillingAccounts: () => [] },
      client: { walletTransactionsSearch: async () => ({ items: [] }) },
    },
  };

  await assert.rejects(main({ ...base, now: 'not-a-date' }), /valid date/);
  await assert.rejects(main({ ...base, now: NOW, graceMs: -1 }), /non-negative/);
  assert.equal(initialized, false);
});
