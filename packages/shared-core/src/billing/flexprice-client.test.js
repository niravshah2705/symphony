'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createFlexpriceClient,
  FlexpriceError,
  FlexpriceScopeError,
  FlexpriceValidationError,
} = require('./flexprice-client');

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

/**
 * The client's tests run on the transport's seam, so what is recorded is what the
 * wire would carry: the URL the SDK resolved, the headers its hooks added, and the
 * body as its model serialized it — snake_case, whatever camelCase was passed in.
 * That indirection is the point: these tests assert the contract the caller depends
 * on, not the shape the caller wrote.
 */
function recorder(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (req) => {
    const text = req.method === 'GET' ? null : await req.text();
    calls.push({
      url: req.url,
      method: req.method,
      headers: Object.fromEntries(req.headers),
      body: text ? JSON.parse(text) : undefined,
    });
    const next = queue.shift() || { status: 200, json: { ok: true } };
    if (next.throw) throw new Error(next.throw);
    return new Response(next.text !== undefined ? next.text : JSON.stringify(next.json ?? {}), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

function client(responses, over = {}) {
  const rec = recorder(responses);
  const c = createFlexpriceClient({
    config: { ...CONFIG, ...(over.config || {}) },
    fetchImpl: over.fetchImpl || rec.fetchImpl,
  });
  return { c, rec };
}

/** The recorded path, without the origin or the query string. */
const pathOf = (call) => call.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];

test('the environment id comes from config and lands on every data route', async () => {
  const { c, rec } = client([{ status: 201, json: { id: 'cus_1', external_id: 'org-a', name: 'org-a' } }]);
  await c.createCustomer({ externalId: 'org-a', name: 'org-a' });
  assert.equal(rec.calls[0].headers['x-environment-id'], 'env-1111');
  assert.equal(rec.calls[0].headers['x-api-key'], 'fp_money_secret');
  assert.equal(rec.calls[0].url, 'http://127.0.0.1:18080/v1/customers');
  assert.deepEqual(rec.calls[0].body, { external_id: 'org-a', name: 'org-a' });
});

test('ingest calls use the ingest key and money calls use the money key', async () => {
  const { c, rec } = client([
    { status: 202, json: { message: 'accepted' } },
    { status: 200, json: { real_time_credit_balance: '500' } },
  ]);
  await c.eventsBulk([{ event_id: 'e1', event_name: 'fleet.llm_cost', properties: { token_credits: 1 } }]);
  await c.walletRealTimeBalance('wal_1');
  assert.equal(rec.calls[0].headers['x-api-key'], 'fp_ingest_secret');
  assert.equal(rec.calls[1].headers['x-api-key'], 'fp_money_secret');
});

test('a missing plane key says which plane and points at provisioning', async () => {
  const { c, rec } = client([], { config: { keys: { ingest: '', money: 'fp_money_secret' } } });
  await assert.rejects(
    () => c.eventsBulk([{ event_id: 'e1' }]),
    /no API key configured for the 'ingest' plane.*flexprice-provision\.js/s,
  );
  assert.deepEqual(rec.calls, []);
});

test('a request body arrives on the wire in FlexPrice spelling, not the caller\'s', async () => {
  const { c, rec } = client([
    { status: 200, json: { id: 'wal_1' } },
    { status: 200, json: { id: 'tx_1' } },
  ]);
  await c.createWallet({ currency: 'INR', externalCustomerId: 'org-a', walletType: 'PRE_PAID' });
  assert.deepEqual(rec.calls[0].body, {
    currency: 'INR',
    external_customer_id: 'org-a',
    wallet_type: 'PRE_PAID',
    // The model's own defaults, which the hand-rolled client spelled at every call
    // site and now spells nowhere.
    conversion_rate: '1',
    initial_credits_to_load: '0',
  });

  await c.topUpWallet('wal_1', { transactionReason: 'PURCHASED_CREDIT_DIRECT', creditsToAdd: '500' }, { idempotencyKey: 'recharge:inv_1' });
  assert.equal(rec.calls[1].body.idempotency_key, 'recharge:inv_1', 'the only place FlexPrice reads the dedup key');
  assert.equal(rec.calls[1].body.credits_to_add, '500');
  assert.equal(rec.calls[1].headers['idempotency-key'], undefined, 'there is no such header in their router');
  assert.equal(pathOf(rec.calls[1]), '/v1/wallets/wal_1/top-up');
});

test('an idempotency-keyed write retries a 503 and then succeeds; an unkeyed one does not', async () => {
  const keyed = client([
    { status: 503, text: 'unavailable' },
    { status: 503, text: 'unavailable' },
    { status: 200, json: { wallet_transaction: { id: 'tx_2' } } },
  ]);
  const out = await keyed.c.topUpWallet('wal_1', { transactionReason: 'PURCHASED_CREDIT_DIRECT', creditsToAdd: '10' }, { idempotencyKey: 'k1' });
  assert.equal(out.walletTransaction.id, 'tx_2', 'the response is the typed model');
  assert.equal(keyed.rec.calls.length, 3);

  const unkeyed = client([{ status: 503, text: 'unavailable' }]);
  await assert.rejects(() => unkeyed.c.createCustomer({ externalId: 'o', name: 'o' }), FlexpriceError);
  assert.equal(unkeyed.rec.calls.length, 1, 'a retried POST with no dedup key is two credits');
});

test('a connection failure on a keyed write retries; on an unkeyed one it does not', async () => {
  const keyed = client([{ status: 503, text: 'x' }, { status: 200, json: { id: 'tx_9' } }]);
  await keyed.c.debitWallet('wal_1', { credits: '1', idempotencyKey: 'k' });
  assert.equal(keyed.rec.calls.length, 2);

  const unkeyed = client([{ throw: 'socket hang up' }]);
  await assert.rejects(() => unkeyed.c.createCustomer({ externalId: 'o', name: 'o' }), /failed before a response/);
  assert.equal(unkeyed.rec.calls.length, 1);
});

test('the debit keeps the measured body and rides the raw seam', async () => {
  const { c, rec } = client([{ status: 200, json: { id: 'tx_1' } }]);
  await c.debitWallet('wal_1', {
    credits: '3000',
    idempotencyKey: 'platform-charge:org-a:2026-11',
    description: 'platform fee',
    metadata: { invoice_id: 'inv_1' },
  });
  assert.equal(pathOf(rec.calls[0]), '/v1/wallets/wal_1/debit');
  assert.deepEqual(rec.calls[0].body, {
    transaction_reason: 'MANUAL_BALANCE_DEBIT',
    credits: '3000',
    idempotency_key: 'platform-charge:org-a:2026-11',
    description: 'platform fee',
    metadata: { invoice_id: 'inv_1' },
  });
  assert.equal(rec.calls[0].headers['x-api-key'], 'fp_money_secret');
  assert.throws(() => c.debitWallet('wal_1', { credits: '50' }), TypeError, 'synchronous, before transport');
});

test('event ingest carries numeric properties verbatim', async () => {
  // The generated `IngestEventRequest` types `properties` as `record<string,string>`.
  // FlexPrice stores them in a `map[string]interface{}` and the meter aggregates the
  // value as a float, so a quoted `token_credits` is a 202-accepted event that bills
  // nothing — the silent-zero case this seam exists to avoid.
  const { c, rec } = client([{ status: 202, json: { message: 'accepted' } }, { status: 202, json: { message: 'accepted' } }]);
  await c.ingestEvent({
    event_id: 'outbox-row-1',
    event_name: 'fleet.llm_cost',
    external_customer_id: 'org-a',
    timestamp: '2026-11-20T09:00:00.000Z',
    properties: { token_credits: 4120, project_id: 'p-1' },
    source: 'ai-fleet-outbox',
  });
  assert.equal(pathOf(rec.calls[0]), '/v1/events');
  assert.deepEqual(rec.calls[0].body.properties, { token_credits: 4120, project_id: 'p-1' });
  assert.equal(rec.calls[0].body.event_id, 'outbox-row-1', 'the dedup key keeps its wire name');

  await c.eventsBulk([{ event_id: 'a' }, { event_id: 'b' }]);
  assert.equal(pathOf(rec.calls[1]), '/v1/events/bulk');
  assert.deepEqual(rec.calls[1].body, { events: [{ event_id: 'a' }, { event_id: 'b' }] });
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
  await assert.rejects(() => c.topUpWallet('wal_1', { transactionReason: 'PURCHASED_CREDIT_DIRECT', creditsToAdd: '-5' }), (err) => {
    assert.ok(!err.message.includes('fp_money_secret'), err.message);
    assert.ok(!err.message.includes('fp_ingest_secret'), err.message);
    assert.match(err.message, /amount out of range/);
    return true;
  });
});

test('a body the vendor model rejects is a local error with no status, never a request', async () => {
  // `CreateInvoiceRequest` requires amount_due/currency/customer_id/subtotal/total.
  // The old client would have sent the partial body and let FlexPrice decide; the
  // SDK refuses it here, and the money paths must not read that as a 404.
  const { c, rec } = client([]);
  await assert.rejects(() => c.createInvoice({ currency: 'INR' }), (err) => {
    assert.ok(err instanceof FlexpriceValidationError, err.name);
    assert.equal(err.status, 0);
    assert.equal(err.code, 'invalid_request');
    assert.match(err.message, /rejected before transport/);
    return true;
  });
  assert.deepEqual(rec.calls, []);
});

test('a status the operation does not promise is an error, not a success it never parsed', async () => {
  // The generated matchers are status-exact: `POST /v1/customers` promises 201. If a
  // deployed FlexPrice answers 200, the SDK has no validated model to hand back, and
  // the wrong answer is a silent `undefined` id on the money path — the shape of the
  // bug this client exists to prevent. So it raises, and `scripts/flexprice-*-verify`
  // confirms the status each create route answers on the running version.
  const { c, rec } = client([{ status: 200, json: { id: 'cus_1', external_id: 'org-a' } }]);
  await assert.rejects(() => c.createCustomer({ externalId: 'org-a', name: 'org-a' }), (err) => {
    assert.ok(err instanceof FlexpriceError, err.name);
    assert.equal(err.status, 200);
    assert.match(err.message, /POST \/v1\/customers -> 200/);
    return true;
  });
  assert.equal(rec.calls.length, 1, 'it was answered, so nothing retried');
});

test('grantPromo stamps FREE_CREDIT_GRANT and never asks for a bonus', async () => {
  const { c, rec } = client([{ status: 200, json: {} }, { status: 200, json: {} }]);
  await c.grantPromo('wal_1', { credits: '50', expiresAt: '2026-12-31T00:00:00.000Z', idempotencyKey: 'promo:org-a:diwali' });
  assert.equal(rec.calls[0].body.transaction_reason, 'FREE_CREDIT_GRANT');
  assert.equal(rec.calls[0].body.credits_to_add, '50');
  assert.equal(rec.calls[0].body.expiry_date_utc, '2026-12-31T00:00:00.000Z');
  assert.equal(rec.calls[0].body.bonus_credits_to_add, undefined);

  await c.grantPromo('wal_1', { credits: '50', idempotencyKey: 'promo:org-a:diwali-2' });
  assert.equal('expiry_date_utc' in rec.calls[1].body, false, 'a promo with no expiry omits the field rather than sending null');

  // Both credit-writing methods refuse a missing key before any request leaves,
  // so this is a synchronous throw, not a rejected promise.
  assert.throws(() => c.grantPromo('wal_1', { credits: '50' }), TypeError);
  assert.throws(() => c.debitWallet('wal_1', { credits: '50' }), TypeError);
});

test('a date the store holds as a string reaches the wire as an ISO string', async () => {
  const { c, rec } = client([{ status: 200, json: { results: [], value: 0 } }]);
  await c.eventsUsage({
    externalCustomerId: 'org-a',
    eventName: 'fleet.llm_cost',
    aggregationType: 'SUM',
    startTime: '2026-11-01T00:00:00.000Z',
    endTime: new Date('2026-11-20T00:00:00.000Z'),
    windowSize: 'DAY',
  });
  assert.equal(pathOf(rec.calls[0]), '/v1/events/usage');
  assert.equal(rec.calls[0].body.start_time, '2026-11-01T00:00:00.000Z');
  assert.equal(rec.calls[0].body.end_time, '2026-11-20T00:00:00.000Z');
  assert.equal(rec.calls[0].body.window_size, 'DAY');
  assert.equal(rec.calls[0].headers['x-api-key'], 'fp_ingest_secret', 'usage reads ride the ingest plane');
});

test('list rows are read from whichever envelope the route actually used', async () => {
  // Measured live and matched by the generated model: `GET /v1/customers/:id/wallets`
  // answers a BARE ARRAY, `GET /v1/environments` (raw seam) answers `{environments}`,
  // and the search routes answer `{items}` + `pagination`.
  const { c } = client([
    { status: 200, json: [{ id: 'wallet_1', currency: 'inr', wallet_type: 'PRE_PAID' }] },
    { status: 200, json: { items: [{ id: 'wtxn_1', credit_amount: '500' }], pagination: { total: 1 } } },
    { status: 200, json: { environments: [{ id: 'env-1111' }] } },
  ]);
  const listed = await c.listWalletsByCustomer('cust_1');
  assert.deepEqual(listed, { items: [{ id: 'wallet_1', currency: 'inr', walletType: 'PRE_PAID' }] });
  const txns = await c.walletTransactionsSearch({ id: 'wallet_1' });
  assert.equal(txns.items[0].creditAmount, '500');
  assert.equal(txns.pagination.total, 1);
  const envs = await c.listEnvironments();
  assert.equal(envs.environments[0].id, 'env-1111');
});

test('balance reads hit the real-time route and expand is a query parameter', async () => {
  const { c, rec } = client([{ status: 200, json: {} }, { status: 200, json: {} }]);
  await c.walletRealTimeBalance('wal/1');
  await c.walletRealTimeBalance('wal_1', { expand: 'credits_available_breakdown' });
  assert.equal(pathOf(rec.calls[0]), '/v1/wallets/wal%2F1/balance/real-time', 'an id from the store cannot rewrite the route');
  assert.match(rec.calls[1].url, /\?expand=credits_available_breakdown$/);
});

test('invoice search is the typed filter and answers items plus pagination', async () => {
  const { c, rec } = client([
    { status: 201, json: { id: 'inv_1', total: '11800.00' } },
    { status: 200, json: { items: [{ id: 'inv_1' }], pagination: { total: 1 } } },
  ]);
  const created = await c.createInvoice({
    currency: 'INR',
    customerId: 'cust_1',
    amountDue: '11800.00',
    subtotal: '10000.00',
    total: '11800.00',
    invoiceType: 'ONE_OFF',
    issueDate: '2026-11-20T00:00:00.000Z',
  }, { idempotencyKey: 'platform-charge-invoice:org-a:2026-11' });
  assert.equal(created.total, '11800.00');
  assert.equal(rec.calls[0].body.idempotency_key, 'platform-charge-invoice:org-a:2026-11');
  assert.equal(rec.calls[0].body.issue_date, '2026-11-20T00:00:00.000Z');

  const filter = {
    filters: [{
      field: 'idempotency_key',
      operator: 'eq',
      dataType: 'string',
      value: { string: 'platform-charge-invoice:org-a:2026-11' },
    }],
  };
  const found = await c.searchInvoices(filter);
  assert.equal(pathOf(rec.calls[1]), '/v1/invoices/search');
  // The caller writes the model's `dataType`; the wire keeps FlexPrice's
  // `data_type`, and `value` stays the tagged union the filter language expects.
  assert.deepEqual(rec.calls[1].body, { filters: [{ field: 'idempotency_key', operator: 'eq', data_type: 'string', value: { string: 'platform-charge-invoice:org-a:2026-11' } }] });
  assert.deepEqual(found.items, [{ id: 'inv_1' }]);
  assert.deepEqual(found.pagination, { total: 1 });
});

test('there is no route on this client that marks an invoice paid, because that is the double-credit loop', async () => {
  const { c } = client([]);
  for (const name of Object.keys(c)) {
    if (typeof c[name] !== 'function') continue;
    assert.ok(!/payment/i.test(name), `unexpected payment method: ${name}`);
  }
  // The generated resource does have those operations; the façade not hiding them
  // is not enough, so the check is that nothing reachable names one.
  const { c: withCall, rec } = client([{ status: 200, json: { message: 'ok' } }]);
  await withCall.finalizeInvoice('inv_1');
  assert.equal(pathOf(rec.calls[0]), '/v1/invoices/inv_1/finalize');
});

test('customer ids are path-escaped, so an id from the store cannot widen the route', async () => {
  const { c, rec } = client([{ status: 200, json: { id: 'cus_1' } }]);
  await c.getCustomerByExternalId('org a/../../secret?x=1');
  // The point is not that the dots disappear — the encoder leaves them — it is that
  // no separator survives, so the value stays inside one path segment.
  assert.equal(
    rec.calls[0].url,
    'http://127.0.0.1:18080/v1/customers/external/org%20a%2F..%2F..%2Fsecret%3Fx%3D1',
  );
});

test('a money read without its wallet or customer is refused before transport', async () => {
  // One FlexPrice key spans the tenant, so `POST /v1/wallets/transactions/search`
  // with no `id` is not a broader query — it is every org's ledger, and
  // `POST /v1/events/usage` with no `externalCustomerId` is the tenant total.
  // A route refactor that drops the selector must fail here, not in production.
  const { c, rec } = client([]);
  const unscoped = [
    () => c.walletTransactionsSearch({ type: 'credit', limit: 50 }),
    () => c.walletTransactionsSearch({ id: '   ' }),
    () => c.walletTransactionsSearch({ walletId: '' }),
    () => c.eventsUsage({ eventName: 'fleet.llm_cost' }),
    // The old spelling of the selector is refused, not translated: an assertion
    // that passes while the model strips the key is an unscoped read.
    () => c.eventsUsage({ external_customer_id: 'org-a' }),
    () => c.eventsUsageMeter({ externalCustomerId: 'org-a' }),
    () => c.walletRealTimeBalance(undefined),
    () => c.listWalletsByCustomer(null),
    () => c.getCustomerByExternalId(''),
    () => c.debitWallet('', { credits: '1', idempotencyKey: 'k' }),
    () => c.grantPromo('', { credits: '1', idempotencyKey: 'k' }),
    () => c.topUpWallet('', {}),
  ];
  for (const call of unscoped) {
    const err = await refusal(call);
    assert.ok(err instanceof FlexpriceScopeError, `expected a scope refusal, got ${err && err.message}`);
    assert.equal(err.code, 'unscoped_query');
    assert.match(err.message, /every organization/);
  }
  assert.equal(rec.calls.length, 0, 'the refusal happens before the request, not after the response');

  await c.eventsUsage({ externalCustomerId: 'org-a', eventName: 'fleet.llm_cost', aggregationType: 'SUM' });
  await c.walletTransactionsSearch({ walletId: 'wal_1' });
  assert.equal(rec.calls.length, 2);
  assert.equal(rec.calls[1].body.id, 'wal_1', 'walletId is renamed to the model discriminator');
});

test('/health is sent without credentials, and the unmodeled routes still go through the transport', async () => {
  const { c, rec } = client([
    { status: 200, json: { health: 'OK' } },
    { status: 200, json: { items: [] } },
    { status: 200, json: { id: 'price_1' } },
  ]);
  assert.deepEqual(await c.getHealth(), { health: 'OK' });
  assert.equal(rec.calls[0].url, 'http://127.0.0.1:18080/health', 'outside the version root');
  assert.equal(rec.calls[0].headers['x-api-key'], undefined, 'a stack-up check must not depend on a provisioned key');

  const meters = await c.request({ plane: 'money', method: 'GET', route: '/v1/meters' });
  assert.deepEqual(meters, { items: [] });
  assert.equal(pathOf(rec.calls[1]), '/v1/meters');
  assert.equal(rec.calls[1].headers['x-environment-id'], 'env-1111');

  await c.request({ plane: 'money', method: 'PUT', route: '/v1/prices/price_1', body: { amount: '1.50' } });
  assert.equal(pathOf(rec.calls[2]), '/v1/prices/price_1');
  assert.deepEqual(rec.calls[2].body, { amount: '1.50' });
  assert.throws(() => c.request({ route: 'v1/meters' }), TypeError);
});

test('the meter routes the SDK does not generate keep their measured bodies', async () => {
  const { c, rec } = client([{ status: 200, json: { id: 'met_1' } }]);
  await c.createMeter({
    event_name: 'fleet.llm_cost',
    aggregation: { type: 'SUM', field: 'token_credits' },
  });
  assert.equal(pathOf(rec.calls[0]), '/v1/meters');
  assert.deepEqual(rec.calls[0].body, {
    event_name: 'fleet.llm_cost',
    aggregation: { type: 'SUM', field: 'token_credits' },
  });
});

async function refusal(call) {
  try {
    const out = call();
    if (out && typeof out.then === 'function') await out;
    return null;
  } catch (err) {
    return err;
  }
}
