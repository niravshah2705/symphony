# Plan — Billing platform: FlexPrice + LiteLLM + substrate actors + OTel + Cashfree/Razorpay + Zoho GST

Approved 2026-11-12, on top of the Phase 0 plan (`/Users/niravshah/.qoder/plans/nimble-cove-hare.md`) and its
measurements (`FLEXPRICE_FINDINGS.md` §9-§11, `SUBSTRATE_METRICS.md`). This file is the live tracker — tick the
status table as each phase lands, and record any deviation in place rather than rewriting the decision above it.

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo hygiene: branch, commit Phase 0 artifacts, code-graph fresh | ✅ `91cd2c9` + `ad479cb`, PR #278 |
| 1 | Money boundary, FlexPrice config/client, catalog provisioning, probes A/B/C/D | ✅ recorded below |
| 2 | Recharge spine — Cashfree + Razorpay, one `settle()`, ₹590 / 500 credits | ⬜ |
| 3 | Usage outbox → ingest, gate reads the wallet, first-party balance deleted | ⬜ |
| 4 | Actor sessions, OTel emitter, orphan sweeper | ⬜ |
| 5 | Zoho connector, ₹3000 platform charge, expiry assertion, reconciliation | ⬜ |
| 6 | UI split, read-boundary posture, pre-existing fixes, full suite | ⬜ |
| 7 | Production release decision document | ⬜ |

All phases are written down and decided here. Phases 0–6 execute locally, Phase 7 is a decision document. Where a measurement could contradict a choice, the choice is still made now and the fallback is pre-committed — we change it later only if we have to.

## Context

Phase 0 (plan `/Users/niravshah/.qoder/plans/nimble-cove-hare.md`; artifacts untracked at `e9c58a8`) proved the money semantics against a live FlexPrice stack (14 probes, `docs/FLEXPRICE_FINDINGS.md` §9-§11) and the metrics path against `kind-kind` (`docs/SUBSTRATE_METRICS.md`). Four pure modules exist with 40/40 tests green and are imported by nothing. This plan makes them authoritative.

Headline invariant, enforced end to end: **a ₹500 recharge charges ₹590 (CGST ₹45 + SGST ₹45), credits exactly 500 spendable credits, and the ₹90 never becomes spendable** — with GST amount and customer GSTIN reaching Zoho Books.

## Decisions, locked

| # | Question | Decision |
|---|---|---|
| D1 | Payment proof locally | **Mock-only.** No Cashfree/Razorpay keys exist in this worktree (there is no `.env` at all). Money math is asserted exactly; the live ₹590 capture is a Phase 7 launch item |
| D2 | Gateways | **Cashfree + Razorpay, org picks.** One provider seam → one `settle()` → one `rechargeIntents`. FlexPrice's native Razorpay connector is **not** used: payment success stays Node's, or we reintroduce the double-credit loop |
| D3 | Zoho | **Their first-class connector only; no Zoho code of ours.** To make that correct, GST lines become **priced** price objects so invoice `total` = ₹590 (price-less lines are measured to be excluded from `total`) |
| D3a | D3 mechanism, corrected by probe C | The connector choice **stands**; the reason changed. `invoice.total` is copied from the sent `subtotal` — `price_id` on a line is decoration, and priced and labelled lines came out byte-identical. So the shape is `subtotal == total == amount_due ==` gross ₹590, the CGST/SGST lines carry ₹45 each as Zoho's disclosure, and `total_tax` is always `0` and must never be read as the GST. GST is rendered from **our** header, not from FlexPrice's line arithmetic. |
| D4 | Actor price | **Meter `duration_seconds`, price 0.** Item 27 stays an operator number; nothing bills actor compute yet |
| D5 | First-party money paths | **Deleted outright, inside the phase that replaces them.** No shadow, no dual-write, no migration, no held-back deletion phase |
| D6 | Credit unit | **1 credit = ₹1 = 100 paise.** `credits.js:22 PAISE_PER_CREDIT` flips 1 → 100. All internal arithmetic stays integer paise; conversion happens only in `money-wire.js` |
| D7 | Topology | **Keep compose + kind.** FlexPrice :18080 (verified 200), LiteLLM :14000, substrate+Prometheus+OTel+Jaeger in `kind-kind`. Nothing moves into the cluster |
| D8 | Deployment usage | **Meter defined, no emitter.** No deployment-duration source exists; we do not invent a quantity |
| D9 | LLM money path | **Node's `pricing.js` owns token→paise; LiteLLM stays an oracle, never an emitter.** `USD_TO_INR` (`config.js:909`) leaves the money path and becomes a dated catalog-generation input |
| D10 | OTel | Node's runner is the authoritative START/STOP clock. The OTLP emitter publishes live-accrual gauges only, for the orphan case and the savings panel |
| D11 | Legal | Local build proceeds on the memo's explicit dev/test clearance for the unmodified image. Nothing production-facing is enabled before `docs/FLEXPRICE_AGPL_MEMO.md` §7 is answered in writing |

## Phase map

| Phase | Goal | Exit criterion |
|---|---|---|
| 0 | Repo hygiene | Work is on a branch and committed; code-graph docs fresh |
| 1 | Boundary, client, catalog, contract re-validation | Provisioned stack + 14 probes green at `v2.1.48` + 3 new probes green |
| 2 | Recharge spine, dual gateway, one `settle()` | ₹590 charged / 500 credits, replay-safe, cross-org order refused |
| 3 | Usage → outbox → ingest; gate reads the wallet | Hand-computed balance equals FlexPrice at zero tolerance; first-party balance deleted |
| 4 | Actor sessions, OTel emitter, sweeper | Kill-the-planner case accrues then closes; metric names survive the scrape filter |
| 5 | Zoho connector, platform charge, expiry assertion, reconciliation | Zoho fixture shows ₹590 + both tax components; double-run of the charge yields one debit |
| 6 | UI split, security posture, full suite | `npm test` + `npm run test:e2e` green; boots with and without `FLEXPRICE_*` |
| 7 | Production release plan | `docs/BILLING_PRODUCTION.md` written; no cloud code |

---

## Phase 0 — Repo hygiene (do first, 10 minutes)

1. `git switch -c feat/billing-flexprice-phase1` (we are on a detached HEAD at `e9c58a8`; a commit here lands on no branch).
2. Commit the Phase 0 artifacts as-is: `docs/{BILLING_FLEXPRICE,FLEXPRICE_FINDINGS,FLEXPRICE_AGPL_MEMO,SUBSTRATE_METRICS}.md`, `packages/shared-core/src/billing/{gst,credits,compute-pricing,substrate-session}.js` + tests, `deploy/flexprice/`, `scripts/flexprice-*`, `scripts/kind-*`, `.gitignore`, `package.json`. `deploy/flexprice/.env` stays out — verified covered by the root `.env` ignore.
3. New source trips the code-graph pre-commit gate: `npm run docs:code` then `git add -A docs/code-graph` before committing.
4. Commit the plan itself as `docs/BILLING_IMPLEMENTATION_PLAN.md` so the phases live in the repo, not only in `~/.qoder/plans/`.

No product code changes.

## Phase 1 — Boundary, client, catalog, contract re-validation

New files.

`packages/shared-core/src/billing/money-wire.js` — the single unit boundary.
```js
paiseFromDecimal('500.005') -> 50000      // shift 2 places on the STRING (BigInt); sub-paise truncated only at the final half-up
decimalFromPaise(59000)      -> '590.00'
creditsToPaise(500)          -> 50000     // PAISE_PER_CREDIT = 100, exported from credits.js
paiseToCredits(50000)        -> 500
```
Banned anywhere in the money path: `parseFloat` on money, `Math.round(x*100)`, FlexPrice's `ToSmallestUnit` (truncates → systematic 1-paise underbill). `gst.js:189 toCashfreeOrderAmount` delegates to `decimalFromPaise` so one implementation exists.

`packages/shared-core/src/billing/flexprice-config.js` — sole reader of `FLEXPRICE_ENABLED`, `FLEXPRICE_BASE_URL` (default `http://127.0.0.1:18080`), `FLEXPRICE_ENVIRONMENT_ID`, `FLEXPRICE_API_KEY_INGEST`, `FLEXPRICE_API_KEY_MONEY`, `FLEXPRICE_TIMEOUT_MS` (default 5000), `FLEXPRICE_SUPPLIER_STATE_CODE`. Surfaced as `CONFIG.FLEXPRICE` beside the `BILLING` block at `config.js:906-920`. Boot assertions: refuse a config-map key when `FLEXPRICE_ENABLED=true`; refuse `FLEXPRICE_ALLOW_INSECURE_DEFAULTS=true` outside local; assert Temporal is reachable (their credit-expiry workflow depends on it); log the mode.

`packages/shared-core/src/billing/flexprice-client.js` — headers `x-api-key` + `X-Environment-ID` (mandatory; absent → 403). Exports `createCustomer, listEnvironments, createMeter, createPrice, createWallet, topUpWallet, grantPromo, debitWallet, eventsBulk, eventsUsage, eventsUsageMeter, walletRealTimeBalance, walletTransactionsSearch, createInvoice, finalizeInvoice, getHealth`. Retries **only** on idempotency-keyed writes. Maps `409 already_exists` → success. Never logs a key; never accepts a caller-chosen environment id.

`scripts/flexprice-provision.js` (`npm run billing:flexprice:provision`, idempotent, `--dry-run`, prints created-vs-existing per resource):
- two keys, **DB-minted only**: `POST /v1/users {type:'service_account', roles:[…]}` → `POST /v1/secrets/api/keys {type:'private_key'}`. One ingest-plane key, one money-plane key. The config-map key is never used (hard-coded super_admin + caller-chosen env = unconfinable).
- meters: `llm-cost` (SUM, field `cost_paise`), `actor-compute` (SUM, field `duration_seconds`), `deployment-minutes` (SUM, created and never emitted).
- prices: per-model INR prices generated from `pricing.js` × `USD_TO_INR` with the FX date recorded in metadata, plus **three GST prices** — `cgst-9`, `sgst-9`, `igst-18` (`price_type:'FIXED'`, INR).
- per-org: `POST /v1/customers {external_id: org_id, address_line1, city, state, postal_code, country}` — **flat** address fields, never nested — then `POST /v1/wallets {external_customer_id, currency:'INR', wallet_type:'PRE_PAID', conversion_rate:'1', alert_settings:{…}}`.
- free initial credit (replaces `ledger.js:50-62`'s local seed) as **`FREE_CREDIT_GRANT`**, never `bonus_credits_to_add` / `PURCHASED_CREDIT_BONUS` — a single bonus row silently destroys `credits_available_breakdown` at HTTP 200.

`scripts/flexprice-phase1-probes.js` — four probes appended to `docs/flexprice-spike/results.json` in the existing `{name,item,ok,observed,decision,at}` shape: **A** `conversion_rate` direction — measured: `credits_to_add` is denominated in **credits** and rate-independent, while `amount` divides by the rate, so Phase 2 tops up with `credits_to_add`; **B** integer-vs-float64 inside event `properties` (the one path findings §12 marks unprobed) — measured: integers exact including one JS rewrites at 2^53, fractions arrive as float64 sums, which is why quantities are integer paise / integer seconds; **C** whether the GST lands in the invoice total — measured: **D3 holds, not by the mechanism named above** (see D3a); **D** the two-plane write confinement, including that the money key cannot mint or enumerate credentials. All four green at the re-pinned `v2.1.48`.

`deploy/flexprice/VERSION` re-pointed at tag `v2.1.48` (from `main`+226) with `FLEXPRICE_REBUILD=1`, then the full 14-probe spike re-run — `VERSION`'s own instruction.

Committed answers + pre-agreed fallbacks:
- **A**: assumed `conversion_rate:'1'` means 1 credit = ₹1. If measured otherwise, the fix is confined to `creditsToPaise/paiseToCredits` in `money-wire.js` (one place, by design) and the wallet field — nothing else in the money path changes.
- **B**: quantities go as integers only (`cost_paise`, `duration_seconds`). No float-in-properties dependency is written anywhere, so B cannot break ingest.
- **C**: priced GST lines. If FlexPrice excludes them or applies its tax engine anyway, GST stops being rendered from FlexPrice's `total` at all and Phase 5's Zoho step records ₹590 from our own `gst.quote` payload — the connector choice stands, the disclosure moves.

Verification: `npm run billing:flexprice:bootstrap && npm run billing:flexprice:provision && npm run billing:flexprice:spike && npm run billing:flexprice:phase1-probes && node --test packages/shared-core/src/billing/` → all green, 0 failing verdicts, `node scripts/flexprice-inspect.js meters` and `customer <org>` show the catalog.
Docs: `FLEXPRICE_FINDINGS.md` §12 (probes A/B/C + re-run), `BILLING_FLEXPRICE.md` §10 (catalog as provisioned).

### Phase 1 outcome (recorded here, decisions above left as written)

Green at the re-pinned `v2.1.48` (commit `21524530`, locally built image `4ad8d8ca6e69`):
bootstrap 11 checks, the full 14-probe spike **re-run** with 0 failing verdicts, probes
**A/B/C/D** 4/4, provisioner 32 created / 0 failed, `node --test
packages/shared-core/src/billing/` green.

- **A confirmed the assumption.** `credits_to_add` is denominated in credits and
  rate-independent; `amount` divides by `conversion_rate`. `PAISE_PER_CREDIT = 100`
  stands and Phase 2 uses `credits_to_add`. The fallback was not needed.
- **B confirmed the rule** — integers exact (including one JS rewrites at 2^53),
  fractions arrive as float64 sums. Nothing depends on a fractional property.
- **C is the deviation.** D3's outcome held (₹590 with both components reaches the
  invoice, `total_tax` 0) but the mechanism is the **header**, not the priced line:
  `total` is copied from the sent `subtotal`, and priced and labelled lines came out
  identical. Recorded as D3a; Phase 2/5 wording follows it. The pre-agreed fallback
  was not needed — no disclosure moved.
- **D added** beyond the plan: the two-plane split verified as a *write* boundary,
  and the money key proven unable to mint credentials (`IsSuperAdminUser()` is false
  for service accounts). Any key probe D mints is revoked before it exits.
- The stack was torn down and reinitialised for the re-pin — an older binary over a
  newer schema is a downgrade, not a restart (see `deploy/flexprice/VERSION`).
  `scripts/flexprice-provision.js --rotate-keys` exists because of it: after `down -v`
  the stored keys are dead, and a stale key 401s with no hint where it came from.

## Phase 2 — Recharge spine: quote → dual-gateway order → one `settle()`

New files.

`services/billing/src/payment-providers.js` — one interface, two adapters, chosen by `paymentInfo.provider`:
```js
createOrder({ provider, orderId, amountPaise, notes }) -> { checkoutUrl, providerOrderId }
verify(orderId)                        -> { status, amountDecimal, providerOrderId }
parseWebhook(rawBody, headers)         -> { event, orderId, amountDecimal, verified }
```
Cashfree adapter wraps the existing `cashfree-client.js` (order amount `"590.00"`, HMAC-SHA256 over `timestamp+rawBody`). Razorpay adapter is greenfield: `/v1/orders` create with `amount` in paise and `currency: INR`, checkout URL, signature verify as HMAC-SHA256 over `order_id|payment_id` with `RAZORPAY_KEY_SECRET`, webhook secret check. Env: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_BASE_URL`, `RAZORPAY_WEBHOOK_SECRET`. **No mandate/auto-recharge for Razorpay in this phase** — one-time recharge only; Cashfree keeps the existing subscription path.

`services/billing/src/recharge-settle.js` — **the only code allowed to credit.** `settle({ orgId, orderId, actor })` asserts, in order: the intent exists; `intent.orgId === callerOrgId` (never client-asserted; comes from `billing-access.js`); status moves `QUOTED → SETTLED` exactly once; `gst.quote(intent.subtotalPaise, intent.couponBps).totalPaise === intent.totalPaise`; the provider's amount equals `intent.totalPaise` in decimal; credits added `=== paiseToCredits(subtotalPaise)` and **never** `paiseToCredits(totalPaise)`; FlexPrice credit-row read-back matches; then `credits.assertNoTaxCredited`. `BILLING_ALLOW_MOCK_PAYMENTS=true` is read **only here** — unset ⇒ refuses `mock_payment_not_accepted`, because the unconfigured mock at `cashfree-client.js:247-253` fabricates `PAID` / ₹100. The mock returns a fixed ₹100, so the intent, not the mock, is the amount authority.

`rechargeIntents` store collection — `store.js:464-473` key list + accessors modelled on `addLedgerEntry`, working for both the file and Firestore backends: `{ orderId, orgId, provider, subtotalPaise, couponBps, bonusPaise, gstPaise, totalPaise, creditCount, status, createdAt, settledAt, providerOrderId }`. Created at quote time — `create-order` persists nothing today (`billing-api.js:466-475`), which is exactly why the ownership hole cannot be fixed in place.

Modified: `billing-api.js` — `/recharge` (`:307`) becomes quote-only (returns the full GST breakdown); `create-order` persists the intent and emits `totalPaise` as `"590.00"`; `verify-order` (`:488-544`) and `webhook` (`:604-643`) both delegate to `settle()`; GSTIN written through `gst.parseGstin` (`ledger.js:33`'s `taxId` is stored unvalidated and unread today) and `resolvePlaceOfSupply` from it — absent or invalid GSTIN ⇒ **IGST**, never a silent CGST split. `credits.js:22` → `PAISE_PER_CREDIT = 100`. The wallet top-up is `credits_to_add` = subtotal rupees, **never** `amount`, which FlexPrice divides by `conversion_rate` (probe A). `public/js/views/cost.js` recharge widget renders ₹500 + ₹45 + ₹45 = ₹590 via `el()`/`textContent`.

**Security fix in this phase (live today, independent of FlexPrice):** `verify-order` credits **the caller's own org** with any fetchable `order_<org>_` id, and the webhook credits any PAID order with no server-side amount re-verification (`billing-api.js:612-642`). `settle()`'s ownership + amount assertions close both, in ~10 lines.

Deleted in this phase: the `type:'recharge'` ledger path (`billing-api.js:513-525`) and `ledger.js:50-62`'s local ₹500 seed (→ `FREE_CREDIT_GRANT`).

Verification: `BILLING_ALLOW_MOCK_PAYMENTS=true FLEXPRICE_ENABLED=true npm start`, scripted recharge on **both** providers → intent `totalPaise 59000`, `gstPaise 9000`, wallet `real_time_credit_balance` **exactly 500**, credit-row `credits_available` delta 500, `collectedPaise == gstPaise + prepaidCredits×100 + promoCredits×100`; replay the same order → one credit; a cross-org order id → refused; Razorpay bad signature → refused.
Docs: `BILLING_FLEXPRICE.md` §11 recharge runbook with a payload transcript for both gateways.

### Phase 2 outcome (recorded here, decisions above left as written)

Done and green. `npm run billing:recharge:verify` — 53/53 checks against the live
stack at `v2.1.48`; `node --test packages/shared-core/src/billing/
services/billing/src/` 220 tests / 218 pass / 0 fail / 2 skipped; `npm test` 2139
tests / 2135 pass / **0 fail** / 4 skipped. The
transcript is `BILLING_FLEXPRICE.md` §11 and the plan's Phase 2 verification line
is met verbatim: intent `totalPaise 59000`, `gstPaise 9000`, wallet
`real_time_credit_balance` **exactly 500**, `collected 59000 = 9000 + 500×100 +
0×100`, replay → one credit row, cross-org → 403, bad Razorpay signature → refused,
and the `BILLING_ALLOW_MOCK_PAYMENTS=false` run → refused with no intent written.

Four deviations, each deliberate:

- **The unknown-location GST rule is not IGST.** The plan said "absent or invalid
  GSTIN ⇒ IGST, never a silent CGST split". Charged as written, that is wrong law
  and it blocks recharges: under Art 269 / the IGST Act s.7 the levy follows the
  *place of supply*, which for an unregistered consumer is their location — and
  when that is genuinely unavailable the default rule is the supplier's state, not
  inter-state. Forcing IGST on every GSTIN-less B2C customer would over-collect
  tax in our own state and refuse the ₹45+₹45 headline case. `gst.js` now resolves
  supplier-state and reports `placeOfSupply.assumed: true` + `basis`, and the quote
  response and the UI both show it, so the guess is visible rather than silent
  (which was the actual worry behind the rule). An invalid GSTIN is refused at the
  *write* (`PUT /config` → 400 `invalid_gstin`) instead of being stored and
  ignored, so the `assumed` path is for a customer who never gave one.
- **`ledger.js`'s ₹500 opening seed is not deleted in this phase.** D5 says delete
  inside the phase that replaces the thing, and the replacement is `gate.js`
  reading the wallet — which is Phase 3. Deleting the seed now would leave every
  org with a zero first-party balance and a gate that still reads it, i.e. nobody
  could run anything. The FlexPrice-side `FREE_CREDIT_GRANT` from Phase 1's
  provisioner already exists, so Phase 3 removes the local seed with no new work.
  The `type:'recharge'` path the plan did assign to this phase **is** gone.
- **The Razorpay checkout signature is verified when the browser presents one.**
  The plan's `verify(orderId)` shape has no signature arguments, because
  Razorpay's proof is over `order_id|payment_id`, which only the client has after
  checkout. So `/razorpay/verify-order` takes `razorpayOrderId`,
  `razorpayPaymentId`, `razorpayPaymentSignature` and refuses a mismatch (400
  `payment_signature_invalid`) before `settle()` runs; with no signature fields it
  falls through to `settle()`'s own server-side amount check, which is the
  authority either way. `parseWebhook` covers the webhook half.
- **Two gates added that the plan did not name.** `create-order` refuses an
  unconfigured gateway with 400 `provider_not_configured` *before* writing an
  intent (an order nobody can pay is not a record worth keeping), and
  `settle()` refuses with 502 `flexprice_wallet_unresolved` rather than crediting
  wallet `undefined`. The second one is the live bug the first run found —
  `GET /v1/customers/:id/wallets` answers a bare array with lower-case `currency`,
  so every second recharge for an org re-created its wallet and read the 409 back
  as a missing id. Fixed at the client boundary (`rowsOf()`), documented in
  `FLEXPRICE_FINDINGS.md` §13 with its regression tests.

Beyond the code the plan listed, the UI half moved too: `public/js/recharge.js` is
the shared checkout flow for both gateways (the old inline Cashfree block and the
"Add credits (manual)" button that credited without paying are deleted), and the
cost page renders the server's quote — ₹500 + ₹45 + ₹45 = ₹590, 500 credits — from
`textContent` only.

## Phase 3 — Usage → outbox → ingest; the gate reads the wallet; first-party balance dies

New files.

`packages/shared-core/src/billing/billing-outbox.js` — row `{ id, orgId, projectId, userId, runId, meter, eventName, quantityPaise|quantitySeconds, idempotencyKey, status: pending|sent|verified|failed, attempts, createdAt }`, written **alongside** `recordUsage` (`usage.js:62-120`, the only place run usage persists today). Never inline a network call: a billing outage must not become run failures.

`services/billing/src/outbox-drain.js` on the existing 5-min tick (`services/billing/src/app.js:61-70`): `POST /v1/events/bulk` (≤1000) with key `ev:{orgId}:{runId}:{meter}`, then **read-back** `POST /v1/events/usage/meter` over the window and assert the value before marking `verified`. Justification, all measured: a 202 proves nothing (Kafka publish failure is swallowed), an event matching no meter or a typo'd aggregation field is stored and contributes nothing **silently**, and `value` is omitted when 0. First-wins dedup on `event_id` makes blind retries safe, and a sent event is never mutated. The outbox is the only proof of delivery; the reconciler is the alarm.

Modified `gate.js` — reads `GET /v1/wallets/:id/balance/real-time` (`real_time_credit_balance`, `current_period_usage`, `unpaid_invoices_amount`, `is_cached_fallback`) behind a single-flight stale-while-revalidate cache (measured p50 5 ms / p95 17 ms, so the cache is load-bearing), plus a **synchronous cached accessor** so the 8 call sites in 6 modules (`run-ticket.js:144`, `pipeline-admission.js:701/786`, `capability-view.js:51`, `planner/routes/agent.js:936/967`, `provisioner/handler.js:91`, `scheduler.js:233/572/580`, `coder-orchestrator.js:616/940`) and ~237 colocated stubs stay sync. **Three states, not two**: positive, non-positive, and **negative** — only `MANUAL_BALANCE_DEBIT` can produce one (measured −2900) because it bypasses the insufficient-balance check. `gatePolicy: enforced | off` replaces the `sweepEnabled` coupling at `gate.js:30/93`; `off` is named, logged at boot, non-default — required because `npm start` must boot with every `FLEXPRICE_*` unset (`scripts/start-all.js:31-37`).

Modified `usage.js` — `llm-cost` quantity from `pricing.js` (D9: Node owns token→paise; LiteLLM is an oracle, never an emitter). Whole-paise integers, no fractional rupees.

Default-org rule: a real `is_default` bool on `Organization` in `services/org` (today the only signal is string equality on the name, and `OrgUpdate.name` lets anyone rename it — bypassable in both directions: free-tier hole *and* unchargeable real org), exposed on the internal billing context and enforced at every site that can move money. `__shared__` stays permanently exempt (`org-context.js:18`).

Deleted in this phase: `sweep.js:57-63` (the only debit path today), `ledger.js`'s `postEntry`/`refreshBalance`/`balanceFromLedger` money semantics, `billingAccounts.balancePaise` as a readable balance, `gate.js`'s `balancePaise > 0`, `DEFAULT_ALERT_THRESHOLDS_PAISE` as local truth, `cost.js`'s local-balance rendering. `usageRecords` **stays** (outbox source, retention prune wanted). `ledgerEntries` survives only as a write-only developer journal — nothing may read a money number from it.

Verification: fixed event set → FlexPrice balance equals hand-computed paise at **zero tolerance**; kill the api container mid-drain → row stays `pending` and a blind retry is safe; typo an `event_name` → the reconciler complains rather than the balance silently freezing; every `FLEXPRICE_*` unset → `npm start` boots and logs `gatePolicy=off`; `grep` gate finds no readable first-party balance.
Docs: `FLEXPRICE_FINDINGS.md` §13 "Outbox + gate as built, with the read-back transcript".

## Phase 4 — Substrate actor sessions, OTel emitter, orphan sweeper

Modified `packages/shared-core/src/agent/substrate-runner.js`:
- stamp `startedAt` at `createEphemeralActor` (`:325`) — the de-facto START, which today takes no timestamp at all (only a transient `waited` poll counter at `:334-341`);
- in the `finally` (`:399-404`, the de-facto STOP) compute integer `durationSeconds = max(0, …)` via `substrate-session.js closeSession` and write it through `usage.js` → outbox as `actor-compute`;
- **add `userId`/`userEmail` to the `recordUsage` call at `:378-386`** — supported at `usage.js:91-92`, dropped today, and without it per-user attribution is unfixable and the Usage page cannot be built;
- attribute org/project/user/tier as event properties (bare names — see Phase 6).

Modified `substrate.js:545/551` → the hardcoded 1000m / 1 GiB is *named* `standard-1v1g` and mapped by `compute-pricing.js tierFor`. Price **0** per D4; a missing rate still throws rather than defaulting, and an unknown shape returns `null` rather than silently billing the wrong tier.

New `packages/shared-core/src/otel/actor-metrics.js` — the repo's **first** metric producer (today: only the trace SDK + a Langfuse span processor; `deploy/litellm/config.yaml:68-69` leaves otel callbacks off). Publishes exactly the three names in `substrate-session.js:22-26` — `substrate_actor_start_timestamp_seconds`, `substrate_actor_first_seen_timestamp_seconds`, `substrate_actor_running_seconds_total` — because the collector's `metric_relabel_configs` keep only `/^(substrate|otelcol)_/` (`deploy/flexprice/kind/prometheus-configmap.yaml:93-96`) and anything else is **accepted with HTTP 200, increments `substrate_datapoints_total`, then is scrape-dropped** (proved by `scripts/kind-otel-roundtrip.sh`). Tenancy rides on **datapoint attributes** (`fleet_org_id`, `substrate_tier`, `agent_id`), never `service.name` (it becomes `exported_job`). Live accrual and the savings panel come from this; **the money never comes from PromQL**, and no `substrate_hourly_rate` series is created — a price in Prometheus would be a third copy of the truth.

New `services/billing/src/actor-session-sweeper.js` — `settleOrphans` closes a session with no STOP at **last-seen**, not sweep time (`substrate-session.js:139-152`, `ORPHAN_GRACE_SECONDS = 180`, configurable; a young session is never swept), so a planner pod killed mid-run cannot bill forever and a genuinely-running actor accrues visibly instead of vanishing from the ledger.

New `services/billing/src/savings-panel.js` — always-on baseline minus actual, computed in PromQL against the existing `otel-system` Prometheus. **Read-only analytics, never billed** — an always-on counterfactual is not a charge, and the savings figure is never wired to any debit.

`deployment-minutes`: meter exists, no emitter (D8). The UI must render it as inert, not as zero usage.

Verification: `./scripts/kind-metrics-install.sh --dry-run` clean, then `--apply`; `/api/v1/label/__name__/values | grep substrate_actor` lists all three with `fleet_org_id` present on the datapoints; create an actor, kill the planner, confirm the gauge accrues and the sweeper closes at last-seen with no unbounded charge; a 90-second session equals `compute-pricing.js`'s fixture exactly at a test rate and 0 at price 0; clock-skew test → bills nothing rather than crediting.
Docs: `docs/SUBSTRATE_METRICS.md` §10 "Emitter as built + the two PromQL oracles". ConfigMaps stay in-tree, never hand-patched.

## Phase 5 — Zoho connector, platform charge, expiry assertion, reconciliation

Zoho (D3, mechanism per D3a): configure FlexPrice's `internal/integration/zoho/` connector for customers + invoices; **we write no Zoho API code**. Correctness comes from Phase 1 probe C — the invoice `total` reaching Zoho is ₹590 because the **header** is sent gross (`subtotal == total == amount_due == 590.00`), and the CGST/SGST lines carry ₹45 each so both components are visible on the document. `price_id` on those lines is decoration, not arithmetic (D3a). Customer `tax_rates` stay empty so `sum(invoice.tax) == 0` and their tax engine never fires. GSTIN + address arrive from the flat customer fields provisioned in Phase 1. Verification is a recorded-response contract test (`ZOHO_MODE=fake`, captured-body assertions, no credentials needed — none exist locally); the live OAuth call is one documented operator step.

Platform charge ₹3000/month as **two ordered calls**: `POST /v1/invoices {invoice_type:'ONE_OFF', billing_reason:'MANUAL', invoice_status:'FINALIZED', external_customer_id, metadata:{auto_completed:'true'}}` — the `payment_status`/`amount_paid` request fields are accepted then **silently dropped**, and the `auto_finalize` cron defaults true, hence FINALIZED-at-creation — then `POST /v1/wallets/:id/debit {transaction_reason:'MANUAL_BALANCE_DEBIT', idempotency_key:'platform-charge:<org>:<YYYY-MM>', credit_amount, metadata:{invoice_id}}` (there is no invoice field on a debit, hence metadata). **Never** `metadata.wallet_transaction_id` on an invoice we also credit, **never** `/invoices/:id/payment` — `UpdatePaymentStatus(SUCCEEDED)` credits the wallet inside FlexPrice, which is the real double-credit loop. Debit replay returns `409 already_exists` (unique index, no pre-check) and maps to success. The balance is pre-checked so the charge cannot drive it negative.

`credit-expiry-job.js` becomes an **assertion**, not a scheduler: their read-time filter plus Temporal `WalletCreditExpiryWorkflow` do the work; ours verifies a back-dated promo grant is no longer drawable and warns otherwise.

`reconcile-gateway-spend.js` extends from printing one JSON line per org (today, read-only, unscheduled) to a FlexPrice-vs-recorded comparison reusing `MATCH_TOLERANCE_PAISE`, wired to the tick so it is the standing drift alarm. Credit reads use `POST /v1/wallets/transactions/search` (response keyed `items`, not `data`); `credits_available_breakdown` stays banned.

Verification: run the charge job twice → exactly one debit; the Zoho fixture shows ₹590 with CGST+SGST disclosed and `invoice.tax == 0`; a back-dated promo grant → the next debit draws prepaid; a deliberately dropped event → the reconciler reports divergence.
Docs: `BILLING_FLEXPRICE.md` §12 runbook (charge, Zoho setup, upgrade, two-key rotation).

## Phase 6 — UI split, read-boundary posture, pre-existing fixes, full suite

New `public/js/views/usage.js` and `public/js/views/billing.js`, split from `cost.js`. Precedent: commit `5a587ae`, 7 touchpoints (`app.js:90-107`, `:115-132`, `index.html:306-372`, `permissions.js:9-31`, `api.js:572-586`).
- Usage: credit-consumption line items grouped by project and user via **one `POST /v1/events/usage` call per dimension value with `filters` on the BARE property name** — `group_by` on a SUM meter is silently ignored (grouped = tenant total), `property_filters` is ignored, dotted `properties.X` matches nothing, and `detailed-analytics` answers 200 with empty `items`. The fan-out is N+1 and loaded lazily per project. Drawn-source column derived from credit-row `credits_available` deltas **or dropped** — no per-line-item attribution exists (a 700 draw across two credit rows wrote one debit row). Live actor accrual for running sessions; the savings panel; `deployment-minutes` shown inert.
- Billing: subscription, payment methods (Cashfree/Razorpay), invoices, recharge widget with the GST breakdown and coupon field. **Never render a FlexPrice `total` as the amount charged** — ₹590 is ours, derived by addition from `gst.quote`. No FlexPrice string (invoice labels, coupon codes) ever reaches `innerHTML`; `el()` + `textContent` only.

Read-boundary posture: **read RBAC in FlexPrice is shadow-only** — a lesser key reads any wallet in its tenant at 200 — so the two-key split is a *write* boundary and must never be described as a read boundary. Every FlexPrice read stays inside `services/billing`; no FlexPrice key or read ever reaches a browser.

Pre-existing fixes: `orderStatus` returned vs `status` read by the UI (`billing-api.js:536`/`cost.js:367`); `billingAddress` vs `address` key mismatch (now load-bearing for place of supply); `SUBSCRIPTION_PAYMENT_SUCCESS` double-credit (no dedupe, loops every account); webhook signature **failing open** outside production (`:585`); docs saying `SUBSCRIPTION_STATUS_CHANGE` vs code matching `..._CHANGED`. Webhooks stay advisory-only, deduped on our side (the non-Svix transport adds no signature).

Full verification (also the reuse recipe):
```bash
npm run billing:flexprice:bootstrap && npm run billing:flexprice:provision && npm run billing:flexprice:spike
./scripts/kind-metrics-install.sh
npm test && npm run test:e2e
FLEXPRICE_ENABLED=true npm start            # then again with every FLEXPRICE_* unset
node scripts/flexprice-inspect.js balance <org-wallet>
```
Money assertions at exact paise, zero tolerance: ₹500 mock → charged **59000p**, **500 credits**, 9000p GST never spendable; 10% coupon → prepaid 500 + promo 50 credits, charged unchanged at 59000; interstate → same total, IGST split; replay → one credit; a negative balance → the gate refuses with the negative state; `gatePolicy=off` logs loudly; no first-party balance readable anywhere in the tree.

## Phase 7 — Production release plan (document only, no cloud code)

`docs/BILLING_PRODUCTION.md`:
1. **AGPL first, and it gates everything else** — `docs/FLEXPRICE_AGPL_MEMO.md` is unsigned; local dev/test on the unmodified image is cleared, production conveyance is not. Route §7's three questions (does the unqualified root AGPL grant production use of `internal/ee` notwithstanding `ee/LICENSE`; is unmodified SaaS via REST a "conveyance/modification"; do "user seats" mean staff or end customers) to counsel or the vendor. If the answer is no, the memo's option-4 first-party engine becomes the plan and FlexPrice shrinks to the compute/price catalog.
2. Hosting: managed FlexPrice vs self-hosted GKE vs first-party fallback. `ghcr.io/flexprice/flexprice` is private (anonymous pull → 401), so production must build in CI from a **release tag** and pin a registry digest, not a local image ID.
3. Tenancy: shared vs per-tenant, and what `customer.external_id = org_id` means with real customers; per-env vs one environment.
4. Secrets: the two key planes minted non-locally and a rotation procedure; the boot assertion that rejects the config-map key; never a fifth place for a key.
5. Payments: production Cashfree/Razorpay keys, real webhook signature verification (the fail-open must be gone), and **one live ₹590 capture reconciled to 500 credits** — the thing mock-only leaves unproven.
6. Zoho: per-org OAuth, through their endpoint allowlist rather than our own URL handling.
7. Ops: Temporal/ClickHouse/Kafka HA, backup and restore, upgrade process and the pinned-version discipline (the tag list contains a non-SemVer `v2.17` that sorts after `v2.1.48` — never derive "latest" by sorting).
8. Catalog: FX/model-price update process; rate-card sign-off for `standard-1v1g` (item 27, deliberately still open).
9. Launch: canary org, then the pre-launch checklist tied to the exact Phase 1-6 commands above.
10. Rollback: redeploy the previous pinned commit and re-seed. **There is no dual-write to fall back to** — that is the price of D5 and it must be stated plainly to whoever signs off.

## Accepted risks

1. Mock-only ⇒ the ₹590 is never really charged by a PG locally; Phase 7 item 5 is the compensating step.
2. Delete-outright with no shadow ⇒ no second ledger detects a FlexPrice mis-price. Two controls exist: the deterministic zero-tolerance money test, and the LiteLLM-vs-FlexPrice reconciler promoted to a scheduled alarm.
3. Probes A/B/C could contradict Phase 1's committed answers; each has a pre-agreed, localized fallback so the shape of the plan does not change.
4. The AGPL memo stays unsigned. Local build proceeds on the memo's own dev/test clearance; nothing production-facing turns on without a written answer.
5. `USD_TO_INR` leaving the money path changes display numbers in `pricing.js` consumers — enumerate them in Phase 3 rather than assume.

## Critical files

**New** — `packages/shared-core/src/billing/{money-wire,flexprice-config,flexprice-client,billing-outbox}.js` (+tests) · `packages/shared-core/src/otel/actor-metrics.js` · `services/billing/src/{payment-providers,recharge-settle,outbox-drain,actor-session-sweeper,savings-panel,credit-expiry-job}.js` · `scripts/{flexprice-provision,flexprice-phase1-probes}.js` · `public/js/views/{usage,billing}.js` · `docs/BILLING_PRODUCTION.md` · `docs/BILLING_IMPLEMENTATION_PLAN.md`

**Modified** — `packages/shared-core/src/billing/{gst,credits,gate,usage,sweep,ledger}.js` · `packages/shared-core/src/{store,config}.js` · `packages/shared-core/src/agent/{substrate,substrate-runner}.js` · `services/billing/src/{billing-api,app,auto-recharge-job,reconcile-gateway-spend}.js` · `services/gateway/src/{billing-access,pipeline-admission}.js` · `services/org` `Organization` model + context/onboarding services · `public/js/{app,api,permissions}.js` · `public/index.html` · `deploy/flexprice/{VERSION,compose.yaml,kind/*}` · `package.json`

**Reused, not rebuilt** — `gst.js quote/parseGstin/resolvePlaceOfSupply/roundHalfUpPaise` · `credits.js topUpCrediting/assertNoTaxCredited/drawOrderForDebit/bonusPaise` · `substrate-session.js openSession/closeSession/accrue/orphanedSessions/settleOrphans` · `compute-pricing.js TIERS/tierFor/priceActorUsage/savingsEstimate` · `flexprice-bootstrap/inspect/spike` · `kind-metrics-install.sh` / `kind-otel-roundtrip.sh` · `money-flow.test.js` as the identity proof · `pricing.js usdToPaise` (display only) · `org-context.js SHARED_ORG_ID` · `billing-access.js` (org is never client-asserted) · `auto-recharge-job.js`'s `--validate` dry-run pattern

**Out of scope** — cloud/Terraform implementation · any Go fork of FlexPrice · FlexPrice's Razorpay connector or tax engine · their `credits_available_breakdown` · migrating first-party balances (no active users → re-seed) · e-invoicing/IRN, GST returns, TDS/TCS, RCMA/SEZ, debit/credit notes · dunning, refunds, proration, tiered/seats pricing, multi-currency · real gVisor actors locally · cpu/mem-hour billing · moving FlexPrice into kind · the FlexPrice dashboard · Langfuse/OTel spend views.
