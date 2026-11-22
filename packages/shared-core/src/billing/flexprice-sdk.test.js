'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PLANES,
  FlexpriceError,
  FlexpriceScopeError,
  FlexpriceValidationError,
  asFlexpriceError,
  createSdkTransport,
  isAlreadyExists,
  makeFetcher,
  retryPolicyFor,
  rowsOf,
  scopedField,
  scopedId,
} = require('./flexprice-sdk');

const CONFIG = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:18080',
  environmentId: 'env-1111',
  keys: { ingest: 'fp_ingest_secret', money: 'fp_money_secret' },
  timeoutMs: 1000,
};

/**
 * The seam is a `fetch`-compatible function handed the finished `Request`, so what
 * a test asserts here is what the wire would carry: the URL the SDK resolved, the
 * headers its hooks added, the body its model serialized.
 */
function harness(responses, over = {}) {
  const seen = [];
  const queue = [...responses];
  const fetchImpl = async (req) => {
    seen.push({
      url: req.url,
      method: req.method,
      envId: req.headers.get('x-environment-id'),
      apiKey: req.headers.get('x-api-key'),
      body: req.method === 'GET' ? undefined : JSON.parse(await req.text() || 'null'),
    });
    const next = queue.shift() || { status: 200, json: { ok: true } };
    if (next.throw) throw new Error(next.throw);
    return new Response(next.text !== undefined ? next.text : JSON.stringify(next.json ?? {}), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const config = { ...CONFIG, ...(over.config || {}) };
  const transport = createSdkTransport({
    config,
    plane: over.plane || PLANES.money,
    fetchImpl: over.fetchImpl || fetchImpl,
  });
  return { seen, transport, config };
}

test('a generated call carries the environment id and its own plane key, and asks nothing else', async () => {
  const { seen, transport } = harness([{ status: 200, json: { id: 'wal_1', currency: 'inr', wallet_type: 'PRE_PAID' } }]);
  const out = await transport.invoke({ method: 'POST', route: '/v1/wallets' }, (client, policy) => client.wallets.createWallet({
    currency: 'INR',
    externalCustomerId: 'org-a',
    walletType: 'PRE_PAID',
    conversionRate: '1',
    initialCreditsToLoad: '0',
  }, policy));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://127.0.0.1:18080/v1/wallets');
  assert.equal(seen[0].envId, 'env-1111', 'the version root and the tenant selector travel together');
  assert.equal(seen[0].apiKey, 'fp_money_secret');
  // The camelCase model is the caller's contract; the snake_case body is the wire's.
  assert.deepEqual(seen[0].body, {
    currency: 'INR',
    external_customer_id: 'org-a',
    wallet_type: 'PRE_PAID',
    conversion_rate: '1',
    initial_credits_to_load: '0',
  });
  assert.equal(out.walletType, 'PRE_PAID');
  assert.equal(out.currency, 'inr');
});

test('the ingest plane never receives the money key', async () => {
  const { seen, transport } = harness([{ status: 200, json: { value: 1000 } }], { plane: PLANES.ingest });
  await transport.invoke({ method: 'POST', route: '/v1/events/usage' }, (client, policy) => client.events.getUsageStatistics({
    eventName: 'fleet.llm_cost',
    aggregationType: 'SUM',
    externalCustomerId: 'org-a',
    startTime: new Date('2026-11-01T00:00:00.000Z'),
    endTime: new Date('2026-11-20T00:00:00.000Z'),
    windowSize: 'DAY',
    filters: { project_id: ['p-1'] },
  }, policy));

  assert.equal(seen[0].apiKey, 'fp_ingest_secret');
  assert.deepEqual(seen[0].body, {
    event_name: 'fleet.llm_cost',
    aggregation_type: 'SUM',
    external_customer_id: 'org-a',
    start_time: '2026-11-01T00:00:00.000Z',
    end_time: '2026-11-20T00:00:00.000Z',
    window_size: 'DAY',
    filters: { project_id: ['p-1'] },
  }, 'a Date serializes to ISO and the filter values stay the bare-property form the meter reads');
});

test('a plane with no key says which one and points at provisioning, without sending anything', async () => {
  const { transport } = harness([], { config: { keys: { ingest: '', money: 'fp_money_secret' } }, plane: PLANES.ingest });
  await assert.rejects(
    () => transport.invoke({ method: 'POST', route: '/v1/events' }, (client) => client.events.ingestEvent({
      eventName: 'fleet.llm_cost', externalCustomerId: 'org-a',
    })),
    /no API key configured for the 'ingest' plane.*flexprice-provision\.js/s,
  );
});

test('a request the model rejects is a local error with status 0, never a request', async () => {
  // `CreateInvoiceRequest` requires amount_due/currency/customer_id/subtotal/total.
  // The point is the failure mode: an incomplete money request must not leave the
  // process and come back as a 400 someone retries.
  const { seen, transport } = harness([{ status: 500, json: { code: 'boom' } }]);
  await assert.rejects(
    () => transport.invoke({ method: 'POST', route: '/v1/invoices' }, (client, policy) => client.invoices.createInvoice({ currency: 'INR' }, policy)),
    (err) => {
      assert.ok(err instanceof FlexpriceValidationError, err.name);
      assert.equal(err.status, 0, 'status 0 cannot match a `err.status === 404` branch');
      assert.match(err.message, /rejected before transport/);
      return true;
    },
  );
  assert.deepEqual(seen, []);
});

test('an HTTP failure keeps the shape the money paths branch on', async () => {
  const { seen, transport } = harness([
    { status: 404, json: { code: 'not_found', message: 'no customer' } },
    { status: 405, text: 'boom' },
  ]);
  await assert.rejects(
    () => transport.invoke({ method: 'GET', route: '/v1/customers/external/:id' }, (client, policy) => client.customers.getCustomerByExternalId('org-a', policy)),
    (err) => {
      assert.ok(err instanceof FlexpriceError);
      assert.equal(err.status, 404);
      assert.equal(err.code, 'not_found');
      assert.deepEqual(err.body, { code: 'not_found', message: 'no customer' });
      assert.match(err.message, /GET \/v1\/customers\/external\/:id -> 404 not_found/);
      return true;
    },
  );
  await assert.rejects(
    () => transport.invoke({ method: 'GET', route: '/v1/wallets/:id' }, (client, policy) => client.wallets.getWallet('wal_1', policy)),
    (err) => {
      assert.equal(err.status, 405, 'an unlisted 4xx still reports its status');
      assert.equal(err.body, 'boom', 'and the response text, which is all there is for it');
      return true;
    },
  );
  assert.equal(seen.length, 2);
  assert.match(seen[1].url, /\/v1\/wallets\/wal_1$/);
});

test('a spec may name its route by pattern and params, which is how the façade avoids spelling URLs', async () => {
  const { transport } = harness([{ status: 404, json: { code: 'not_found' } }, { status: 404, json: { code: 'not_found' } }]);
  await assert.rejects(
    () => transport.invoke({ method: 'GET', pattern: 'wallets/{id}', params: { id: 'wal_1' } }, (client, policy) => client.wallets.getWallet('wal_1', policy)),
    (err) => {
      assert.match(err.message, /GET \/v1\/wallets\/wal_1 -> 404/, 'the version root the transport put on the wire reappears in the label');
      return true;
    },
  );
  await assert.rejects(
    () => transport.raw({ method: 'GET', pattern: 'wallets/{id}/balance/{kind}', params: { id: 'wal_1', kind: 'real-time' } }),
    (err) => {
      assert.match(err.message, /GET \/v1\/wallets\/wal_1\/balance\/real-time/);
      return true;
    },
  );
});

test('a 409 duplicate is reported, not thrown, on both seams', async () => {
  const { transport } = harness([
    { status: 409, text: '{"code":"already_exists","message":"wallet transaction already exists"}' },
    { status: 409, json: { code: 'insufficient_balance', message: 'nope' } },
  ]);
  const replay = await transport.invoke({ method: 'POST', route: '/v1/wallets/:id/top-up', idempotencyKey: 'k1' }, (client, policy) => client.wallets.topUpWallet('wal_1', {
    transactionReason: 'PURCHASED_CREDIT_DIRECT', creditsToAdd: '50000', idempotencyKey: 'k1',
  }, policy));
  assert.deepEqual(replay, {
    alreadyExists: true,
    status: 409,
    detail: { code: 'already_exists', message: 'wallet transaction already exists' },
  });

  await assert.rejects(
    () => transport.invoke({ method: 'POST', route: '/v1/wallets/:id/debit', idempotencyKey: 'k2' }, (client, policy) => client.wallets.topUpWallet('wal_1', {
      transactionReason: 'MANUAL_BALANCE_DEBIT', creditsToAdd: '1', idempotencyKey: 'k2',
    }, policy)),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'insufficient_balance', 'a 409 that is not a duplicate is still an error');
      return true;
    },
  );
});

test('a retry happens only when a dedup key makes it safe', async () => {
  const keyed = harness([
    { status: 503, text: 'unavailable' },
    { status: 503, text: 'unavailable' },
    { status: 200, json: { wallet_transaction: { id: 'tx_2' } } },
  ]);
  const out = await keyed.transport.invoke({ method: 'POST', route: '/v1/wallets/:id/top-up', idempotencyKey: 'k' }, (client, policy) => client.wallets.topUpWallet('wal_1', {
    transactionReason: 'FREE_CREDIT_GRANT', creditsToAdd: '50', idempotencyKey: 'k',
  }, policy));
  assert.equal(out.walletTransaction.id, 'tx_2');
  assert.equal(keyed.seen.length, 3, 'an idempotency-keyed write rides out a 503');

  const unkeyed = harness([{ status: 503, text: 'unavailable' }, { status: 200, json: {} }]);
  await assert.rejects(
    () => unkeyed.transport.invoke({ method: 'POST', route: '/v1/customers' }, (client, policy) => client.customers.createCustomer({ externalId: 'o', name: 'o' }, policy)),
    FlexpriceError,
  );
  assert.equal(unkeyed.seen.length, 1, 'a POST with no key is attempted exactly once: a retry would be two customers');
});

test('retryPolicyFor names the three safe shapes and nothing else', () => {
  assert.deepEqual(retryPolicyFor({ method: 'GET' }).retries.strategy, 'backoff');
  assert.deepEqual(retryPolicyFor({ method: 'POST', idempotencyKey: 'k' }).retries.strategy, 'backoff');
  assert.deepEqual(retryPolicyFor({ method: 'POST', deduped: true }).retries.strategy, 'backoff');
  const unsafe = retryPolicyFor({ method: 'POST' });
  assert.deepEqual(unsafe.retries, { strategy: 'none' });
  assert.deepEqual(unsafe.retryCodes, []);

  const safe = retryPolicyFor({ method: 'POST', idempotencyKey: 'k' });
  assert.deepEqual(safe.retryCodes, ['429', '500', '502', '503', '504']);
  assert.equal(safe.retries.retryConnectionErrors, true, 'a dropped connection is exactly what a dedup key covers');
  // The generated loop is bounded by elapsed time, not by an attempt count, so the
  // budget is what plays the role `MAX_ATTEMPTS` used to.
  assert.deepEqual(safe.retries.backoff, { initialInterval: 150, exponent: 2, maxInterval: 600, maxElapsedTime: 900 });
});

test('the raw seam escapes its path parameters and sends the body verbatim', async () => {
  const { seen, transport } = harness([{ status: 200, json: { id: 'tx_9' } }]);
  const out = await transport.raw({
    method: 'POST',
    pattern: 'wallets/{id}/debit',
    params: { id: 'wal/1?x=2' },
    body: { transaction_reason: 'MANUAL_BALANCE_DEBIT', credits: '3000', idempotency_key: 'k' },
    idempotencyKey: 'k',
  });
  assert.deepEqual(out, { id: 'tx_9' });
  assert.equal(seen[0].url, 'http://127.0.0.1:18080/v1/wallets/wal%2F1%3Fx%3D2/debit',
    'an id from the store stays inside one path segment');
  assert.deepEqual(seen[0].body, { transaction_reason: 'MANUAL_BALANCE_DEBIT', credits: '3000', idempotency_key: 'k' },
    'no model in between may restyle a money field');
  assert.equal(seen[0].envId, 'env-1111');
  assert.equal(seen[0].apiKey, 'fp_money_secret');
});

test('a request this process failed to build never reaches the network', async () => {
  const { seen, transport } = harness([]);
  // A caller bug — a body on a GET — is thrown by the SDK's own Request build, not
  // answered by FlexPrice. It maps like every other local refusal.
  await assert.rejects(
    () => transport.raw({ method: 'GET', pattern: 'wallets/{id}', params: { id: 'wal_1' }, body: { credits: '1' } }),
    (err) => {
      assert.match(err.message, /GET \/v1\/wallets\/wal_1 failed before a response/);
      assert.match(err.message, /cannot have body/);
      assert.ok(err.cause, 'the original TypeError stays reachable');
      return true;
    },
  );
  assert.deepEqual(seen, []);
});

test('/health needs no key, and a missing key still stops a data route', async () => {
  const { seen, transport } = harness([{ status: 200, json: { health: 'ok' } }], { config: { keys: { ingest: '', money: '' } } });
  assert.deepEqual(await transport.raw({ method: 'GET', pattern: 'health', root: true, anonymous: true }), { health: 'ok' });
  assert.equal(seen[0].url, 'http://127.0.0.1:18080/health', 'health lives outside the version root');
  assert.equal(seen[0].apiKey, null, 'a stack-up check must not depend on a provisioned key');

  await assert.rejects(
    () => transport.raw({ method: 'GET', pattern: 'environments' }),
    /no API key configured for the 'money' plane/,
  );
  assert.equal(seen.length, 1);
});

test('makeFetcher refuses a /v1 request that left without the environment id', async () => {
  const sent = [];
  const fetcher = makeFetcher({ environmentId: 'env-1111', fetchImpl: async (req) => { sent.push(req.url); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); } });
  await assert.rejects(() => fetcher(new Request('http://h/v1/wallets/wal_1/balance/real-time')), /without X-Environment-ID/);
  assert.deepEqual(sent, [], 'the refusal is before the network, not after the response');

  // The rule is about the data plane: `/health` carries no tenant selector to lose.
  assert.equal(sent.length, 0);
  const ok = await fetcher(new Request('http://h/health'));
  assert.equal(ok.status, 200);

  const noEnv = makeFetcher({ environmentId: '', fetchImpl: async () => new Response('{}', { status: 200 }) });
  assert.equal((await noEnv(new Request('http://h/v1/wallets'))).status, 200, 'nothing to assert when config names no environment');

  const withHeader = await fetcher(new Request('http://h/v1/wallets', { headers: { 'X-Environment-ID': 'env-1111' } }));
  assert.equal(withHeader.status, 200);
});

test('a connection failure reads as a failure before a response, and keeps its cause', async () => {
  const { transport } = harness([{ throw: 'socket hang up' }]);
  await assert.rejects(
    () => transport.invoke({ method: 'GET', route: '/v1/wallets/:id/balance' }, (client, policy) => client.wallets.getWalletBalance('wal_1', undefined, policy)),
    (err) => {
      assert.match(err.message, /GET \/v1\/wallets\/:id\/balance failed before a response/);
      assert.ok(!/fp_money_secret/.test(err.message), 'an error message never carries a credential');
      return true;
    },
  );
});

test('asFlexpriceError finds the status through the SDK wrapper', () => {
  const inner = Object.assign(new Error('API error occurred: Status 409'), { statusCode: 409, body: '{"code":"already_exists"}' });
  const wrapped = Object.assign(new Error('Unexpected HTTP client error'), { cause: inner });
  assert.deepEqual(asFlexpriceError(wrapped, { method: 'POST', route: '/v1/w' }), {
    alreadyExists: true, status: 409, detail: { code: 'already_exists' },
  });

  const http = asFlexpriceError(Object.assign(new Error('x'), { statusCode: 400, body: '{"code":"bad_request","message":"amount out of range"}' }), { method: 'POST', route: '/v1/w' });
  assert.ok(http instanceof FlexpriceError);
  assert.equal(http.status, 400);
  assert.match(http.message, /amount out of range/);

  const validation = asFlexpriceError(Object.assign(new Error('Input validation failed: [...]'), { name: 'SDKValidationError' }), { method: 'POST', route: '/v1/e' });
  assert.ok(validation instanceof FlexpriceValidationError);

  assert.equal(asFlexpriceError(null, { method: 'GET', route: '/v1/x' }).status, 0);
});

test('the scope assertions answer both spellings and refuse an empty one', () => {
  assert.equal(scopedId('GET /v1/wallets/:id/balance/real-time', 'walletId', ' wal_1 '), 'wal_1');
  assert.throws(() => scopedId('GET /v1/x', 'walletId', '   '), FlexpriceScopeError);
  assert.equal(scopedField('POST /v1/events/usage', ['external_customer_id', 'externalCustomerId'], { externalCustomerId: 'org-a' }), 'org-a');
  assert.throws(() => scopedField('POST /v1/events/usage', ['external_customer_id', 'externalCustomerId'], {}), /external_customer_id or externalCustomerId/);
  assert.throws(() => scopedField('POST /v1/wallets/transactions/search', ['id', 'walletId'], { id: '' }), FlexpriceScopeError);
});

test('rowsOf still covers the three list envelopes the raw routes use', () => {
  assert.deepEqual(rowsOf([{ id: 'a' }]), [{ id: 'a' }]);
  assert.deepEqual(rowsOf({ items: [{ id: 'a' }] }), [{ id: 'a' }]);
  assert.deepEqual(rowsOf({ environments: [{ id: 'env-1' }] }), [{ id: 'env-1' }]);
  assert.deepEqual(rowsOf({}), []);
  assert.deepEqual(rowsOf(null), []);
});

test('isAlreadyExists matches the duplicate spellings and no other 409', () => {
  assert.equal(isAlreadyExists({ status: 409, json: { code: 'already_exists' }, text: '' }), true);
  assert.equal(isAlreadyExists({ status: 409, json: null, text: 'wallet transaction already exists' }), true);
  assert.equal(isAlreadyExists({ status: 409, json: { code: 'insufficient_balance' }, text: 'nope' }), false);
  assert.equal(isAlreadyExists({ status: 400, json: { code: 'already_exists' }, text: '' }), false);
});
