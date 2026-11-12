'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createFlexpriceClient, FlexpriceError } = require('./flexprice-client');

const CONFIG = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:18080',
  environmentId: 'env-1111',
  keys: { ingest: 'fp_ingest_secret', money: 'fp_money_secret' },
  timeoutMs: 1000,
  supplierStateCode: '27',
  temporalAddr: '127.0.0.1:17233',
  allowInsecureDefaults: false,
  deploymentMode: 'local',
  isProduction: false,
};

function recorder(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const next = queue.shift() || { status: 200, json: { ok: true } };
    if (next.throw) throw new Error(next.throw);
    return {
      status: next.status,
      async text() { return next.text !== undefined ? next.text : JSON.stringify(next.json ?? {}); },
    };
  };
  return { calls, fetchImpl };
}

const client = (responses, over = {}) => {
  const rec = recorder(responses);
  const c = createFlexpriceClient({
    config: { ...CONFIG, ...over.config },
    fetchImpl: rec.fetchImpl,
    sleep: async () => {},
    ...over.client,
  });
  return { c, rec };
};

test('the environment id comes from config and lands on every data route', async () => {
  const { c, rec } = client([{ status: 200, json: { id: 'cus_1' } }]);
  await c.createCustomer({ external_id: 'org-a' });
  assert.equal(rec.calls[0].headers['X-Environment-ID'], 'env-1111');
  assert.equal(rec.calls[0].headers['x-api-key'], 'fp_money_secret');
  assert.match(rec.calls[0].url, /^http:\/\/127\.0\.0\.1:18080\/v1\/customers$/);
});

test('ingest calls use the ingest key and money calls use the money key', async () => {
  const { c, rec } = client([
    { status: 202, json: {} },
    { status: 200, json: { real_time_credit_balance: '500' } },
  ]);
  await c.eventsBulk([{ event_id: 'e1', event_name: 'fleet.llm_cost', properties: { cost_paise: 1 } }]);
  await c.walletRealTimeBalance('wal_1');
  assert.equal(rec.calls[0].headers['x-api-key'], 'fp_ingest_secret');
  assert.equal(rec.calls[1].headers['x-api-key'], 'fp_money_secret');
});

test('/health is sent without credentials', async () => {
  const { c, rec } = client([{ status: 200, json: { status: 'ok' } }]);
  await c.getHealth();
  assert.deepEqual(rec.calls[0].headers, {});
  assert.equal(rec.calls[0].url, 'http://127.0.0.1:18080/health');
});

test('a missing plane key says which plane and points at provisioning', async () => {
  const { c } = client([], { config: { keys: { ingest: '', money: 'fp_money_secret' } } });
  await assert.rejects(
    () => c.eventsBulk([{ event_id: 'e1' }]),
    /no API key configured for the 'ingest' plane.*flexprice-provision\.js/s,
  );
});

test('idempotency_key travels in the body, which is the only place FlexPrice reads it', async () => {
  const { c, rec } = client([{ status: 200, json: { id: 'tx_1' } }]);
  await c.debitWallet('wal_1', { credits: '3000', idempotencyKey: 'platform-charge:org-a:2026-11' });
  assert.equal(rec.calls[0].body.idempotency_key, 'platform-charge:org-a:2026-11');
  assert.equal(rec.calls[0].body.transaction_reason, 'MANUAL_BALANCE_DEBIT');
  assert.equal(rec.calls[0].headers['Idempotency-Key'], undefined);
});

test('a write with no dedup key is attempted exactly once, even on a 503', async () => {
  const { c, rec } = client([{ status: 503, text: 'unavailable' }]);
  await assert.rejects(() => c.createMeter({ name: 'm' }), FlexpriceError);
  assert.equal(rec.calls.length, 1);
});

test('an idempotency-keyed write retries a 503 and then succeeds', async () => {
  const { c, rec } = client([
    { status: 503, text: 'unavailable' },
    { status: 503, text: 'unavailable' },
    { status: 200, json: { id: 'tx_2' } },
  ]);
  const out = await c.debitWallet('wal_1', { credits: '10', idempotencyKey: 'k1' });
  assert.equal(out.id, 'tx_2');
  assert.equal(rec.calls.length, 3);
});

test('a connection failure on a keyed write retries; on an unkeyed one it does not', async () => {
  const keyed = client([{ throw: 'socket hang up' }, { status: 200, json: { id: 'ok' } }]);
  await keyed.c.debitWallet('wal_1', { credits: '1', idempotencyKey: 'k' });
  assert.equal(keyed.rec.calls.length, 2);

  const unkeyed = client([{ throw: 'socket hang up' }]);
  await assert.rejects(() => unkeyed.c.createCustomer({ external_id: 'o' }), /failed before a response/);
  assert.equal(unkeyed.rec.calls.length, 1);
});

test('a 409 already_exists reads as success, since a replay and a race look the same', async () => {
  const { c } = client([{ status: 409, json: { code: 'already_exists', message: 'wallet transaction already exists' } }]);
  const out = await c.debitWallet('wal_1', { credits: '3000', idempotencyKey: 'platform-charge:org-a:2026-11' });
  assert.equal(out.alreadyExists, true);
  assert.equal(out.detail.code, 'already_exists');
});

test('a 409 that is not a duplicate still raises with the status and route', async () => {
  const { c } = client([{ status: 409, json: { code: 'insufficient_balance', message: 'nope' } }]);
  await assert.rejects(
    () => c.debitWallet('wal_1', { credits: '3000', idempotencyKey: 'k' }),
    (err) => {
      assert.ok(err instanceof FlexpriceError);
      assert.equal(err.status, 409);
      assert.equal(err.code, 'insufficient_balance');
      assert.match(err.message, /POST \/v1\/wallets\/wal_1\/debit -> 409 insufficient_balance/);
      return true;
    },
  );
});

test('an error message never carries a credential', async () => {
  const { c } = client([{ status: 400, text: '{"code":"bad_request","message":"amount out of range"}' }]);
  await assert.rejects(() => c.topUpWallet('wal_1', { credits_to_add: '-5' }), (err) => {
    assert.ok(!err.message.includes('fp_money_secret'), err.message);
    assert.ok(!err.message.includes('fp_ingest_secret'), err.message);
    assert.match(err.message, /amount out of range/);
    return true;
  });
});

test('grantPromo stamps FREE_CREDIT_GRANT and never asks for a bonus', async () => {
  const { c, rec } = client([{ status: 200, json: { id: 'tx_3' } }]);
  await c.grantPromo('wal_1', { credits: '50', expiresAt: '2026-12-31T00:00:00.000Z', idempotencyKey: 'promo:org-a:diwali' });
  assert.equal(rec.calls[0].body.transaction_reason, 'FREE_CREDIT_GRANT');
  assert.equal(rec.calls[0].body.credits_to_add, '50');
  assert.equal(rec.calls[0].body.expiry_date_utc, '2026-12-31T00:00:00.000Z');
  assert.equal(rec.calls[0].body.bonus_credits_to_add, undefined);
  // Both credit-writing methods refuse a missing key before any request leaves,
  // so this is a synchronous throw, not a rejected promise.
  assert.throws(() => c.grantPromo('wal_1', { credits: '50' }), TypeError);
  assert.throws(() => c.debitWallet('wal_1', { credits: '50' }), TypeError);
});

test('a promo with no expiry omits the field rather than sending null', async () => {
  const { c, rec } = client([{ status: 200, json: {} }]);
  await c.grantPromo('wal_1', { credits: '50', idempotencyKey: 'k' });
  assert.equal('expiry_date_utc' in rec.calls[0].body, false);
});

test('balance reads hit the two distinct routes and expand is encoded', async () => {
  const { c, rec } = client([{ status: 200, json: {} }, { status: 200, json: {} }]);
  await c.walletRealTimeBalance('wal/1');
  await c.walletRealTimeBalance('wal_1', { cached: true, expand: 'credits_available_breakdown' });
  assert.match(rec.calls[0].url, /\/v1\/wallets\/wal%2F1\/balance\/real-time$/);
  assert.match(rec.calls[1].url, /\/balance\/real-time-cached\?expand=credits_available_breakdown$/);
});

test('list rows are read from whichever envelope the route actually used', async () => {
  // Measured against the live stack: `GET /v1/customers/:id/wallets` answers a
  // BARE ARRAY, `GET /v1/environments` answers `{environments}`, and the search
  // routes answer `{items}`. A caller that picks one key and finds nothing does
  // not get an error — it gets "there are none", which for wallets means creating
  // a resource that already exists and then reading back no id.
  const { c } = client([
    { status: 200, json: [{ id: 'wallet_1', currency: 'inr' }] },
    { status: 200, json: { items: [{ id: 'wtxn_1' }] } },
    { status: 200, json: { environments: [{ id: 'env-1111' }] } },
  ]);
  assert.deepEqual(await c.listWalletsByCustomer('cust_1'), { items: [{ id: 'wallet_1', currency: 'inr' }] });
  const search = await c.walletTransactionsSearch({ id: 'wallet_1' });
  assert.equal(search.items[0].id, 'wtxn_1');
  const envs = await c.listEnvironments();
  assert.equal(envs.environments[0].id, 'env-1111');
});

test('there is no route on this client that marks an invoice paid, because that is the double-credit loop', async () => {
  const { c } = client([]);
  for (const name of Object.keys(c)) {
    if (typeof c[name] !== 'function') continue;
    assert.ok(!/payment/i.test(name), `unexpected payment method: ${name}`);
  }
  const withCall = client([{ status: 200, json: {} }]);
  await withCall.c.createInvoice({ invoice_type: 'ONE_OFF' });
  assert.equal(withCall.rec.calls[0].url, 'http://127.0.0.1:18080/v1/invoices');
});

test('customer ids are path-escaped, so an id from the store cannot widen the route', async () => {
  const { c, rec } = client([{ status: 200, json: {} }]);
  await c.getCustomerByExternalId('org a/../../secret?x=1');
  // The point is not that the dots disappear — encodeURIComponent leaves them — it
  // is that no separator survives, so the value stays inside one path segment.
  assert.equal(
    rec.calls[0].url,
    'http://127.0.0.1:18080/v1/customers/external/org%20a%2F..%2F..%2Fsecret%3Fx%3D1',
  );
});
