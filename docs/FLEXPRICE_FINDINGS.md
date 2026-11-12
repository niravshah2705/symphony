# FlexPrice findings — Phase 0 spike

Answers to the open items listed in the approved plan. Method: a full clone at
`/tmp/fp-research/flexprice` (outside the repo), HEAD `709ff3bc`, `git describe`
= **v2.1.48-226-g709ff3bc6**, read with `rg` + targeted line ranges. Every
`path:line` below is in that clone unless marked `[docs]`. Claims I verified
personally on disk are marked ✅; claims from the research pass that I did not
re-run are marked ◻, and claims that only a live instance can settle were marked
🔬 while they waited. **§9 now reports those measurements**: the spike ran 14 probes
against `deploy/flexprice/compose.yaml` at this same commit with 0 failing verdicts,
so every claim below is either graded by measurement or explicitly marked as
deliberately not probed. Two of the old 🔬 rows did **not** get settled and are
flagged ◻ in place: the wire shape of numbers inside event `properties` (an
`interface{}` float64 path we route around by billing integer seconds) and the
low-balance alert *semantics* (no alert consumer was minted). Neither gates Phase 1.
The ones the measurements falsified were corrected in place, and §9 says which.

## 0. Four findings that change the plan

Read these before anything else; three of them are the plan's own
"re-plan rather than patch around" conditions firing.

### 0.1 🔴 `internal/ee` is not a boundary we can stay on the correct side of

The locked decision was "**AGPL-3.0 core, `internal/ee` untouched**". That decision
is not implementable, because the features Phase 1 depends on **are** `internal/ee`:

```
internal/ee/service/wallet.go              the wallet, top-up, debit, balance
internal/ee/service/event.go               the event ingest path
internal/ee/service/invoice.go             invoice finalize + ApplyCreditsToInvoice
internal/ee/service/credit_expiry.go       promotional credit expiry
internal/ee/service/payment_processor.go   consumption debit on invoice payment
internal/ee/service/creditgrant.go         the free-initial-credit grant (item 20)
```

✅ and worse, it cannot be excluded from the build:

| Check | Result |
|---|---|
| `internal/ee/LICENSE` | exists — "may only be used in production, if you … have a valid Flexprice Enterprise license for the correct number of user seats" |
| root `LICENSE` | verbatim AGPL-3.0, `Copyright (c) 2024-present SQUIRRELLY TECHNOLOGIES PRIVATE LIMITED` (line 1) |
| edition build tags | ✅ none. `grep -rn go:build --include=*.go` → only `published`, `e2eprobe`, `pgintegration`, `ignore` |
| runtime license check | ✅ none. `FLEXPRICE_LICENSE`, `licenseKey`, `IsEnterprise`, `enterprise license` → **0 hits** in the Go tree |
| `cmd/server/main.go:21-25` | ✅ imports `internal/ee/service` directly — ee is linked into every binary |
| `BUILD_VARIANT` (Dockerfile:25, default `Enterprise` at `internal/buildinfo/buildinfo.go:7`) | ✅ consumed **only** by `internal/telemetry/events.go:47,83`. Cosmetic |
| size of ee | ✅ 531 of 2638 Go files (~20%) vs `README.md:195`'s claim that ee is "the last 1%" |

So the AGPL image we would run executes ~20% of its own source under a commercial
license that the code neither checks nor can be made to skip. There is no "core
only" build to choose. This is a legal/commercial decision, not an engineering
one, and it is the item-18 hard gate: **Phase 1 must not start on FlexPrice until
this is resolved** (buy the enterprise license, get written clarification, or
re-platform). See `docs/FLEXPRICE_AGPL_MEMO.md`.

One asymmetry worth noting for the memo: the AGPL covers the whole tree by
copyright fact (single root LICENSE, no per-file headers anywhere — ✅ zero
`SPDX-License-Identifier` hits in the repo), while `ee/LICENSE` asserts
commercial terms over files that carry no header of their own. Both parties'
claims rest on the same bytes.

### 0.2 🔴 Kafka and ClickHouse are load-bearing, not optional (item 13)

The plan allowed for "minimal = api + postgres + redis". That topology does not
exist.

- **Kafka required.** `internal/types/publisher.go` + `internal/publisher/event_publisher.go`:
  `PublishDestination` accepts only `kafka | dynamodb | all` ◻ — there is no
  "write straight to ClickHouse". `event.publish_destination: kafka` is the default.
  Compose sets `KAFKA_AUTO_CREATE_TOPICS_ENABLE: "false"`, so topics must be
  pre-created with `make init-kafka` (`events events_lazy events_dlq
  events_backfill events_post_processing system_events wallet_alert activity_logs …`).
- **ClickHouse required, and not as "analytics".** Raw events live there
  (`migrations/clickhouse/000001_create_events_table.up.sql`,
  `ReplacingMergeTree(ingested_at) ORDER BY (tenant_id, environment_id, timestamp, id)`)
  and so do meter aggregates (`000007_create_meter_usage.sql`,
  `qty_total Decimal(25,15)`). `analytics.enabled: false` in `config.yaml` refers
  to a different subsystem — do not read it as "ClickHouse optional".
- **Redis genuinely optional** — `[docs] self-hosting-guide` says a Redis
  connection refused is non-fatal; it powers caching, dedup locks and rate limits.
  But see §3: turning it off also turns off the single-event dedup lock.
- **Temporal required for anything that consumes** — `cmd/server/main.go`
  `startTemporalWorker` fails without it; `api` mode alone boots because it uses a
  lazy client. The credit-expiry cron we care about (§4) lives in
  `internal/temporal/registration.go:597` (`WalletCreditExpiryWorkflow`), so
  skipping Temporal silently skips promotional expiry.
- Upstream `docker-compose.yml` ships **9 services** (postgres 17, cp-kafka 7.7.1,
  clickhouse 24.9-alpine, redis 7, temporal auto-setup 1.26.2, temporal-ui,
  kafbat-ui (dev profile), and three app containers api/consumer/worker all built
  as `flexprice-app:local`). No frontend container at all.
- **No RAM figure exists anywhere** in the repo or docs — confirmed by search, not
  by absence of looking. The only sizing numbers are k8s requests/limits in
  `internal/ee/infrastructure/helm/flexprice/values.yaml` (api 768Mi/1536Mi,
  consumer 1024Mi/2048Mi), summing to ~4Gi of *limits* before Kafka/ClickHouse.
  ✅ **Measured on the live stack** (item 13, `docker stats --no-stream`, 2026-11-12,
  after the spike had run traffic through it):

  | container | MiB | what it is for |
  |---|---|---|
  | clickhouse | 526 | event store + meter aggregates |
  | kafka | 495 | ingest bus (JVM) |
  | postgres | 143 | money state |
  | temporal | 129 | expiry/finalize/scheduler workflows |
  | consumer | 53 | Kafka → ClickHouse drain |
  | worker | 38 | Temporal worker |
  | api | 32 | our write path |
  | redis | 6 | cache + dedup lock |
  | **total** | **1422 (1.39 GiB)** | |

  Against `free -m` inside the Docker VM at the same instant — `Mem: 7934 4515 170 71
  3249 3150` (total/used/free/shared/buff-cache/**available**, MiB) — so FlexPrice
  takes 1.39 GiB of an 7.9 GiB VM that had 3.1 GiB free *with kind and the other
  local stacks already running*. Three things worth saying about that number:
  it is a **floor, not a ceiling** — `compose.yaml` sets no memory limits, so these
  are the sizes the processes chose, **and that was confirmed rather than predicted**:
  a later `resource-footprint` sample taken after a full spike run measured **2015 MiB
  total, with clickhouse at 800 and kafka at 724**. Both figures are honest; the first
  is warm-on-boot, the second is after traffic. The two "optional accelerators"
  §0.2 is arguing about are **72% of the footprint** between them, which is why a
  `minimal` profile would not have made this laptop-friendly anyway; and the four
  application containers together cost 222 MiB, so the FlexPrice binary is not the
  thing to optimize. The plan's re-plan trigger ("item 13 needs all nine containers")
  is answered in §0.6 and flagged in §9: all of them are load-bearing, and the
  measured cost of that is 1.4-2.0 GiB, which still fits.

Consequence for A1: `deploy/flexprice/compose.yaml` has one honest shape
(postgres + kafka + clickhouse + temporal + app), not a `full`/`minimal` pair.
The two-profile plan is dropped as misleading rather than implemented.

### 0.3 🟠 Money is decimal-major on the wire, not integer paise (items 1, 2)

Everything is `shopspring/decimal`, and ✅ **it marshals as a quoted JSON string,
not a bare number.** Corrected after checking: `decimal.MarshalJSON` returns
`"123.45"` unless the package-global `MarshalJSONWithoutQuotes` is set true, and
grep finds **zero** occurrences of that identifier anywhere in the repo. The
`swaggertype:"string"` annotations are therefore not cosmetic — they describe what
is actually on the wire.

That inverts the failure mode B1 was going to have. The dangerous direction is not
"they send floats and we lose precision"; it is **our client assuming a JSON
number** (`amount * 100`, `toFixed`, a `typeof === 'number'` guard, or a schema
validation that rejects strings). So:

- `flexprice-client.js` parses money as **string in, string out**, and converts to
  integer paise exactly once, at the boundary, by shifting two decimal places on
  the string — never through `parseFloat`, never through `Math.round(x*100)`.
- Inbound requests must send the same shape (`"500.00"`, not `500.0`), which
  decimal-aware `JSON.stringify` of a string already does.
- ✅ **Measured in both directions** (item 1): every money field in a live response
  came back as a quoted string — `"500"`, `"500.5"`, `"1000.505"` — and ₹0.005
  survived a round trip (`real_time_credit_balance "1000.505"`, sub-paise preserved
  rather than rounded). So the boundary rule is: parse string → exact paise, never
  `parseFloat`, never `Math.round(x*100)`. ◻ The *outbound* shape for numbers inside
  event `properties` was not probed — those sit in an `interface{}` and decode as
  float64 (next bullet), which is why the metered quantity is integer seconds. §9.

- INR is configured: `internal/types/currency.go` `CURRENCY_CONFIG["inr"] =
  {Symbol:"₹", Precision:2}`; unknown codes fall back to precision 2.
- **₹500.005 → ₹500.01** — `RoundToCurrencyPrecision` rounds half-up at 2 places.
  Our smallest representable unit is 1 paise, so `priceActorUsage` returning
  integer paise is exactly right and the "no 4-decimal rupees" deviation is
  compatible with FlexPrice rather than imposed on it.
- ⚠️ **`ToSmallestUnit(amount, currency)` truncates** (`IntPart()` after scaling)
  and clamps negatives to 0. Any conversion between our paise and their decimals
  must go through an explicit divide-by-100, never through that helper, or a
  systematic one-paise-underbill appears and no test fails.
- ⚠️ `ValidateCurrencyCode` only checks `len == 3` — a typo like `"XYY"` is
  accepted with precision 2. Currency is per price/invoice/wallet, not per
  tenant, so "the dev wallet is INR too" is a bootstrap assertion, not an
  invariant of the system. ✅ measured: wallets came back `"currency":"inr"` and
  accepted INR fractional credit at 200 — which is precisely why it is an
  assertion we must own (B1's wallet-create path pins the currency).
- ⚠️ Event `properties` is `map[string]interface{}`, so numbers there decode as
  **float64** even though `meter_usage.qty_total` is `Decimal(25,15)`. Integer
  seconds stay exact in float64, which is one more reason the metered quantity is
  seconds and not a fractional hour.
- Tiered prices use `UpTo *uint64` boundaries documented **inclusive** for both
  VOLUME and SLAB (not used in Phase 1, but it contradicts the common assumption).

### 0.4 🟢 Zoho Books is first-class; NetSuite and Cashfree do not exist (item on B8)

✅ `internal/integration/zoho/` exists — `client.go`, `invoice.go`,
`invoice_approval.go`, `item_sync.go`, `tax.go`, `customer.go`, `webhook/verify.go`.
Also `internal/integration/quickbooks/`. `internal/types/secret.go:40-41` defines
`SecretProviderQuickBooks = "quickbooks"` and `SecretProviderZohoBooks =
"zoho_books"`.

Zoho coverage: contacts, invoices (create/update/fetch/submit-for-approval),
customer payments, items, taxes and tax-exemptions, inbound Zoho webhooks with
signature verification, OAuth setup, per-tenant Zoho API-domain allowlisting
(`ValidateZohoEndpoint`, which rejects lookalike suffixes, userinfo and paths),
and explicit India-vs-US edition handling including GST fields and HSN
(`internal/integration/zoho/dto.go:74`, `hsn_sync_test.go`). Sync runs as Temporal
workflows (`ZohoBooksInvoiceSyncWorkflow`).

**So `services/billing/src/zoho-sync.js` should not be built** (plan B8). It would
re-implement, worse, something the platform already does with per-tenant OAuth and
an SSRF-hardened endpoint allowlist. Phase 1 replaces that work item with
"configure a Zoho Books connection per tenant and verify what it pushes".

✅ **NetSuite: 0 hits.** An earlier research pass believed NetSuite shipped; it
does not. ✅ **Cashfree: 0 hits** anywhere in the repo — which is why Cashfree
stays in Node, as decided. **Xero: 0 hits.**

Razorpay, by contrast, is a complete processor (`internal/integration/razorpay/`:
orders, capture, refunds with idempotency, UPI/e-mandate recurring, checkout
links, HMAC-verified webhooks), so if a Go Cashfree connector is ever wanted, the
contract is ~10 methods across 4 interfaces
(`interfaces.CheckoutProvider` `internal/interfaces/checkout_provider.go:12-38`,
`PaymentMethodProvider`, `RefundProvider`, plus client/connection + webhook
registration). Still out of scope — but now sized rather than guessed.

### 0.5 Five more that change a specific B-item, but not the shape of the plan

Not gate-firing, so they are not in the four above; each one does change code we
were going to write, which is why they are here rather than buried in §5–§7:

1. **The double-credit loop is not the webhook** — it is
   `metadata.wallet_transaction_id` on an invoice whose payment status we mark
   succeeded, which credits the wallet inside FlexPrice (§6b). B2's rule changes
   accordingly.
2. **"Pass no tax rates" does not make an invoice tax-free, and there is no
   per-invoice exempt switch** — auto-apply associations fall through, and
   `tax_treatment` lives on the *customer*, which must stay taxable for the
   recharge. Hence their tax engine is never used and GST becomes line items we
   compute (§5). B8's `sum(tax) == 0` assertion was going to be vacuous.
3. **A `ONE_OFF` invoice cannot be marked paid at creation via the fields that
   look right** — `payment_status`/`amount_paid` are accepted then silently
   dropped; `metadata.auto_completed` is the real lever (§6b).
4. **Read RBAC is shadow-only** (`observe()` = `Shadow()`), so no FlexPrice API key
   can be scoped to read-less-than-everything-within-its-tenant, even though
   cross-*tenant* access is genuinely impossible (§7). B1 gets two keys, and a
   browser must never reach a FlexPrice read.
5. **Usage grouping by event property works**, so the per-project/per-user Usage
   dashboard can be served by FlexPrice instead of by our own `usageRecords`
   (§7c) — the plan assumed the opposite.

### 0.6 ✅ The boot path itself is the finding (item 13, from actually running it)

Everything in this subsection came from a container failing to start, not from
reading. It matters because a spike that cannot come up produces no answers, and
because three of these are traps that documentation would have missed.

1. **There is nothing to pull.** `ghcr.io/flexprice/flexprice` returns 401 for an
   anonymous pull (the token endpoint answers `UNAUTHORIZED` for an empty scope),
   and the image is not on Docker Hub (404). Their `publish-app-image.yml` builds
   `${{ github.repository_owner }}/flexprice` multi-arch, cosign-signs it, and
   publishes it to a package this account cannot read. So the local stack **builds
   from the pinned checkout**, which is what upstream's own compose does for
   `flexprice-app:local` — not a workaround we invented.
   **Follow-on for B1:** any deployment story that assumes a published image is
   false; either we build it in CI or we host the artifact ourselves.
2. **A from-scratch `docker compose up` of upstream's own file cannot boot on this
   commit.** ✅ Observed: `postgres` exited 3 on
   `V5__settings_unique_published_only.up.sql` → `relation "public.settings" does
   not exist`. Cause: `docker-compose.yml:11` mounts the *whole*
   `./migrations/postgres` directory into `/docker-entrypoint-initdb.d`, and that
   directory mixes two kinds of file — `V0__init.sql` is explicitly pre-Ent
   bootstrap ("All entity tables are created by the Ent ORM migration layer", zero
   `CREATE TABLE` in it) while V2–V5 are post-Ent schema changes. initdb runs them
   all before any table exists. Nobody upstream sees it because
   `/docker-entrypoint-initdb.d` is **first-boot-only**: an existing volume ignores
   the directory entirely, so a developer's laptop has been silently running the
   version they never re-validated. V2–V5's content is superseded anyway — the
   canonical set is `migrations/versioned/postgres/`, and the settings uniqueness
   index lives in `20260819000000_baseline.sql`.
   Our compose therefore mounts `V0__init.sql` + `init-temporal-db.sh` only, and
   applies the data separately (next item).
3. **Seed data must be applied *after* the schema, and upstream says so in the
   file itself.** `V1__seed.sql`'s header: "This file runs twice: 1. automatically
   at container first-init (tables may not exist yet — DO blocks below guard
   against that) 2. explicitly via `make seed-db`, which runs after
   `make migrate-ent`". It is idempotent throughout (`ON CONFLICT DO NOTHING`),
   which is what makes the re-apply safe. Our `seed` one-shot runs it after
   `migrate` succeeds. What it creates is what everything else assumes:
   Default Tenant `00000000-…-000`, a `users` row with `roles = '["super_admin"]'`
   (without it the seeded administrator holds no permissions and cannot write
   settings or invite anyone — their comment says so), and two environments,
   `Sandbox`/development `…000` and `Production`/production `…001`.
   **Note for B6:** per-org seeding should reuse these IDs' *shape*, not their values.
4. **✅ The DB role name is not ours to choose.**
   `init-temporal-db.sh` runs `GRANT ALL PRIVILEGES ON DATABASE temporal TO
   flexprice` with the role hardcoded (and `config.yaml`'s default `user:
   flexprice` for the same reason), so `FLEXPRICE_PG_USER` must be `flexprice` or
   first boot dies with an error pointing at postgres instead of at the name.
5. **✅ Generated passwords cannot start with `-`.** ClickHouse's `/entrypoint.sh`
   builds its `clickhouse-client` command with `$CLICKHOUSE_PASSWORD` **unquoted**,
   so a base64url password beginning with a dash was parsed as a CLI flag:
   `Code: 552. Unrecognized option '-G9_…' (UNRECOGNIZED_ARGUMENTS)`, container
   exit 1, and every downstream service blocked. The bootstrap now emits hex for
   every generated secret — the smallest charset that is simultaneously inert in a
   shell word, a URL userinfo, and a YAML scalar. This is a general rule for our
   own config too: a secret's charset is part of its interface.
6. **✅ `pg_isready` does not mean initialised.** The postgres entrypoint starts a
   unix-socket-only server *before* running any initdb script, and `pg_isready`
   answers "accepting connections" the whole time — so a healthcheck of
   `pg_isready` alone reports Healthy against an empty schema, and anything gated
   on it (Temporal's auto-setup, the migrate container) can race the seed. The
   healthcheck now also requires the `temporal` database to exist, which the last
   init script creates, making it a deterministic end-of-init signal.
7. **✅ `./migrate postgres up` is two things, not one.** The `postgres` argument
   of `cmd/migrate` is the **Ent auto-migration** layer (Makefile:230
   `migrate-ent`), and `up` hands off to **dbmate** over
   `migrations/versioned/postgres` — the Dockerfile copies the dbmate binary
   specifically for it ("`./migrate postgres up` execs this; keep it on PATH",
   Dockerfile:75). So the one-shot is Ent tables → reviewed versioned SQL →
   ClickHouse schema → Kafka topics, and the `schema_migrations` row count is the
   evidence that the versioned path ran, which is why the bootstrap checks it.
8. **✅ A `localhost` healthcheck is not the same as a `127.0.0.1` one.** The
   ClickHouse container sat *unhealthy for its whole life* while serving requests
   perfectly: the alpine image's busybox `wget --spider http://localhost:8123/ping`
   resolves `localhost` to `::1` first, and this Docker network has no IPv6 — the
   server's own startup log says `Listen [::]:8123 failed: … Address family for
   hostname not supported` for every port it binds. `wget -qO-
   http://127.0.0.1:8123/ping` answers `Ok.` on the same container. Two rules
   follow, and both are general: a healthcheck must pin the family it tests, and a
   healthcheck should assert the response body it needs rather than a HEAD request
   whose status code the server may not even support. Anything gated on
   `service_healthy` inherits this bug as "the stack never comes up", with no
   error anywhere that mentions IPv6.

**Correction to §0.2's container count:** upstream's 9 services becomes 10 here —
the same four app processes and four stores, plus the `seed` one-shot, and
`temporal-ui`/`kafka-ui` behind a `dev` profile as upstream does. `migrate` and
`seed` exit; nothing pays RAM for them once they have run.

## 1. Credit semantics, wallets, draw order (items 3, 15, 20)

- **There are only two wallet types**: `PRE_PAID` and `POST_PAID`
  (`internal/types/wallet.go`). Promotional-vs-purchased is *not* a wallet type —
  it is a property of each transaction, via `TransactionReason`:
  `FREE_CREDIT_GRANT`, `SUBSCRIPTION_CREDIT_GRANT`, `PURCHASED_CREDIT_INVOICED`,
  `PURCHASED_CREDIT_DIRECT`, `PURCHASED_CREDIT_BONUS`, `CREDIT_EXPIRED`,
  `MANUAL_BALANCE_DEBIT`, `CREDIT_NOTE`, `WALLET_TERMINATION`,
  `CREDIT_ADJUSTMENT`, `INVOICE_PAYMENT`, `INVOICE_VOID_REFUND`.
  → Our "bonus → promotional wallet" decision maps to `bonus_credits_to_add` +
  `bonus_credits_expiry_date_utc` on a top-up, or to a separate
  `FREE_CREDIT_GRANT` credit row — **not** to a second wallet. ✅ **Measured:** two
  top-ups against **one** wallet produced two credit rows carrying their own
  `transaction_reason` + `priority` (promo `priority 0`, prepaid `priority 1`), and a
  single 700-credit debit consumed the promo row completely
  (`FREE_CREDIT_GRANT 0/500`) before touching the prepaid one
  (`PURCHASED_CREDIT_DIRECT 800/1000`). ◻ What was *not* probed is whether one call
  may carry several `credits_to_add` entries; if it cannot, `credits.js`'s two-row
  `instructions[]` becomes two ordered calls, which the measured path already
  supports. Either way the shape is right and a second wallet is not needed. §9.
- **Draw order is configurable and is a real order, not a preference hint.**
  `internal/repository/ent/wallet.go:250 FindEligibleCredits`:
  `WHERE type=credit AND credits_available > 0 AND (expiry IS NULL OR expiry >= t)
  AND created_at < t AND status=published AND tx_status=completed
  ORDER BY priority ASC, expiry_date ASC, credit_amount DESC`.
  `priority` is settable per top-up (`TopUpWalletRequest.Priority`, "lower number
  means higher priority"). → **Item 3/15 answered favourably**: promotional-first
  and earliest-expiry-first are expressible exactly as our `drawOrderForDebit`
  assumes; set promo `priority` lower than prepaid and the platform order matches
  our policy instead of relying on ours. The scan is capped at 100 credits.
- Each consumed credit is its own row with `credits_available`, so the per-line
  "which source was drawn" column the Usage page needs is obtainable. ◻ exact
  endpoint → §9.
- **Item 20 (free initial ₹500)**: `FREE_CREDIT_GRANT` exists, and
  `internal/ee/service/creditgrant.go` implements grants with
  `CreditGrantExpiryType = NEVER | DURATION | BILLING_CYCLE` and expiry computed in
  the **customer's billing timezone** (`internal/types/creditgrant.go:74-135`).
  That replaces the local seed at `ledger.js:50-62`.
- **There is no `CreditWithdrawalBehavior`/rollover enum** in this version —
  searched, 0 hits.
- ✅ **`CreateWalletRequest` carries more of our policy than the plan assumed**
  (`internal/api/dto/wallet.go:22-73`): `conversion_rate` (default 1) *and*
  `topup_conversion_rate`, `price_unit`, `alert_settings`, `auto_topup`,
  `initial_credits_to_load` + `initial_credits_expiry_date_utc`, and a
  `WalletConfig`. Consequences:
  - "1 credit = 1 paise" is a **per-wallet** `conversion_rate`, so it can change
    for a new recharge cohort without re-denominating existing credits — which is
    exactly what the locked decision wanted ("never a re-denominated credit
    unit"). The ratio lives on the wallet, not in a config map.
  - `initial_credits_to_load` + expiry is a second, simpler answer to item 20
    (the ₹500 signup grant) than `POST /v1/creditgrants`: it needs no plan
    entitlement and no timezone logic, at the cost of the grant/campaign
    bookkeeping `creditgrant.go` provides. Both are available; pick at B-implementation.
  - `alert_settings` at creation resolves the "where does the low-balance
    threshold live" question in §6 favourably — **per wallet, set by us** — so
    `DEFAULT_ALERT_THRESHOLDS_PAISE` can retire into FlexPrice wallet state rather
    than staying local truth.

## 2. When consumption actually debits (item 12 — the one that gates `gate.js`)

**Answer: never at ingest.** `DebitWallet` on the billing path is called from
`internal/ee/service/credit_adjustment.go:332` and
`internal/ee/service/payment_processor.go:829`; `ApplyCreditsToInvoice` runs
**inside the finalize transaction** (`internal/ee/service/invoice.go:1520`, also
`:6079`). Events accumulate into `meter_usage` and nothing else.

**Overdraft: refused.** `internal/ee/service/wallet.go` `processDebitOperation`:
if `totalAvailable < req.CreditAmount` and the reason is not
`MANUAL_BALANCE_DEBIT`, it returns `insufficient balance`
(`ErrInvalidOperation`). Only the manual debit path can persist a negative.

Both halves matter for the plan:
- The good news: a balance cannot silently go negative from usage.
- ⚠️ The exception is exactly the path B8 uses. ✅ `processDebitOperation` refuses
  with `insufficient balance` **unless** the reason is `MANUAL_BALANCE_DEBIT`, and
  in the manual case it consumes whatever exists and lets
  `newCreditBalance = CreditBalance - amount` go **negative**
  (`internal/ee/service/wallet.go:2438-2448, 2508-2510`). So the ₹3000/month
  platform charge is the one operation in this system that can put an org's
  balance below zero, and our gate must treat a negative balance as
  "refuse everything", not "clamp at zero". It is also the answer to "what happens
  when we charge an org with nothing": the charge lands, the balance goes to
  -300000, and no error is returned. Phase 1 must decide explicitly between
  pre-checking balance before the debit and letting it go negative and gating on
  the result. **Recommendation: pre-check and skip the charge with a log line** —
  a negative prepaid balance is a number our UI has no vocabulary for.
- The bad news, and this is the real answer to item 12: **the balance the gate
  reads does not move as usage accrues.** An org can consume all day and still
  show a full prepaid balance until an invoice finalizes. So
  `gate.js:71`'s `balancePaise > 0` cannot be replaced by "read the FlexPrice
  balance". It must read the *projection* —
  `GET /v1/wallets/:id/balance/real-time` returns
  `real_time_balance, real_time_credit_balance, current_period_usage,
  unpaid_invoices_amount, credits_available_breakdown, is_cached_fallback`,
  computed at read time for PRE_PAID wallets (`internal/ee/service/wallet.go:1833`).
  → B5's cache is not an optimisation, it is load-bearing: the gate reads a
  computed endpoint, not a stored number, and 8 call sites in 6 modules hit it per
  run. ✅ **Measured:** 18 samples over a warm stack — **p50 5 ms, p95 17 ms, max
  17 ms**, `is_cached_fallback false`. The 30 ms budget survives, but with under 2×
  headroom at p95, which is the argument for stale-while-revalidate rather than a
  synchronous fetch per call site. §9.

## 3. Idempotency and durability of ingest (items 5, 6)

- **No ingestion-level idempotency store exists.** The only dedup is a Redis lock
  in the meter-usage consumer, and
  `meter_usage_tracking.redis_deduplication_enabled: false` **for the single-event
  path** while `bulk_meter_usage_tracking.redis_deduplication_enabled: true`.
  TTL `eventDeduplicationLockTTL = 24h`.
- Storage-level: ClickHouse `ReplacingMergeTree` collapses rows only when the full
  sort key **including `timestamp`** matches, and only after a background merge.
  Same `event_id` + different timestamp ⇒ two rows, both counted. Aggregate reads
  use `FROM events FINAL` in three places (`internal/repository/clickhouse/
  aggregators.go:391,794,830`) but the list/lookup queries do **not**
  (`event.go:442,628,776,858,915,973,1060,1150`), so a raw listing can show both
  versions pre-merge.
- ✅ **Item 5, measured** (and the source reading was right): the same `event_id`
  posted twice and posted a third time with a **changed payload** all returned `202`
  with an identical body, and the aggregate our query read was exactly **10** — not
  20, not 30. So the duplicate is deduped at the event_id level on the read path
  regardless of `redis_deduplication_enabled`, and first-write wins. **The outbox may
  retry blindly**, which is what makes B3's derived key (`ev:{org}:{runId}:{meter}`)
  safe. §9.
- **The durability trap.** `internal/ee/service/event.go` `CreateEvent` logs a
  failed Kafka publish and **does not return the error**; the handler still answers
  **202 Accepted with an `event_id`**. So an ACKed event can be lost. Plan B3 must
  therefore: use `/v1/events/bulk` (dedup on by default), derive an idempotent key
  (`ev:{orgId}:{runId}:{meter}`), and **verify by read-back**, never by status
  code. This strengthens the plan's "never inline" rule: the outbox is the only
  thing that can prove delivery.
- **Item 6 answered: yes, silently.** An event whose `event_name` matches no meter
  is stored in ClickHouse and contributes to nothing
  (`internal/ee/service/meter_usage_tracking.go` ~:500, "no meters found for
  event name, skipping"). An unknown *property* is not validated at all.
  `event.rejected` with reasons `no_meter_for_event_name` / `no_matching_meter`
  exists but `rejected_event_webhook_enabled: false` by default
  (`FLEXPRICE_METER_USAGE_TRACKING_REJECTED_EVENT_WEBHOOK_ENABLED=true`), throttled
  by `rejected_event_webhook_window: 10m`.
- Aggregations: `COUNT, SUM, AVG, COUNT_UNIQUE, LATEST, SUM_WITH_MULTIPLIER, MAX,
  WEIGHTED_SUM` (`internal/types/aggregation.go`). **There is no CEL aggregation**
  — CEL exists only as an optional per-event `Expression`, and
  `SupportsExpression()` is true only for SUM/AVG/MAX/LATEST. Our SUM meter on
  integer seconds is inside the supported set.

## 4. Expiry: we do not need to schedule it ourselves (item 4)

The plan locked "**schedule expiry ourselves**, new hourly job alongside
`auto-recharge-job.js`". That is now the *fallback*, not the design:

- Read-time filter: expired credits are excluded from `FindEligibleCredits`
  immediately (`Or(ExpiryDateIsNil, ExpiryDateGTE(timeReference))`), so an expired
  promo credit stops being spendable with no job at all.
- Materialising job: `WalletCreditExpiryWorkflow` Temporal cron →
  `ExpireCredits` (`internal/ee/service/wallet.go:2653`), `debitExpiredCredits`
  (:2715), `EligibleCreditsAmount` (:2702), writing `CREDIT_EXPIRED` transactions.
  Expiry is set on top-up via `expiry_date` (a YYYYMMDD **int**, and `json:"-"`) or
  `expiry_date_utf`, plus `bonus_credits_expiry_date_utc`.
- Note `timeReference` is `now` **or the invoice's `PeriodEnd`** when an invoice id
  is supplied, and eligibility requires `created_at < timeReference` — so a
  back-dated invoice cannot draw on a credit created after the period it covers.
  `effective_date` on a top-up is how you place a credit inside a past window.

→ `credit-expiry-job.js` shrinks to "assert FlexPrice's own expiry ran", and
**requires Temporal to be up** (§0.2). A deployment that omits Temporal quietly
stops expiring promo credits — worth a boot-time assertion in Phase 1.

## 5. GST: FlexPrice agrees with our model (item 9)

`handlePurchasedCreditInvoicedTransaction`
(`internal/ee/service/wallet.go:984`) creates the credit with
`CreditAmount = req.CreditsToAdd` while the invoice carries
`amount = credits_to_add * conversion_rate` **plus** the customer's auto-apply tax
rates. So the split is structural and correct for us: **invoice = gross (₹590),
credit = net (₹500)** — the ₹90 never becomes spendable. Independently confirmed
by `money-flow.test.js`, which asserts
`collected - gst == prepaid + promo` as the invariant.

Two sharp edges:
- `autoCompleteEnabled = invoiceConfig.AutoCompletePurchasedCreditTransaction &&
  !isPayFirst && !req.TriggeringActor.IsEndCustomer()`, and the code comments that
  **coupons are not supported when purchased credits auto-complete**. Our flow is
  "Cashfree collects, then Node credits", so auto-complete must stay off; if it is
  ever enabled, coupons silently stop working.
- Because FlexPrice considers the invoice's tax-inclusive ₹590 as what must be
  paid, marking it paid with the right number is our job — see §6.
- ⚠️ Tax is stamped from the **customer's `auto_apply` tax associations**, which
  means place-of-supply lives on the FlexPrice customer record as well as in our
  `gst.js` quote. Two sources for one fact. Phase 1 must either let FlexPrice
  compute tax and have `gst.js` verify it, or set FlexPrice tax to zero and carry
  ours. The plan's "tax computed in Node so exactly one number exists" now needs
  an explicit decision about what the FlexPrice customer's tax associations are
  set to. **Recommendation: their side zero, ours authoritative, asserted
  `sum(invoice.tax) == 0` on their invoices too** — which is the same rule the
  plan already had for period invoices, extended to the recharge invoice.
- 🔴 **"Pass no tax rates" does not achieve a tax-free invoice.** ✅ When an
  invoice is built with no `tax_rates`/`tax_rate_overrides`, the fall-through
  resolves the **customer's auto-apply associations** and attaches them
  (`internal/ee/service/tax.go:1094-1155`). So an invoice we intend to be a
  tax-free statement silently acquires whatever rate someone later marks
  auto-apply on that customer.
- 🔴🔴 **And the per-invoice `EXEMPT` lever does not exist on an invoice.**
  `tax_treatment` is a **customer** field
  (`api/dto/customer.go:67` on create, `:134` on update; domain
  `customer/model.go:59-60`; consumed at `api/dto/taxassociation.go:197` as
  `Exempt: cust.TaxTreatment == exempt`), and `grep TaxTreatment internal/api/dto/invoice.go`
  returns **nothing**. It cannot be set on `POST /v1/invoices`. That closes the
  easy route, because the org's customer **must stay taxable** — it is the same
  customer the GST-bearing recharge invoice is issued to. One customer cannot be
  both exempt and taxable.

  → **Decision for Phase 1: do not use their tax engine at all.** Keep the
  customer's `tax_rates` associations empty, and render GST as **line items** that
  our `gst.js` quote produced: the ₹590 recharge invoice is
  `subtotal 50000p + line(CGST) 4500p + line(SGST) 4500p = total 59000p`, and the
  ₹3000 statement invoice is one line item with no tax lines. Then
  `sum(invoice.tax) == 0` holds on **every** invoice by construction rather than by
  a per-invoice flag, `place_of_supply`/`gstin` on their customer record become
  descriptive fields for Zoho rather than inputs to a computation, and the plan's
  "tax computed in Node so exactly one number exists" is actually true instead of
  approximately true. This is also what an Indian tax invoice looks like: CGST and
  SGST as separate disclosed lines.
  ✅ **Both halves measured** — and (a) came with a caveat nobody should discover in
  production: an invoice line item with **no `price_id`** is legal (201, three
  `price_type:"FIXED"` lines 500/45/45 with `price_id: null`), **but those lines do
  not enter the invoice total**: the requested `amount_due` of `590.00` was stored as
  lines summing to 590 while the invoice reported `total "500"`, `total_tax "0"` and
  `amount_paid "500"`. (b) `tax_rates: []` is indistinguishable from omitting the
  field — same `total "500"`, `total_tax "0"`. → "GST as disclosed line items, their
  tax engine unused" **is** expressible, but the resulting invoice's own `total` is
  the *taxable* figure, not the charged one. B2/B7 must render the ₹590 from
  `gst.js` and must never present FlexPrice's `total` as the amount charged. §9.

## 6b. Invoice pre-paid at creation, and dunning (items 14, 17) — both YES, with a trap

**Item 14: there is no `payment_type`/`collection_method` on an invoice.** ✅
`CollectionMethod` (`CHARGE_AUTOMATICALLY` vs `SEND_INVOICE`) lives on the
**subscription** only (`internal/api/dto/invoice.go:1590-1627`, used at
`internal/ee/service/invoice.go:3630`); the invoice itself can only express
pre-paid as `invoice_status + payment_status + amount_paid`.

🔴 **And the obvious way to set it does not work — it fails silently.**
`CreateInvoiceRequest` *accepts* `InvoiceStatus`, `PaymentStatus`, `AmountPaid`
and `TotalPrepaidApplied` (`internal/api/dto/invoice.go:125-136`), `Validate()`
never rejects them, but `ToDraftRequest()` **drops** `PaymentStatus`,
`AmountPaid` and `TotalPrepaidApplied` (`internal/api/dto/invoice.go:186-204`) and
builds the draft with `PaymentStatus: PENDING, AmountPaid: 0`
(`internal/api/dto/invoice.go:337,351`). So `POST /v1/invoices`
`{"payment_status":"succeeded"}` is **ignored, not an error** — you get a PENDING
invoice and no signal. (Only `ValidateForCheckout`, `:501-516`, rejects the
combination.)

✅ **The supported way** is metadata, and it is the mechanism FlexPrice's own
top-up auto-complete uses: `FinalizeInvoice` honours `metadata.auto_completed ==
"true"` by setting `PaymentStatus=SUCCEEDED`, `AmountPaid=AmountDue`,
`AmountRemaining=0` in one call (`internal/ee/service/invoice.go:1595-1603`), and
`Metadata` **does** survive `ToDraftRequest` (`internal/api/dto/invoice.go:200`):

```
POST /v1/invoices
{ "invoice_type":"ONE_OFF", "billing_reason":"MANUAL", "invoice_status":"FINALIZED",
  "external_customer_id":"<org_id>", "metadata":{"auto_completed":"true"} }
```

Zero-total invoices also auto-succeed (`invoice.go:1595-1597`) — not usable for
₹3000. The later-settle route is `PUT /v1/invoices/:id/payment`
(`router.go:528` → `invoice.go:2649`), which allows PENDING→SUCCEEDED and forces
`AmountPaid=AmountDue, PaidAt=now` (`invoice.go:2720-2723,3529-3551`).

**Dunning: with that shape, nothing fires.** The plan's "dunning disabled" is
satisfiable without a config fork, and the residual timers are enumerable:

| Timer | Scope | Why it cannot reach us |
|---|---|---|
| `SubscriptionAutoCancellationWorkflow` (15-min cron, `temporal/service/schedules.go:34-40`) | subscription invoices only | needs tenant setting `subscription_config.auto_cancellation_enabled`, **default false** (`types/settings.go:96-99,642`; gate `subscription.go:6115`), and its query is hard-scoped `InvoiceType: SUBSCRIPTION, FINALIZED, PENDING\|FAILED, amount_remaining>0, SubscriptionID != nil` (`subscription.go:6128-6170`) — a `ONE_OFF` can never enter it |
| `SubscriptionOverdueInvoicesWorkflow` (`schedules.go:41-47`) | subscription + gated env | scoped to `ListEnvironmentsWithGatedActiveSubscriptions` (`subscription.go:5871-5872`) |
| payment-retry cron | — | ✅ **no `payment_retry` key and no dunning schedule exists anywhere** in the cron registry (`schedules.go:24-130`); attempts happen only inside `ProcessInvoiceWorkflow`/`FinalizeDraftInvoiceWorkflow` (`temporal/workflows/invoice/*:139-150`, `:110`) |
| **draft-finalization cron** | any `DRAFT` invoice | ⚠️ the one that can bite: `invoice_config.auto_finalize` **defaults true** (`types/settings.go:635-636`, `FinalizationDelaySeconds` 7200), and after finalizing it runs a credit-payment attempt (`invoice.go:1663-1741`, esp. `1726-1731`). Dead for us because we create invoices **already `FINALIZED`** (`invoice.go:423-426`) |
| wallet credit expiry (`schedules.go:48-54`) | any credit with `expiry_date_utc` | give the platform-charge top-up no expiry date |
| `invoice.payment.overdue` webhook | — | published **only as a side-effect of a customer-invoice-summary read** (`invoice.go:3315`), never by a timer, and skipped for `SUCCEEDED` (`:3301`) |

Also: `AttemptPayment` on a subscription-less invoice does **not** touch a gateway
— it only spends wallet credits (`invoice.go:3723-3760` →
`subscription_payment_processor.go:564-620`) and is refused unless `FINALIZED`
(`:3595-3604`); emails need an explicit `POST /invoices/:id/comms/trigger`
(`invoice.go:5327-5336`); vendor sync needs a configured connection
(`invoice.go:2768-2772,3647-3665`).

🔴 **The re-entrancy trap for B2.** `UpdatePaymentStatus(..., SUCCEEDED)` on an
invoice carrying `metadata.wallet_transaction_id` calls
`CompletePurchasedCreditTransactionWithRetry` — **it credits the wallet itself**
(`internal/ee/service/invoice.go:2749-2766`). This is precisely the "does the
webhook re-enter our crediting code" question from the plan's item 8′, and the
answer is: it can, through the invoice-payment path, not just through a webhook.
Our `settle()` must therefore **never** put `wallet_transaction_id` into the
metadata of an invoice it also credits against, and must never call
`/invoices/:id/payment` on such an invoice. Either Node credits, or FlexPrice's
auto-complete does — one creditor, asserted.

**Item 17: a recurring fixed wallet debit without a payable invoice — YES.**
`POST /v1/wallets/:id/debit` (`router.go:501` → `api/v1/wallet.go:529-555` →
`ManualBalanceDebit` `ee/service/wallet.go:3659-3699`):
- `transaction_reason` **must** be `MANUAL_BALANCE_DEBIT` — the allowlist is
  exactly that one value (`api/dto/wallet.go:603-615`);
- `idempotency_key` is **required** by binding (`api/dto/wallet.go:589`), unlike
  top-up where it is derived (`:346`, `wallet.go:737-740`);
- **no invoice field at all** (`wallet.go:3681-3691`); writes one
  `wallet_transactions` DEBIT row with `reference_type=REQUEST` and a synthetic
  `reference_id` (`wallet.go:2529-2554, 2330-2334`) plus consumption decrements on
  the source credit rows (`ConsumeCredits`, `:2458`) and the balance update
  (`:2615`). No invoice, no payment, no credit-note row.
- ⚠️ **Idempotency is enforced only by the DB partial unique index
  `(tenant, env, idempotency_key)`** (`migrations/versioned/postgres/20260819000000_baseline.sql:77`)
  and the debit path does **not** pre-check it (only top-up pre-checks,
  `wallet.go:871`). A replay therefore returns a **unique-violation error**, not
  the original transaction. → `flexprice-client.js` (B1) must map that error class
  to "already charged, success" or the platform-charge job will log a failure and
  possibly retry forever on every month it has already billed.
- Cheaper alternatives checked and rejected: a **credit note** requires an existing
  invoice and models a *reduction*, not a charge (`api/dto/creditnote.go:21`
  `invoice_id` required); `POST /payments` with `payment_method_type=CREDITS`
  (`wallet_payment.go:313-345` → `payment_processor.go:763-820`) is the most
  double-entry-correct route but **hard-requires a `POST_PAID` wallet**
  (`payment.go:163-176`) — so a prepaid INR credit wallet is rejected — and it
  emits `payment.created/updated/success` plus invoice payment reconciliation,
  i.e. exactly the re-entrancy surface above.

→ **The ₹3000 platform charge is two calls, in this order** (statement first, so
the debit can reference it): the `ONE_OFF`/`FINALIZED`/`auto_completed` invoice
from item 14, then the `MANUAL_BALANCE_DEBIT` with
`idempotency_key: platform-charge:<org_id>:<YYYY-MM>` and
`metadata: {"invoice_id": "<step-1 id>"}` — the invoice↔wallet link lives in the
debit's metadata because there is no first-class field for it
(`api/dto/wallet.go:581-590`).

## 6. Webhooks: our "advisory only" rule is now mandatory

✅ **The native (non-Svix) transport adds no signature at all** — a plain `POST`
with static configured headers (`internal/webhook/handler/handler.go:394-401`);
backend chosen at `:251-255` by `webhook.svix_config.enabled`. With Svix, HMAC and
per-endpoint `whsec_…` secrets are Svix's, not in this repo. Endpoint URLs come
from **operator YAML config** (`webhook.tenants.<id>.{endpoint,headers,enabled,
excluded_events}`), not tenant input, so there is no user-settable URL to abuse —
and no per-tenant endpoint management without Svix.

Retry: DB `system_events` row → post-commit Kafka publish → consumer; stale rows
retried by Temporal cron `OutboundWebhookStaleRetryWorkflow` **every 2 minutes**
(`internal/temporal/activities/service/schedules.go:83-91` →
`RetryStalePendingWebhooks`, MaxAttempts default 5, token bucket 5/s).
~62 dot-form event names in `internal/types/webhook.go:99-254`, including
`wallet.transaction.*`, `wallet.credit_balance.*`,
`wallet.ongoing_balance.dropped`, `invoice.update.*`, `payment.success`,
`feature.wallet_balance.alert`, `event.rejected`.

→ The plan's rule "FlexPrice webhooks are unsigned by default, therefore advisory
only, never authoritative amounts" is confirmed as necessary rather than
hypothetical. If `settle()` (B2) and a webhook both credit, that is a
double-credit.

✅ **The exact per-action event list, so the anti-loop rule is enforceable rather
than aspirational** (all sites verified):

| Our action | Events that fire | Publish site |
|---|---|---|
| top-up credit, auto-completed | `wallet.transaction.created` (nothing at PENDING-tx creation) | `ee/service/wallet.go:1318` |
| top-up credit, deferred (credits applied on payment) | `wallet.transaction.updated` | `wallet.go:1611` (from `completePurchasedCreditTransaction`, `:1427`) |
| wallet debit (usage or generic) | `wallet.transaction.created` **+** `wallet.credit_balance.dropped\|recovered`, `wallet.ongoing_balance.*` | `wallet.go:2628` (end of `processWalletOperation`), alerts at `:2640,3140,3154`, `:2762-2780` |
| manual balance debit (₹3000 charge) | same as the row above — **no invoice event, no payment event** | `wallet.go:2628,2640` |
| invoice created as DRAFT | `invoice.update` only (draft creation itself publishes nothing) | `ee/service/invoice.go:939` (`ComputeInvoice`) |
| invoice finalized | `invoice.update.finalized` — single funnel `notifyInvoiceFinalized` | `revenue_hooks.go:15-23`, called at `invoice.go:1637` and `payment_processor.go:997` |
| `payment_status` → paid | `invoice.update.payment` | `invoice.go:2783` (manual) and `:2917` (`ReconcilePaymentStatus`, gateway callback) |
| payment failed | `invoice.payment.failed` — **only** from Razorpay charge paths | `invoice.go:2295,2375` → `:4396-4398` |

Three consequences for Phase 1:
1. The `MANUAL_BALANCE_DEBIT` and usage-debit paths emit **nothing
   invoice-shaped**, so they cannot re-enter `settle()`. The re-entrancy risk is
   confined to the top-up/invoice-payment pair — see the
   `metadata.wallet_transaction_id` trap in §6b.
2. A balance **can** go negative, and the only reason a debit is refused is
   `insufficient balance` for non-manual reasons (`wallet.go:2438-2448`). So the
   gate's answer to item 12 is: usage never overdraws, and the platform charge
   does. Which means the platform charge must not be gated on balance the way
   usage is, or a broke org silently stops being charged ₹3000/month with no error.
3. `wallet.credit_balance.dropped` can retire `DEFAULT_ALERT_THRESHOLDS_PAISE` as
   local truth: ✅ `CreateWalletRequest.AlertSettings` (`api/dto/wallet.go:64`) is
   set **per wallet, by us, at creation**, so the threshold is data rather than an
   `internal/ee` feature entitlement. ◻ The alert *types* and comparison semantics
   (`types.AlertSettings`) were **not** probed — the spike minted no alert consumer,
   so nothing here proves when FlexPrice fires one. Non-gating: B1 pins the
   threshold at wallet creation either way, and the balance *read* is closed (§9,
   item 12). Revisit only if we ever let FlexPrice notify instead of us.

## 7. Tenancy and the API key (item 10) — measured: scoping is real, reads are not confined

**Cross-tenant access is not possible on the money paths, and that is now verified
per endpoint rather than assumed.** Every lookup takes scope from the auth context,
never from a caller-supplied field:

| Endpoint | Where tenant/environment come from | Tenant predicate proven at |
|---|---|---|
| `POST /v1/events` | `IngestEventRequest` has **no tenant/env fields at all** (`dto/events.go:30-38`); `ToEvent` stamps from ctx (`events.go:81-93`) | `internal/api/router.go:239` gate + ctx stamp |
| `POST /v1/events/bulk` | same (`router.go:240`, cap 1000) | as above |
| `POST /v1/wallets/:id/top-up` | path id only; service does `GetWalletByID` first (`ee/service/wallet.go:670-672`) | `repository/ent/wallet.go:123-129` — `ID + TenantID + EnvironmentID` |
| `POST /v1/wallets/:id/debit` | identical fetch-then-act (`wallet.go:3659-3671`) | same |
| `GET /v1/wallets/:id/balance/real-time` | scoped `GetWalletByID` before computing (`wallet.go:1833-1841`) | breakdown SQL carries `tenant_id = $1` (`repository/ent/wallet.go:1824-1845`) |
| invoice list/get | — | `repository/ent/invoice.go:481-482` (`ID + TenantID`) |
| `POST /v1/meter-usage/query` | DTO takes only `external_customer_id` + `meter_id`; handler converts with `ToParams(GetTenantID(ctx), GetEnvironmentID(ctx))` (`dto/meter_usage.go:13-20`, `meter_usage.go:27-41`) | ClickHouse `WHERE tenant_id = ?` (`repository/clickhouse/meter_usage.go:1032,1127,1209`) |

A DB-minted key is **pinned to its environment**; only unbound callers (dashboard
JWT, config-map key) may select one via `X-Environment-ID`, and that header is
validated as belonging to the caller's tenant, so a foreign env id yields
not-found → 403 (`middleware/auth.go:52-95`, `:216-251`). Auth is fail-closed on a
missing environment (`auth.go:46-50,199-210`). The Redis cache pre-check is keyed
by tenant+env too (`repository/ent/wallet.go:113`, `internal/cache/cache.go:125-137`),
so there is no cache-side bypass of the predicate.

**Roles do exist and are selectable at mint** — five of them
(`internal/types/rbac.go:14-18` + `internal/config/rbac/roles.json`):
`super_admin` (`*:*`), `all_reader`, `all_writer`, `event_ingestor`
(`event:write` only), `event_reader`. `POST /v1/secrets/api/keys`
(`router.go:669-670`) stores them on the secret. This refines the earlier note
that a key merely inherits the minter's roles.

🔴 **The gap that changes our design — read RBAC is shadow-only.** Most read routes
are registered with `observe(...)`, i.e. `RequirePermission(..., Shadow())`
(`router.go:150-151`), which **logs a denial and allows the request**. Enforced
`read(...)` gates exist only for users, environments, analytics, activity, secrets,
commitments and customer payment methods (`router.go:217-225,268-277,339,551-552,669`).
Consequence: an `event_ingestor` key — the narrowest one we could sensibly mint —
**can still read every wallet balance, invoice and meter usage inside its tenant**.
So:
- A leaked ingest key is a **tenant-wide read of all customer financials**, not a
  write. That bounds the blast radius usefully (it cannot mint money) but it is a
  privacy/compliance incident, and it means our two-plane design must not share one
  key: give the ingest path (`B3` outbox drain) and the money path (`B1` client)
  **separate keys**, so the higher-volume, more-exposed one cannot read balances.
- Read-scoping must be enforced at our gateway. Never expose a FlexPrice read to a
  browser.

**No per-customer API key exists.** The only per-customer credential is the
**customer-portal session token** (`SessionTokenAuthMiddleware`,
`middleware/auth.go:392-424`, setting `CtxCustomerID`/`CtxExternalCustomerID`; the
`/v1/customer/portal/*` group at `router.go:828-858`, e.g.
`GET /v1/customer/portal/wallets`). It is short-lived, not a reusable key. Plan B7
already routes the Usage page through our server, which is therefore **required, not
just preferable** — and portal tokens are the escape hatch if we ever want a
customer-facing FlexPrice surface without proxying it ourselves.

**Config/env keys are hard-coded `super_admin`** (`middleware/auth.go:29-33`) with an
empty environment id (choose-env-per-request). Never provision one in a
customer-reachable component; and since the shipped
`sk_local_flexprice_test_key` / hash `0cfd568f…` is exactly such a key present in
`config.yaml`, and `FLEXPRICE_ALLOW_INSECURE_DEFAULTS=true` additionally **disables
`validateCriticalSecrets` and `validateEncryptionKey` entirely**, Phase 1 needs a
boot assertion that rejects a config-map key outside local mode.

- Tenant/environment bootstrap is available three ways: idempotent
  `migrations/postgres/V1__seed.sql` (Default Tenant `00000000-…`, an
  `admin@flexprice.dev` **super_admin**, Sandbox + Production environments, run via
  the postgres `docker-entrypoint-initdb.d` mount and again via `make seed-db`),
  `POST /v1/auth/signup` on the **public** route group, or the UI.

### Item 10, measured on the live stack (spike probe `key-planes-and-shadow-rbac`)

The whole §7 above is source reading. The probe minted real keys on the pinned
commit and exercised the boundary rather than reasoning about it:

| Test | Measured | Verdict |
|---|---|---|
| mint a scoped service-account key | `POST /v1/users {name, type:"service_account", roles:["event_ingestor"]}` (email **omitted**) → `POST /v1/secrets/api/keys {name, type:"private_key", service_account_id}` → `{secret:{id, display_id, roles, user_id}, api_key}` | ✅ works unauthenticated-free; `type` is `binding:"required"` and **must** be `private_key` (`publishable_key`/`integration` are the only other values; `api_key` 400s) |
| ingest with the narrow key, own customer | `POST /v1/events` | ✅ accepted |
| ingest against a **foreign** customer | same key, other org's `external_customer_id` | ✅ **403** `insufficient permissions` — writes are role-enforced, tenant predicate real |
| **read** a production wallet with the `event_ingestor` key | `GET /v1/wallets/:id/balance/real-time` | ⚠️ **200** — the shadow-RBAC prediction confirmed. An ingest-only key reads every balance in its tenant. |
| environment-bound key + foreign `X-Environment-ID` | — | ✅ confinement **holds**: either the same wallet comes back (header ignored) or 403 — never a cross-environment object |
| config-map key (`FLEXPRICE_AUTH_API_KEY_KEYS`) | caller-chosen env, hard-coded `super_admin` | ⚠️ **unconfinable by design** — re-plan trigger #2 fires on the letter of "if the key cannot be confined" |

→ **What Phase 1 must do with this:** the two-plane split (separate ingest key vs
money key) is **required**, not a hardening suggestion, and B1 must mount a
**DB-minted** key (`private_key` on a service account with a named role), never the
config-map key. But **do not present read confinement as a boundary in the design
doc or the threat model** — it does not exist in this release. The boundary we do
have is tenant + environment scoping on writes; reads are confined only by our own
gateway never exposing a FlexPrice read to a browser.

## 7b. Our org ↔ FlexPrice customer mapping is directly supported

`external_id` exists on customer (`ent/schema/customer.go:38`) with a **partial
unique index on `(tenant_id, environment_id, external_id) WHERE status='published'
AND external_id <> ''`** (`customer.go:142-145`, migration
`migrations/versioned/postgres/20260819000000_baseline.sql`). So `org_id` goes in
`external_id` and needs no local mapping table.

Two consequences to design around:
- Uniqueness is per **environment** as well as per tenant, so the same org must be
  created in each environment we use, or we standardise on one environment.
- An **archived** customer may hold a duplicate `external_id`, and lookup uses
  `Only()` with the published filter (`repository/ent/customer.go:183-190`) — so a
  published/archived pair **errors rather than silently picking**. A re-onboarded
  org whose old customer was archived will therefore fail loudly. Good: loud is
  what we want, but the error must be surfaced, not retried.
- `external_customer_id` is accepted on event ingest (required there), wallet
  create (`dto/wallet.go:24-25,225-233`), meter-usage query and invoice list
  filters (`internal/types/invoice.go:517-519`). Wallet **by-id** paths still take
  the UUID, so `settle()` must resolve org → wallet once (cache it) rather than
  assuming external ids address wallets directly.

## 7c. Per-project / per-user usage: `group_by` does NOT work — `filters` does (B7)

🔴 **The source reading in the earlier draft of this section was wrong, and the
spike falsified it.** `GetUsageRequest` really does carry a `GroupBy []string` field
accepting `"properties.X"`, and the ClickHouse meter-usage builder really does write
per-group CTEs — but neither is reachable for the aggregation we use. Measured on one
event set (`project_id` alpha 90 + 3600, beta 5 ⇒ tenant total 3695):

| Mechanism | Measured | Verdict |
|---|---|---|
| `group_by: ["properties.project_id"]` on `POST /v1/events/usage`, SUM meter | `{"value":3695}` — **byte-identical to the ungrouped call** | ❌ silently ignored. The grouped path is gated on the MAX aggregator alone: `hasGroupBy := params.AggregationType == types.AggregationMax && …` (`internal/repository/clickhouse/event.go:310`). A Usage page built on this shows **every project the tenant total**, with no error. |
| `group_by` on `POST /v1/events/usage/meter` | identical to ungrouped | ❌ the field **does not exist** — `GetUsageByMeterRequest` (`dto/events.go:142-176`) has no `GroupBy`, so the binder drops it. The meter-scoped route can never group. |
| MAX + `bucket_size: DAY` + `group_by` | `results: [{…3600}, {…5}]` | ❌ per-**bucket** rows; the HTTP DTO drops the group key (`dto/events.go:231-241` vs `internal/domain/events/repository.go:171`), so the rows are not attributable to a project. |
| `POST /v1/meter-usage/detailed-analytics` | `{"subtotal":"0","total_discount":"0","total_cost":"0","currency":"","items":[]}` — under **every** variant tried (grouped, ungrouped, `window_size`, `expand=meter`, `group_by: source`), while `/v1/events/usage/meter` on the same meter + customer returned 3695 | ❌ not a `group_by` problem: this endpoint builds cost over **priced** usage lines and a bare meter does not satisfy its prerequisite. It answers 200-with-nothing instead of explaining. |
| **`filters: {project_id: ["alpha"]}` on `POST /v1/events/usage`** | **3690**; `["beta"]` → **5**; `{user_id:["u1"]}` → **95** (= 90+5) | ✅ **exact.** This is the mechanism. |
| `filters: {"properties.project_id": ["alpha"]}` | response with **no `value` key** (= 0) | ⚠️ the dotted spelling that is correct for `group_by` matches nothing here and reads as "this project used nothing". |
| `property_filters: {project_id: ["alpha"]}` | **3695** — the whole tenant | ⚠️ a real DTO field (`dto/events.go:195`) that this route **ignores**. The plausible-looking one returns the total. |
| `POST /v1/meter-usage/properties` | `{"keys":["project_id","user_id","value"]}` | ✅ dimension discovery works, so the query fan-out is enumerable rather than hardcoded. |

→ **Change to B7:** per-project and per-user usage is served by **one `POST
/v1/events/usage` per dimension value, with `filters` keyed on the BARE property
name** (`{project_id: ["p-123"]}`), never `group_by`, never `property_filters`, never
the dotted form. That is N+1 queries per Usage page (N = projects the org has, from
our own org/project table — the safer source than the properties route anyway, since
`"value"` shows up in its key list), each exact. `usageRecords` stays the outbox
source and audit copy; it is **not** demoted to a mere bystander either — it is what
makes the N+1 enumerable and what the retention prune still needs.

Cardinality is not the constraint; request count is. A 20-project org's Usage page is
21 round trips at ~5-30 ms each, which is why B7 loads the breakdown lazily per
project rather than pre-computing a matrix.

## 7d. Credit breakdown read (item 19) — worse than a missing bucket: it fails outright

`GET /v1/wallets/:id/balance/real-time` is documented to return
`credits_available_breakdown: { purchased, free }` alongside
`real_time_balance` / `real_time_credit_balance` (`dto/wallet.go:262-266,549`;
`types/wallet.go:398-401`), mapped as
`PURCHASED_CREDIT_* → purchased`, `FREE_CREDIT_GRANT | SUBSCRIPTION_CREDIT_GRANT →
free` (`repository/ent/wallet.go:1837-1844`).

🔴 **Measured: on any wallet that holds a `PURCHASED_CREDIT_BONUS` row, the breakdown
does not exist at all.** The classifying SQL has **no `ELSE` branch**:

```sql
SELECT CASE
         WHEN transaction_reason IN ('PURCHASED_CREDIT_INVOICED','PURCHASED_CREDIT_DIRECT') THEN 'PURCHASED'
         WHEN transaction_reason IN ('FREE_CREDIT_GRANT','SUBSCRIPTION_CREDIT_GRANT')       THEN 'FREE'
       END AS credit_type, SUM(credits_available) …        -- wallet.go:1839-1845
```

Any other reason groups to `NULL`, the scan target is a non-nullable Go `string`, and
the query dies with

```
sql: Scan error on column index 0, name "credit_type": converting NULL to string is unsupported
```

verified directly against the stack's own postgres — `PURCHASED_CREDIT_BONUS` groups
to a NULL `credit_type` row alongside the `FREE` and `PURCHASED` ones. The handler
then **swallows the error on purpose** (`internal/api/v1/wallet.go:363-375`: *"Don't
fail the request, just log the error and continue without breakdown"*), so the caller
sees **HTTP 200 with the field simply absent** — indistinguishable from "this wallet
has no breakdown". The error is only visible in the API container's **stderr**
(`docker logs`, not `stdout`).

Two consequences, both load-bearing:

1. **FlexPrice's own bonus mechanism breaks FlexPrice's own bucket read.**
   `bonus_credits_to_add` on `/v1/wallets/:id/top-up` — the native path a coupon bonus
   would use — mints exactly the row that poisons the wallet. Not a hypothetical: the
   probe called that field and lost the breakdown.
2. **`credits_available_breakdown` may not be used at all**, which retires the idea
   that any UI reads it. The promo/purchased split comes from the credit **rows**,
   which do carry the truth: `transaction_reason`, `credits_available` (remaining),
   `expiry_date`, `priority`, `parent_transaction_id`, via
   `GET /v1/wallets/:id/transactions` and `POST /v1/wallets/transactions/search`
   (`router.go:493,502`; `types/wallet.go:161-174`). Both are keyed `items` +
   `pagination`, **not** `data`.

→ **Item 19 closed, with a rule attached:** mint coupon bonus and free initial credit
as **`FREE_CREDIT_GRANT`** (which is inside the CASE, and is what
`initial_credits_to_load` already produces — measured) rather than
`PURCHASED_CREDIT_BONUS`; read remaining + next-expiry from the transactions search,
never from the expand. The search filter `expiry_date_before` is LTE, so it correctly
excludes never-expiring rows. The `credits.js` two-row `instructions[]` shape stands —
the draw order was confirmed separately (§1, item 3/15: `ASC(priority)` ate the
`priority: 0` promo row before the `priority: 1` prepaid one, exactly as planned).


## 8. Ops and upgrades

- **Migrations never run at app boot** (no Ent `Schema.Create` in
  `cmd/server/main.go`). Tools: **dbmate v2.35.0** pinned as a separate binary
  (`Dockerfile:41-56`) for `migrations/versioned/postgres/`, plus a Go CLI
  `./migrate` with `postgres`, `postgres up`, `clickhouse`, `kafka`, `svix`
  (`cmd/migrate/main.go:15-19`). `migrations/postgres/V1__seed.sql` is first-boot
  only.
- ⚠️ **ClickHouse migrations have no tracking table**
  (`cmd/migrate/clickhouse.go:21-57,67-72`) — they are idempotent
  `IF NOT EXISTS` files re-applied every run. A renamed column therefore does not
  fail loudly; it leaves the old one behind.
- **Forward-only in practice**: dbmate requires a `-- migrate:down` section "even if
  it is only a comment explaining why reversal is unsafe"
  (`migrations/versioned/README.md:113-115`); **no auto-rollback exists**; a partial
  run leaves a known prefix applied; migrations must be additive and
  backward-compatible because they run *before* the new code rolls
  (`README.md:69-74`). Rollback of code is "a values flip, not an image rebuild" —
  schema stays migrated.
- Concurrency: no advisory-lock code in-repo; safety is deploy orchestration (the
  Helm migration Job `pre-install,pre-upgrade` completes before pods roll) plus
  `lock_timeout=3s -c statement_timeout=0` in the apply wrapper — a deliberate fix
  for a documented "prod DDL-lock incident 2026-06-25"
  (`cmd/migrate/postgres.go:148-158`). `make migrate-check` gates ordering in CI;
  ClickHouse is deliberately excluded from that check (`Makefile:255-256`).
- **Pinning**: image `ghcr.io/flexprice/flexprice`, published on `v*` with both
  `v2.1.48` and `2.1.48` tags, **multi-arch amd64+arm64** (so it runs natively on
  this Mac), cosign-signed by digest, provenance + SBOM, Trivy-scanned, label
  `org.opencontainers.image.licenses=AGPL-3.0-only`. Note upstream
  `docker-compose.yml` does **not** use it — all three app services are
  `image: flexprice-app:local` built from the local Dockerfile, so a
  production-shaped compose must swap to the digest-pinned public image. ✅
  Beware a non-SemVer tag `v2.17` in the list: never sort tags or use `:latest`.
- ✅ There is **no `.env.example`**; config is `internal/config/config.yaml`
  (688 lines) with `FLEXPRICE_`-prefixed env overrides bound by reflection
  (`internal/config/config.go`), plus three bare envs `SERVICE_NAME`,
  `ENVIRONMENT`, `REGION`. One exception: `FLEXPRICE_AUTH_API_KEY_KEYS` is read
  raw as JSON to dodge a Viper decode panic.
- ⚠️ **Two boot traps for our compose**: `redis.cluster_mode` defaults to **true**
  and must be set false against `redis:7-alpine`; and
  `FLEXPRICE_DEPLOYMENT_MODE=local` **skips all config validation**, so a
  successful local-mode boot proves nothing about the env you will use in
  api/consumer mode. Compose also volume-mounts `./internal/config`, so the
  containers read a config *directory*, not only env.

## 9. Resolved on the live instance — spike measurements (A3)

The spike (`scripts/flexprice-spike/run.js`, `npm run billing:flexprice:spike`) ran
14 idempotent probes against `deploy/flexprice/compose.yaml` at commit `709ff3bc6`
and finished with **0 failing verdicts**. Evidence below is `file:line` for source
claims and a measured response for empirical ones; nothing in this table is inferred.
Machine-readable output: `docs/flexprice-spike/results.json`.

**Read this first — the gate.** Probe 1 is `pipeline-health`: it posts one event and
requires it to come back through the meter. The stack can be fully healthy and the
ingest pipeline dead (the Kafka topic-namespace mismatch in
`deploy/flexprice/README.md` produced exactly that: `202`, all containers healthy,
ClickHouse `events` at 0 rows forever). **If `pipeline-health` fails, every
ingest-shaped verdict below is a measurement of the compose stack, not of FlexPrice,
and must not be written up as a finding.** The run reported
`post_status 202 → value 424242 in 3069 ms`, so the ingest verdicts are valid.

| # | Item | Measured | Grade |
|---|---|---|---|
| **1** | minor units vs decimal-major | `shopspring/decimal` marshals **every** money field as a **quoted JSON string** (`"500"`, `"500.5"`, `"1000.505"`). ₹500.00 / ₹500.50 / **₹0.005** all credited at 200 and the balance read back `real_time_credit_balance "1000.505"` — sub-paise is preserved, not rounded away. | ✅ closed |
| **5** | `event_id` replay | first / same-payload / **changed**-payload all `202` with an identical body; the meter total over the replay set was exactly **10**, not 20 or 30. | ✅ **deduped by `event_id`** ⇒ the outbox may retry blindly. The changed-payload case resolves to *first wins* at the storage layer, which is why B3 must never mutate an event it has already sent. |
| **6** | mis-deployed meter = free usage | ingest `202` in 3151 ms, queryable in 3096 ms. A meter whose `event_name` matches nothing: `200` with **no `value` key** (`omitempty` ⇒ absent means 0, not failure). A meter built on a typo'd property field: accepted at create (`POST /v1/meters` validates nothing) and then **silently free forever**. | ✅ closed → this is why `reconcile-gateway-spend.js` (B8) is load-bearing, and why it must compare FlexPrice usage against LiteLLM/runner counts rather than against an empty result set. |
| **8′** | native top-up path | `POST /v1/wallets/:id/top-up` works unauthenticated-free and returns the `wallet_transaction`; with `auto_complete_purchased_credit_transaction` left off it credits without generating a receivable. | ✅ usable — but B2 still credits explicitly, because the invoice→checkout→top-up link re-enters the payment path (§6b trap). |
| **9/GST** | price-less line items | `201`, three lines `500 + 45 + 45`, `tax_rates: []` identical to omitting it. But the invoice reports **`total "500"`**, `total_tax "0"`, `amount_paid "500"` while the lines sum to 590. | ✅ legal / 🔴 **do not trust `total`** → the GST breakdown must come from `gst.js`; FlexPrice `total` may never be presented as the amount charged. |
| **10** | org↔customer separation | see §7 "Item 10, measured": scoping real (foreign-customer write → **403**), **reads shadow-only** (ingest key read a production wallet at 200), environment confinement holds, config-map key unconfinable. | ✅ closed; re-plan trigger #2 fires on the config-map half. |
| **12** | real-time balance latency | 18 samples: **p50 5 ms / p95 17 ms / max 17 ms**, `is_cached_fallback false`, all documented fields present. | ✅ closed → B5's cache stays, and a 30 ms budget has under 2× headroom at p95: keep stale-while-revalidate, do not make it a synchronous per-call fetch. |
| **12/17** | can it go negative | `MANUAL_BALANCE_DEBIT` of 3000 against a 100-credit wallet → **200, `balance "-2900"`**. Replay → **409 `already_exists`**, `details` echoing amount/key/type. Missing key → **400** `Invalid request format`. | ✅ closed → the platform charge **does** overdraw while usage does not; B1 must map that exact 409 to "already charged → success", and the gate needs a negative state (or the job a pre-check). |
| **13** | container set + RAM | 8 long-running containers. **1422 MiB warm / 2015 MiB after a full spike run** (ClickHouse 800, Kafka 724). No `minimal` profile is honest: Kafka, ClickHouse and Temporal are load-bearing. | ✅ closed → fits an 8 GiB Docker VM beside `kind`; the number is a floor, not a ceiling (no memory limits set). |
| **14** | pre-paid invoice, no dunning | request `payment_status`/`amount_paid` are **bound then dropped** → `PENDING`/`0`. `metadata.auto_completed:"true"` → `FINALIZED` + **`"SUCCEEDED"`** (uppercase) + `amount_paid "3000"` + `amount_remaining "0"`. | ✅ closed → `auto_completed` is the only lever; the enum is uppercase, which bit the harness first. |
| **15 / 3** | draw order + drawn source | a 700 debit across promo(500, `priority 0`) + prepaid(1000, `priority 1`) left **`FREE_CREDIT_GRANT 0/500`** and **`PURCHASED_CREDIT_DIRECT 800/1000`** → their `ORDER BY priority` *is* our policy. But only **one** debit row exists: `drawn_source_reported: false`. | ✅ order closed / 🔴 source attribution **does not exist** → the per-row remaining+expiry from the transactions search is the Usage column, not a per-line-item source field. |
| **19** | promo remaining + next-expiry | `transactions/search` (`type=credit`, `credits_available_gt=0`, `expiry_date_before`) returns rows carrying both. `credits_available_breakdown` **absent entirely** once a `PURCHASED_CREDIT_BONUS` row exists — see §7d. | ✅ closed by the search / 🔴 the expand is broken upstream |
| **B7** | `group_by=properties.project_id` | falsified: SUM `group_by` ignored, meter route has no field, `detailed-analytics` returns empty `items` under every variant. **`filters` on the bare property name is exact** (alpha 3690 / beta 5 / u1 95). | ✅ closed with a different mechanism — see §7c |
| — | low-balance alert threshold | `AlertSettings` is set **per wallet by us** at creation (`api/dto/wallet.go:64`). | ◻ threshold is data, so `DEFAULT_ALERT_THRESHOLDS_PAISE` can retire; the alert **types**/comparison semantics were **not probed** (no alert consumer was minted) — non-gating, §6 |
| — | API keys per tenant; writes gated? | minted via service account + `type:"private_key"`; roles land on the key (`roles_on_key:["event_ingestor"]`); writes enforced, reads not. | ✅ closed → two-plane split required (but is *not* a read boundary) |
| — | webhook transport | `GET /v1/webhooks` and the config read both **404** → endpoints come from operator YAML, not tenant input. | ℹ️ INFO — no user-settable URL, no per-tenant management without Svix |
| **18** | AGPL | not empirical. | ⚖️ **hard gate** — `docs/FLEXPRICE_AGPL_MEMO.md`, unsigned. Nothing in Phase 1 proceeds on "probably fine". |

**Answered by the source pass, no live instance needed:** 2, 4, 7, 9(half), 11, 16,
20, and items 21-27 (cluster → `docs/SUBSTRATE_METRICS.md`). Items 6, 12, 15, 17, 19
were *framed* from source and are now closed by measurement.

**Still genuinely open after the spike:** every gating empirical question is
answered; the two deliberate non-probes above (`properties` number wire shape,
alert firing semantics) are ◻ and gate nothing. What remains is (a) the signed memo
(item 18); (b) **item 27's ₹/hour for `standard-1v1g`**, which is an operator pricing
decision rather than a measurement; and (c) the three re-plan triggers, which need a
human answer, not a probe.

### Two classes of failure the harness had to learn apart

Worth recording because it is the reason this table can be trusted at all:

1. **Harness bugs that looked like product findings.** The first runs "failed"
   because the harness polled the wrong route (`/usage` needs `event_name`, not
   `meter_id`), read the wrong field (`total` vs `value`, which is `omitempty` so
   *absent ≠ failure*), read `data` where wallet collections return **`items`**, used
   the wrong debit reason (`MANUAL_BALANCE_DEBIT` is the only accepted value), sent a
   nested `billing_address` that this API **silently drops** (address fields are flat),
   and asserted `"Succeeded"` where the enum is `"SUCCEEDED"`. None of that was a
   FlexPrice semantic.
2. **A product finding that was actually the compose stack.** The Kafka topic mismatch
   made every usage number read 0. That is a `deploy/flexprice/compose.yaml` bug with a
   one-line fix per name, not a billing-engine property — and it was only caught
   because the read-back was compared to a *known* expected value.

The gate rule and the `expectedValue` floor in `pollUsage` exist so that class 2 can
never again be written up as class 1.

## 10. Net effect on the plan

| Plan item | Change |
|---|---|
| Locked: "AGPL core, `internal/ee` untouched" | **Not implementable as written.** §0.1. Hard gate. |
| A1 two profiles `full`/`minimal` | Collapse to one honest topology (+ optional UI/dev profiles). §0.2 |
| B8 `zoho-sync.js` dry-run emitter | **Delete the work item**; configure their Zoho connector. §0.4 |
| B1 client | Needs an explicit paise↔decimal boundary; never `ToSmallestUnit`. §0.3. Plus: map the debit path's unique-violation-on-replay to success. §6b |
| B3 outbox | Must use `/v1/events/bulk` and verify by read-back; 202 proves nothing. §3 |
| B5 gate | Reads the real-time *projection*, not a balance; enable webhook dedup or accept the gap; assert Temporal is up. §2, §4. **New:** must define a negative-balance state, because `MANUAL_BALANCE_DEBIT` can produce one. §2 |
| B7 UI split | ~~grouping served by `group_by=properties.X`~~ — **falsified by measurement.** Per-project/per-user usage = one `POST /v1/events/usage` per dimension value with **`filters` on the BARE property name**; `group_by` on a SUM meter is ignored, `property_filters` is ignored, the dotted filter matches nothing, and `detailed-analytics` answers 200 with empty `items`. `usageRecords` stays the outbox source; the N+1 breakdown is loaded lazily per project. §7c |
| B8 platform charge | **Two calls, specified:** a `ONE_OFF`/`FINALIZED`/`metadata.auto_completed=true` statement invoice carrying its own amount line and no tax, then `MANUAL_BALANCE_DEBIT` with key `platform-charge:<org>:<YYYY-MM>`. §5, §6b |
| B2 `settle()` | **Never** set `metadata.wallet_transaction_id` on an invoice it credits, and never call `/invoices/:id/payment` on one — that path credits the wallet itself, which is the real double-credit loop (not the webhook). §6b. **New (measured):** mint a coupon bonus as **`FREE_CREDIT_GRANT`**, never `bonus_credits_to_add`/`PURCHASED_CREDIT_BONUS` — the latter silently destroys the wallet's own breakdown read. §7d |
| Item 4 `credit-expiry-job.js` | Their cron + read-time filter covers it; ours becomes an assertion. §4 |
| Item 9 GST | Their split already matches; but their tax engine reads the customer's auto-apply associations and there is no per-invoice exempt switch → **don't use their tax engine at all**; GST as invoice line items, `sum(tax)==0` everywhere by construction. §5. **Corrected by Phase 1 probe C:** the ₹500 `total` was not an exclusion of price-less lines — `total` is copied from the sent `subtotal`, and line price-ness never mattered. Send the **gross** in the header. §12 |
| B1 key scoping | Measured, not reasoned: cross-tenant access **is** refused on money writes (403), environment confinement **holds**, but **read RBAC is shadow-only** — a lesser key reads any wallet in its tenant at 200. → two keys (ingest vs money), **DB-minted** (`type:"private_key"` on a service account), never the config-map key (super_admin + caller-chosen env = unconfinable), and the design doc must not call the split a *read* boundary. §7 |
| Item 15 drawn-source column | 🔴 **No per-line-item source attribution exists** (`drawn_source_reported: false`; a 700 draw across two credit rows wrote one debit row). The column is derived from the credit rows' `credits_available` deltas, or dropped. §9 |
| Item 19 promo expiry UI | Worse than "no promo bucket": the **whole breakdown vanishes** on any wallet holding a bonus row, at HTTP 200. Remaining + next-expiry come from `POST /v1/wallets/transactions/search` (keyed `items`, not `data`). §7d |
| B3 outbox | **Load-bearing for a second reason:** the silent-zero class of failure (topic mismatch, typo'd meter field, `value` omitted when 0) means a 202-only drain cannot distinguish "no usage" from "broken pipeline". Read-back verification is the control; the reconciliation job is the alarm. §9 |
| Items 21-27 (cluster) | Done — `docs/SUBSTRATE_METRICS.md`. **Item 27 is not closed:** the ₹/hour for `standard-1v1g` is an operator pricing decision, not a measurement. |

## 11. Phase 0 exit criteria — status, checked rather than asserted

The plan gates Phase 1 on four conditions. Walking them literally:

| Criterion | Status | Evidence |
|---|---|---|
| "all items have a written answer" | ✅ every item 1-27 answered | §9 (empirical set, 14 probes, 0 failing verdicts), §§1-8 (source), `docs/SUBSTRATE_METRICS.md` §0 (items 21-27), `docs/FLEXPRICE_AGPL_MEMO.md` (item 18) |
| "the stack comes up with one command" | ✅ | `npm run billing:flexprice:bootstrap` — pins `VERSION`, generates `.env` (0600, values never echoed), builds, migrates, and *verifies* rather than assuming: `/health`, authenticated `/v1/tenants`, an unauthenticated read refused, topic + table counts, `schema_migrations`, seeded tenant, `consumer`/`worker` running |
| "the four modules pass `npm test`" | ✅ 40/40 | `gst` · `credits` · `substrate-session` · `compute-pricing` (`node --test packages/shared-core/src/billing/{gst,credits,substrate-session,compute-pricing}.test.js`) |
| "items **1, 5, 12, 13, 18, 21, 24** explicitly resolved" | ⚠️ **6 of 7** | 1 ✅ quoted-string money, sub-paise preserved · 5 ✅ deduped by `event_id` (total 10) · 12 ✅ negative `"-2900"`, p50 5 / p95 17 ms · 13 ✅ 8 containers, 1422 warm / 2015 loaded MiB · 21 ✅ inventoried live · 24 ✅ `ate*` publishes per-atespace CPU/mem only ⇒ oracle, not emitter · **18 ⚖️ the memo is written and correct but unsigned — that is a human/legal action, not a code task** |

→ **Phase 0 is complete except for the item-18 signature, which is the plan's own
hard gate. Phase 1 must not start before it is signed.**

### Re-plan triggers: all three fired, and each needs a decision rather than a probe

| Trigger | Plan's condition | What the evidence says |
|---|---|---|
| #2 item 10 | "if the key cannot be confined" | **Fires on the letter, not the reason.** Tenant + environment confinement *is* real for writes (foreign-customer write → 403), so the money paths are safe. But read RBAC is shadow-only and the config-map key is `super_admin` with a caller-chosen environment, so no key in this release is a *read* boundary. Phase 1's answer is architectural (keep every FlexPrice read inside `services/billing`), not a FlexPrice change. |
| #3 item 13 | "if it needs all nine containers" | **Fires on the letter, and the consequence is affordable.** Eight long-running containers are load-bearing — postgres, kafka, clickhouse, temporal, redis, api, consumer, worker — plus `migrate`/`seed`, which do their work and exit. 1.4 GiB warm / 2.0 GiB loaded fits the Docker VM beside `kind`. The plan's worry was laptop viability; it holds. |
| #1 item 18 | "no Phase 1 code before the memo is signed" | **Live and blocking.** `docs/FLEXPRICE_AGPL_MEMO.md` §8 records the verdict — *CLEARED for local Phase 0 dev/test, NOT CLEARED for production* — with three open questions for counsel/the vendor in its §7. Unsigned. |

Item 24's trigger did **not** fire: nothing in `ate-system` publishes actor cost
attributable to project or user, so the duration model in B4 stays the emitter.

### The one item that is not a measurement

**Item 27 — the ₹/hour price for `standard-1v1g`.** The tier name is decided (the
hardcoded 1 vCPU / 1 GiB at `substrate.js:545/551`, named rather than modelled, per
the plan's recommendation), and the price *lives* in FlexPrice as a per-tier price so
a change is an edit and not a redeploy. The number itself is the operator's to set:
it is not discoverable by probing, and nothing in Phase 1 is blocked on it except the
`compute-pricing.js` fixture's expected-paise assertion.

## 12. Phase 1 — the four contract probes, and the one Phase 0 answer they reversed

Phase 0 left four questions open because no DTO could answer them. They are now
measured on the live stack by `npm run billing:flexprice:phase1-probes`
(`scripts/flexprice-phase1-probes.js`), appended to
`docs/flexprice-spike/results.json` in the same `{name,item,ok,observed,decision,at}`
shape as §9. All four are green; **one reversed a Phase 0 conclusion.**

| Probe | Question | Measured answer | What it changes |
|---|---|---|---|
| **A** `wallet-conversion-rate-direction` | Which side of `amount = credits × conversion_rate` is the rupee? | `credits_to_add: "100"` on a `conversion_rate: "1"` wallet → **100 credits**. The same call on a `conversion_rate: "2"` wallet → **still 100 credits**. `amount: "100.00"` on the rate-2 wallet → **+50 credits**. | `credits_to_add` is denominated in **credits** and the rate only scales them to rupees, so `conversion_rate: "1"` genuinely means **1 credit = ₹1** (D6 stands; `money-wire.PAISE_PER_CREDIT = 100`). Phase 2 tops up with `credits_to_add` and **never** with `amount` — `amount` divides by the rate and would silently credit the wrong number on any wallet that is not 1. |
| **B** `float64-inside-event-properties` | What width does a `properties` value survive? The one path §9 never probed. | integers 1+2+3 → **6** in 203 ms; 0.1+0.2 → **0.30000000000000004**; `9007199254740993` → **9007199254740992** (JS rewrote it before the wire, not ClickHouse after). | Every quantity we emit is an **integer** (`cost_paise`, `duration_seconds`, `minutes`), so no float reaches this path and Phase 3's outbox can rely on exactness. A value that needs a fraction of the smallest unit is a **unit error**, not a rounding problem — measured, not preferred. |
| **C** `gst-lands-in-invoice-total` | Do priced GST lines land in `total` while `invoice.tax` stays 0? | **`total` is copied from the sent `subtotal`.** Line price-ness is irrelevant. Four corners below. | Reverses the Phase 0 row in §10 and rewrites D3's *mechanism*, not its outcome. |
| **D** `two-plane-write-confinement` | Is the money/ingest split a real boundary, and can a leaked money key mint credentials? | money-plane key minting an API key → **403 `permission_denied`**; the admin key, same request → **201** (the control; the mint was revoked again); ingest key creating a meter / topping up / debiting → **403** each; ingest key ingesting an event → **accepted**. | The split is a **write** boundary and the money key cannot escalate to credential issuance, because `IsSuperAdminUser()` is false for service accounts even though `super_admin` is the only writer role one can hold. It is still **not a read boundary** (§7: read RBAC is shadow-only), so no document may call it one. |

### C, in the four corners that separate the two hypotheses

Phase 0 sent `subtotal 500 / amount_due 590` with lines `500 + 45 + 45`, got
`total "500"`, and concluded *price-less lines are excluded from `total`*. Phase 1
sent the same three lines twice — once carrying `price_id`, once `display_name` —
across two header shapes:

| Sent `subtotal` | Sent `amount_due` | Lines | Resulting `total` |
|---|---|---|---|
| `590.00` | `590.00` | priced (3 × `price_id`) | **590** |
| `590.00` | `590.00` | price-less (3 × `display_name`) | **590** — identical |
| `500.00` | `590.00` | priced | **500** ← the number Phase 0 mistook for an exclusion |
| `590.00` | `500.00` | priced | **400** `sum of line item amounts 590 must equal invoice amount_due 500` |

So: **the header is the gross**; `total_tax` is 0 and is never the GST; the
bind-time check compares the **lines against `amount_due`** (not `subtotal`); and
the catalog's `gst-cgst-9` / `gst-sgst-9` / `gst-igst-18` prices are rate-card
**metadata**, not invoice arithmetic. The plan's pre-agreed fallback for probe C —
"GST stops being disclosed through FlexPrice `total`" — is **not needed**: ₹590
with both components visible does reach the invoice, and therefore Zoho, but it
arrives through the header and the line amounts, which is exactly where `gst.js`
already computes them.

### The DTO surface the client and provisioner had to measure rather than read

Each of these returned a 400 to a request that looked correct against the OpenAPI
docs, and each is now encoded in `flexprice-client.js` or
`scripts/flexprice-provision.js`:

- `idempotency_key` is a **JSON body field** (`dto/wallet.go:346,589`), required on a
  manual debit. There is no `Idempotency-Key` header anywhere in their router, so
  sending one buys a retry that duplicates the write.
- Prices attach to `entity_type: "PLAN"`; `"PRICE"` is unsupported and
  `"SUBSCRIPTION"` needs an existing subscription.
- `billing_period_count` must be sent explicitly.
- A `USAGE` price requires `invoice_cadence: "ARREAR"`; `ADVANCE` is a 400.
- `USAGE` on a `SUM` meter forbids `PER_UNIT` (allowed: `FLAT_FEE | PACKAGE | TIERED`);
  per-unit is `PACKAGE` + `transform_quantity {divide_by, round: "up"|"down"}`.
- Wallet alert-condition operators are **lower-case** `above` / `below`; `"BELOW"`
  is rejected as "Please provide a valid critical threshold condition".
- `DELETE /v1/meters/:id` **archives**: the meter keeps status `archived`, still
  appears in `GET /v1/meters`, and still resolves by id — an idempotency check that
  looks only at ids will never re-create a meter it deleted.
- `DELETE /v1/prices/:id` requires a JSON body.
- Customer address is **flat** — `address_line1 / address_city / address_state /
  address_postal_code / address_country` — never a nested `address` object.
- Usage reads take `start_time` / `end_time` and return `value`, which is
  `omitempty`: an absent key means **zero rows matched**, not a failed request.
- A line's `amount` is taken at face value; a line with **no** `amount` binds to `0`,
  because `amount` is `validate:"required"` on the DTO — which is how a request that
  meant ₹590 arrives as ₹0 and fails the check above.
- `invoice_status: "DRAFT"` on `POST /v1/invoices` is ignored — a one-off invoice
  lands `FINALIZED` — so `POST /:id/compute` and `/:id/finalize` both answer 400 on
  it ("Only draft or skipped invoices can be computed"). The draft-first flow is not
  reachable through this endpoint.

### The pin this section was measured at

`deploy/flexprice/VERSION` moved from `main`+226 (`709ff3bc`, what §1-§11 were read
from) to the release tag **`v2.1.48` (`21524530`, image `4ad8d8ca6e69`)**, and the
whole §9 spike was re-run against it — see the re-validation row below. The
`file:line` citations above therefore point at the Phase 0 tree; the *behaviour* is
confirmed at the tag. Where the two disagree, the probe result in
`docs/flexprice-spike/results.json` wins, because that is the binary we run.


## 13. Phase 2 — two response shapes that broke the money path, measured live

Found by `npm run billing:recharge:verify` (the first run of the recharge spine
against the stack rather than against fakes). Both are silent: neither produces an
error FlexPrice reports, and neither is visible from the OpenAPI shape.

| Route | What it answers | What the code assumed | What that did |
|---|---|---|---|
| `GET /v1/customers/:id/wallets` | a **bare JSON array** (`[{...}]`) | the `{items}` envelope the search routes use | `ensureWallet()` never found the org's existing wallet, so it called `POST /v1/wallets` again, FlexPrice answered `409 already_exists` (unique index, no pre-check), the client mapped that to `{alreadyExists: true}` — **which has no `id`** — and the next call was `GET /v1/wallets/undefined/balance/real-time` → 404. Net effect: the *first* recharge for an org succeeded and **every second one failed**. |
| the same route's `currency` field | `"inr"` (lower-cased on read) | `'INR'` as sent on create | an exact `===` comparison, so even an `{items}` read would have missed the wallet. Their DTO lower-cases on the way out; nothing in the request told us. |

The failure mode is the reason it is recorded here rather than just fixed: a
shape mismatch on a *list* route does not raise, it reads as "there are none", and
the next verb is a create. For wallets that means the create's 409 is what tells
you the resource existed — and a 409 mapped to success carries no id, so the money
path proceeds with an undefined target.

Fixed at the boundary instead of at the call site: `flexprice-client.js` now
normalises that route to `{items}` through one `rowsOf()` helper that accepts a
bare array, `items`, `data`, or the `{environments}` key `GET /v1/environments`
uses. `recharge-settle.js` compares currency case-insensitively and refuses with
`flexprice_wallet_unresolved` (502) if a wallet still cannot be resolved, so an
unresolved target is a refusal with a sentence rather than a credit to `undefined`.
`scripts/flexprice-provision.js` had the same comparison and is fixed the same way —
provision was not idempotent for wallets, it only looked so because each org had
been provisioned once.

Credit-row field names, for the record (Phase 3's reconciler reads these):
`type: "credit"`, `transaction_reason: "PURCHASED_CREDIT_DIRECT"` (or
`"FREE_CREDIT_GRANT"` for a promo), the amount as `credit_amount`, the remainder as
`credits_available`, both as **strings**, `priority` as a number, and
`idempotency_key` echoed back on the row — which is what makes "a replay produced
exactly one row" checkable instead of assumed. `metadata` on a top-up row keeps
whatever we sent it (`subtotal_paise`, `gst_paise`, `collected_paise`, `provider`,
`fleet_order_id`), so the GST that was collected next to a credit is auditable
without reading our store.

Pinned at the same `v2.1.48` (`21524530`, image `4ad8d8ca6e69`) as §12; the
transcript is `docs/BILLING_FLEXPRICE.md` §11.
