'use strict';

// The one FlexPrice client for the billing surface.
//
// This file is a façade: it names the operations the product performs and binds
// each to a plane. `flexprice-sdk.js` is the transport that answers them through
// `@flexprice/sdk`. Nothing here builds a URL, sets a header, retries a request or
// calls `fetch` — that is the point of the migration, and it is what makes the
// four rules below properties of the client rather than habits of the caller.
//
// The rules, restated from `docs/FLEXPRICE_FINDINGS.md` (the transport's header
// says how each is now enforced on SDK knobs):
//
//  1. The environment id is never a parameter. It comes from config and only from
//     config, and a request that would leave without it does not leave.
//  2. Retries need a dedup key: a GET, an `idempotencyKey`, or an event id whose
//     store row is first-wins. A retried POST without one is two credits.
//  3. There is no method here for `PUT /v1/invoices/:id/payment`, and the façade
//     must not grow one. It marks an invoice paid AND credits the wallet inside
//     FlexPrice — the double-credit loop for a recharge already settled through
//     the wallet API. `attemptInvoicePayment` and `updateInvoicePaymentStatus`
//     exist on the generated `invoices` resource and are deliberately unreachable.
//  4. A scoped query must name its scope. Wallet, transaction and usage reads
//     carry a wallet id or an `external_customer_id` (see `FlexpriceScopeError`):
//     with one key for the whole tenant, an unscoped read is a cross-tenant read.
//
// ## What the SDK changed for callers
//
// Request bodies and responses are the generated models: **camelCase in,
// camelCase out**. The wire still carries snake_case because the models remap it,
// so a route contract that was measured against the live stack (`idempotency_key`
// in the body, `event_id` as the event dedup key) holds exactly as before — it is
// just no longer spelled by this repo.
//
// Two bodies therefore stay snake_case, on purpose:
//
//   * event ingest (`ingestEvent`, `eventsBulk`) — `IngestEventRequest.properties`
//     is typed `record<string, string>`, so `token_credits: 4120` is either refused or
//     quoted, and a quoted number aggregates as zero: 202 accepted, nothing billed.
//     Ingest rides the transport's raw seam with the measured body.
//   * `debitWallet` — there is no generated `debit` operation at all.
//
// Dates: the store and the jobs hold ISO strings, the models want `Date`. The
// façade converts on the fields it knows are typed `z.date()`, so a caller may
// pass either; an unparseable value becomes the SDK's own validation error rather
// than a silently dropped bound.
//
// A 202 from `eventsBulk` proves the request was accepted, nothing more: the Kafka
// publish happens later and a failure is swallowed. Delivery is proven by the
// outbox read-back, not by this client's return value.

const { FLEXPRICE } = require('./flexprice-config');
const {
  PLANES,
  FlexpriceError,
  FlexpriceScopeError,
  FlexpriceValidationError,
  createSdkTransport,
  isAlreadyExists,
  rowsOf,
  scopedField,
  scopedId,
} = require('./flexprice-sdk');

/** Normalize the date-typed fields of a request body; leave everything else alone. */
function withDates(body, fields) {
  const out = { ...body };
  for (const field of fields) {
    const value = out[field];
    if (value === undefined || value === null || value === '') continue;
    out[field] = value instanceof Date ? value : new Date(value);
  }
  return out;
}

/**
 * Build a client over a config snapshot.
 *
 * `fetchImpl` is injectable so the unit tests (and the Phase 5 Zoho contract test)
 * run without a stack; it is the transport's seam and receives the finished
 * `Request`, after auth headers, timeout and retry cloning. There is no key
 * argument: a client that could be handed a key would be a client that gets handed
 * the config-map one.
 */
function createFlexpriceClient({ config = FLEXPRICE, fetchImpl = globalThis.fetch } = {}) {
  const transports = {
    [PLANES.money]: createSdkTransport({ config, plane: PLANES.money, fetchImpl }),
    [PLANES.ingest]: createSdkTransport({ config, plane: PLANES.ingest, fetchImpl }),
  };
  const money = transports[PLANES.money];
  const ingest = transports[PLANES.ingest];
  const at = (plane) => (plane === PLANES.ingest ? ingest : money);

  function topUp(walletId, body, idempotencyKey) {
    const id = scopedId('POST wallets/:id/top-up', 'walletId', walletId);
    // `idempotency_key` is a JSON field FlexPrice reads; their router has no
    // `Idempotency-Key` header, so sending one would buy a retry that duplicates
    // the write. The model remaps this back to the snake_case name on the wire.
    const request = withDates(
      { ...body, ...(idempotencyKey ? { idempotencyKey } : {}) },
      ['effectiveDate'],
    );
    return money.invoke(
      { method: 'POST', pattern: 'wallets/{id}/top-up', params: { id }, idempotencyKey },
      (client, policy) => client.wallets.topUpWallet(id, request, policy),
    );
  }

  return {
    // Read-only knobs a caller may legitimately want.
    planes: PLANES,

    /**
     * The seam for a route this façade does not model — an admin call a provisioning
     * or probe script makes against `/v1/secrets/api/keys`, `/v1/plans`, a price
     * lookup. It rides the transport, so the environment id, the plane key, the
     * timeout and the retry rule still apply. What it cannot do is enforce rule 4:
     * nothing here asserts a scope on a route it does not know, which is why no
     * request path in the product calls it.
     */
    request: (opts = {}) => {
      const { plane = PLANES.money, method = 'GET', route, body, idempotencyKey = null, deduped = false } = opts;
      if (typeof route !== 'string' || !route.startsWith('/')) {
        throw new TypeError(`flexprice-client: request() requires a route beginning with '/', got ${String(route)}`);
      }
      const underVersionRoot = route.startsWith('/v1/');
      return at(plane).raw({
        method,
        pattern: underVersionRoot ? route.slice('/v1/'.length) : route.slice(1),
        root: !underVersionRoot,
        route,
        body,
        idempotencyKey,
        deduped,
      });
    },

    getHealth: () => money.raw({ method: 'GET', pattern: 'health', root: true, anonymous: true }),

    // ---- catalog (money plane) ------------------------------------------------
    // `GET /v1/environments` has no generated operation (`cloneEnvironment` only).
    listEnvironments: () => money.raw({ method: 'GET', pattern: 'environments' }),
    createCustomer: (customer) => money.invoke(
      { method: 'POST', pattern: 'customers' },
      (client, policy) => client.customers.createCustomer(customer, policy),
    ),
    getCustomerByExternalId: (externalId) => {
      const id = scopedId('GET customers/external/:external_id', 'externalId', externalId);
      return money.invoke(
        { method: 'GET', pattern: 'customers/external/{external_id}', params: { external_id: id } },
        (client, policy) => client.customers.getCustomerByExternalId(id, policy),
      );
    },
    // There is no `meters` resource in the published spec at all.
    createMeter: (meter) => money.raw({ method: 'POST', pattern: 'meters', body: meter }),
    listMeters: () => money.raw({ method: 'GET', pattern: 'meters' }),
    createPrice: (price) => money.invoke(
      { method: 'POST', pattern: 'prices' },
      (client, policy) => client.prices.createPrice(price, policy),
    ),
    searchPrices: (query) => money.invoke(
      { method: 'POST', pattern: 'prices/search' },
      (client, policy) => client.prices.queryPrice(query, policy),
    ),

    // ---- wallets (money plane) -----------------------------------------------
    createWallet: (wallet) => money.invoke(
      { method: 'POST', pattern: 'wallets' },
      (client, policy) => client.wallets.createWallet(wallet, policy),
    ),
    /**
     * The org's own wallets, as `{ items }`.
     *
     * `GET /v1/customers/:id/wallets` answers a BARE JSON array (measured live, and
     * the generated matcher is `z.array(WalletResponse)`), unlike the search routes'
     * `{items}` envelope. Normalising it here is not decoration: a caller that reads
     * `out.items` off a bare array gets `undefined`, treats it as "this customer has
     * no wallets", re-creates one, takes the `409 already_exists` echo as the created
     * resource, and then reads the balance of wallet `undefined`.
     */
    listWalletsByCustomer: async (customerId) => {
      const id = scopedId('GET customers/:id/wallets', 'customerId', customerId);
      const wallets = await money.invoke(
        { method: 'GET', pattern: 'customers/{id}/wallets', params: { id } },
        (client, policy) => client.wallets.getWalletsByCustomerId(id, policy),
      );
      return { items: wallets };
    },
    topUpWallet: (walletId, body = {}, opts = {}) => topUp(
      walletId,
      body,
      opts.idempotencyKey || body.idempotencyKey || null,
    ),
    /**
     * Promotional / free credit grant.
     *
     * `FREE_CREDIT_GRANT` and nothing else: `bonus_credits_to_add` produces a
     * PURCHASED_CREDIT_BONUS row which poisons `credits_available_breakdown`
     * while still returning HTTP 200.
     */
    grantPromo: (walletId, { credits, expiresAt = null, priority = 0, idempotencyKey, description } = {}) => {
      if (!idempotencyKey) throw new TypeError('flexprice-client: grantPromo requires an idempotencyKey');
      return topUp(walletId, {
        transactionReason: 'FREE_CREDIT_GRANT',
        creditsToAdd: String(credits),
        priority,
        ...(expiresAt ? { expiryDateUtc: expiresAt } : {}),
        ...(description ? { description } : {}),
      }, idempotencyKey);
    },
    /**
     * The only route that can push a balance below zero, and the only reason the
     * gate needs three states. `idempotencyKey` is required here even though the
     * API tolerates its absence, because a platform charge without one is a charge
     * that can be applied twice.
     *
     * Raw seam, and the body keeps FlexPrice's own snake_case field names: there is
     * no generated `debit` operation, so there is no model to serialize it.
     */
    debitWallet: (walletId, { credits, idempotencyKey, description, metadata } = {}) => {
      if (!idempotencyKey) throw new TypeError('flexprice-client: debitWallet requires an idempotencyKey');
      const id = scopedId('POST wallets/:id/debit', 'walletId', walletId);
      return money.raw({
        method: 'POST',
        pattern: 'wallets/{id}/debit',
        params: { id },
        idempotencyKey,
        body: {
          transaction_reason: 'MANUAL_BALANCE_DEBIT',
          credits: String(credits),
          idempotency_key: idempotencyKey,
          ...(description ? { description } : {}),
          ...(metadata ? { metadata } : {}),
        },
      });
    },
    /**
     * The wallet's live projection. The transport has one balance route,
     * `.../balance/real-time`: the SDK does not generate the `real-time-cached`
     * variant, and nothing in the product asked for a second, staler number.
     */
    walletRealTimeBalance: (walletId, { expand = null } = {}) => {
      const id = scopedId('GET wallets/:id/balance/real-time', 'walletId', walletId);
      return money.invoke(
        { method: 'GET', pattern: 'wallets/{id}/balance/real-time', params: { id } },
        (client, policy) => client.wallets.getWalletBalance(id, expand || undefined, policy),
      );
    },
    /**
     * One wallet's ledger rows. The model's discriminator is `id`; `walletId` is
     * accepted as the caller-facing spelling and renamed, never passed through —
     * a key the model does not know is a key it drops, and a dropped `id` on this
     * route is every wallet in the environment.
     */
    walletTransactionsSearch: (query = {}) => {
      const walletId = scopedField('POST wallets/transactions/search', ['id', 'walletId'], query);
      const filter = withDates({ ...query, id: String(walletId).trim() }, ['startTime', 'endTime']);
      return money.invoke(
        { method: 'POST', pattern: 'wallets/transactions/search' },
        (client, policy) => client.wallets.queryWalletTransaction(filter, policy),
      );
    },

    // ---- events (ingest plane) -----------------------------------------------
    // Retry-safe because `event_id` is the dedup key and the store is first-wins
    // (measured): a replay of the same id adds nothing, and a replay with a
    // different value under the same id is dropped rather than overwriting. Raw
    // seam, because the generated model would quote a numeric `properties` value
    // and a quoted number aggregates as zero.
    ingestEvent: (event, opts = {}) => ingest.raw({ method: 'POST', pattern: 'events', body: event, deduped: true, ...opts }),
    eventsBulk: (events, opts = {}) => ingest.raw({ method: 'POST', pattern: 'events/bulk', body: { events }, deduped: true, ...opts }),
    /**
     * Aggregated usage for one event name. `aggregationType` is required by the
     * model and is not defaulted here: SUM for a cost meter and COUNT_UNIQUE for a
     * seats meter are different bills, and a client that guesses which one the
     * caller meant is the bug this repo already guards elsewhere.
     *
     * The selector is `externalCustomerId` and nothing else. Accepting the old
     * snake_case spelling here would be the cross-tenant read Part A exists to
     * prevent: the assertion would pass, and the model would strip the key it does
     * not know — an unscoped usage query that looks scoped in the log.
     */
    eventsUsage: (query = {}) => {
      scopedId('POST events/usage', 'externalCustomerId', query.externalCustomerId);
      const body = withDates(query, ['startTime', 'endTime', 'billingAnchor']);
      return ingest.invoke(
        { method: 'POST', pattern: 'events/usage' },
        (client, policy) => client.events.getUsageStatistics(body, policy),
      );
    },
    eventsUsageMeter: (query = {}) => {
      scopedId('POST events/usage/meter', 'externalCustomerId', query.externalCustomerId);
      scopedId('POST events/usage/meter', 'meterId', query.meterId);
      const body = withDates(query, ['startTime', 'endTime', 'billingAnchor']);
      return ingest.invoke(
        { method: 'POST', pattern: 'events/usage/meter' },
        (client, policy) => client.events.getUsageByMeter(body, policy),
      );
    },

    // ---- invoices (money plane) ----------------------------------------------
    createInvoice: (invoice = {}, opts = {}) => {
      const idempotencyKey = opts.idempotencyKey || invoice.idempotencyKey || null;
      const body = withDates(
        { ...invoice, ...(idempotencyKey ? { idempotencyKey } : {}) },
        ['issueDate', 'dueDate', 'periodStart', 'periodEnd'],
      );
      return money.invoke(
        { method: 'POST', pattern: 'invoices', idempotencyKey },
        (client, policy) => client.invoices.createInvoice(body, policy),
      );
    },
    searchInvoices: (query = {}) => money.invoke(
      { method: 'POST', pattern: 'invoices/search' },
      (client, policy) => client.invoices.queryInvoice(withDates(query, ['startTime', 'endTime']), policy),
    ),
    getInvoice: (invoiceId) => {
      const id = scopedId('GET invoices/:id', 'invoiceId', invoiceId);
      return money.invoke(
        { method: 'GET', pattern: 'invoices/{id}', params: { id } },
        (client, policy) => client.invoices.getInvoice(id, undefined, undefined, undefined, policy),
      );
    },
    finalizeInvoice: (invoiceId, opts = {}) => {
      const id = scopedId('POST invoices/:id/finalize', 'invoiceId', invoiceId);
      return money.invoke(
        { method: 'POST', pattern: 'invoices/{id}/finalize', params: { id }, idempotencyKey: opts.idempotencyKey || null },
        (client, policy) => client.invoices.finalizeInvoice(id, policy),
      );
    },
  };
}

module.exports = {
  PLANES,
  FlexpriceError,
  FlexpriceScopeError,
  FlexpriceValidationError,
  createFlexpriceClient,
  isAlreadyExists,
  rowsOf,
  scopedField,
  scopedId,
};
