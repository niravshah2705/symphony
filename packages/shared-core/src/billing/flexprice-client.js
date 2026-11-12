'use strict';

// The one HTTP client for the FlexPrice stack.
//
// Three rules come from measurements in docs/FLEXPRICE_FINDINGS.md rather than
// from taste, so they are enforced here instead of in a README:
//
//  1. The environment id is never a parameter. Every data route needs
//     `X-Environment-ID`, and a caller that can choose it can point a correctly
//     keyed request at another environment in the same tenant. It comes from
//     config and only from config.
//  2. Retries need a dedup key. A retried POST without one is two credits, and
//     FlexPrice dedups events by `event_id` and wallet writes by an
//     `idempotency_key` JSON field (not a header — their router has none), so a
//     retry is only safe when one of those is present. GETs are treated as keyed
//     because they change nothing.
//  3. There is no method for `PUT /v1/invoices/:id/payment` on purpose. It marks
//     an invoice paid AND credits the wallet inside FlexPrice, which is the real
//     double-credit loop for a recharge we already settled through the wallet
//     API. If someone adds it, they have added the bug.
//
// A 202 from `eventsBulk` proves the request was accepted, nothing more: the
// Kafka publish happens later and a failure is swallowed. Delivery is proven by
// the outbox read-back (Phase 3), not by this client's return value.

const { FLEXPRICE } = require('./flexprice-config');

const PLANES = Object.freeze({
  // Event ingest and usage queries. Measured: an `event_ingestor` service account
  // writes events and is refused when it creates a meter.
  ingest: 'ingest',
  // Anything that can move money or change what money is owed: customers,
  // wallets, prices, meters, invoices.
  money: 'money',
});

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 150;

class FlexpriceError extends Error {
  constructor({ method, route, status, body, code }) {
    super(`flexprice ${method} ${route} -> ${status}${code ? ` ${code}` : ''}: ${truncate(body)}`);
    this.name = 'FlexpriceError';
    this.method = method;
    this.route = route;
    this.status = status;
    this.code = code || null;
    // The parsed body when it is JSON. Callers that branch on a specific
    // FlexPrice error read this instead of matching the message string.
    this.body = body;
  }
}

function truncate(value, max = 400) {
  const text = typeof value === 'string' ? value : safeStringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safeStringify(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

// Every id that reaches a URL is interpolated into a path segment, and the ids
// come from the store or from a FlexPrice response — not from a literal. Encoding
// here means a value containing `/` or `?` addresses one wallet rather than
// rewriting the route.
const seg = (value) => encodeURIComponent(String(value));

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Build a client over a config snapshot.
 *
 * `fetchImpl` is injectable so the unit tests (and the Phase 5 Zoho contract
 * test) run without a stack. There is no default key argument: a client that
 * could be handed a key would be a client that gets handed the config-map one.
 */
function createFlexpriceClient({ config = FLEXPRICE, fetchImpl = globalThis.fetch, sleep = defaultSleep } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('flexprice-client: global fetch is unavailable; pass fetchImpl');
  }
  const base = String(config.baseUrl || '').replace(/\/+$/, '');
  const environmentId = config.environmentId;

  function headersFor(plane) {
    const key = config.keys && config.keys[plane];
    if (!key) {
      // A missing plane key is a config error, not an HTTP error: say which
      // plane, so the operator runs provisioning rather than rotating a secret
      // that was never the problem.
      throw new Error(`flexprice-client: no API key configured for the '${plane}' plane (run scripts/flexprice-provision.js)`);
    }
    const headers = { 'x-api-key': key, 'Content-Type': 'application/json' };
    // `/health` is the one route that needs neither; sending a bogus header there
    // would make a stack-up check fail on config instead of on the stack.
    if (environmentId) headers['X-Environment-ID'] = environmentId;
    return headers;
  }

  async function once({ plane, method, route, body }) {
    const url = `${base}${route}`;
    const headers = plane === null ? {} : headersFor(plane);
    const res = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : safeStringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const text = await res.text();
    const json = parseJson(text);
    return { status: res.status, text, json };
  }

  async function request(opts) {
    const { method, route } = opts;
    // `idempotency_key` is a JSON field FlexPrice reads (dto/wallet.go:346,589);
    // there is no `Idempotency-Key` header anywhere in their router, so sending
    // one would buy a retry that duplicates the write. Events have no such field
    // — their dedup is `event_id`, first-wins — so a caller that is safe to retry
    // for another reason says so with `deduped`.
    const body = opts.idempotencyKey && method !== 'GET'
      ? { ...(opts.body || {}), idempotency_key: opts.idempotencyKey }
      : opts.body;
    const mayRetry = opts.deduped === true || method === 'GET' || Boolean(opts.idempotencyKey);
    let lastError = null;
    for (let attempt = 1; attempt <= (mayRetry ? MAX_ATTEMPTS : 1); attempt += 1) {
      let out;
      try {
        out = await once({ plane: opts.plane, method, route, body });
      } catch (err) {
        // Timeout / connection refused: the request may or may not have landed,
        // which is exactly what a dedup key is for.
        lastError = new Error(`flexprice ${method} ${route} failed before a response: ${err.message}`);
        if (!mayRetry || attempt === MAX_ATTEMPTS) throw lastError;
        await sleep(BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      if (out.status >= 200 && out.status < 300) return out.json === null ? { raw: out.text } : out.json;
      if (isAlreadyExists(out)) {
        // FlexPrice mints most resources under a unique index and answers 409
        // without a pre-check, so a replay is indistinguishable from a competing
        // creator. Both mean the resource exists: report it, do not raise.
        return { alreadyExists: true, status: out.status, detail: out.json || out.text };
      }
      if (RETRYABLE_STATUS.has(out.status) && mayRetry && attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      throw new FlexpriceError({
        method,
        route,
        status: out.status,
        body: out.json || out.text,
        code: out.json && (out.json.code || out.json.error_code),
      });
    }
    throw lastError || new Error(`flexprice ${method} ${route}: exhausted attempts`);
  }

  const get = (route, opts = {}) => request({ plane: opts.plane || 'money', method: 'GET', route, ...opts });
  const post = (route, body, opts = {}) => request({ plane: 'money', method: 'POST', route, body, ...opts });

  return {
    // Read-only knobs a caller may legitimately want.
    planes: PLANES,
    request,

    getHealth: () => request({ plane: null, method: 'GET', route: '/health' }),

    // ---- catalog (money plane) ------------------------------------------------
    listEnvironments: () => get('/v1/environments'),
    createCustomer: (customer) => post('/v1/customers', customer),
    getCustomerByExternalId: (externalId) => get(`/v1/customers/external/${seg(externalId)}`),
    createMeter: (meter) => post('/v1/meters', meter),
    listMeters: () => get('/v1/meters'),
    createPrice: (price) => post('/v1/prices', price),
    searchPrices: (query) => post('/v1/prices/search', query),

    // ---- wallets (money plane) -----------------------------------------------
    createWallet: (wallet) => post('/v1/wallets', wallet),
    listWalletsByCustomer: (customerId) => get(`/v1/customers/${seg(customerId)}/wallets`),
    topUpWallet: (walletId, body, opts = {}) => post(`/v1/wallets/${seg(walletId)}/top-up`, body, opts),
    /**
     * Promotional / free credit grant.
     *
     * `FREE_CREDIT_GRANT` and nothing else: `bonus_credits_to_add` produces a
     * PURCHASED_CREDIT_BONUS row which poisons `credits_available_breakdown`
     * while still returning HTTP 200.
     */
    grantPromo: (walletId, { credits, expiresAt = null, priority = 0, idempotencyKey, description } = {}) => {
      if (!idempotencyKey) throw new TypeError('flexprice-client: grantPromo requires an idempotencyKey');
      return post(`/v1/wallets/${seg(walletId)}/top-up`, {
        transaction_reason: 'FREE_CREDIT_GRANT',
        credits_to_add: String(credits),
        priority,
        ...(expiresAt ? { expiry_date_utc: expiresAt } : {}),
        ...(description ? { description } : {}),
      }, { idempotencyKey });
    },
    /**
     * The only route that can push a balance below zero, and the only reason the
     * gate needs three states. `idempotencyKey` is required here even though the
     * API tolerates its absence, because a platform charge without one is a
     * charge that can be applied twice.
     */
    debitWallet: (walletId, { credits, idempotencyKey, description, metadata } = {}) => {
      if (!idempotencyKey) throw new TypeError('flexprice-client: debitWallet requires an idempotencyKey');
      return post(`/v1/wallets/${seg(walletId)}/debit`, {
        transaction_reason: 'MANUAL_BALANCE_DEBIT',
        credits: String(credits),
        ...(description ? { description } : {}),
        ...(metadata ? { metadata } : {}),
      }, { idempotencyKey });
    },
    walletRealTimeBalance: (walletId, { cached = false, expand = null } = {}) => {
      const q = expand ? `?expand=${encodeURIComponent(expand)}` : '';
      return get(`/v1/wallets/${seg(walletId)}/balance/${cached ? 'real-time-cached' : 'real-time'}${q}`);
    },
    walletTransactionsSearch: (query) => post('/v1/wallets/transactions/search', query),

    // ---- events (ingest plane) -----------------------------------------------
    // Retry-safe because `event_id` is the dedup key and the store is first-wins
    // (measured): a replay of the same id adds nothing, and a replay with a
    // different value under the same id is dropped rather than overwriting.
    ingestEvent: (event, opts = {}) => post('/v1/events', event, { plane: PLANES.ingest, deduped: true, ...opts }),
    eventsBulk: (events, opts = {}) => post('/v1/events/bulk', { events }, { plane: PLANES.ingest, deduped: true, ...opts }),
    eventsUsage: (query) => post('/v1/events/usage', query, { plane: PLANES.ingest }),
    eventsUsageMeter: (query) => post('/v1/events/usage/meter', query, { plane: PLANES.ingest }),

    // ---- invoices (money plane) ----------------------------------------------
    createInvoice: (invoice) => post('/v1/invoices', invoice),
    getInvoice: (invoiceId) => get(`/v1/invoices/${seg(invoiceId)}`),
    finalizeInvoice: (invoiceId, opts = {}) => post(`/v1/invoices/${seg(invoiceId)}/finalize`, undefined, opts),
  };
}

function isAlreadyExists(out) {
  if (out.status !== 409) return false;
  const text = `${out.json && (out.json.code || out.json.message) || ''} ${out.text || ''}`.toLowerCase();
  return /already_exists|already exists|duplicate|conflict/.test(text);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  PLANES,
  FlexpriceError,
  createFlexpriceClient,
  isAlreadyExists,
};
