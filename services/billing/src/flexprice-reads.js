'use strict';

/**
 * FlexPrice READ routes — the browser-visible read surface for the Usage page.
 *
 * This is the only place a FlexPrice value crosses into the client, and it is
 * deliberately narrow: GET only, no body, no ids taken from the request other
 * than window/limit/filter names. `external_customer_id` and the wallet id are
 * derived from the gateway-resolved org (`resolveCallerOrg`), never from the
 * caller — and that org is only honored when the caller *proved* it is the gateway
 * (`trusted-caller.js`), so which tenant a request addresses is checked at this
 * endpoint rather than inherited from the network in front of it. An unproven
 * caller is served a degraded envelope with zero FlexPrice calls. Money fields are
 * also verified to belong to the org: `gate.resolveWalletId` refuses a stored
 * wallet id the org's own FlexPrice customer does not have (wallet-scope.js),
 * because one API key spans the tenant — measured in docs/FLEXPRICE_FINDINGS.md
 * §10, the ingest plane's *reads* are shadow-only, so a key that could be pointed
 * at another customer would still answer. The money path (top-up, debit, invoice)
 * stays in `recharge-settle.js` and the jobs; nothing here can move money.
 *
 * Degradation is spelled, never implied: an unreadable number is `null` with a
 * `reason`, because `0` on this page reads as "you are out of credit" and that is
 * a different fact. `GET /summary` already established that contract; these routes
 * keep it.
 *
 * Every value is a FlexPrice value. Where FlexPrice cannot answer something the
 * design asked for, the route says so in `note`/`reason` rather than substituting
 * first-party data — the Cost page (`billing-api.js` `/usage`) remains the
 * first-party surface.
 *
 * Two mechanics here are load-bearing, both from the pinned source (`v2.1.48`)
 * rather than taste:
 *
 *  1. Daily consumption is ONE request, not one per day. `POST /v1/events/usage`
 *     with `window_size: "DAY"` returns `results[]` bucketed per day for a SUM
 *     (`internal/repository/clickhouse/event.go:288` takes the bucketed path for
 *     SUM when `window_size` is set), and the top-level `value` is left at zero in
 *     that branch — so the total is summed from the buckets, and a response with a
 *     scalar and no buckets is reported as "not bucketed" instead of being drawn as
 *     an empty grid.
 *  2. Per-dimension filtering uses `filters` keyed on the BARE property name
 *     (findings §7c): `group_by` is ignored for SUM, `property_filters` silently
 *     returns the whole tenant, and the dotted `properties.X` form matches nothing.
 *     A Usage page built on any of those shows the org total under a project label.
 */

const express = require('express');
const crypto = require('node:crypto');
const { CONFIG } = require('@software-factory/shared-core/config');
const { asyncHandler } = require('@software-factory/shared-core/util');
const log = require('@software-factory/shared-core/logger');
const store = require('@software-factory/shared-core/store');
const gate = require('@software-factory/shared-core/billing/gate');
const moneyWire = require('@software-factory/shared-core/billing/money-wire');
const { createFlexpriceClient, rowsOf } = require('@software-factory/shared-core/billing/flexprice-client');
const { WalletScopeError } = require('@software-factory/shared-core/billing/wallet-scope');
const { SHARED_ORG_ID } = require('@software-factory/shared-core/billing/org-context');
const { ORG_ID_RE } = require('./trusted-caller');
// The meter/event/property names come from the outbox's own table: a quantity
// posted under any other property name is acknowledged with 202 and contributes
// nothing (billing-outbox.js:28-31), so a read that spells them differently would
// silently report zero usage.
const { METERS } = require('@software-factory/shared-core/billing/billing-outbox');

const LLM = METERS.llmTokenCredits;
const DAY_MS = 24 * 60 * 60 * 1000;

// `llm-token-credits` is the only meter that can produce a credit number:
// `actor-compute` and `deployment-minutes` are deliberately priced at ₹0 (decision D8),
// so reading them would add calls without adding consumption. It is also the only meter
// the outbox still writes: its predecessor `llm-cost` binds to the property name the
// events carried before the rename, so reading it now would answer an honest zero.
const CREDIT_METER = LLM.meter;

/** The filterable event properties, keyed by the query name the page uses. */
const DIMENSIONS = Object.freeze({
  project: 'project_id',
  user: 'user_id',
  agent: 'agent_id',
  tier: 'tier',
});

/** Same keys, but naming the `usageRecords` field that supplies the candidate values. */
const BREAKDOWN_SOURCES = Object.freeze({
  project: 'projectId',
  user: 'userId',
  agent: 'agentId',
  tier: 'tier',
});

// The complete `TransactionReason` set is 12 values (v2.1.48
// `internal/types/wallet.go`); these are the ones that ADD credits. Grouping by
// reason is a presentation choice, so anything unrecognised lands in `other`
// rather than being dropped — a dropped reason silently makes the buckets fail to
// add up to the balance.
const PLAN_REASONS = new Set(['FREE_CREDIT_GRANT', 'SUBSCRIPTION_CREDIT_GRANT']);
// A recharge settles as PURCHASED_CREDIT_DIRECT, and an invoice-funded purchase as
// PURCHASED_CREDIT_INVOICED — both measured in the local stack's ledger.
const ADDON_REASONS = new Set(['PURCHASED_CREDIT_DIRECT', 'PURCHASED_CREDIT_INVOICED', 'PURCHASED_CREDIT_BONUS', 'CREDIT_NOTE', 'INVOICE_VOID_REFUND']);
// Debits that reduce the balance without the org having used anything.
const NOT_USAGE_REASONS = new Set(['CREDIT_EXPIRED', 'WALLET_TERMINATION']);

// Labels for the ledger's own `transaction_reason`, so the Credits Log says what
// moved money rather than echoing an enum. `CREDIT_EXPIRED` matters most: it is a
// debit that is NOT usage, and a table that calls it "usage" invents spend.
const REASON_LABELS = Object.freeze({
  FREE_CREDIT_GRANT: 'Included allowance',
  SUBSCRIPTION_CREDIT_GRANT: 'Subscription credits',
  PURCHASED_CREDIT_DIRECT: 'Credit purchase',
  PURCHASED_CREDIT_INVOICED: 'Credit purchase (invoiced)',
  PURCHASED_CREDIT_BONUS: 'Bonus credits',
  CREDIT_NOTE: 'Credit note',
  INVOICE_VOID_REFUND: 'Refunded invoice',
  INVOICE_PAYMENT: 'Invoice payment',
  MANUAL_BALANCE_DEBIT: 'Platform charge',
  CREDIT_ADJUSTMENT: 'Balance adjustment',
  CREDIT_EXPIRED: 'Expired credits',
  WALLET_TERMINATION: 'Wallet closed',
});

const READS_TTL_MS = gate.DEFAULT_TTL_MS;
// A window whose days are all past is settled history, so it is held far longer
// than the live window. Without this a page render re-reads 91 days of usage.
const PAST_WINDOW_TTL_MS = 6 * 60 * 60 * 1000;
const WALLET_TTL_MS = 10 * 60 * 1000;
// A missing wallet is a provisioning state, not a permanent fact — a recharge or
// the provisioner creates it, so retry quickly instead of pinning the page.
const MISSING_WALLET_TTL_MS = 5 * 1000;
// Used by /usage-breakdown only: one windowed read per dimension value (§7c says
// FlexPrice cannot group a SUM server-side), so the request count is the fan-out.
const FANOUT = 8;
const SEARCH_LIMIT = 200;
const MAX_SEARCH_LIMIT = 500;
const MAX_WEEKS = 13;
const MAX_RANGE_DAYS = 92;
// One FlexPrice read per value, so this is the request count of /usage-breakdown.
// The values themselves come from our own records; this only bounds the fan-out.
const MAX_BREAKDOWN_VALUES = 25;
const RANGE_PRESETS = Object.freeze({
  '1d': { days: 1 },
  '7d': { days: 7 },
  '30d': { days: 30 },
  mtd: { month: 'current' },
  'last-month': { month: 'previous' },
});

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving order.
 * `null` for a rejected entry — a hole is reported as `partial`, not as zero.
 *
 * Only the multi-value breakdown reads need this: an unfiltered window is one
 * request, so fanning out per day would buy latency and half-failures instead of
 * data.
 */
async function fanOut(items, limit, fn) {
  const out = new Array(items.length).fill(null);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        out[index] = await fn(items[index], index);
      } catch (err) {
        out[index] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** [00:00, next 00:00) UTC for one day key, as the `*_time` fields want it. */
function dayWindow(dayIso) {
  const start = Date.parse(`${dayIso}T00:00:00.000Z`);
  if (!Number.isFinite(start)) return null;
  return { start, startIso: new Date(start).toISOString(), endIso: new Date(start + DAY_MS).toISOString() };
}

function filterSignature(filters) {
  if (!filters) return '';
  const keys = Object.keys(filters).sort();
  return keys.length ? keys.map((k) => `${k}=${String(filters[k])}`).join('&') : '';
}

/**
 * A cache-partition segment.
 *
 * The org id is the isolation key, and these caches are keyed by concatenation, so
 * an org id containing the separator (`a|overview` addressing org `a`'s partition)
 * would let one tenant be served another's cached numbers. Hashing makes the
 * segment fixed-width and unforgeable; `invalidate` clears by the same hash.
 */
function partition(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/** A browser-named filter value: an id, not a payload. See `DIMENSIONS`. */
const FILTER_VALUE_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The request's filters, built server-side from the four dimensions this page
 * knows about. A value that is not id-shaped is dropped and reported rather than
 * forwarded: these go into a FlexPrice query body, and the only thing a browser
 * chooses here is which *narrowing* to apply — never which customer.
 */
function parseFilters(query) {
  const filters = {};
  const rejected = [];
  for (const [param, property] of Object.entries(DIMENSIONS)) {
    const value = String((query && query[param]) ?? '').trim();
    if (!value) continue;
    if (FILTER_VALUE_RE.test(value)) filters[property] = [value];
    else rejected.push(param);
  }
  return { filters, rejected };
}

/**
 * Why this request may not address an org, or `null` when it may.
 *
 * `trusted` is set by `trusted-caller.js` and means the peer proved it is the
 * gateway. Without that proof the org this route would read is a guess made by
 * whoever opened the socket, so the answer is a degraded envelope and ZERO
 * FlexPrice calls — the property the Usage page's isolation rests on is checked
 * here, at the endpoint, not assumed from the network in front of it.
 */
function scopeViolationOf(caller) {
  if (!caller || caller.trusted !== true) return 'unscoped_caller';
  const orgId = String(caller.orgId || '').trim();
  if (!orgId || !ORG_ID_RE.test(orgId)) return 'unscoped_org_id';
  return null;
}

/**
 * Resolve a requested range into a `[startMs, endMs]` window.
 *
 * `mtd`/`last-month` are CALENDAR months in UTC because that is what the labels
 * say; a day preset is a sliding window. An explicit from/to pair wins over both,
 * clamped so a hand-made range cannot ask for a year of buckets.
 */
function windowFor({ range, fromIso, toIso, nowMs }) {
  const from = dayWindow(fromIso);
  const to = dayWindow(toIso);
  if (from && to && to.start >= from.start) {
    return { startMs: from.start, endMs: Math.min(to.start + DAY_MS, from.start + MAX_RANGE_DAYS * DAY_MS) };
  }
  const spec = RANGE_PRESETS[String(range || '').trim().toLowerCase()];
  const name = String(range || '').trim().toLowerCase();
  // A day preset counts WHOLE UTC days ending today, so "last 7 days" is seven
  // cells that include today — not a window starting at this clock time seven
  // days ago, which would slice today's bucket in half and draw an eighth cell.
  const todayStart = dayWindow(isoDay(nowMs)).start;
  if (!spec) return { ...windowOfDays(RANGE_PRESETS['7d'].days, todayStart), range: '7d' };
  if (spec.days) return { ...windowOfDays(spec.days, todayStart), range: name };
  const d = new Date(nowMs);
  const current = spec.month === 'current';
  return {
    startMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (current ? 0 : -1), 1),
    endMs: current ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
    range: name,
  };
}

/** `count` whole UTC days ending at `todayStart` inclusive, as a `[start, end)` window. */
function windowOfDays(count, todayStart) {
  const days = Math.min(MAX_RANGE_DAYS, Math.max(1, count));
  return { startMs: todayStart - (days - 1) * DAY_MS, endMs: todayStart + DAY_MS };
}

/**
 * The top values of one dimension, newest window first, from OUR usage records.
 * Only used to decide WHICH meter reads to spend (see /usage-breakdown); the
 * numbers themselves always come from FlexPrice.
 */
function topValuesFor(orgId, field, limit, sinceMs, nowMs) {
  if (!field) return [];
  const counts = new Map();
  for (const record of store.listUsageRecords({ orgId })) {
    const at = Date.parse(String(record.createdAt || ''));
    if (!Number.isFinite(at) || at < sinceMs || at > nowMs) continue;
    const value = String(record[field] ?? '').trim();
    if (!value) continue;
    const hit = counts.get(value) || { value, count: 0, tokenCredits: 0 };
    hit.count += 1;
    hit.tokenCredits += Math.max(0, Math.round(Number(record.costTokenCredits) || 0));
    counts.set(value, hit);
  }
  return [...counts.values()]
    .sort((a, b) => b.tokenCredits - a.tokenCredits || b.count - a.count || String(a.value).localeCompare(String(b.value)))
    .slice(0, limit)
    .map((entry) => entry.value);
}

/**
 * The only money shape this file hands the browser: an integer `tokenCredits` (the
 * ledger unit, and what the chart bins sort on) plus `credits` as a decimal string
 * for a human.
 *
 * There is deliberately no rupee field. A wallet balance is not a sum of money the
 * customer paid — ₹2,360 bought 3,500 credits and 40 of them are gone — so the only
 * honest unit for what is left is credits, and a `currency: 'INR'` on the same
 * envelope invited every view to print a ₹ figure the org never had. Rupees exist on
 * the two pages where money actually moves: the Cashfree checkout total and the GST
 * invoice, both built from the recharge intent's `…Paise` fields, never from here.
 *
 * `null` is not zero (see the header): an unreadable number must not read as an empty
 * wallet.
 */
function creditView(tokenCredits) {
  if (tokenCredits === null || tokenCredits === undefined) return { tokenCredits: null, credits: null };
  const value = Number(tokenCredits);
  if (!Number.isInteger(value)) return { tokenCredits: null, credits: null };
  return { tokenCredits: value, credits: moneyWire.creditsFromTokenCredits(value) };
}

/**
 * A meter/event SUM is in the unit it aggregates: `llm-token-credits` sums `token_credits`, so
 * the number is tokenCredits. An unparseable value is `null` (unreadable), which is NOT
 * the same as `0`: `value` is `omitempty` in the response DTO, so an empty window
 * genuinely answers with no key at all (findings §14, verbatim read-back `{}`).
 */
function tokenCreditsFromMeter(out) {
  if (!out || typeof out === 'string') return null;
  if (out.value === undefined || out.value === null || out.value === '') return 0;
  const n = Number(out.value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Parse a windowed SUM read into `{ byDay, totalTokenCredits, bucketed }`.
 *
 * `windowSize: "DAY"` on `POST /v1/events/usage` is answered per bucket
 * (`GetUsageResponse.results[].windowSize`), and for a windowed SUM the DTO's
 * top-level `value` is left at zero and therefore omitted — the total has to be
 * summed from the buckets here, not read off the envelope.
 *
 * `bucketed: false` is the honest "this FlexPrice did not bucket" signal: a single
 * scalar `value` with no rows means the windowing was ignored, and a day grid built
 * from it would be one day's worth of invented zeros. A caller renders that as
 * unavailable, not as an empty chart.
 */
function seriesFromUsage(out) {
  if (!out || typeof out === 'string') return { byDay: new Map(), totalTokenCredits: null, bucketed: false };
  const rows = Array.isArray(out.results) ? out.results : [];
  const byDay = new Map();
  let total = 0;
  let unreadable = 0;
  for (const row of rows) {
    const day = row && row.windowSize !== undefined && row.windowSize !== null
      ? isoDay(row.windowSize)
      : null;
    const tokenCredits = tokenCreditsFromMeter(row);
    if (!day || tokenCredits === null) {
      unreadable += 1;
      continue;
    }
    byDay.set(day, (byDay.get(day) || 0) + tokenCredits);
    total += tokenCredits;
  }
  if (rows.length === 0) {
    const scalar = tokenCreditsFromMeter(out);
    // No buckets and no (or zero) scalar: the window is empty, which is a true
    // answer for every day. A NON-zero scalar with no buckets means the server
    // ignored `window_size`, so the usage cannot be attributed to days at all.
    return { byDay, totalTokenCredits: scalar, bucketed: !(scalar > 0) };
  }
  return { byDay, totalTokenCredits: unreadable ? null : total, bucketed: true, unreadableRows: unreadable };
}

/** Decimal-as-string on the wire, number or Date on the model: tokenCredits or `null`. */
function rowAmountTokenCredits(row, field) {
  const raw = row && row[field];
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    return moneyWire.tokenCreditsFromCredits(String(raw));
  } catch (_) {
    return null;
  }
}

/**
 * The magnitude of a wallet transaction row, in tokenCredits.
 *
 * `creditAmount` is the credit-side field; a debit row leaves it out and carries its
 * magnitude in `amount` (measured against a live `MANUAL_BALANCE_DEBIT` row in
 * `scripts/flexprice-phase5-verify.js`). There is no `debit_amount` on this route —
 * the earlier fallback here read a key FlexPrice never answers, so a debit would
 * have rendered as no amount at all.
 */
function rowCreditTokenCredits(row) {
  const direct = rowAmountTokenCredits(row, 'creditAmount');
  if (direct !== null) return direct;
  return rowAmountTokenCredits(row, 'amount');
}

/** `createdAt` is a `Date` on the model and an ISO string on a canned fixture. */
function isoOf(value) {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function rowTime(row) {
  return isoOf(row && (row.createdAt || row.timestamp || row.timeCreated));
}

function rowExpiry(row) {
  return isoOf(row && (row.expiryDate || row.expiresAt));
}

function reasonLabel(reason) {
  return REASON_LABELS[String(reason || '').toUpperCase()] || String(reason || 'unknown').toLowerCase().replace(/_/g, ' ');
}

/**
 * The log's tab, read the same way whether the read succeeded or degraded.
 *
 * A degraded answer that drops `tab` would make the page snap its selected pill
 * back to "Earned" under a user who just clicked "Used" — and the sign of every
 * row comes from this value, so it is part of the answer, not just of the query.
 */
function logTabOf(req) {
  return String((req && req.query && req.query.tab) || 'earned').trim().toLowerCase() === 'used' ? 'used' : 'earned';
}

/**
 * Split live credit rows into the three buckets the page draws.
 *
 * `used` is total minus remaining rather than a sum of debits: FlexPrice reports
 * consumption by shrinking `credits_available` on the grant row (no per-run debit
 * exists at ingest — findings §2), so the grant rows are the only place accrued
 * usage is visible per bucket.
 */
function bucketCreditRows(rows) {
  const bucket = () => ({ totalTokenCredits: 0, remainingTokenCredits: 0, rowCount: 0, unreadableRows: 0 });
  const plan = bucket();
  const addon = bucket();
  const other = bucket();
  const packs = [];
  const packages = [];

  for (const row of rows) {
    const reason = String((row && row.transactionReason) || '').toUpperCase();
    const total = rowCreditTokenCredits(row);
    const remaining = rowAmountTokenCredits(row, 'creditsAvailable');
    const target = PLAN_REASONS.has(reason) ? plan : (ADDON_REASONS.has(reason) ? addon : other);
    target.rowCount += 1;
    if (total === null || remaining === null) {
      target.unreadableRows += 1;
      continue;
    }
    target.totalTokenCredits += total;
    target.remainingTokenCredits += Math.max(0, remaining);

    if (remaining > 0) {
      packs.push({
        id: row.id || null,
        reason: reason || null,
        ...creditView(remaining),
        total: creditView(total),
        expiresAt: rowExpiry(row),
        orderId: (row.metadata && row.metadata.fleet_order_id) || row.idempotencyKey || null,
      });
    }
    // A package is a credit that expires: that is the only thing FlexPrice can
    // distinguish a "dedicated pack" by, and the expiry date is its real bound.
    const expiresAt = rowExpiry(row);
    if (expiresAt && remaining > 0) {
      packages.push({
        id: row.id || null,
        name: (row.metadata && row.metadata.description) || row.description || reasonLabel(reason),
        reason: reason || null,
        remaining: creditView(remaining),
        total: creditView(total),
        expiresAt,
      });
    }
  }

  const view = (b) => {
    const usedTokenCredits = Math.max(0, b.totalTokenCredits - b.remainingTokenCredits);
    return {
      total: creditView(b.totalTokenCredits),
      used: creditView(usedTokenCredits),
      remaining: creditView(b.remainingTokenCredits),
      pctUsed: b.totalTokenCredits > 0 ? Math.round((usedTokenCredits / b.totalTokenCredits) * 1000) / 10 : null,
      rowCount: b.rowCount,
      unreadableRows: b.unreadableRows,
    };
  };

  const expiring = packs.filter((p) => p.expiresAt).map((p) => p.expiresAt).sort();
  return {
    plan: { ...view(plan), resetsOn: expiring.length ? expiring[0] : null },
    addon: { ...view(addon), resetsOn: null },
    other: view(other),
    packs: packs.sort((a, b) => String(b.expiresAt || '').localeCompare(String(a.expiresAt || ''))).slice(0, 20),
    packages: packages.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)).slice(0, 10),
  };
}

/** The shared envelope: every route answers, even when it has nothing to show. */
function envelope({ degraded = false, reason = null, detail = null, stale = false, now, ...rest }) {
  const out = {
    degraded,
    reason,
    asOf: new Date(now).toISOString(),
    ...rest,
  };
  if (detail) out.reasonDetail = String(detail).slice(0, 200);
  if (stale) out.stale = true;
  return out;
}

function createFlexpriceReadsRouter({ resolveCallerOrg, deps = {} } = {}) {
  if (typeof resolveCallerOrg !== 'function') {
    throw new TypeError('flexprice-reads: createFlexpriceReadsRouter needs resolveCallerOrg');
  }
  const router = express.Router();
  const now = () => (typeof deps.now === 'function' ? deps.now() : Date.now());
  const ttl = (fallback) => (Number.isFinite(deps.ttlMs) ? deps.ttlMs : fallback);

  const wallets = new Map();
  const windows = new Map();
  const lastGood = new Map();

  function client() {
    return deps.client || createFlexpriceClient({ config: deps.flexpriceConfig || CONFIG.FLEXPRICE });
  }

  /** Drop everything for one org — called after a settle so the page shows the payment. */
  function invalidate(orgId) {
    const key = String(orgId || '').trim();
    if (!key) return { cleared: null };
    const orgHash = partition(key);
    wallets.delete(key);
    // `lastGood` and `windows` are keyed by the org's hash partition, so a bare
    // delete of one entry would leave a failed read serving the pre-recharge
    // numbers behind the fresh ones.
    for (const cache of [lastGood, windows]) {
      for (const [cacheKey, entry] of cache) {
        if (entry && entry.orgHash === orgHash) cache.delete(cacheKey);
      }
    }
    return { cleared: key };
  }

  /**
   * The single pre-flight every route shares. Returning an envelope here means a
   * handler never has to reason about disabled config, an unproven caller or a
   * shared-tier account.
   */
  function guard(caller) {
    const orgId = String((caller && caller.orgId) || '').trim();
    // Overridable for the tests only; in deployment this is the same switch the
    // gate and the money path read.
    const enabled = deps.flexpriceEnabled === undefined ? CONFIG.FLEXPRICE.enabled : deps.flexpriceEnabled;
    if (!enabled) {
      return envelope({ degraded: true, reason: 'flexprice_disabled', now: now(), note: 'FLEXPRICE_ENABLED is not set, so no FlexPrice read is possible on this deployment.' });
    }
    // Who is asking, before what they are asking for: an unproven caller gets no
    // numbers and costs no FlexPrice read.
    const violation = scopeViolationOf(caller);
    if (violation) {
      log.warn('billing_flexprice_read_unscoped', { orgId: orgId || null, violation });
      return envelope({
        degraded: true,
        reason: violation,
        now: now(),
        note: 'This request did not arrive as a verified gateway caller, so it is served by its deployment org only and no organization\'s usage was read.',
      });
    }
    // The free-tier account has never had a wallet and is permanently exempt from
    // the gate (gate.js:351), so it must not spend catalog or customer reads here.
    if (orgId === SHARED_ORG_ID) {
      return envelope({ degraded: true, reason: 'not_provisioned', now: now(), note: 'This deployment has no per-tenant FlexPrice wallet to read.' });
    }
    return null;
  }

  async function walletIdFor(orgId) {
    const hit = wallets.get(orgId);
    if (hit && hit.until > now()) return hit.walletId;
    // `gate.resolveWalletId` is the single answer to "which wallet", and it verifies
    // the stored id against this org's own FlexPrice customer before returning it —
    // a mismatch throws rather than reading a neighbour's balance.
    const walletId = await gate.resolveWalletId(client(), orgId, store.getBillingAccount(orgId));
    wallets.set(orgId, {
      walletId: walletId || null,
      until: now() + (walletId ? ttl(WALLET_TTL_MS) : ttl(MISSING_WALLET_TTL_MS)),
    });
    return walletId || null;
  }

  /**
   * One windowed UTC-day SUM over the org's `fleet.llm_cost` events.
   *
   * `external_customer_id` is server-derived and is the ONLY org selector the
   * route accepts: FlexPrice scopes by tenant+environment from the key, and the
   * ClickHouse events table carries `external_customer_id` as a real column, so
   * filtering to this org's events is a property of the request the server makes
   * — never of a browser-supplied parameter.
   *
   * `filters` is part of the cache key: serving an unfiltered window from the
   * heatmap cache to a filtered trend request would print the org total under a
   * project label.
   */
  async function usageSeries({ orgId, startIso, endIso, filters }) {
    // Every property key here is one this file declared; a filter that could name
    // an arbitrary key would be a way to query somebody else's selector.
    const allowed = new Set(Object.values(DIMENSIONS));
    const scoped = {};
    for (const [property, values] of Object.entries(filters || {})) {
      if (allowed.has(property)) scoped[property] = values;
    }
    const orgHash = partition(orgId);
    const key = `${orgHash}:${partition(`${startIso}|${endIso}|${filterSignature(scoped)}`)}`;
    const hit = windows.get(key);
    if (hit && hit.expiresAt > now()) return hit.series;
    const series = seriesFromUsage(await client().eventsUsage({
      eventName: LLM.eventName,
      propertyName: LLM.field,
      aggregationType: 'SUM',
      // Server-derived and the only org selector this route accepts — hence the
      // explicit refusal to run without it. An unfiltered usage read answers with
      // the whole tenant's total, which would then be labeled with one org's name.
      externalCustomerId: orgId,
      startTime: startIso,
      endTime: endIso,
      // Day buckets in UTC, matching the `date` keys the page labels. FlexPrice
      // would otherwise bucket in its own default timezone and a day cell would
      // silently contain part of two days.
      windowSize: 'DAY',
      timezone: 'UTC',
      ...(Object.keys(scoped).length ? { filters: scoped } : {}),
    }));
    windows.set(key, {
      series,
      orgHash,
      // A window that has fully closed cannot gain rows (late-arriving events aside),
      // so it is cached long; one still containing "now" is cached for the read TTL.
      expiresAt: now() + (endIso <= new Date(now()).toISOString()
        ? ttl(PAST_WINDOW_TTL_MS)
        : ttl(READS_TTL_MS)),
    });
    return series;
  }

  /**
   * Wrap a handler so a failed read degrades to the last known view instead of
   * answering 500: the page is read after a money event, and a FlexPrice blip must
   * not render as "no credits" — or as an error boundary.
   */
  function read(route, fn, coldShape = {}) {
    return asyncHandler(async (req, res) => {
      const caller = resolveCallerOrg(req);
      const orgId = caller.orgId;
      // Some routes answer a different shape depending on the query (the log's
      // `tab`), so the empty shape can be a function of the request.
      const shape = typeof coldShape === 'function' ? coldShape(req) : coldShape;
      const blocked = guard(caller);
      if (blocked) {
        res.json({ ...blocked, ...shape, orgId, isAdmin: caller.isAdmin });
        return;
      }
      const orgHash = partition(orgId);
      const stored = lastGood.get(`${orgHash}:${route}`);
      try {
        const out = await fn({ req, res, caller, orgId });
        // The envelope keys are added here rather than in each handler so that
        // "did this answer?" is one contract for all routes, not five.
        const body = {
          degraded: false,
          reason: null,
          asOf: new Date(now()).toISOString(),
          ...out,
          orgId,
          isAdmin: caller.isAdmin,
        };
        lastGood.set(`${orgHash}:${route}`, { body, at: now(), orgHash });
        res.json(body);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        // A wallet the org does not own is not a read that failed: answering it
        // with the cached numbers would show another tenant's money under this
        // org's name, which is the one thing worse than no data.
        const scopeFailure = err instanceof WalletScopeError;
        const reason = scopeFailure ? (err.kind || 'wallet_org_mismatch') : 'read_failed';
        log.warn('billing_flexprice_read_failed', {
          orgId,
          route,
          status: err && err.status,
          reason,
          holding: scopeFailure ? false : Boolean(stored),
        });
        const fallback = stored && !scopeFailure
          ? { ...stored.body, degraded: true, reason, reasonDetail: message.slice(0, 200), stale: true, asOf: new Date(now()).toISOString() }
          : envelope({
            degraded: true,
            reason,
            detail: message,
            now: now(),
            // The empty shape is merged in even on a failure with no cache, so a
            // caller never has to guess whether `days`/`rows` is missing or empty:
            // a degraded read has zero of them and null money.
            ...shape,
            orgId,
            isAdmin: caller.isAdmin,
          });
        res.json(fallback);
      }
    });
  }

  // GET /api/billing/flexprice/overview — credit buckets, packs and the wallet balance.
  // The balance is the gate's number, so this route never recomputes money: a
  // recharge must not be able to show two different balances on one page.
  router.get('/overview', read('overview', async ({ orgId }) => {
    const fund = await gate.ensureFundStatus(orgId, deps);
    const walletId = await walletIdFor(orgId);
    const base = {
      // `unit`, not `currency`: the number beside it is credits, and a key named for a
      // currency invites the view to format it as money.
      unit: 'credits',
      balance: creditView(fund.balanceTokenCredits),
      fundState: fund.state,
      gatePolicy: fund.gatePolicy,
      balanceStale: Boolean(fund.stale),
      walletResolved: Boolean(walletId),
    };
    if (!walletId) {
      return {
        ...base,
        degraded: true,
        reason: 'wallet_missing',
        note: 'This organization has no FlexPrice wallet yet. It is created by provisioning or by the first recharge.',
        planCredits: null,
        addOnCredits: null,
        creditPacks: [],
        packages: [],
        otherCredits: null,
      };
    }

    // No `credits_available_gt: '0'` filter, unlike the expiry job: a fully
    // consumed grant still carries its original `credit_amount`, and that is the
    // denominator of "1,240 / 5,000 used". Filtering to live rows would report the
    // plan as smaller every time an org actually finished it.
    const response = await client().walletTransactionsSearch({
      id: walletId,
      type: 'credit',
      limit: SEARCH_LIMIT,
    });
    const rows = rowsOf(response);
    const buckets = bucketCreditRows(rows);
    return {
      ...base,
      rowsInspected: rows.length,
      rowsTruncated: rows.length >= SEARCH_LIMIT,
      planCredits: buckets.plan,
      // "3 Included Credit Packs" counts the purchased balances, not every live
      // grant row — an open free allowance is not a pack the org bought.
      addOnCredits: { ...buckets.addon, packCount: buckets.packs.filter((p) => ADDON_REASONS.has(p.reason)).length },
      creditPacks: buckets.packs,
      packages: buckets.packages,
      otherCredits: buckets.other,
    };
  }, {
    // A read that never succeeded still answers with the buckets it has none of.
    unit: 'credits',
    balance: creditView(null),
    fundState: null,
    walletResolved: false,
    planCredits: null,
    addOnCredits: null,
    creditPacks: [],
    packages: [],
    otherCredits: null,
  }));

  // GET /api/billing/flexprice/heatmap?weeks=13&end=YYYY-MM-DD — daily consumption.
  router.get('/heatmap', read('heatmap', async ({ req, orgId }) => {
    const weeksParam = Number(String(req.query.weeks ?? MAX_WEEKS));
    const weeks = Math.min(MAX_WEEKS, Math.max(1, Number.isFinite(weeksParam) ? Math.floor(weeksParam) : MAX_WEEKS));
    const endParam = String(req.query.end ?? '').trim();
    const endWindow = endParam ? dayWindow(endParam) : dayWindow(isoDay(now()));
    const endMs = endWindow ? endWindow.start : now();
    const dayKeys = [];
    for (let offset = weeks * 7 - 1; offset >= 0; offset -= 1) dayKeys.push(isoDay(endMs - offset * DAY_MS));
    // The whole grid is ONE request. FlexPrice buckets a windowed SUM per day, so
    // reading it day by day would be 91 round trips for 91 numbers that arrive
    // together — and 91 chances to half-fail.
    const series = await usageSeries({
      orgId,
      startIso: `${dayKeys[0]}T00:00:00.000Z`,
      endIso: new Date(endMs + DAY_MS).toISOString(),
      filters: null,
    });
    if (!series.bucketed) {
      // The server answered with a scalar: the money is real, but it cannot be
      // attributed to days. An all-zero grid would be a lie, so the grid is empty
      // and the total is still reported.
      return {
        degraded: true,
        reason: 'read_failed',
        note: 'FlexPrice answered this window without day buckets, so daily consumption cannot be attributed to days.',
        weeks,
        total: creditView(series.totalTokenCredits),
        days: [],
      };
    }

    const days = dayKeys.map((date) => ({
      date,
      // A day with no rows has no events, which measures as 0 (findings §14).
      ...creditView(series.byDay.get(date) || 0),
      unreadable: false,
    }));
    const unreadableBuckets = series.unreadableRows || 0;
    return {
      degraded: false,
      meter: CREDIT_METER,
      weeks,
      startUtc: days.length ? days[0].date : null,
      endUtc: days.length ? days[days.length - 1].date : null,
      // The window total comes from the same response as the cells, so the header
      // and the grid can never disagree.
      total: creditView(series.totalTokenCredits),
      partial: unreadableBuckets > 0,
      unreadableBuckets,
      days,
    };
  }, { weeks: MAX_WEEKS, total: creditView(null), days: [] }));

  // GET /api/billing/flexprice/trend?range=7d|1d|30d|mtd|last-month&from&to&project&user&agent&tier
  router.get('/trend', read('trend', async ({ req, orgId }) => {
    const win = windowFor({
      range: String(req.query.range ?? '7d').trim().toLowerCase(),
      fromIso: String(req.query.from ?? '').trim(),
      toIso: String(req.query.to ?? '').trim(),
      nowMs: now(),
    });
    const preset = win.range;

    const { filters, rejected } = parseFilters(req.query);

    // `windowFor` always answers with day boundaries, so these cells are whole
    // UTC days: `endMs` is exclusive and never slices the current day in half.
    const dayKeys = [];
    for (let ms = win.startMs; ms < win.endMs; ms += DAY_MS) dayKeys.push(isoDay(ms));
    const series = await usageSeries({
      orgId,
      startIso: `${dayKeys[0]}T00:00:00.000Z`,
      endIso: new Date(win.endMs).toISOString(),
      filters,
    });

    const points = series.bucketed
      ? dayKeys.map((date) => ({ date, ...creditView(series.byDay.get(date) || 0) }))
      : [];
    const unreadableBuckets = series.unreadableRows || 0;
    return {
      meter: CREDIT_METER,
      range: preset || 'custom',
      window: { startUtc: `${dayKeys[0]}T00:00:00.000Z`, endUtc: new Date(win.endMs).toISOString(), days: dayKeys.length },
      filters,
      // A dimension value that was not id-shaped is reported, not silently dropped:
      // an empty series and a refused filter are different answers.
      ignoredFilters: rejected,
      filterableDimensions: Object.keys(DIMENSIONS),
      total: creditView(series.totalTokenCredits),
      points,
      // No buckets means the filter cannot be honoured either, and that is reported
      // rather than drawn as a flat zero line.
      bucketed: series.bucketed,
      unreadableBuckets,
      peak: points.reduce(
        (best, p) => (p.tokenCredits !== null && (!best || p.tokenCredits > best.tokenCredits) ? p : best),
        null,
      ),
    };
  }, { total: creditView(null), points: [], bucketed: false, filters: {} }));

  // GET /api/billing/flexprice/usage-breakdown?dimension=project|user|agent&limit=
  // The filter picker for /trend: which projects/users/agents used credit, and how
  // much. FlexPrice cannot group a SUM server-side (findings §7c — `group_by` is
  // ignored for SUM, the meter route has no such field, and `property_filters`
  // silently returns the tenant total), so this is one windowed read per value and
  // the candidate values come from our own outbox table. That is deliberate: a
  // model or gateway-created project id that never reaches our store is not a
  // thing the org can have used, whereas the properties route does list a
  // non-dimension `"value"` key (§7c) that would otherwise appear as a project.
  router.get('/usage-breakdown', read('usage-breakdown', async ({ req, orgId }) => {
    const dimensionParam = String(req.query.dimension ?? 'project').trim().toLowerCase();
    const property = DIMENSIONS[dimensionParam];
    if (!property) {
      return {
        degraded: true,
        reason: 'unknown_dimension',
        note: `Pick one of ${Object.keys(DIMENSIONS).join(', ')}.`,
        dimension: dimensionParam,
        meter: CREDIT_METER,
        values: [],
      };
    }
    const limitParam = Number(String(req.query.limit ?? 10));
    const limit = Math.min(MAX_BREAKDOWN_VALUES, Math.max(1, Number.isFinite(limitParam) ? Math.floor(limitParam) : 10));
    const rangeParam = String(req.query.range ?? '30d').trim().toLowerCase();
    const win = windowFor({ range: rangeParam, nowMs: now() });
    const startIso = new Date(win.startMs).toISOString();
    const endIso = new Date(win.endMs).toISOString();

    const values = topValuesFor(orgId, BREAKDOWN_SOURCES[dimensionParam], limit, win.startMs, win.endMs);
    const perValue = await fanOut(values, FANOUT, async (value) => {
      const series = await usageSeries({
        orgId,
        startIso,
        endIso,
        filters: { [property]: [value] },
      });
      return { value, total: creditView(series.totalTokenCredits), bucketed: series.bucketed };
    });

    const rows = perValue
      .map((row, index) => (row === null
        // A failed dimension read is null, not 0: "this project used nothing" and
        // "we could not tell" are different answers about money.
        ? { value: values[index], total: creditView(null), unreadable: true }
        : { ...row, unreadable: row.total.tokenCredits === null }))
      .sort((a, b) => (b.total.tokenCredits ?? -1) - (a.total.tokenCredits ?? -1));
    return {
      dimension: dimensionParam,
      property,
      meter: CREDIT_METER,
      range: rangeParam,
      window: { startUtc: startIso, endUtc: endIso },
      values: rows,
      // The candidate list is ours, so a value FlexPrice has never seen is a
      // missing row rather than a FlexPrice bug — hence `source`.
      source: 'fleet_usage_records',
      // Provenance for the figure, so a reader knows what unit `total.tokenCredits`
      // is a SUM of: this is the metered property name, not a currency.
      sourceUnit: LLM.field,
      note: 'Values are the projects/users/agents this organization has records for; the credits beside each is a FlexPrice usage read filtered to that value.',
    };
  }, { dimension: 'project', values: [] }));

  // GET /api/billing/flexprice/log?tab=used|earned&limit=&offset= — wallet transactions.
  router.get('/log', read('log', async ({ req, orgId }) => {
    const tab = logTabOf(req);
    const limitParam = Number(String(req.query.limit ?? 50));
    const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Number.isFinite(limitParam) ? Math.floor(limitParam) : 50));
    const offsetParam = Number(String(req.query.offset ?? 0));
    const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? Math.floor(offsetParam) : 0;

    const walletId = await walletIdFor(orgId);
    // Debits are minted when an invoice is finalized, never per run (findings §2),
    // so an empty `used` tab is the expected state and must be explained as such.
    const note = tab === 'used'
      ? 'Wallet debits are posted when an invoice is finalized, not per agent run, so this list is sparse by design. The daily meter totals above are the consumption figure; expired and closed-wallet debits are labelled as adjustments, not usage.'
      : null;
    const empty = {
      tab,
      limit,
      offset,
      rows: [],
      nextOffset: null,
      total: null,
      note,
    };
    if (!walletId) {
      return { ...empty, degraded: true, reason: 'wallet_missing', walletResolved: false };
    }

    const query = { id: walletId, type: tab === 'used' ? 'debit' : 'credit', limit };
    if (offset) query.offset = offset;
    const response = await client().walletTransactionsSearch(query);
    const items = rowsOf(response);
    const pagination = response && response.pagination;
    return {
      tab,
      limit,
      offset,
      walletResolved: true,
      rows: items.slice(0, limit).map((row) => {
        const amount = rowCreditTokenCredits(row);
        return {
          id: row.id || null,
          at: rowTime(row),
          reason: row.transactionReason || null,
          reasonLabel: reasonLabel(row.transactionReason),
          // A debit that is not spend: credits expiring and a wallet closing both
          // reduce the balance without any agent having used anything, and a log
          // that lists them as usage invents cost the org never paid.
          kind: NOT_USAGE_REASONS.has(String(row.transactionReason || '').toUpperCase()) ? 'adjustment' : 'movement',
          amount: creditView(amount),
          remaining: creditView(rowAmountTokenCredits(row, 'creditsAvailable')),
          // What the wallet held after this row landed. `creditBalanceAfter` is a
          // real field on the transaction (`internal/domain/wallet/transaction.go`),
          // so the log's running-balance column needs no arithmetic of our own.
          balanceAfter: creditView(rowAmountTokenCredits(row, 'creditBalanceAfter')),
          expiresAt: rowExpiry(row),
          orderId: (row.metadata && row.metadata.fleet_order_id) || row.idempotencyKey || null,
          provider: (row.metadata && row.metadata.provider) || null,
          description: (row.metadata && row.metadata.description) || row.description || null,
        };
      }),
      // `pagination` is `{total, limit, offset}` in the response DTO
      // (`internal/types/pagination.go`), and `NewPaginationResponse` writes the
      // NEXT offset into it while `NewListResponse` writes the CURRENT one — the
      // search path uses one of the two depending on the route, so `offset` from
      // the envelope is never trusted. `total` is a plain count and is used when
      // present; the page falls back to "showing N" when it is not.
      total: pagination && Number.isFinite(Number(pagination.total)) ? Number(pagination.total) : null,
      nextOffset: items.length >= limit ? offset + items.length : null,
      note,
    };
  }, (req) => ({ rows: [], total: null, nextOffset: null, tab: logTabOf(req) })));

  return Object.assign(router, { invalidate });
}

module.exports = {
  createFlexpriceReadsRouter,
  // Exported for the tests: these are the decisions that a fake client must match.
  bucketCreditRows,
  tokenCreditsFromMeter,
  seriesFromUsage,
  dayWindow,
  windowFor,
  topValuesFor,
  fanOut,
  reasonLabel,
  // The isolation contract, exported because a test that re-implements them tests
  // nothing: the point is that the routes call THESE.
  scopeViolationOf,
  parseFilters,
  partition,
  PLAN_REASONS,
  ADDON_REASONS,
  NOT_USAGE_REASONS,
  REASON_LABELS,
  DIMENSIONS,
  BREAKDOWN_SOURCES,
  CREDIT_METER,
  MAX_WEEKS,
  MAX_BREAKDOWN_VALUES,
  FANOUT,
};
