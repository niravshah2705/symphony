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

Three consequences:

- B5's cache is load-bearing, not an optimisation. 8 call sites in 6 modules hit
  the gate per run; the endpoint is computed at read time. ✅ Measured (item 12):
  p50 **5 ms**, p95 **17 ms**, max 17 ms with `is_cached_fallback false` — the 30 ms
  budget holds, with under 2× headroom at p95, which is exactly why it is
  stale-while-revalidate rather than a synchronous fetch per call site.
- `CONFIG.BILLING.sweepEnabled` cannot stay the gate switch, because the sweep
  debit it names is being deleted. → explicit
  `gatePolicy: enforced | stale_ok | off`, where `off` is a **named, logged,
  non-default** local-dev mode replacing today's silent fail-open. The boot
  invariant is zero-credential `npm start`.
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

## 8. Independent of all of this

`verify-order` (`billing-api.js:488-536`) is a live cross-tenant credit-theft hole
today: it takes an arbitrary `orderId`, fetches it from Cashfree, and credits
**the caller's own org** with `order.order_amount`, with no ownership check; the
dedupe at `:498` scans only the caller's ledger so it cannot detect it. A ~10-line
fix (own the order or refuse) does not depend on FlexPrice and should not wait for
Phase 1.

---

## 9. Runbook — local

Everything below runs against Docker + the `kind-kind` cluster on this machine.
Nothing deploys to cloud in either phase.

### What exists today

```bash
npm run billing:flexprice:bootstrap  # A1 — checkout → secrets → build → up → verify
npm run billing:flexprice:spike      # A3 — 14 probes (pipeline-health first), prints + writes results.json
npm run billing:flexprice:inspect    # read back a wallet / balance / transactions / meter
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
What is owed is *decisions* — §11 — and the Phase 1 work itself, which the item-18
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
  `pricing.js` × `USD_TO_INR`, with the FX date recorded in metadata (D9: this is
  a catalog snapshot, not a money-path input).

**Per-org** — `POST /v1/customers` with **flat** `address_*` fields (nested
`address` is accepted and dropped) then a `PRE_PAID` INR wallet with
`conversion_rate:'1'`. The local org `ota` exists so the gate has something to
read: `cust_01M77WCFMW6T54FYP70EMPZ7HA` / `wallet_01M77WCFN8WCQ8H1DKARS1DFD1`,
seeded with **500 free credits** as `FREE_CREDIT_GRANT` — never
`bonus_credits_to_add`, which silently breaks the credit-row breakdown.
`--org <id>` provisions another org; `FLEET_ORG_ID` does the same non-interactively.

Two known pieces of litter, both intentional: probe B creates a dedicated meter
per run (`phase1-<run> probe-b`) because measuring float behaviour needs an
aggregation field nothing else uses, and probe D mints and **revokes** a key to
prove the money key cannot. Neither is part of the catalog; delete the meters if
the list bothers you, they are not referenced.

## 11. Decisions still needed from you

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
