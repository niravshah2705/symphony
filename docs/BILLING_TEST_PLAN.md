# Testing the token-credit billing path

How to verify the work in #343 (Stages 1–4: the rename, the YAML card, the rate-card cost
path) and #344 (Stages 5–8: fixed packages, per-event reconciliation, credits-only display,
the catalog that no longer publishes a rate card).

Read this document's commands as a **checklist, not a transcript**. Levels A and B are the
ones a reviewer can run anywhere; Level C needs the local FlexPrice stack and Levels D–E
name what only a live cluster or a real Cashfree account can answer. Where a level was **not
run** in the session that produced a commit, that commit message and the PR body say so —
nothing below is a claim that a number was observed on your machine.

## 0. The four things that have to be true

| Claim | Where it is enforced | Fastest check |
|---|---|---|
| The subunit rename is **naming, not rescaling** — every stored integer is byte-identical | `token-credit-naming.test.js` (both directions) + the load-time migration | Level A, then §3.6's before/after window read |
| The YAML card is the **only** price of a token; FlexPrice prices aggregate, they never charge | `credit-rates.test.js`, `balance-authority.test.js`, the two ₹0.00 USAGE prices | Level A; §3.3 confirms the catalog shape |
| What the provider reported is **provenance**, never a money source | the provenance name-scan in `balance-authority.test.js` + the group-by allow-list test | Level A |
| A package's money identity holds end to end: `collected − gst == prepaid`, promo **outside** it, ₹ on the charge and the invoice | `money-flow.test.js`, `recharge-settle.test.js`, `app.test.js` | Level A; §3.4 reads the same numbers off a real wallet |

## 1. Level A — unit suites and the gates (no cluster, no keys, ~1 min)

```bash
npm test
node --test packages/shared-core/src/billing/ packages/shared/src/billing/ \
           services/billing/src/ deploy/ scripts/flexprice-provision.test.js
```

Expected on a clean checkout of `feat/billing-credit-packages-display`: **2730 tests / 1
failure** for `npm test`, and **685 tests / 0 failures / 5 skipped** for the targeted run
(618 if you scope it to `deploy/gcp/` instead of `deploy/`). The single
failure is `scripts/marketing-site.test.js:149` (the staleness check wants a built
`marketing/`, which a worktree does not carry); it passes in CI, which builds it first. If
anything else is red, stop and read that file — this work did not touch the marketing site.

### 1.1 The gate map — and how to falsify each rule

These are the checks that make the money model a property of the code rather than a habit.
Each row is worth running once by breaking it on purpose: a gate nobody has seen fail is a
gate nobody trusts.

| Rule | Gate | Deliberate break → the test that goes red |
|---|---|---|
| A number that becomes a wallet credit is `tokenCredits`; a number that is a payment or a tax is `paise` | `packages/shared-core/src/billing/token-credit-naming.test.js` | Rename `gst.js`'s `subtotalPaise` → `subtotalTokenCredits` (the *rupee-side* half fails); or reintroduce `costPaise` in any file under `packages/services/public/scripts/deploy/e2e/e2e-live` (the credit-side half fails). The scan also fails on a credit-side name in an e2e fixture, which is how a stale contract claim gets caught. |
| FlexPrice is the only readable balance | `services/billing/src/balance-authority.test.js` | Read `account.balanceTokenCredits` in a new file, or move credits outside the allowed credit sites (`flexprice-client.js`, `recharge-settle.js`, `platform-charge-job.js` + four scripts). The reverse direction is held too: every file that *carries* an exemption is asserted to be inside the scan, so an exemption cannot outlive the scan that grants it. |
| Provenance fields are audit payload, not money | same file, the name scan | Sum `record.inrCost` or `providerCost` on any read path. The names may appear only in the files that compute, persist, stamp or audit the tuple (`pricing.js`, `usage.js`, `store.js`, `billing-outbox.js`, `flexprice-usage-verify.js`), plus one exempted production reader: `reconcile-gateway-spend.js`, whose exemption is recorded as *one field only* — `fxRateToInr`, to compare a past window at the rate it carried. Name `inr_cost` there and you are outside what the exemption says. |
| No provenance property becomes a group-by dimension | `services/billing/src/flexprice-reads.test.js` | Add `inr_cost` to the `DIMENSIONS` allow-list in `flexprice-reads.js`. |
| A credit surface declares one currency formatter | `balance-authority.test.js` (`RUPEE_VIEWS`) | Import `inr()` into a credits-only view, or add a second `style: 'currency'` formatter. |
| A read envelope carries no rupee field | `flexprice-reads.test.js` | Put `currency: 'INR'` or any `…paise` key on a `/overview`-shaped answer. |
| The card is fail-closed and never silently stale | `deploy/billing/credit-rates.test.js` | `the shipped card loads from the default path the loader computes`, `the card prices nothing the gateway refuses to serve` (break it **both** ways: delete a model row that `deploy/litellm/config.yaml` serves, then add a row for a model it does not), `the offered packages are the offers…`, `the card says where its prices came from…`. |
| Every image that meters a run bakes the card in | `deploy/billing/credit-rates.test.js` → `each image that meters a run bakes the card in, at the path its own ENV names` and `each metering process gates its own boot on the card` | Delete the `COPY deploy/billing/credit-rates.yaml …` line from `Dockerfile.orchestrator` or `Dockerfile.substrate-actor`, or drop the `ensureLoaded()` call from one entrypoint. This is the failure mode that ships green and costs a month of unmetered runs, because `recordUsage` is deliberately fail-open. |
| `settle()` never consults the card | `services/billing/src/recharge-settle.test.js` → `settle() never consults the rate card, in code` and `a package repriced or retired after the order still settles at the frozen numbers` | Add a defensive "is this package still enabled?" check to `settle()`. The test exists precisely so that later helpfulness cannot strand a paid order. |
| An order's money **and** its tax location are frozen at quote time | `recharge-settle.test.js` → `the store freezes intent money and offer identity…`, `a GSTIN saved after the quote is only drift if it changes the money` | Drop `supplierStateCode` from the freeze list in `store.js` — the interstate swap keeps `totalPaise` byte-identical, which is why `quote_drift` alone could never see it. |
| The event contract is one aggregated integer plus a fixed provenance set | `packages/shared-core/src/billing/billing-outbox.test.js` | Rename `token_credits` in `properties` (the meter binds on the exact name, so this is the edit that silently bills nothing — the test is the only thing that speaks up), or camel-case a provenance key. |
| The retire step parks the old rate rows and destroys nothing | `scripts/flexprice-provision.test.js` | Turn the retire `PUT` into a `DELETE`: the contract test asserts the request log contains no DELETE. It also pins the merged metadata (a whole-document `PUT` that drops `fleet_meter` fails) and a second run's idempotence. |
| The pricing alert still exists | `deploy/gcp/observability-config.test.js` | Rephrase the `priceMatch === 'Default'` warn sentence in `usage.js`, or rename the literal. The Terraform metric filter matches on `jsonPayload.meta.priceMatch="Default"`, so prose edits silently un-monitor the alert. |

## 2. Level B — the browser, with the local payment mock

Nothing here talks to Cashfree or Razorpay: `BILLING_ALLOW_MOCK_PAYMENTS=true` is the local
mock and the persisted intent is the amount authority (decision D1).

```bash
BILLING_ALLOW_MOCK_PAYMENTS=true npm start
npx playwright test e2e/usage.spec.js e2e/persistent-footer.spec.js
```

`npm start` loads the repo's `.env` (`node --env-file-if-exists=.env`, `AUTH_MODE=disabled` is
the default local profile) but **strips every key ending in `API_KEY`/`TOKEN`/`SECRET` from the
child services** (`scripts/start-all.js:79-85` — the same rule that keeps provider credentials
out of agent containers). Consequence worth knowing before you read a screen: under `npm start`
the FlexPrice plane keys never reach the billing process, so the FlexPrice-backed sections
answer **degraded** and the numbers you see are the local store's. That is a check in itself —
degraded must read "unreadable", never `0` (the scoping note at the end of this section) — but for the live numbers run billing in
a shell that has both files, which is also what the Level C verify scripts do:

```bash
set -a; . .env; . deploy/flexprice/.env; set +a
BILLING_ALLOW_MOCK_PAYMENTS=true FLEXPRICE_ENABLED=true node services/billing/src/index.js
```

The specs themselves need neither: they stub the reads, so a failed spec is a display contract
broken, not a stack down.

Expected: **16 pass** for those two specs (the whole e2e suite ran 92 pass in the Stage 7
session). `usage.spec.js` is the display contract, not a smoke test: it asserts the balance
card reads `3,760` with the note `credits`, that `main` contains **zero** `₹`/`INR` outside
`.usage-purchase`, and that the purchase panel shows `Pay ₹2,360.00 incl. GST ₹360.00`
beside `3,500 credits` — ₹ exactly where money enters.

Manual pass, once, on a fresh org:

1. **Usage page** — balance, heatmap bins, trend axis and the run table all read credits. The
   purchase panel offers the two packages and nothing else: there is no amount input to type
   into, because a typed amount was the thing that made a client able to choose a price.
2. **Cost page** — thresholds say `(credits)`, and the `Estimate rate ₹87/USD` line is gone.
   FX left the money path, so a UI that shows a rate invites the customer to believe one
   sets their cost.
3. **The footer on every page** (`services/gateway/src/capability-view.js`) — `unit:
   'credits'`, `balanceCredits`. This is the fourth surface, and the one a regression here
   shows on every screen at once.
4. **Admin drill-down** — a run row shows `≈ ₹…` beside its credit figure. Log in as a
   member with the same URL: the `₹` column must be absent, not zero and not `—`, because the
   gate is **key presence** (`rupeeFields(isAdmin, …)` sends no field at all).
5. **The two refusals**, from the browser console so the session's own auth applies:
   ```js
   fetch('/api/billing/recharge', {method:'POST', headers:{'content-type':'application/json'},
     body: JSON.stringify({amountInr: 2000})}).then(r=>r.json())   // 400 amount_not_accepted
   fetch('/api/billing/config', {method:'PUT', headers:{'content-type':'application/json'},
     body: JSON.stringify({autoRecharge:{amountInr:500,thresholdInr:400}})}).then(r=>r.json())
   // 400 unit_not_accepted — and this one is the dangerous case: autoRecharge is rewritten
   // wholesale, so a stale key would arrive as 0 and switch the alert and the auto-reload off
   // silently on a balance that is falling.
   ```
   Equivalent cURL against the billing service directly works locally only because
   `AUTH_MODE=disabled` over loopback is proof 3 of `services/billing/src/trusted-caller.js`
   (default port 4050):
   ```bash
   curl -s localhost:4050/api/billing/summary \
     -H 'x-ai-fleet-billing-org-id: <org>' -H 'x-ai-fleet-billing-org-role: ORG_ADMIN' \
     | jq '{unit, balanceCredits, packages: [.rechargePackages[] | {packageId, credits, priceInr}]}'
   ```
   The `/summary` body is flat — no `data` wrapper — and `rechargePackages` (not `packages`)
   is what you can *buy*, while `overview.packages` is what you *own*: credit balances
   FlexPrice already holds an expiry for.
   A deployment without that proof is **scoped, not rejected**: it answers its own org,
   `isAdmin: false`, and the FlexPrice-backed sections come back degraded with zero calls.
   Confirm it: the same request without the headers must not 403 on reads, and must return a
   degraded envelope — that is the Part A property (#339) this work is stacked on.

## 3. Level C — the live FlexPrice stack

Prerequisites, in order. `deploy/flexprice/.env` holds both plane keys and the base URL:
**read it, never print it**, and note `npm start` does not load it.

```bash
npm run billing:flexprice:bootstrap                 # checkout → secrets → build → up → 11 assertions
set -a; . deploy/flexprice/.env; set +a
export FLEXPRICE_ENABLED=true FLEXPRICE_SUPPLIER_STATE_CODE=27 BILLING_ALLOW_MOCK_PAYMENTS=true
curl -s http://api.flexprice.local/health           # not 127.0.0.1:18080 — the host rule matters
```

### 3.1 The provisioner, projected before it writes

```bash
node scripts/flexprice-provision.js --dry-run
```

What must appear, and what each line means:

- `meter llm-token-credits (fleet.llm_cost)` → `dry-run SUM token_credits` on a stack that
  predates the rename, or `existing` on one that has been provisioned since. A **new** meter
  is expected: a deployed meter binds event name + aggregation property at creation, so the
  property rename could not be an edit.
- `meter llm-cost (fleet.llm_cost)` → `existing (retired)`, and the detail prints **what the
  stack actually aggregates** (`SUM cost_paise`). That is the line to look at when a window
  straddles the cutover. On a fresh stack it says `retired / not created` instead — there is
  no history to preserve, and inventing an empty meter would hide that fact.
- `price meter-llm-cost` → `dry-run amount 0.01 -> 0.00, metadata fleet_retired,fleet_note`.
  The zero matters: a live ₹0.01 USAGE price on any subscription bills the same usage a
  second time on top of the debit the card already made.
- Nothing about `rate-*`. `ensurePrice` never deletes, so the fourteen stale rate-card rows a
  pre-Stage-4 stack carries are invisible unless you ask for them.

### 3.2 Retiring the published rate card

```bash
node scripts/flexprice-provision.js --retire-rate-rows
```

Expect one `retired … (kept, not deleted)` row per `rate-{provider}-{direction}` price, then
run the same command **again**: a second pass prints `existing (retired)` for every one of
them, and that branch is keyed on `metadata.fleet_retired === "true"` — so the idempotent
re-run *is* the read-back of the write, with no extra tooling. `billing:flexprice:inspect` has
no `prices` command; to see the row directly, the raw read names the money plane only through
env references (never echo them):

```bash
curl -s "${FLEXPRICE_BASE_URL:-http://api.flexprice.local}/v1/prices?limit=200" \
  -H "Authorization: Bearer $FLEXPRICE_API_KEY_MONEY" \
  -H "X-Environment-ID: $FLEXPRICE_ENVIRONMENT_ID" \
  | jq -c '.items[] | select(.lookup_key | test("^rate-")) | {lookup_key, metadata}'
```

A row should read `fleet_retired: "true"`, `fleet_retired_on: "<date>"`, and keep
`provider` / `direction` / `usd_per_mtok` — the FX pair (`fx_usd_inr`, `fx_captured_on`) is
dropped because a rate with no date and a date with no rate are both meaningless alone, while
the row's own identity is the record of what was published. If FlexPrice refuses a
metadata-only `PUT /v1/prices/:id`, that is the one unprobed shape in this work: it surfaces as
a `failed` row and a non-zero exit, **not** as a silent pass. `DELETE` is deliberately never
attempted — the façade exposes no price delete and no probe established what one does to a
price a subscription may still point at.

### 3.3 The catalog shape after provisioning

```bash
node scripts/flexprice-provision.js --org <throwaway-org> --org-name "Verify Corp" --state 27
```

Both LLM meter prices must be ₹0.00 with `fleet_meter` still present (the read-back in §3.2's
curl, shape-changed to `^meter-` — proof the whole-document `PUT` merged rather than replaced),
`actor-compute` ₹0.00 per D4, and `recharge-principal` plus the three `gst-*` lines unchanged —
those four are what the Zoho invoice shape reads, so they must survive every catalog change.

### 3.4 The recharge spine, end to end

```bash
npm run billing:recharge:verify      # 53 checks; add -- --keep to leave the temp store
```

The assertions that are specific to this change, with their exact expected values for
`credits-3500`: intent `{subtotalPaise 200000, couponBps 7500, bonusTokenCredits 150000,
gstPaise 36000 (= CGST 18000 + SGST 18000), totalPaise 236000, totalInr "2360.00", packageId,
bonusValidDays 30, promoExpiresAt = createdAt + 30d}`; **exactly two credit rows** —
`PURCHASED_CREDIT_DIRECT` 2,000 (priority 1, no expiry) and `FREE_CREDIT_GRANT` 1,500 (expiring,
and a row rather than a bonus field on the purchase); `totalPaise − gstPaise ==
prepaidTokenCredits` with the bonus outside it; balance delta **exactly 3,500**; and a replay of
the same order answers `alreadyProcessed: true` with `creditsAdded` 2,000 / `totalCredits`
3,500 — nothing re-posted, the promo not doubled.
And the negative that must not soften:

```bash
BILLING_ALLOW_MOCK_PAYMENTS=false npm run billing:recharge:verify   # still mock_payment_not_accepted
```

### 3.5 Usage, actors, the drain and the gate

```bash
npm run billing:usage:verify
npm run billing:actor:verify
npm run billing:phase5:verify
npm run billing:zoho:contract        # needs the pinned Go checkout: FLEXPRICE_CHECKOUT=/tmp/fp-research/flexprice
```

`usage:verify` is the one that proves the metered number rather than asserting it: a 202 proves
nothing in this engine, and `value` is omitted when it is 0. Its money assertion is on the
**meter SUM over `token_credits`** — it deliberately asserts the wallet balance did *not* move,
because consumption debits at invoice finalize, not at ingest.

### 3.6 The rename's "no rescaling" claim, read off the engine

This is the check that a unit test structurally cannot make. Pick a window that straddles the
cutover and read both meters:

```bash
node scripts/flexprice-inspect.js meters      # the two ids come from here, not from memory
node scripts/flexprice-inspect.js usage --customer <org> --hours 72 --meter <llm-token-credits-id>
node scripts/flexprice-inspect.js usage --customer <org> --hours 72 --meter <llm-cost-id>
```

Post-cutover days must come from `llm-token-credits` and pre-cutover days from `llm-cost`, and
where the two windows are adjacent the **integers are comparable** — a 100k-in/20k-out claude
run is 5,220 token credits on either side of the rename. If the two series differ by a factor
of 100, something rescaled, which is the bug the whole Stage 1 was designed not to have. The
same comparison on our side: summed `costTokenCredits` from the usage records for the window
must equal the new meter's SUM at **zero** tolerance (both are our number, so any delta is a
defect — that is the FlexPrice leg of the reconciler, §3.7).

### 3.7 The reconciler

```bash
npm run billing:reconcile
```

The report now has to answer in the units the runs were priced in. Expect
`fx: {asOf, ageDays, toleranceBps, stale}` and `coverage: {withRate, without}`, and:

- a window whose events all carry `fx_rate_to_inr` → the band does **not** apply to them, so a
  real pricing error cannot hide inside tolerance; the tolerance applies only to the
  `coverage.without` share (pre-Stage-4 history and providers that never reported a cost);
- past `stale_after_days` → `fx_stale`, not "who is ahead" — the honest answer when the rate
  row is out of date;
- a `flexprice_delta` of even **1 token credit** → a failure, not a warning.

A band breach on the platform leg now means a rate-card error (a model row missing so it
priced from `defaults`, transposed input/output, a stale price). Remediation is to edit
`deploy/billing/credit-rates.yaml` and redeploy — never to rotate FX.

### 3.8 Metrics and the alert

```bash
npm run billing:metrics:check        # bash scripts/kind-metrics-install.sh
```

Confirm the `Default`-price alert still has a series behind it after the cost path moved: the
filter matches `jsonPayload.meta.priceMatch="Default"`, so an empty alert here means prose
drifted from code (see §1.1's last row), not that pricing is healthy.

## 4. Level D — what a monitor should now watch

Not a test, but the three signals that say whether the above held in a running system:

- `billing_usage_cost_rounded_to_zero` — a run whose tokens priced to **less than one token
  credit** is unmetered by design, and per-model INR rows make small runs cheaper than the old
  provider-level USD table. A rising count is the card being too cheap for the traffic, not a
  rounding bug: rounding was deliberately not changed.
- `fleet_egress_cred_unavailable` / `fleet_egress_no_route` on the sidecar — unchanged by this
  work, and still the only place a `litellmApiKey` failure shows up.
- The gateway-vs-platform delta trend from §3.7, per org.

## 5. Level E — what cannot be tested on a laptop

These are **open items**, listed rather than assumed done. The Cashfree integration skills
pack (`validation-and-testing`, `pg/go-live`) is not present in this worktree or in
`~/.agent/skills`, so its checklists were never read and no go-live item below is marked
verified.

1. **Pay Native / DCC is an ops enablement, not code.** International cards must pay in their
   own currency with the merchant order and settlement staying INR. Nothing here detects the
   feature being absent on the account, so a US card fails at the gateway until Cashfree's
   sales team enables it. Test: one real USD-denominated card auth against a staging org,
   `credits-3500`, then confirm the captured amount is still `"2360.00"` INR on our side.
2. **A real webhook**, with signature verification, from a capture that our `settle()` did not
   see arrive — replay it, and confirm `already_processed` and a balance delta of 0. The
   webhook is advisory by design; the settled intent is the authority.
3. **The GST invoice as filed** — the Zoho contract check runs in `ZOHO_MODE=fake`, so the
   CGST/SGST-versus-IGST split on a real return is unexercised here.
4. **A refund.** There is no code path and that is deliberate; support operates refunds out of
   band today. `docs/BILLING_FLEXPRICE.md` §11 records the two wrong answers (claw back only
   the prepaid row and 1,500 bonus credits stay spendable on a cancelled payment; claw back all
   3,500 and you charge someone for a gift) and the four questions to settle first.
5. **The 150% bonus package against a real ₹4,000 charge**, in a state other than 27, so the
   IGST branch and the raised `MAX_BONUS_BPS` meet in production rather than in a fixture.

## 6. Rehearsing a failure that has no test

Two of this work's worst outcomes are silent, so they are worth forcing on a throwaway org:

- **The card missing from an image.** Delete the `COPY` line from `Dockerfile.orchestrator`,
  build, and watch what happens: `recordUsage` is fail-open, so the process **starts fine** and
  runs meter to nothing. That is the point of
  `credit-rates.test.js → each image that meters a run bakes the card in…`, and the reason the
  boot gate (`each metering process gates its own boot on the card`) exists as a separate
  assertion: the crash-loop failure mode was never the real one.
- **A stale SPA bundle posting the old unit.** §2 step 5 covers `/config`; the order path is the
  louder one (`amount_not_accepted`), and both are refusals rather than silent 0s.

## 7. Rollback is a deploy, not a migration

Nothing here rescaled a number, so a revert needs no backfill:

- The rename is a **load-time** migration in `normalizeStore`, idempotent and applied per read,
  which is why it covers Firestore without a separate script (`store/firestore-backend.js`
  passes every document through `assemble()`). Reverting to `eedab390`'s parent leaves records
  under the new keys that the old code never reads — so a rollback is *forward-only* in
  practice, and the reason the old `llm-cost` meter is kept readable rather than archived.
- Retired `rate-*` prices are metadata only: PUT `fleet_retired` off and the row is exactly what
  it was. Nothing was deleted, which is why the step was safe to run without a probe.
- `llm-token-credits` is additive; `llm-cost` keeps answering for its history, so a rollback
  re-reads the old window from the old meter instead of losing it.

## 8. Not covered by any of the above

Auto-recharge still settles nothing (it validates and stores `autoRecharge.packageId` and
deliberately does not use it); subscriptions and invoices are not part of the debit path, which
is why both LLM prices are ₹0.00; `antigravity` and local providers stay direct, so no card
prices their runs; and the per-tenant GCP path (Cloud Run ↔ GKE, the `litellm` gateway mode) is
unproven independent of this work. See `docs/BILLING_IMPLEMENTATION_PLAN.md` for the phase map
and `docs/FLEXPRICE_FINDINGS.md` for the measured engine behaviours this plan leans on.
