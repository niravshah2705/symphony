'use strict';

// The FlexPrice transport.
//
// Everything in this directory that needs FlexPrice asks here, and here answers
// through `@flexprice/sdk` — a generated operation where one exists, and where
// one does not, the SDK's own HTTP client, security resolution, retry wrapper,
// timeout and `X-Environment-ID` hook. Either way there is no `fetch()` and no
// per-call URL construction left in the billing code, which is the point of the
// migration: the wire is described in one place, by the vendor's types.
//
// ## Why some routes are still "raw"
//
// The generated client is only as complete as the spec FlexPrice published, and
// six routes this repo uses are not in it:
//
//   POST /v1/wallets/:id/debit  — no `debit` operation on `wallets` (the one route
//                                 that can drive a balance below zero).
//   POST /v1/meters, GET /v1/meters — there is no `meters` resource at all.
//   GET  /v1/environments       — only `cloneEnvironment` is generated.
//   GET  /health                — outside `/v1`, and sent without credentials.
//   POST /v1/events, POST /v1/events/bulk — the generated `IngestEventRequest`
//                                 types `properties` as `record<string, string>`
//                                 with a strict string, so `cost_paise: 4120` is
//                                 either refused or quoted. FlexPrice stores
//                                 properties in a `map[string]interface{}` and the
//                                 meter aggregates the value as a float
//                                 (docs/FLEXPRICE_FINDINGS.md §9 B), and a quoted
//                                 number is the silent-zero-billing bug this repo
//                                 already guards elsewhere: 202 accepted, nothing
//                                 billed. So ingest keeps its measured body here.
//
// Those calls take no arguments that could widen them: `raw()` builds the URL from
// the SDK's base plus a pattern whose parameters it percent-encodes, so the only
// inputs are the route and its scope.
//
// ## The four rules, now enforced on SDK knobs
//
//  1. The environment id is never a parameter. It comes from config and reaches
//     every `/v1/` request through the SDK's own auth hook; `makeFetcher` refuses
//     a data request that left without it, so a future transport option cannot
//     drop it silently.
//  2. Retries need a dedup key (`retryPolicyFor`). The SDK defaults to no retries
//     and to an unbounded timeout, which are both wrong in opposite directions
//     here, so each call states its own policy: time-bounded exponential backoff
//     only when a GET, an `idempotency_key` or an event id makes a replay safe.
//  3. There is no method here for `PUT /v1/invoices/:id/payment`, and the façade
//     must not grow one: it marks an invoice paid AND credits the wallet, which
//     is the double-credit loop for a recharge already settled through the wallet
//     API. `attemptInvoicePayment` and `updateInvoicePaymentStatus` exist on the
//     generated `invoices` resource and are deliberately unreachable.
//  4. A scoped query must name its scope (`scopedId` / `scopedField`, checked
//     before transport) — one FlexPrice key spans the tenant, so an unscoped
//     wallet, ledger or usage read is a cross-tenant read.
//
// A 202 from the ingest routes proves the request was accepted, nothing more: the
// Kafka publish happens later and a failure is swallowed. Delivery is proven by the
// outbox read-back, not by this client's return value.

const { FLEXPRICE } = require('./flexprice-config');

const PLANES = Object.freeze({
  // Event ingest and usage queries. Measured: an `event_ingestor` service account
  // writes events and is refused when it creates a meter.
  ingest: 'ingest',
  // Anything that can move money or change what money is owed: customers,
  // wallets, prices, meters, invoices.
  money: 'money',
});

// The SDK matches these with the same spelling the HTTP spec uses: exact codes,
// `4XX`/`5XX` families, and `default`.
const RETRYABLE_CODES = Object.freeze(['429', '500', '502', '503', '504']);
// The generated retry loop is bounded by elapsed time, not by an attempt count
// (there is no `retries: 3` in this SDK), so the budget is what caps the
// attempts: 150ms then 300ms of waiting is three tries, like the hand-rolled
// client this replaces.
const BACKOFF = Object.freeze({
  initialInterval: 150,
  exponent: 2,
  maxInterval: 600,
  maxElapsedTime: 900,
});

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

/**
 * A wallet- or customer-scoped read that does not name its scope is not a wider
 * query — one FlexPrice key spans the tenant, so it is every org's ledger in one
 * response. The discriminator is therefore part of the method contract and is
 * checked here, before transport: an unscoped money query is unrepresentable
 * rather than discouraged.
 */
class FlexpriceScopeError extends Error {
  constructor(route, field) {
    super(`flexprice-client: ${route} requires a non-empty '${field}' — without it the query returns every organization in the environment`);
    this.name = 'FlexpriceScopeError';
    this.route = route;
    this.field = field;
    this.code = 'unscoped_query';
  }
}

/**
 * The SDK's own input validation refusing our payload. Not a FlexPrice error: it
 * means this repo built a request the vendor's model does not describe, which is
 * a bug to read, not a status to branch on. `status: 0` keeps it from matching
 * any `err.status === 404` check on the money paths.
 */
class FlexpriceValidationError extends Error {
  constructor({ method, route, detail }) {
    super(`flexprice ${method} ${route} was rejected before transport: ${detail}`);
    this.name = 'FlexpriceValidationError';
    this.method = method;
    this.route = route;
    this.status = 0;
    this.code = 'invalid_request';
  }
}

function truncate(value, max = 400) {
  const text = typeof value === 'string' ? value : safeStringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safeStringify(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function scopedId(route, field, value) {
  const id = value === undefined || value === null ? '' : String(value).trim();
  if (!id) throw new FlexpriceScopeError(route, field);
  return id;
}

/**
 * The query-body form. Accepts the snake_case and camelCase spelling of each
 * accepted field, because the request bodies move to the SDK's camelCase models
 * while this assertion must keep holding across that change.
 */
function scopedField(route, fields, query) {
  for (const field of fields) {
    const value = query && query[field];
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  throw new FlexpriceScopeError(route, fields.join(' or '));
}

/**
 * The route for an error message. `pattern` is the SDK-relative template and
 * `params` are substituted *unencoded* — a label reading `wal%2F1` sends a reader
 * to a wallet that does not exist. The façade never spells a URL, so this is where
 * the version root reappears in a message, which is also where `serverURL` put it
 * on the wire.
 */
function labelOf({ pattern = null, params = {}, route = null, root = false }) {
  if (route) return route;
  const filled = String(pattern || '').replace(/\{([^}]+)\}/g, (all, key) => (key in params ? String(params[key]) : all));
  return `${root ? '/' : '/v1/'}${filled}`;
}

/**
 * The rows of a list response, whichever of its three shapes FlexPrice used.
 *
 * Measured against the live stack: search routes answer `{items}`, `GET
 * /v1/environments` answers `{environments}`, and `GET /v1/customers/:id/wallets`
 * answers a bare array. A caller that picks one of those keys and finds nothing
 * does not get an error — it gets "there are none", which in the wallet case
 * means creating a resource that already exists and reading back no id.
 *
 * Generated operations answer a typed model and never need this; it stays for the
 * `raw()` routes, which are exactly the ones with no schema to vouch for them.
 */
function rowsOf(out) {
  if (Array.isArray(out)) return out;
  if (!out || typeof out !== 'object') return [];
  const keyed = ['items', 'data', 'environments', 'wallets', 'prices', 'meters'];
  for (const key of keyed) if (Array.isArray(out[key])) return out[key];
  return [];
}

function isAlreadyExists(out) {
  if (!out || out.status !== 409) return false;
  const text = `${out.json && (out.json.code || out.json.message) || ''} ${out.text || ''}`.toLowerCase();
  return /already_exists|already exists|duplicate|conflict/.test(text);
}

/**
 * `@flexprice/sdk` is ESM-only (`"type": "module"`, no `require` condition), and
 * the client factory that 20+ call sites use is synchronous. So the import is a
 * memoized promise that the async methods await internally — the façade keeps its
 * shape and the module is loaded exactly once per process.
 */
let sdkLoad = null;
function loadFlexpriceSdk() {
  if (!sdkLoad) sdkLoad = import('@flexprice/sdk');
  return sdkLoad;
}

/** Rule 2: which calls may be replayed, and with what backoff. */
function retryPolicyFor({ method = 'GET', idempotencyKey = null, deduped = false } = {}) {
  const keyed = method === 'GET' || Boolean(idempotencyKey) || deduped === true;
  if (!keyed) return { retries: { strategy: 'none' }, retryCodes: [] };
  return {
    retries: {
      strategy: 'backoff',
      backoff: { ...BACKOFF },
      // A connection failure is the case the dedup key exists for: the request may
      // or may not have landed, which is exactly what a replay is safe against.
      retryConnectionErrors: true,
    },
    retryCodes: [...RETRYABLE_CODES],
  };
}

/** The first error in the chain that carries an HTTP status, if any. */
function httpErrorIn(err) {
  for (let node = err, depth = 0; node && depth < 5; depth += 1) {
    if (typeof node.statusCode === 'number' && node.statusCode > 0) return node;
    node = node.cause;
  }
  return null;
}

/**
 * One error shape for both transports, so every caller's existing branch keeps
 * working: `err.status === 404` (`gate.js`), `err.status === 409`
 * (`recharge-settle.js`), and a 409 duplicate reported as
 * `{ alreadyExists: true, status, detail }` rather than thrown.
 *
 * The SDK reports a status on `FlexPriceError` subclasses, with the response body
 * as TEXT in `err.body` (`rawResponse` is already consumed by that point), and
 * wraps transport-level failures in an `UnexpectedClientError` whose real cause is
 * one level down.
 */
function asFlexpriceError(err, { method, route }) {
  if (!err) return new FlexpriceError({ method, route, status: 0, body: 'unknown error' });
  if (err instanceof FlexpriceError || err instanceof FlexpriceValidationError) return err;

  const http = httpErrorIn(err);
  if (http) {
    const status = http.statusCode;
    const text = typeof http.body === 'string' ? http.body : safeStringify(http.body);
    const json = parseJson(text);
    const code = (json && (json.code || json.error_code)) || http.code || null;
    // FlexPrice mints most resources under a unique index and answers 409 without
    // a pre-check, so a replay is indistinguishable from a competing creator. Both
    // mean the resource exists: report it, do not raise.
    if (isAlreadyExists({ status, json, text })) {
      return { alreadyExists: true, status, detail: json || text };
    }
    return new FlexpriceError({ method, route, status, body: json || text, code });
  }

  const detail = String(err.message || err.rawMessage || err || '');
  if (err.name === 'SDKValidationError' || /Input validation failed|rejected the request/i.test(detail)) {
    return new FlexpriceValidationError({ method, route, detail: truncate(detail, 300) });
  }
  // No status at all: the request never got an answer (timeout, refused
  // connection, or a hook that refused to send it).
  return new Error(`flexprice ${method} ${route} failed before a response: ${truncate(detail, 200)}`, { cause: err });
}

/**
 * A request leaves this process with the environment id on it, or it does not
 * leave. `/health` is the one route outside `/v1/` that needs neither credentials
 * nor an environment, so the rule is scoped to the data plane rather than to the
 * transport.
 */
function makeFetcher({ fetchImpl, environmentId }) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('flexprice-sdk: global fetch is unavailable; pass fetchImpl');
  }
  return async function fetchWithEnvironmentId(request) {
    const path = String(request.url || '').replace(/^https?:\/\/[^/]+/i, '');
    if (environmentId && path.startsWith('/v1/') && !request.headers.get('x-environment-id')) {
      throw new Error(`flexprice-sdk: refusing to send ${path.split('?')[0]} without X-Environment-ID`);
    }
    return fetchImpl(request);
  };
}

/**
 * One SDK client per plane. Two keys, two clients, because the planes are the
 * measured write boundary (`FLEXPRICE_FINDINGS.md` §7) and a client that carried
 * both would let an ingest call move money.
 *
 * `fetchImpl` is the test seam: it receives the final `Request`, exactly as the
 * SDK's own `HTTPClient` hands it over, after auth headers, timeout signal and
 * retry cloning have all been applied.
 */
function createSdkTransport({ config = FLEXPRICE, plane = PLANES.money, fetchImpl = globalThis.fetch } = {}) {
  const base = String(config.baseUrl || '').replace(/\/+$/, '');
  const environmentId = String(config.environmentId || '');
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : undefined;
  const key = String((config.keys && config.keys[plane]) || '');
  let boot = null;

  /**
   * A missing plane key is a config error, not an HTTP error: say which plane, so
   * the operator runs provisioning rather than rotating a secret that was never
   * the problem. Checked per call rather than at construction, because `/health`
   * needs no key and a stack-up check has to work before provisioning does.
   */
  async function started({ credential = true } = {}) {
    if (credential && !key) {
      throw new Error(`flexprice-client: no API key configured for the '${plane}' plane (run scripts/flexprice-provision.js)`);
    }
    if (!boot) boot = build().catch((err) => { boot = null; throw err; });
    return boot;
  }

  async function build() {
    const [sdk, url] = await Promise.all([loadFlexpriceSdk(), import('@flexprice/sdk/lib/url.js')]);
    const client = new sdk.Flexprice({
      // Generated paths are relative to the version root, so the `/v1` the
      // hand-rolled client spelled on every route lives here instead.
      serverURL: `${base}/v1`,
      apiKeyAuth: key,
      environmentId,
      timeoutMs,
      httpClient: new sdk.HTTPClient({ fetcher: makeFetcher({ fetchImpl, environmentId }) }),
    });
    return { sdk, client, pathToFunc: url.pathToFunc };
  }

  /** The generated `client` object, for `run` to call one operation on. */
  async function invoke(spec, run) {
    const labeled = { ...spec, route: labelOf(spec) };
    const { client } = await started();
    const policy = retryPolicyFor(labeled);
    try {
      return await run(client, policy);
    } catch (err) {
      const mapped = asFlexpriceError(err, labeled);
      if (mapped && mapped.alreadyExists) return mapped;
      throw mapped;
    }
  }

  /**
   * A route with no generated operation, on the same client, the same auth hook
   * and the same retry/timeout seam — only the response matcher is this file's,
   * because there is no model to match against.
   *
   * `pattern` is a path template relative to `/v1` (`wallets/{id}/debit`) and
   * `params` are percent-encoded into it, so an id from the store cannot rewrite
   * the route.
   */
  async function raw(spec) {
    const { method, pattern, params = {}, body, root = false, anonymous = false } = spec;
    const display = labelOf(spec);
    const scoped = { ...spec, route: display, method };
    const { client, pathToFunc } = await started({ credential: !anonymous });
    const path = pathToFunc(pattern, { charEncoding: 'percent' })(params);
    const policy = retryPolicyFor(scoped);
    const context = {
      options: client._options,
      baseURL: client._baseURL,
      operationID: `raw:${display}`,
      oAuth2Scopes: null,
      resolvedSecurity: null,
      securitySource: client._options.apiKeyAuth,
      retryConfig: policy.retries,
      retryCodes: policy.retryCodes,
    };
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // `/health` is the one route sent without credentials; everything else on
    // this seam carries the plane key. The environment id is NOT set here — the
    // SDK's own auth hook puts it on, which is why `makeFetcher`'s assertion is
    // meaningful for a raw call too.
    const key = anonymous ? '' : String((config.keys && config.keys[plane]) || '');
    if (key) headers['x-api-key'] = key;

    // `_createRequest` builds a `Request`, so a caller bug — a body on a GET —
    // throws here rather than arriving as a rejected result. Mapped like every
    // other local refusal, because the money paths branch on `err.status`.
    let request;
    try {
      request = client._createRequest(context, {
        method,
        path: root ? `../${path}` : path,
        headers: new Headers(headers),
        body: body === undefined ? undefined : safeStringify(body),
        userAgent: client._options.userAgent,
        timeoutMs,
      }, {});
    } catch (err) {
      throw asFlexpriceError(err, scoped);
    }
    if (!request.ok) throw asFlexpriceError(request.error, scoped);

    const response = await client._do(request.value, {
      context,
      isErrorStatusCode: (status) => status >= 400,
      retryConfig: policy.retries,
      retryCodes: policy.retryCodes,
    });
    if (!response.ok) {
      const mapped = asFlexpriceError(response.error, scoped);
      if (mapped && mapped.alreadyExists) return mapped;
      throw mapped;
    }
    const text = await response.value.text();
    const json = parseJson(text);
    const status = response.value.status;
    if (status >= 200 && status < 300) return json === null ? { raw: text } : json;
    const duplicate = isAlreadyExists({ status, json, text });
    if (duplicate) return { alreadyExists: true, status, detail: json || text };
    throw new FlexpriceError({
      method,
      route: display,
      status,
      body: json || text,
      code: json && (json.code || json.error_code),
    });
  }

  return {
    plane,
    config,
    started,
    invoke,
    raw,
    /** The SDK module, for callers that need a model helper. */
    load: loadFlexpriceSdk,
  };
}

module.exports = {
  PLANES,
  BACKOFF,
  RETRYABLE_CODES,
  FlexpriceError,
  FlexpriceScopeError,
  FlexpriceValidationError,
  asFlexpriceError,
  createSdkTransport,
  isAlreadyExists,
  loadFlexpriceSdk,
  makeFetcher,
  retryPolicyFor,
  rowsOf,
  safeStringify,
  scopedField,
  scopedId,
  truncate,
};
