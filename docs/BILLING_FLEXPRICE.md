# Billing on FlexPrice — architecture, invoice shapes, runbook

**Status: Phase 0 design document. Nothing here is wired to a running money path.**
Phase 1 is blocked on two conditions the plan set for itself, both of which fired:

- **item 18 (AGPL)** — `docs/FLEXPRICE_AGPL_MEMO.md`. Local use is clear;
  production conveyance is not. The `internal/ee` boundary the locked decision
  assumed does not exist as a boundary.
- **item 13 (stack weight)** — Kafka and ClickHouse are load-bearing, so there is
  no light FlexPrice (`docs/FLEXPRICE_FINDINGS.md` §0.2).

The four pure modules in `packages/shared-core/src/billing/` are tested and
imported by nothing. That is deliberate: they are the semantics Phase 1 will
build against, and the deterministic test
[`money-flow.test.js`](../packages/shared-core/src/billing/money-flow.test.js) is
the executable form of this document. Read §3 and that file together.

---

## 1. What owns what

One authoritative system for money, and exactly one owner for every number. Where
a fact has two homes, that is a defect — the same rule the repo already applies to
credentials ("never a fifth place for a key").

| Fact | Owner | Never held by |
|---|---|---|
| An org's spendable balance | **FlexPrice wallet** (`real_time_credit_balance`) | our `billingAccounts.balancePaise`, the gate, the UI |
| Price of a token or a model | `pricing.js` → FlexPrice price object | Prometheus (no `substrate_hourly_rate` series) |
| Price of an actor-hour | FlexPrice per-tier price | Prometheus, Node, a config map |
| GST rate and split | **Node** (`gst.js`) | FlexPrice's tax engine — which we do not use at all (§4) |
| Actor session duration (integer seconds) | `substrate-runner.js` `finally` block → `usage.js` → outbox | PromQL (it supplies the *live* view only) |
| Org → customer identity | FlexPrice `customer.external_id = org_id` | a mapping table |
| Whether work is allowed right now | `gate.js`, reading the FlexPrice projection | any local balance copy |
| Payment success | Cashfree, confirmed in Node `settle()` | FlexPrice webhooks (advisory only) |

The two-plane split: Node is the **collector** (Cashfree, GST, identity, the
admission decision) and FlexPrice is the **bank** (balances, draws, meters,
invoices, coupons, expiry). Nothing crosses from the bank back into the
collector's hands as a spendable number.

## 2. The three billable streams

| Stream | Metered quantity | Meter type | Priced by |
|---|---|---|---|
| LiteLLM token usage | paise, already computed by `pricing.js` | SUM | per-model price |
| Actor compute | **integer duration seconds** per `(org, project, user, tier)` | SUM | per-tier hourly rate |
| Platform charge | none — fixed | — | scheduled `MANUAL_BALANCE_DEBIT` of 300000 paise |

Actor compute is duration-based, not cpu/mem-based. Consequences we accepted:
OpenCost and cAdvisor are therefore not needed for billing
(`docs/SUBSTRATE_METRICS.md` §6 records that as a decision, not an oversight), and
`substrate_tier` is a *name for a fixed shape* (`standard-1v1g` = 1000m /
1073741824B, the values hardcoded at `substrate.js:545/551` today) rather than a
field actors vary on.

The quantity FlexPrice receives is **seconds**, and the paise conversion happens
once, inside their pricing, half-up. No 4-decimal rupees, and no third copy of a
price.

## 3. Money semantics, stated once

**Recharge.** ₹500 subtotal → CGST ₹45 + SGST ₹45 → **₹590 charged**,
**₹500 credited**. The ₹90 is tax collected; it is never spendable. Rounding is
per-component half-up with the total derived by addition, so the Cashfree charge
cannot differ from the invoice by a paise.

`1 credit = 1 paise` of prepaid value. A coupon bonus is *not* a re-denomination:
it lands as a separate promotional credit row with an expiry. Draw order is our
policy, recorded per line item so the Usage page can show which source paid —
**promotional first (earliest expiry), then prepaid**.

**The invariant, and its guard.** Every rupee credited is either prepaid
value paid for with tax on top, or promotional value granted for free:

```
collectedPaise == gstPaise + prepaidPaise + promoPaise
```

`money-flow.test.js` asserts that identity, and `credits.js`'s
`assertNoTaxCredited({ amountPaise, quote })` guards the specific way it breaks: it
throws when the amount credited equals a quote's **tax-inclusive** total while tax
was charged. The failure is quiet — a ₹500 recharge that credits ₹590 is not an
error anywhere, the balance simply looks right, and 18% of every tax rupee has
become spendable. `topUpCrediting()` returns `instructions[]`: one `prepaid` row
and, only when a bonus exists, one `promotional` row carrying the expiry.

The suite also pins ₹500/₹90/₹590, a 10% coupon
case (prepaid 50000 + promo 5000, charged still 59000 — a coupon never reduces
what the customer paid, it adds spendable value), and an IGST case with an
identical total.

Two verified facts that make the shape safe rather than merely plausible:

- FlexPrice's own purchased-credit path splits the same way — the invoice carries
  `credits_to_add × conversion_rate` **plus** tax while the credit carries
  `CreditAmount` (`wallet.go:984`). Their structure agrees with our arithmetic.
- `external_id` is unique per `(tenant_id, environment_id, external_id)` among
  published customers, so `org_id` is a real primary key into their customer
  table, addressable on events, wallet create, meter-usage query and invoice list.

## 4. The two invoice shapes

This is the part that has to be exact, because an invoice in a tax system is a
legal document and in FlexPrice it is also a state machine with timers attached.

### Shape A — the recharge invoice (taxable, gross)

Created by FlexPrice's native top-up path or by us with the customer's rate
attached, representing **money collected**:

| Field | Value | Why |
|---|---|---|
| `invoice_type` | `ONE_OFF` | never a subscription; nothing may cancel or downgrade |
| `subtotal` / `total` / `amount_due` | **all three = `590.00` (gross)** | `total` is copied from the sent `subtotal` and their tax adds 0, so the taxable figure has to go in the line items, not the header — measured in Phase 1, see the note below |
| GST | **two line items**, CGST ₹45.00 + SGST ₹45.00, amounts produced by `gst.js` | *not* their tax engine — see the note under Shape B |
| `payment_status` | `SUCCEEDED` after the gateway confirms | statement of fact, not a receivable |
| wallet credit | **500 credits** (`credits_to_add: "500"`) | tax excluded; never the `amount` field, which divides by the wallet's `conversion_rate` |
| `metadata.wallet_transaction_id` | set *only* if FlexPrice is the sole creditor | see the trap below |

`POST /v1/invoices` also checks the document against itself before it accepts it:
`sum(line amounts)` must equal the sent `amount_due`, or the request is a 400. So
Shape A is one number stated three ways — ₹590 in the header, ₹590 across the
lines — and a half-written invoice cannot reach the customer's Zoho.

### Shape B — the statement invoice (zero-tax, used for the platform charge)

Represents **money already consumed**, so GST on it would be a second charge on
the same rupee:

| Field | Value | Why |
|---|---|---|
| `invoice_type` | `ONE_OFF` | |
| `billing_reason` | `MANUAL` | |
| `invoice_status` | **`FINALIZED` at creation** | the draft-finalization cron (`auto_finalize` defaults **true**) otherwise finalizes it *and attempts a payment* |
| `metadata.auto_completed` | **`"true"`** | the only supported way to land on `SUCCEEDED` with `amount_paid = amount_due`; the `payment_status`/`amount_paid` request fields are accepted and then **silently dropped** |
| tax | **none, and none possible** — their tax engine is not used | `sum(invoice.tax) == 0` holds on every invoice by construction |
| `subscription_id` | absent | every dunning workflow is subscription-scoped |
| balance movement | separate `MANUAL_BALANCE_DEBIT`, `idempotency_key: platform-charge:<org>:<YYYY-MM>` | the API has no invoice field on a debit, so the link lives in the debit's `metadata.invoice_id` |

### Why their tax engine is off the table

FlexPrice's tax is computed from the **customer's** auto-apply rate associations
(`internal/ee/service/tax.go:1094-1155`), and the per-supply switch that looks like
the right answer — `tax_treatment: exempt` — is a **customer field**
(`api/dto/customer.go:67`, read at `api/dto/taxassociation.go:197`), not an invoice
field. It is absent from `CreateInvoiceRequest`. So a customer cannot be taxable for
its recharge and exempt for its statements, which are the same customer.

The posture that survives is: **never attach a tax rate to our customers, and put
GST on the recharge invoice as two ordinary line items whose amounts `gst.js`
produced.** Then:

- `sum(invoice.tax) == 0` is true for every invoice in the system, so the Zoho-side
  assertion cannot be violated by an omission nobody noticed.
- "Tax computed in Node so exactly one number exists" is literally true rather than
  approximately true — there is no second computation to disagree with ours.
- The invoice renders the way an Indian tax invoice is expected to render: subtotal,
  CGST, SGST, total.
- `place_of_supply` and the GSTIN on their customer record become descriptive fields
  for Zoho, not inputs to arithmetic. That removes the two-sources-for-one-fact
  problem the plan flagged.

✅ This was probed twice, and the second probe corrected the first. Phase 0 read
`total "500"` from a document whose lines summed to ₹590 and concluded that
**price-less lines do not enter `total`**. Phase 1 probe C rebuilt the same
document four ways and the rule turned out to be simpler and different: **`total`
is copied from the sent `subtotal`**, and whether a line carries a `price_id` or a
`display_name` makes no difference at all (priced and labelled invoices were
byte-identical). The ₹500 Phase 0 saw was its own `subtotal: "500.00"`, not an
exclusion.

Three things follow, and each is now a rule rather than a preference:

- The header carries the **gross**: `subtotal == total == amount_due == 590.00`.
  Sending the taxable ₹500 there produces a ₹500 invoice and a customer who was
  charged ₹590.
- `invoice.total_tax` is **always 0 on our invoices and must never be read as the
  GST**. The ₹90 exists only in the two line amounts and in our own `gst.quote`
  payload. Anything that wants the tax figure reads ours.
- The catalog's `gst-cgst-9` / `gst-sgst-9` / `gst-igst-18` price objects are
  **rate-card metadata** — the record of what the rate was on the day an invoice
  was issued — not invoice arithmetic. Changing them changes nothing already
  issued. §12 of the findings doc has the four-corner table.

**The double-credit trap.** `UpdatePaymentStatus(…, SUCCEEDED)` on an invoice
carrying `metadata.wallet_transaction_id` credits the wallet *inside FlexPrice*
(`invoice.go:2749-2766`). The plan assumed the risk lived in an unsigned webhook;
it also lives in a call we might make ourselves. One creditor, asserted in code,
never configured per-deployment.

**What cannot fire, and that is now enumerable rather than hoped for:** no
`payment_retry` key or dunning schedule exists anywhere in their cron registry;
auto-cancellation is default-off *and* subscription-scoped; the overdue workflow
needs a gated-env subscription; `invoice.payment.overdue` is emitted only as a
side-effect of a summary read we would have to perform ourselves.
(`docs/FLEXPRICE_FINDINGS.md` §6b has the table with each gate's file:line.)

## 5. The gate, and the one thing it cannot be

`gate.js:71`'s `balancePaise > 0` cannot become "read the FlexPrice balance",
because **that number does not move as usage accrues**. Debits happen at
invoice-finalize, not at ingest: an org can consume all day and still show a full
prepaid balance. The gate must read
`GET /v1/wallets/:id/balance/real-time` — a *computed projection* returning
`real_time_credit_balance`, `current_period_usage`, `unpaid_invoices_amount`,
`is_cached_fallback` ✅ measured, item 12. **`credits_available_breakdown` is not on
that list on purpose** (the field exists in the DTO, but it silently disappears from
a 200 response on any wallet holding a `PURCHASED_CREDIT_BONUS` row — findings §7d),
so nothing may branch on it.

As built (Phase 3), the view exposes the balance, the derived state, and
`unpaid_invoices_amount` — **and no usage number**. `current_period_usage` answers
`"0"` for every wallet in the stack, including one a manual debit drove to −2900:
it is anchored to the current *invoice* cycle, which does not exist until usage
invoices are finalized. Nothing was harmed by reading it; it is simply not the
accrued-usage figure it sounds like, and a field with that name on an admission
view would be read that way. Accrued usage lives where it was measured — the meter
sum the outbox drain reads back (findings §14).

Three consequences:

- B5's cache is load-bearing, not an optimisation. 8 call sites in 6 modules hit
  the gate per run; the endpoint is computed at read time. ✅ Measured (item 12):
  p50 **5 ms**, p95 **17 ms**, max 17 ms with `is_cached_fallback false` — the 30 ms
  budget holds, with under 2× headroom at p95, which is exactly why it is
  stale-while-revalidate rather than a synchronous fetch per call site.
- `CONFIG.BILLING.sweepEnabled` cannot stay the gate switch, because the sweep
  debit it names is being deleted. → explicit
  `gatePolicy: enforced | off`, where `off` is a **named, logged,
  non-default** local-dev mode replacing today's silent fail-open. The boot
  invariant is zero-credential `npm start`. As built it is two values, not the
  three planned: `stale_ok` would have been a policy about *freshness*, and
  freshness is already the `stale`/`isCachedFallback` flags on the view, so a
  policy that also carried it would have said the same thing twice. The default
  follows the money source — `enforced` when FlexPrice is configured, `off`
  otherwise — and `BILLING_GATE_POLICY` overrides it by name; `reportBoot()`
  refuses `enforced` with no FlexPrice rather than opening a door that logs as
  shut.
- A balance **can** go negative, via exactly one path: `MANUAL_BALANCE_DEBIT`
  bypasses the insufficient-balance check (`wallet.go:2438-2448`). Usage never
  overdraws; the platform charge does. So the gate needs a third state beyond
  `> 0`, and the charge job needs a deliberate policy (recommendation: pre-check
  and skip with a log line, rather than bill an org into a negative number the UI
  has no vocabulary for).

## 6. Security rules, and the one that changed

Non-negotiable, inherited from the repo's egress model:

- The FlexPrice key mounts on `services/billing` + the billing job **only**.
  FlexPrice is *not* an egress route and *not* a vault secret, so
  `egress-secret-parity.test.js` must pass unchanged and no provider-key env
  fallback may be added to the proxy. Agents/actors/workloads never see it.
- Org identity is never client-asserted; it comes from `billing-access.js`.
- Webhooks are **advisory only** — the non-Svix transport adds no signature at all.
- The UI renders FlexPrice-authored strings (invoice labels, coupon codes) with
  `el()` + `textContent`. **No `innerHTML`.**
- Never a `FLEXPRICE_ALLOW_INSECURE_DEFAULTS=true` boot outside local mode: it
  disables `validateCriticalSecrets` and `validateEncryptionKey` entirely, and the
  shipped `sk_local_flexprice_test_key` is a **super_admin** config-map key.

**What changed from the plan's assumption.** The plan feared the key was an
unscopeable company-wide *write* credential. Source says something narrower and
worse in a different direction:

- **Cross-tenant access is genuinely impossible** on every money path — and ✅
  measured, not just read: a scoped key writing against a *foreign* customer is
  refused **403**, while its own customer's event is accepted. Events have no tenant
  field in their DTO, wallet top-up/debit/balance fetch by scoped-ID first, invoices
  and ClickHouse meter usage carry `tenant_id` in the predicate.
  (`docs/FLEXPRICE_FINDINGS.md` §7 has the per-endpoint table and the probe output.)
- **But read RBAC is shadow-only.** Most read routes use `observe(...)` =
  `RequirePermission(..., Shadow())`, which logs a denial and *allows the
  request*. The narrowest useful role (`event_ingestor`, `event:write` only) can
  still read every wallet balance, invoice and meter usage inside its tenant —
  ✅ measured: an `event_ingestor` key read a production wallet balance at **200**.

Therefore: **two keys, not one** — the ingest plane (B3's outbox drain) and the
money plane (B1's client) get separate credentials. Be precise about what that
buys: it limits who can **write** money-shaped state, and it shrinks the blast radius
of a leaked ingest key to *read* exposure inside one tenant. **It is not a read
boundary, and must not be described as one** in the threat model. What actually
protects financials is that a FlexPrice read is never exposed to a browser:
read-scoping is enforced at our gateway, and the only legitimately per-customer
credential is their short-lived customer-portal session token.

Both plane keys must be **DB-minted** (`POST /v1/users` with
`type:"service_account"` + roles, then `POST /v1/secrets/api/keys` with
`type:"private_key"`), never the config-map key: that one is hard-coded
`super_admin` with a caller-chosen environment and therefore cannot be confined at
all. Environment-bound keys, by contrast, ignore a foreign `X-Environment-ID` —
confinement measured.

## 7. What Phase 1 deletes

No active users ⇒ deletion, not migration. No dual-write, no shadow gate, no kill
switch. The compensating control for losing the second ledger is the deterministic
money test — fixed events in, hand-computed paise out, zero tolerance.

`sweep.js:57-63` (the only debit path today) · `ledger.js`'s
`postEntry`/`refreshBalance`/`balanceFromLedger` money semantics and its ₹500 local
seed → FlexPrice promo grant · `gate.js`'s `balancePaise > 0` predicate and its
`sweepEnabled` coupling · `billingAccounts.balancePaise` as a *readable* balance ·
the `type:'recharge'` path in `billing-api.js:513-525` ·
`DEFAULT_ALERT_THRESHOLDS_PAISE` as local truth · `cost.js`'s local-balance
rendering.

`usageRecords` stays (outbox source + retention prune). `ledgerEntries` survives
only as a write-only developer journal — **nothing may read a money number from
it**.

These deletions are **explicitly blocked** pending the AGPL memo. Removing the
working money path while the replacement may be undeployable would leave the
product unable to bill at all.

**Status after Phase 2.** The `type:'recharge'` path in `verify-order` is gone —
every one-time credit now runs through `settle()` and the wallet, and nothing it
does touches `ledgerEntries`. Two items are still standing, on purpose:
`ledger.js`'s ₹500 local opening seed, because `gate.js` still reads
`balancePaise` and deleting the seed without moving the gate would lock everyone
out of a run (it goes in Phase 3 with the gate, which is the phase that replaces
it — the FlexPrice-side `FREE_CREDIT_GRANT` from Phase 1's provisioner already
exists, so no second funding source is being created); and the
`SUBSCRIPTION_PAYMENT_SUCCESS` mandate path, which is a *cashfree subscription*
credit with no quote and therefore no intent — the plan assigns the mandate spine
to Phase 6. The mandate path did get the two cheap fixes it was holding: replayed
events no longer double-credit, and its rupee conversion no longer goes through a
float.

**Status after Phase 3 — the list above is executed, and the grep gate holds it.**
`sweep.js` aggregates and prunes only (its balance debit is gone); `ledger.js`'s
money semantics went with its ₹500 local opening seed; `gate.js` reads the wallet
projection and no longer predicates on anything the store holds; and
`billingAccounts` carries no readable balance — the live proof is an account whose
keys are `createdAt, updatedAt, flexprice, id, orgId`. `ledgerEntries` is now what
the paragraph above says it must be: write-only.

The enforcement is `services/billing/src/balance-authority.test.js`, which scans the
tree and fails on any of: reading `account.balancePaise` (or any of its aliases),
calling `postEntry`/`refreshBalance`/`balanceFromLedger`/`currentBalancePaise`/
`maybeAutoRecharge`, calling `listLedgerEntries(` outside `store.js`, moving credits
outside the five files allowed to (`flexprice-client.js`, `recharge-settle.js`, and
the three provisioning/spike scripts), a `balancePaise` anywhere under `public/`, or
a reference to the deleted `/api/billing/ledger` route. It covers `packages`,
`services`, `public`, `scripts`, `e2e` and `e2e-live` — the last two because a test
fixture that still claims the old money model teaches it to the next reader.

Still standing, on purpose: the Cashfree `SUBSCRIPTION_PAYMENT_SUCCESS` mandate
spine (Phase 6). It is the one credit path with no quote and therefore no intent,
and the compensating control is that it **charges nothing** — `auto-recharge-job.js`
answers "the mandate is not settled into the FlexPrice wallet" and alerts the org
instead of capturing a payment that would leave the tenant paid and still blocked.

## 8. Independent of all of this

> ✅ **Closed in Phase 2**, as planned. `verify-order` and both webhooks now go
> through `settle()`, which refuses an order that is not the caller's (403
> `order_not_mine`) and takes the amount from the persisted intent rather than from
> whatever the gateway reports. §11 has the live transcript of the refusal.

`verify-order` (`billing-api.js:488-536`) **was** a live cross-tenant credit-theft
hole: it took an arbitrary `orderId`, fetched it from Cashfree, and credited
**the caller's own org** with `order.order_amount`, with no ownership check; the
dedupe then scanned only the caller's ledger, so it could not even detect the
duplicate. The fix did not depend on FlexPrice and did not wait — `settle()`'s
ownership and amount assertions are ~10 lines, and they are what the replay and
cross-org checks in §11 exercise.

---

## 9. Runbook — local

Everything below runs against Docker + the `kind-kind` cluster on this machine.
Nothing deploys to cloud in either phase.

### What exists today

```bash
npm run billing:flexprice:bootstrap  # A1 — checkout → secrets → build → up → verify
npm run billing:flexprice:spike      # A3 — 14 probes (pipeline-health first), prints + writes results.json
npm run billing:flexprice:inspect    # read back a wallet / balance / transactions / meter
npm run billing:flexprice:provision  # keys, meters, prices, GST prices, per-org customer+wallet
npm run billing:recharge:verify      # §11 — the recharge spine end to end, 53 checks
npm run billing:flexprice:down       # compose down -v (the -v matters: see §0.6)
npm run billing:metrics:check   # bash scripts/kind-metrics-install.sh
npm run billing:metrics:probe   # bash scripts/kind-otel-roundtrip.sh
npm test                        # includes the 4 unwired modules + money-flow.test.js
```

`billing:flexprice:bootstrap` is the one command the plan asked for: it generates
`deploy/flexprice/.env` (hex secrets, mode 600, nothing echoed), builds the image
from the pinned checkout, brings the stack up in the order the boot contract
requires, and ends with 11 assertions against the live API. It is idempotent, and
`--dry-run` rehearses without pretending. Topology: postgres + kafka + clickhouse +
temporal + redis + api/consumer/worker, plus `migrate` and `seed` one-shots;
**no** `full`/`minimal` profiles, because item 13 says Kafka and ClickHouse are
load-bearing (item 13's measured answer: 1.39 GiB, see §0.2).

`billing:metrics:check` is the guard for the two contracts billing depends on in
`otel-system`: the collector's `count` connectors still emit `substrate_*`, and
Prometheus's `keep` regex still admits them. It diffs the in-tree ConfigMap
snapshots against the cluster and **fails on drift** — silently counting nothing
is the failure mode this whole area has, and a silent failure deserves a check that
fails loudly. Modes: `--dry-run`, `--apply` (includes the rollout a mounted
ConfigMap needs), `--snapshot` (regenerate the in-tree copies from the cluster,
self-validating), `--report`.

`billing:metrics:probe` is the OTLP→collector→Prometheus→PromQL round trip. Run it
after `--apply`, and after any change to a metric name. The measured verdict worth
remembering: `agent_substrate_*` is **accepted** (HTTP 200, increments
`substrate_datapoints_total`) and then **dropped at scrape** by the `keep` regex —
accept ≠ ingest ≠ queryable, and that is the trap in this system.

### What Phase 0 still owes

Nothing in the stack: it comes up with one command and the four modules are tested.
What is owed is *decisions* — §13 — and the Phase 1 work itself, which the item-18
gate blocks.

Phase 1 has since been built and measured: the catalog is in §10, and the four
contract probes (A/B/C/D) are in `docs/FLEXPRICE_FINDINGS.md` §12. One Phase 0
reading did not survive probe C — the mechanism, not the outcome, changed; see §4.

Two compose traps found in source and easy to re-introduce:
`redis.cluster_mode` defaults to **true** (must be false against `redis:7-alpine`),
and `FLEXPRICE_DEPLOYMENT_MODE=local` **skips all config validation**, so a
successful local boot proves nothing about the api/consumer env you'd deploy.
Upstream's compose also volume-mounts `./internal/config`, so its containers read a
config *directory*; ours mounts nothing, which is why
`FLEXPRICE_RBAC_ROLES_CONFIG_PATH` has to be set explicitly — see §0.6.

Prometheus is deliberately **not** in that compose file: the cluster already runs
one, and Phase 0 extends its scrape config instead of standing up a second, so what
we validate locally is the thing that will run.

### Verifying a claim before repeating it

| Claim | How to check |
|---|---|
| a metric reaches Prometheus | `npm run billing:metrics:probe` — never trust the 200 |
| a name is still emitted | `npm run billing:metrics:check` |
| money math | `node --test packages/shared-core/src/billing/` |
| **the recharge spine, end to end** | `npm run billing:recharge:verify` — §11. The unit suites can only prove the refusals (`CONFIG` is a require-time snapshot), so this is the command that proves the ₹590 → 500-credit half against a live wallet |
| **the ingest pipeline actually works** | `npm run billing:flexprice:spike -- --only pipeline-health` — posts one event and requires it back through the meter. If this fails, every usage number below is a property of the compose stack, not of FlexPrice |
| a FlexPrice behaviour | the graded table in `docs/FLEXPRICE_FINDINGS.md` §9 (measured: ✅ / 🔴 / ◻, each citing its probe). If a claim is marked ◻ it was **not** probed and source reading is not evidence; re-run the spike rather than reasoning harder |

### Upgrade / ops posture (their side)

Forward-only in practice: dbmate requires a `-- migrate:down` section even when it
only explains why reversal is unsafe, no auto-rollback exists, and migrations run
*before* the new code rolls, so they must be additive and backward-compatible.
Code rollback is "a values flip, not an image rebuild"; schema stays migrated.
`lock_timeout=3s -c statement_timeout=0` in the apply wrapper is a deliberate fix
for a documented DDL-lock incident. Concurrency safety is deploy orchestration, not
in-repo advisory locks — which means **two app pods migrating at once is our
problem to avoid**, and the compose file must run migration as a one-shot.

## 10. The catalog as provisioned

`npm run billing:flexprice:provision` is what created this, and re-running it is
what keeps it true: it reports `created / existing / failed` per resource and is
safe to run against a live stack (the dry run above wrote nothing and found 27
existing). Ids are not secret and are not stable across a teardown — after
`billing:flexprice:down` everything below is re-minted, so read them from the
provisioner or `billing:flexprice:inspect` rather than copying them into code.

**Two keys, two planes.** `FLEXPRICE_API_KEY_INGEST` (service account
`fleet ingest plane`, role `event_ingestor`) and `FLEXPRICE_API_KEY_MONEY`
(`fleet money plane`, `super_admin`). Both live in `deploy/flexprice/.env`, which
is not committed. What the split is proven to do (probe D) and what it is not
proven to do are different sentences — see §6 before describing it as a boundary.

**Meters** — three, all `SUM`, all `reset_usage: DAILY`:

| Meter | event_name | aggregation field | Emitted by |
|---|---|---|---|
| `llm-cost` | `fleet.llm_cost` | `cost_paise` | Phase 3 outbox |
| `actor-compute` | `fleet.actor_compute` | `duration_seconds` | Phase 4 runner STOP |
| `deployment-minutes` | `fleet.deployment_minutes` | `minutes` | **nothing** (D8 — meter defined, no emitter; the UI renders it inert, not zero) |

**Prices** — 16, all attached to the `fleet-catalog` plan, all INR:

- `recharge-principal` — the ₹500 taxable line.
- `gst-cgst-9` / `gst-sgst-9` / `gst-igst-18` — rate-card metadata only. Probe C
  settled that the invoice total comes from the header, not from these
  (`§4`), so nothing may treat their presence as the reason a GST line was
  charged; and nothing may read `invoice.total_tax` as the GST amount, because it
  is always `0` on our invoices.
- `meter-llm-cost` / `meter-actor-compute` / `meter-deployment-minutes` — usage
  prices, `USAGE`/`ARREAR`. `actor-compute` is priced **0** per D4.
- `rate-<provider>-input` / `rate-<provider>-output` × 7 providers (claude, codex,
  antigravity, ollama, lmstudio, omlx, huggingface) — generated from
  `pricing.js` × `USD_TO_INR`, with the FX date recorded in metadata. **Read this
  twice:** the catalog snapshot is decoration next to the live one. D9 moved
  `USD_TO_INR` out of the *display* path and into the *ingest* path —
  `usage.js` calls `pricing.usdToPaise()` with it to produce the `cost_paise` the
  outbox delivers, so the rate reprices every future run and is a versioned
  catalog input, not a page setting. Changing it should go with a re-provision, so
  the two copies (the prices here and `CONFIG.BILLING.usdToInr`) do not drift.

**Per-org** — `POST /v1/customers` with **flat** `address_*` fields (nested
`address` is accepted and dropped) then a `PRE_PAID` INR wallet with
`conversion_rate:'1'`. The local org `ota` exists so the gate has something to
read: `cust_01M77WCFMW6T54FYP70EMPZ7HA` / `wallet_01M77WCFN8WCQ8H1DKARS1DFD1`,
seeded with **500 free credits** as `FREE_CREDIT_GRANT` — never
`bonus_credits_to_add`, which silently breaks the credit-row breakdown.
`--org <id>` provisions another org; `FLEET_ORG_ID` does the same non-interactively.

The opening grant is the replacement for `ledger.js`'s deleted ₹500 local seed, so
it is the only way an org gets money without paying:

```bash
node scripts/flexprice-provision.js --org <orgId> --free-credit
node scripts/flexprice-inspect.js balance <walletId>     # → real_time_credit_balance 500
```

It reads the wallet before it writes one: a non-zero balance means **no grant**
(`openingCreditDecision`), so a second run cannot stack a second ₹500. The same
grant happens on its own for an org the org service reports as the free tier — the
`is_default` flag, never the name or a tag — and `--free-credit` is the deliberate
exception for when that answer is unavailable (no org service, id not a tenant
UUID, or the call failed). An org that needs money after that recharges (`§11`):
nothing in the app can hand an org credits any more, because `settle()` is the only
credit site and it requires a quoted, paid intent.

Two known pieces of litter, both intentional: probe B creates a dedicated meter
per run (`phase1-<run> probe-b`) because measuring float behaviour needs an
aggregation field nothing else uses, and probe D mints and **revokes** a key to
prove the money key cannot. Neither is part of the catalog; delete the meters if
the list bothers you, they are not referenced.

## 11. The recharge spine — as built (Phase 2)

Four pieces, and one rule: **`services/billing/src/recharge-settle.js` is the only
code in this repository that adds spendable credit.**

```
POST /recharge            → quote only. Returns ₹500 + CGST ₹45 + SGST ₹45 = ₹590,
                            500 credits. Persists nothing, credits nothing.
POST /recharge/create-order  (also /cashfree/…, /razorpay/…)
                          → re-quotes, writes the `rechargeIntents` row (status
                            QUOTED), then asks the chosen gateway for an order.
POST /cashfree/verify-order · /razorpay/verify-order · /recharge/settle
POST /cashfree/webhook · /razorpay/webhook
                          → all five delegate to settle(), in that order:
                            intent exists → belongs to the caller's org → not
                            already settled → the GST recomputes to the intent's
                            own totals → the provider confirms the intent's
                            amount → credit `paiseToCredits(subtotalPaise)` →
                            read the wallet back → only then status SETTLED.
```

`payment-providers.js` is the two adapters behind that seam (Cashfree takes rupees
as a decimal string, Razorpay takes integer paise; both are verified, neither is
allowed to define the price). `BILLING_ALLOW_MOCK_PAYMENTS` is read in exactly two
places — `settle()` and the create-order gate — and both read the same helper, so
a deployment cannot create mock orders in one place and refuse them in the other.

**Both live holes in §8 are closed by it.** `verify-order` credited the *caller's*
org for any `order_<org>_` id it could fetch; it now refuses with 403
`order_not_mine` before touching a wallet, and the org comes from the gateway's
`x-ai-fleet-billing-org-id` header, never from the request body. The webhook
credited any PAID order with no server-side amount check; it now settles the
*intent*, so the amount is the one this server quoted.

### Running it

```bash
npm run billing:recharge:verify        # 53 checks against the live stack
npm run billing:recharge:verify -- --keep
```

It boots the real `services/billing/src/app.js` on an ephemeral loopback port with
a throwaway org id, drives the routes exactly as a browser and the gateway would,
and reads the money back out of FlexPrice rather than trusting its own responses.
It needs the stack up and provisioned (`billing:flexprice:bootstrap`,
`billing:flexprice:provision`) and reads both plane keys from
`deploy/flexprice/.env` — it never echoes one. No Cashfree or Razorpay credentials
are involved: the payment is the local mock (decision D1), so **what this proves is
the arithmetic, the ownership and the idempotency — not a real ₹590 capture**,
which stays Phase 7 item 5.

### Transcript (2026-11-12, FlexPrice v2.1.48, org `org-recharge-verify-mwdpe7v1`)

```
1. quote ₹500 (POST /recharge — quote only)
  [ok] settled:false — a quote credits nothing
  [ok] subtotal 50000p + gst 9000p = total 59000p
  [ok] total rendered as the decimal string "590.00"
  [ok] CGST 9% 4500p + SGST 9% 4500p
  [ok] credits = 500 = subtotal/100, never total/100   (total/100 would be 590)
  [ok] place of supply assumed from the supplier state (no GSTIN saved) — state=24 assumed=true

2. place of supply from the saved GSTIN (24=Gujarat supplier)
  [ok] intra-state GSTIN 24 → CGST+SGST, assumed:false, total still 59000p
  [ok] inter-state GSTIN 27 → one IGST 9000p, total unchanged at 59000p, credits=500
  [ok] a malformed GSTIN is refused at the write, not stored — 400 invalid_gstin
  [ok] a rejected GSTIN changes nothing — the previously saved 27 still prices the quote

3. Cashfree — create-order persists, verify-order settles
  [ok] create-order returns the mock checkout for an unconfigured gateway
  [ok] provider recorded as cashfree (org default) with environment named — env=sandbox
  [ok] create-order echoes the gross as "590.00", never a provider number
  [ok] intent persisted — QUOTED 50000/9000/59000/500 gstin=24AAACR1296F1Z5
  [ok] settlement reports 500 credits added, ₹590.00 collected
  [ok] collected == gst + prepaid×100 + promo×100  →  59000 = 9000 + 500×100 + 0×100
  [ok] wallet real_time_credit_balance is EXACTLY 500

4. replay the same order
  [ok] replay is accepted as already-processed, not re-charged
  [ok] balance still EXACTLY 500 after the replay
  [ok] exactly one credit row for the settled order

5. ownership and provenance refusals
  [ok] another org cannot settle my order — 403 order_not_mine
  [ok] an order id with no intent is refused — 404 intent_not_found
  [ok] a missing order id is refused — 400 missing_order_id
  [ok] a caller context with no admin role cannot mutate billing — 403 access_denied
  [ok] none of the refusals moved the balance

6. 10% coupon bonus on a ₹500 recharge
  [ok] coupon settle reports 500 paid + 50 bonus credits
  [ok] charged unchanged at ₹590.00 (the bonus is not a discount)
  [ok] balance is now 1,050   [ok] the bonus is a FREE_CREDIT_GRANT row, not a bonus field

7. Razorpay — second gateway, same settle()
  [ok] quote ₹1,000 → 18,000p GST → 118,000p total
  [ok] a bad Razorpay signature is refused before any credit — payment_signature_invalid
  [ok] the refused signature left the intent QUOTED
  [ok] razorpay verify-order settles — wallet balance is now 2,050 credits

8. credit-row proof
  [ok] three purchase rows totalling 2,000 credits — never 2,270 (₹590+₹590+₹1,180)
  [ok] every purchase row carries priority 1 and reason PURCHASED_CREDIT_DIRECT
  [ok] each row's idempotency key is the recharge order
  [ok] GST metadata on the row is the ₹90, recorded but never credited

9. the mock refusal (BILLING_ALLOW_MOCK_PAYMENTS=false)
  [ok] create-order with no gateway and no mock flag is refused — provider_not_configured
  [ok] the refusal wrote no intent   [ok] and left the balance at 2,050
```

The headline invariant, in one line of that output: `59000 = 9000 + 500×100`. ₹590
is collected, ₹90 of it is tax, 500 credits become spendable, and the identity
`collected = gst + prepaid×100 + promo×100` is asserted from the settled intent —
so a future change that credits the gross shows up as a failure here, not as an
invoice that quietly over-funds someone.

### Measured while proving it

* 🔴 **`GET /v1/customers/:id/wallets` answers a bare JSON array** — not the
  `{items}` envelope every search route uses. And it reports `currency: "inr"`
  lower-case. The first live run caught the consequence: `ensureWallet()` looked
  for `items`, found none, re-created the wallet, took the `409 already_exists`
  echo as the created resource, and then asked for the balance of wallet
  `undefined`. That is not a first-recharge bug — **every second recharge for the
  same org would fail.** Fixed at the client boundary (`flexprice-client.js`
  `rowsOf()`), with the casing fixed in `recharge-settle.js` and
  `scripts/flexprice-provision.js` too, and a refusal (`flexprice_wallet_unresolved`)
  for a wallet that still cannot be resolved, so the failure is a 502 with a
  sentence rather than a credit to `undefined`. Regression tests: the client's
  three-shape read, and `recharge-settle.test.js`'s "a second recharge for the
  same org reuses its wallet".
* A credit row is `type: "credit"` with `transaction_reason:
  "PURCHASED_CREDIT_DIRECT"`; the credited amount is `credit_amount` (string) and
  the remaining amount is `credits_available`. `idempotency_key` round-trips on
  the row, which is what makes a replay provably one row.
* `metadata` on the row carries `subtotal_paise`, `gst_paise`, `collected_paise`,
  `provider`, `fleet_order_id` — the GST is *recorded* next to the credit and is
  never part of it.
* `placeOfSupply` in a quote response is `{type, stateCode, supplierStateCode,
  assumed, basis}`. Nothing in the tree reads a nested `code` key.

### What Phase 2 deliberately did not finish

Recorded as deviations in `docs/BILLING_IMPLEMENTATION_PLAN.md` §Phase 2 outcome —
the unknown-location GST rule (supplier-state default + `assumed`, not IGST), the
`ledger.js` opening ₹500 seed left in place one phase longer (the gate still reads
`balancePaise`; the FlexPrice-side `FREE_CREDIT_GRANT` already exists), and the
Razorpay checkout-signature check being conditional on the browser presenting one.

## 12. The usage pipeline — as built (Phase 3)

Four pieces, and one rule: **a run never waits for billing, and billing never
believes a 202.**

```
recordUsage()  (usage.js)        writes the usage record AND one `billingOutbox`
                                 row. No network call on this path, ever.
        ↓  on the 5-minute billing tick
drainOnce()    (outbox-drain.js)  POST /v1/events/bulk ≤1000 rows, keyed
                                 ev:{org}:{run|recordId}:{meter} → rows go `sent`
        ↓  next pass
verify()       (outbox-drain.js)  POST /v1/events/usage/meter per org+meter over the
                                 window; equal ⇒ `verified`, else WARN + stay `sent`
        ↓  continuously, on demand
gate.js                           GET /v1/wallets/:id/balance/real-time behind a
                                 single-flight SWR cache (15 s TTL)
```

The three rules that make the pipeline honest, each measured rather than assumed:

- **`sent` is not `verified`.** A 202 from `eventsBulk` means Kafka took the batch;
  findings §3 shows it does not mean ClickHouse aggregated it, and an event whose
  `event_name` matches no meter — or whose property is spelled wrong — is stored,
  acknowledged, and contributes nothing *silently*. So the drain reads the number
  back out of the meter and only then marks the row, and the row that stays `sent`
  past 30 minutes is the standing alarm (`staleSent()`).
- **The window is the event's clock, not the drain's.** `occurredAt` is stamped at
  enqueue, so a backlog drained an hour late still meters into the hour it happened
  — otherwise the read-back disagrees with what was sent, which is exactly the drift
  the alarm is supposed to be able to see.
- **The gate reports money and nothing else.** `current_period_usage` is `"0"` on
  every wallet in the stack (findings §14), so the view carries the balance, the
  derived state (`available` / `exhausted` / `negative` / `unknown`),
  `unpaid_invoices_amount` and `gatePolicy`. Accrued usage lives on the meter.

`npm run billing:usage:verify` — 40 checks, `scripts/flexprice-usage-verify.js` —
proves the above end to end against the live stack: four runs → three rows (a BYOK
run queues nothing) → ₹35.50 hand-computed → meter reads exactly `3550` → the credit
balance has *not* moved → a blind double re-send does not move the meter → a typo'd
`event_name` complains and the row stays `sent` → a closed port leaves every row
`pending` with `attempts` at 1 and the usage records untouched → and with every
`FLEXPRICE_*` unset the fleet still boots, logging `gatePolicy=off`. Full read-back
transcript: `docs/FLEXPRICE_FINDINGS.md` §14.

**The first-party money paths are gone.** `sweep.js` no longer touches balances,
`ledger.js` keeps no money semantics and its ₹500 local opening seed is deleted (the
FlexPrice-side `FREE_CREDIT_GRANT` from §10 replaced it), `billingAccounts` holds no
readable balance, `USD_TO_INR` moved *into* the ingest path and its float arithmetic
replaced with the BigInt boundary, and `cost.js` renders only what the server
derived. What enforces that is §7's grep gate — `services/billing/src/balance-authority.test.js`,
7 checks over `packages`, `services`, `public`, `scripts`, `e2e` and `e2e-live`.

### What Phase 3 deliberately did differently

Recorded as deviations in `docs/BILLING_IMPLEMENTATION_PLAN.md` §Phase 3 outcome:
the drain lives at `packages/shared-core/src/billing/outbox-drain.js` rather than
`services/billing/src/` (the gateway and planner import it), the exit criterion is
the **meter sum** rather than the wallet balance (findings §2 — consumption does not
debit at ingest), the ingest outage is a **closed port** rather than a container
restart, `gate.js` carries no usage field, and `pricing.js usdToPaise` is decimal
arithmetic rather than the display-only helper D9 assumed it was.

## 13. Decisions still needed from you

1. **AGPL** — the memo's five options with a recommendation. Nothing else here is
   actionable until this is chosen; I am not treating "probably fine" as an answer.
2. **Negative balances** — pre-check and skip the platform charge for an org with
   no credits, or bill it and let the balance go negative (§5)?
3. **Where the low-balance alert lives** — their `wallet.credit_balance.dropped`
   event could retire `DEFAULT_ALERT_THRESHOLDS_PAISE`, and the precondition is met:
   ✅ the threshold is set **per wallet by us** at creation (`api/dto/wallet.go:64`),
   not gated by an `internal/ee` entitlement. ◻ What is still unknown is *when* they
   fire it — no alert consumer was minted by the spike. So the decision is only
   "do we let FlexPrice notify, or keep our own threshold-and-mail" — and keeping ours
   is the safe default until that is measured.
4. ~~GST as line items depends on price-less invoice lines.~~ ✅ **Settled twice —
   and the second settling reversed the first.** Phase 0 measured that an invoice
   whose lines sum to ₹590 reports `total "590"` and concluded *priced* lines were
   what made that true. Phase 1 probe C re-ran it with the header held constant and
   found the truth is elsewhere: `total` is **copied from the sent `subtotal`**, and
   `price_id` on a line is decoration (priced and labelled lines came out identical).
   So the ₹500-taxable header comes back ₹500 no matter how the lines are built.
   The conclusion for us is unchanged and now better founded: the ₹590 is ours to
   compute and render (`gst.js`), no UI may label a FlexPrice `total` as "amount
   charged", and Phase 2 sends `subtotal == total == amount_due ==` the **gross**.
   What did change is that the GST lines' ₹45 each are a disclosure for Zoho rather
   than the source of the total. §12 of the findings doc has the probe.
5. **Do you want pod-level infra visibility at all.** Billing does not need it
   (duration model). If you want it in the same panel for capacity conversations,
   kube-state-metrics + node-exporter is the OpenCost-shaped addition this plan
   declined, and §6 of `docs/SUBSTRATE_METRICS.md` is where it would stop being a
   skip.
6. **The ₹/hour for `standard-1v1g`** (plan item 27) — the tier name is decided and
   the price lives in FlexPrice, but the number is yours. Nothing else in Phase 0
   waits on it; the `compute-pricing.js` fixture's expected paise does.
7. **The drawn-source column on the Usage page** — 🔴 FlexPrice reports **no**
   per-line-item source attribution (a 700 draw across two credit rows wrote a single
   debit row). Either we derive the column from the credit rows' remaining-balance
   deltas, or we drop it and show promo/prepaid balances separately. Deriving is
   honest but is arithmetic on someone else's rows; dropping loses a column the plan
   promised.
8. **Auto-recharge on a Cashfree mandate — charge it, or keep refusing.** Since
   Phase 3 the job **does not charge**: a mandate payment has no quote and therefore
   no `rechargeIntents` row, and `settle()` — the only code that may credit — refuses
   an order it never quoted. Charging anyway would take money and leave the org
   blocked, which is the worst available outcome, so the job alerts the org instead
   (`rechargeIsNotChargeable`: "the mandate is not settled into the FlexPrice
   wallet"). The decision is the shape of the replacement: mint an intent at
   mandate-charge time (the org's saved amount + GST + place of supply, quoted by the
   same `gst.quote` as a manual recharge) and let `settle()` credit it, or retire the
   mandate and keep recharges manual. The first is Phase 6's assignment; the second
   is a product decision nothing in the code can make.
