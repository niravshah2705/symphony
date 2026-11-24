# LiteLLM ↔ FlexPrice integration (self-hosted, configuration only)

Bill AI-gateway usage recorded by a self-hosted [LiteLLM](https://docs.litellm.ai) proxy
through FlexPrice, using **only existing FlexPrice APIs and configuration — no FlexPrice
code changes**. The gateway hierarchy is organisation → project (LiteLLM *team*) → user;
requests can additionally carry billable **tags** (by default `planning`, `skill`, `mcp`).

> **Cloud vs self-hosted.** FlexPrice's hosted product ships a turnkey "AI Cost Tracking"
> connector (`callbacks: ["flexprice"]` in LiteLLM, auto-provisioned meter templates,
> hierarchy resolution). **None of that exists in this open-source repo** — a search of the
> codebase finds no `flexprice` LiteLLM callback, no `ai.usage` connector, no
> `cost_tracking`/`team_budget`/`resale_markup` templates. LiteLLM OSS likewise does not
> bundle a `flexprice` callback name. This document is the self-hosted path: the same
> canonical `ai.usage` event contract (so events stay forward-compatible with the cloud
> convention), delivered by a small callback file deployed **next to the LiteLLM proxy**,
> configured entirely through FlexPrice APIs.

## Architecture

```
apps / agents / MCP servers
        │  OpenAI-compatible calls, tags via litellm_metadata = ["planning"|"skill"|"mcp"]
        ▼
 self-hosted LiteLLM Proxy  ──── virtual keys: org → team(project) → user
        │
        │  bridge (pick ONE; no FlexPrice code involved)
        ├─ A. CustomLogger callback (flexprice_callback.py, mounted with proxy) → POST /v1/events/bulk   [real-time, recommended]
        └─ B. cron poller (poll-spend-logs.sh) reading /spend/logs/v2          → POST /v1/events/bulk   [zero proxy files]
        ▼
 FlexPrice: meters (filters + sum) → prices on a plan → subscription per org → invoices
        │
        │  spend alerts (subscription.spend.threshold_reached webhook)
        ▼
 enforcement receiver (enforce-receiver.py) or pull-sync (sync-budgets.sh)
        → LiteLLM /key/update (soft) | /key/block (hard)
```

Billing model decisions encoded here:

- **The organisation is the invoiced customer.** Projects (teams), users and tags are
  usage *breakdown dimensions* (`group_by` on the usage APIs) plus tag-scoped meters —
  there are no per-project/per-user FlexPrice customers.
- **Dual cost basis:** token meters priced inside FlexPrice (you control margin/price
  lists) *and* a pass-through meter summing LiteLLM's own computed USD cost (`reported_cost`)
  for BYOK/negotiated rates and reconciliation.
- A call is billed **either** on its tag meters (when tagged) **or** the base meters
  (when untagged) — never both. See the tag encoding below.

## 1. Conventions on the LiteLLM side

1. **Organisations / teams / users.** Provision one LiteLLM *organisation* per billed
   entity, one *team* per project, and virtual keys per team/user. The bridge reads
   `user_api_key_org_id` / `user_api_key_team_id` / `user_api_key_user_id` from the
   standard logging payload — these are populated automatically from the virtual key
   identity, no client changes needed.
2. **Tags.** Callers mark billable products by sending tags in the request body. Over
   raw HTTP use `litellm_metadata` (the OpenAI SDK's `extra_body={"metadata": ...}`
   maps to it); tags configured on the key/team arrive the same way:

   ```json
   { "model": "gpt-5-mini", "messages": [...],
     "litellm_metadata": { "tags": ["planning"] } }
   ```

   The proxy exposes them to callbacks as `request_tags` in the standard logging
   payload; the bridge intersects them with the billable set (LiteLLM also appends
   `User-Agent` pseudo-tags there, which must not flip the `tagged` flag).

   The set of *billable* tags is `FLEXPRICE_BILLABLE_TAGS` (default `planning,skill,mcp`);
   other tags are ignored by meters. Adding a new billable tag later is config-only:
   extend the env var and add one meter + prices (no historical relabeling needed —
   events already ingested carry whatever `tag_<name>` properties existed at send time).
3. **Config example:** [`litellm-config.yaml`](./litellm/litellm-config.yaml).

## 2. Event contract

One event per LiteLLM request, `event_name: ai.usage` (FlexPrice cloud's canonical AI
event name, adopted for forward compatibility), posted to
`POST /v1/events/bulk` (`internal/api/dto/events.go` — `IngestEventRequest`):

| Field | Value | Why |
|---|---|---|
| `event_id` | LiteLLM `request_id` (`chatcmpl-…`) | FlexPrice dedups on the ClickHouse `events` ORDER BY key → **retries/duplicate deliveries are harmless** |
| `external_customer_id` | `litellm-org:<organization_id>` | org = billed customer |
| `timestamp` | request end time, ISO 8601 | usage windows follow event time, not ingest time |
| `source` | `litellm` | provenance |
| `properties.provider/.model/.operation` | strings | breakdown dimensions |
| `properties.input_tokens/.output_tokens/.total_tokens` | integer as **string** | summed by token meters |
| `properties.reported_cost` | USD as string | summed by the passthrough meter |
| `properties.organisation_id/.raw_team/.raw_user` | ids | hierarchy breakdown (`group_by`) |
| `properties.tag_planning/.tag_skill/.tag_mcp` | tag value **or** `""` | see below |
| `properties.tagged` | `"true"`/`"false"` | base-vs-tag meter switch |
| `properties.fidelity` | `per_request` | cloud convention |

**Why tags are flattened to scalars:** FlexPrice meters can only filter with
`JSONExtractString(properties, <top-level key>) IN (<values>)` — positive IN-lists on flat
scalar strings (`internal/repository/clickhouse/aggregators.go`). A JSON array property
cannot be filtered, so each billable tag becomes its own property (`tag_planning` =
`"planning"` when present, `""` otherwise) plus a `tagged` flag. Consequences:

- tag meter filter: `{"key": "tag_planning", "values": ["planning"]}` → counts only calls carrying that tag;
- base meter filter: `{"key": "tagged", "values": ["false"]}` → counts only untagged calls;
- a call tagged `["planning","mcp"]` bills on both tag meters (per-tag line items) and on neither base meter.

Sample events: [`events-sample.jsonl`](./litellm/events-sample.jsonl).

## 3. Bridge A (recommended): LiteLLM custom callback

Example implementation: [`flexprice_callback.py`](./litellm/flexprice_callback.py) — a
LiteLLM `CustomLogger` that buffers events (default 200 / 10s), maps the
`standard_logging_object` to the contract above and POSTs `/v1/events/bulk` with retry +
backoff. It uses only the stdlib HTTP client.

Deploy: copy the file next to the proxy's `config.yaml` (or mount it into the image at the
module search path) and register the *instance* by dotted path:

```yaml
litellm_settings:
  callbacks: flexprice_callback.flexprice_logger
```

Env: `FLEXPRICE_API_URL`, `FLEXPRICE_API_KEY`, optional `FLEXPRICE_ENVIRONMENT_ID`,
`FLEXPRICE_ENTITY_FROM` (default org id, fallback team id), `FLEXPRICE_BILLABLE_TAGS`,
`FLEXPRICE_BUFFER_SIZE`, `FLEXPRICE_FLUSH_SECONDS`.

Properties to know:

- This is LiteLLM OSS's supported custom-callback mechanism (`callbacks: <module>.<instance>`);
  it is **gateway-side deployment, not a FlexPrice change**.
- Failures never block the LLM call path beyond the callback's own retry budget; events
  dropped after exhausted retries are recovered via Bridge B backfill (Section 8).
- Streaming usage is captured by LiteLLM itself in the standard logging payload.

## 4. Bridge B (no proxy files): poll `/spend/logs/v2`

Example: [`poll-spend-logs.sh`](./litellm/poll-spend-logs.sh) (bash + jq + curl) for cron
or a k8s `CronJob`. Every N minutes it pages `GET /spend/logs/v2?start_date=<cursor>`,
maps rows to the same events (LiteLLM `spend` → `reported_cost`) and bulk-POSTs in
≤500-event batches. Semantics:

- **at-least-once**: the cursor file advances only after a fully successful run, and
  `event_id` dedup absorbs the deliberate 10-minute overlap window.
- Requires no deployment inside the proxy container at all — anything that can reach both
  APIs works (host cron, sidecar, n8n "HTTP → map → HTTP" workflow).
- Latency = poll interval; tags must be present in the logged `request_tags`.

## 5. FlexPrice setup (all via API; equivalent screens exist in the UI)

Auth for everything below: `x-api-key: <private key created in /v1/secrets/api/keys>` plus
`X-Environment-ID: <env>` when the key is not environment-bound. In production the key
lives in your secret manager (Helm `existingSecret`/env), never in a values file.

### 5.1 Customer per organisation

```bash
curl -sS -X POST "$FP/v1/customers" -H "x-api-key: $FP_KEY" -H 'Content-Type: application/json' -d '{
  "external_id": "litellm-org:org_acme",
  "name": "Acme Corp (LiteLLM)",
  "email": "billing@acme.example"
}'
```

Email must be RFC-valid — underscores in the domain (e.g. `billing@org_acme.example`)
fail validation with a generic 400; use hyphens in the address even when the org id
itself contains underscores.

### 5.2 Meters

Seven meters from [`meters.json`](./litellm/meters.json) — three base (untagged input /
output tokens, passthrough cost) and four tag-scoped (planning in/out, skill, mcp):

```bash
jq -c '.[]' meters.json | while read -r m; do
  curl -sS -X POST "$FP/v1/meters" -H "x-api-key: $FP_KEY" -H 'Content-Type: application/json' -d "$m"
done
```

(`reset_usage: BILLING_PERIOD` so usage windows align with invoice periods; sum-of-field is
the meter aggregation form FlexPrice pushes down to ClickHouse. Meter `filters` are applied
automatically on the billing path; the raw usage API needs them passed explicitly — see 5.4.)

### 5.3 Plan, usage prices, subscription

Payloads: [`prices-plan.json`](./litellm/prices-plan.json). Order: create plan → create
prices with `entity_type: "PLAN"`, `type: "USAGE"`, `invoice_cadence: "ARREAR"`,
`meter_id` → subscribe the customer:

```bash
curl -sS -X POST "$FP/v1/subscriptions" -H "x-api-key: $FP_KEY" -H 'Content-Type: application/json' -d '{
  "customer_id": "<cust_id>", "plan_id": "<plan_id>",
  "currency": "USD", "billing_period": "MONTHLY", "start_date": "2026-11-01T00:00:00Z"
}'
```

Token prices use `billing_model: "PACKAGE"` with `transform_quantity.divide_by = 1000`
(amount = price per 1K tokens). The passthrough price uses `FLAT_FEE` (flat fee **per
unit**) with amount = margin multiplier (e.g. `1.10` = LiteLLM cost × 1.10), since 1 unit
of that meter = 1 USD. Sub-cent pass-through amounts round to `0.00` at currency
precision — verify the multiplier on a window with real spend.

Two ordering rules that silently zero out billing:

- **Prices carry a `start_date`; usage line items clip to `max(price start_date, period
  start)`.** Prices created *after* the usage you want to bill default to
  `start_date = now` and the window comes out empty. Create prices before traffic starts,
  or pass a backdated `start_date` when re-pricing history.
- **Invoiced usage reads the `meter_usage` rollup, not raw events.** The rollup is fed by
  the `meter_usage_tracking` Kafka consumer (`meter_usage_tracking.enabled: true` in
  FlexPrice config; the `POST /v1/subscriptions/usage` endpoint skips meters with no
  rollup rows). If that consumer is disabled, raw `POST /v1/events/usage/meter` still
  returns numbers while subscription usage and invoices show `0` — check
  `SELECT count() FROM meter_usage WHERE event_name = 'ai.usage'` before debugging
  prices. Events already ingested while the consumer was off can be re-fed by re-posting
  the same `event_id`s; both `events` and `meter_usage` dedup on id.

### 5.4 Verify usage & billing

```bash
# ingest the five sample events (idempotent — safe to run twice)
curl -sS -X POST "$FP/v1/events/bulk" -H "x-api-key: $FP_KEY" \
  -H 'Content-Type: application/json' -d "{\"events\": $(jq -sc '.' events-sample.jsonl)}"

# org totals for the sample window, per meter. NOTE: this raw usage endpoint does NOT
# apply the meter's own filters — only what you pass in `filters` (the billing path does
# apply meter filters automatically). Pass the meter's filter here to match the invoice.
curl -sS -X POST "$FP/v1/events/usage/meter" -H "x-api-key: $FP_KEY" -H 'Content-Type: application/json' -d '{
  "meter_id": "<METER_ID_INPUT_TOKENS>", "external_customer_id": "litellm-org:org_acme",
  "start_time": "2026-11-01T00:00:00Z", "end_time": "2026-11-02T00:00:00Z",
  "filters": {"tagged": ["false"]}
}'

# breakdown by team/model straight from the raw events (ad-hoc analytics)
curl -sS -X POST "$FP/v1/events/usage" -H "x-api-key: $FP_KEY" -H 'Content-Type: application/json' -d '{
  "event_name": "ai.usage", "aggregation_type": "SUM", "property_name": "input_tokens",
  "external_customer_id": "litellm-org:org_acme",
  "start_time": "2026-11-01T00:00:00Z", "end_time": "2026-11-02T00:00:00Z",
  "group_by": ["properties.raw_team", "properties.model"],
  "filters": {"tagged": ["false"]}
}'

# invoice preview against the live subscription
curl -sS -X POST "$FP/v1/subscriptions/usage" -H "x-api-key: $FP_KEY" -H 'Content-Type: application/json' -d '{
  "subscription_id": "<sub_id>", "start_time": "2026-11-01T00:00:00Z", "end_time": "2026-12-01T00:00:00Z"
}'
```

Expected with the sample data and `org_acme`: base input meter = 812 (only the untagged
call), planning meters = 1840/320, mcp/skill token meters = 330/720, passthrough = 0.0021.
`POST /v1/subscriptions/usage` over 2026-11-01 → 2026-12-01 charges exactly those
quantities: input 812→$0.50, output 150→$2.50, planning 1840→$1.60 / 320→$4.00, skill
720→$0.60, mcp 330→$0.60 (PACKAGE rounds each line up to a whole 1K package), pass-through
0.0021×1.10 → $0.00 at USD precision; invoice total $9.80.

## 6. Budget enforcement back into LiteLLM

No FlexPrice code required — FlexPrice already evaluates spend alerts on subscription
line items (`internal/ee/service/alert_settings*.go`, Temporal `usage_alert_workflow`) and
publishes `subscription.spend.threshold_reached` webhooks (`internal/webhook/dto/alert.go`,
payload `SpendAlertEvent`). Prerequisite: the evaluation pipeline is off by default — set
`usage_alerts.enabled: true` (`FLEXPRICE_USAGE_ALERTS_ENABLED`) and run the Temporal
worker; AND enable the tenant-level spend toggle, which fail-closes independently of
per-subscription alert settings:

```bash
curl -sS -X PUT "$FP/v1/settings/subscription_alert_config" -H "x-api-key: $FP_KEY" -H 'Content-Type: application/json' \
  -d '{"value": {"alert_enabled": true}}'
```

Without both, alert settings are stored but never fire. Verified live on the kind stack:
a fresh event past a threshold scheduled `UsageAlertWorkflow` (debounce ≈ `schedule_delay`)
and the webhook delivered `{"alert_type":"subscription_spend","alert_status":"in_alarm",
"current_spend":"9.8","threshold":"9.5","subscription":{...,"customer":{"external_id":
"litellm-org:org_acme", ...}}}` — exactly the shape `enforce-receiver.py` parses.
Two deployment shapes:

1. **Push (receiver):** run [`enforce-receiver.py`](./litellm/enforce-receiver.py) beside
   the proxy. It resolves the FlexPrice customer → `litellm-org:<id>`, lists that org's
   teams/keys via `/team/list` + `/key/list`, then on `warning` sets
   `max_budget = remaining` (`/key/update`, soft throttle) and on `in_alarm` either throttles
   to 0 (`ENFORCE_MODE=soft`) or blocks outright (`ENFORCE_MODE=hard`, `/key/block`).
   Every action is one JSON audit line on stdout.
2. **Pull (cron):** [`sync-budgets.sh`](./litellm/sync-budgets.sh) reconciles
   budget − spend into `max_budget` on every key of every org each run — no always-on
   service; enforcement lag = interval.

Wiring:

```bash
# alert settings on the org subscription (thresholds in USD)
curl -sS -X POST "$FP/v1/alerts/setting" -H "x-api-key: $FP_KEY" -H 'Content-Type: application/json' -d '{
  "entity_type": "subscription", "entity_id": "<sub_id>",
  "config": {
    "alert_enabled": true, "alert_threshold_type": "absolute",
    "info":     { "threshold": "400", "condition": "above" },
    "warning":  { "threshold": "450", "condition": "above" },
    "critical": { "threshold": "500", "condition": "above" }
  }
}'
```

(`condition` is `above`/`below` — `above` is mandatory for subscription spend alerts;
thresholds are absolute USD in the subscription currency.)

Webhook delivery target is static config per tenant (`webhook.tenants.<tenant_id>.endpoint`
+ headers in `internal/config/config.yaml`; there is no destinations CRUD API in OSS), so
point it at the receiver (or at your event bus that fans out to it). **Warn-only → soft →
hard** is the intended rollout: start with `ENFORCE_MODE=warn`, compare numbers for a full
billing period, then graduate. Receiver down degrades to advisory — alerts still fire in
FlexPrice; blocked keys are unblocked manually via `/key/unblock` (kept out of automation
on purpose).

## 7. Reconciliation

Weekly, per org, compare LiteLLM's own totals with FlexPrice's passthrough meter:

```bash
curl -sS -X POST "$LITELLM/global/spend/logs" -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"organization_ids": ["org_acme"], "start_date": "2026-11-01T00:00:00Z", "end_date": "2026-11-08T00:00:00Z"}' \
  | jq '[.[].spend // 0] | add'
# vs FlexPrice passthrough meter usage for the same window (Section 5.4)
```

A persistent delta usually means: dropped callback batches (recovered by Bridge B backfill),
requests logged without `request_id` (dedup falls back to time-based ids), or events
ingested into the wrong environment header.

## 8. Backfill & failure playbook

| Situation | Action |
|---|---|
| Bridge B missed windows / callback retry exhausted | Run `poll-spend-logs.sh` with `CURSOR_FILE` seeded to the gap start (LiteLLM spend logs retention applies). `event_id` dedup makes overlap safe. |
| FlexPrice ingest 4xx (validation) | Batch is rejected atomically — check `event_name`/`external_customer_id` presence; the poller keeps its cursor and retries the whole batch. |
| FlexPrice ingest 5xx / timeout | Callback retries 5× with exponential backoff; poller exits without advancing the cursor. |
| Wrong customer id mapping | Re-run `poll-spend-logs.sh` with corrected mapping (new `event_id`s are separate rows — remediation requires voiding/correcting invoices, not re-ingest). |
| LiteLLM log retention < gap | Historical backfill impossible through the proxy; document as accepted loss. |

## 9. Production checklist

- [ ] Secrets: `FLEXPRICE_API_KEY` (private key, env-scoped) and `LITELLM_MASTER_KEY` from secret manager / Helm `existingSecret`; nothing plaintext in values files; `.env` files are `chmod 600` and gitignored.
- [ ] One FlexPrice **environment** per LiteLLM deployment stage (prod keys ingest to prod env; set `FLEXPRICE_ENVIRONMENT_ID` on the bridge).
- [ ] Bridge A mounted via the proxy image (pinned LiteLLM version) or ConfigMap; Bridge B in a `CronJob` with `concurrencyPolicy: Forbid`.
- [ ] Monitored: bulk-ingest error rate, callback buffer drops (log lines), poller exit codes + cursor age, alert-webhook delivery failures (`/v1/webhooks/dashboard`).
- [ ] Meters/prices/plan match the tag list agreed with product (tag rename = config + optional backfill, see §1.2).
- [ ] First invoice cycle reviewed against LiteLLM spend UI before auto-charging (`auto_charge` off until reconciled, §7).
- [ ] Enforcement starts warn-only; soft/hard gated on 1 clean billing period (§6).
- [ ] `meter_usage_tracking` consumer enabled and consuming — invoices read the `meter_usage` rollup, not raw events (§5.3); an empty rollup bills $0 while usage APIs still show numbers.

## 10. Local verification (kind cluster)

End-to-end smoke without any provider API key: install the proxy against the
self-hosted stack's own postgres/redis and route one model to an in-cluster echo
server ([`llm-mock.yaml`](./litellm/llm-mock.yaml)). Helm values:
[`litellm-local-values.yaml`](./litellm/litellm-local-values.yaml) — the gotchas it
encodes: `db.deployStandalone: false` (the chart otherwise rolls an unmigrated
postgres and the proxy crash-loops on missing tables), the cross-namespace
FLEXPRICE_API_URL FQDN, and mounting the callback via chart `volumes`/`volumeMounts`.

```bash
# one-time: database + secrets + callback mount
kubectl -n flexprice exec statefulset/flexprice-postgresql -- \
  psql -U flexprice -d flexprice -c 'CREATE DATABASE litellm'
kubectl -n litellm create secret generic litellm-postgres \
  --from-literal=username=flexprice \
  --from-literal=password="$(kubectl -n flexprice get secret flexprice-postgresql -o jsonpath='{.data.password}' | base64 -d)"
kubectl -n litellm create configmap litellm-callback --from-file=flexprice_callback.py=docs/integrations/litellm/flexprice_callback.py
kubectl apply -f docs/integrations/litellm/llm-mock.yaml

helm upgrade --install litellm oci://ghcr.io/berriai/litellm-helm --version 1.109.1 \
  --namespace litellm --create-namespace --values litellm-local.yaml --wait

kubectl -n litellm port-forward svc/litellm 14000:4000 &
MK=$(kubectl -n litellm get secret litellm-masterkey -o jsonpath='{.data.masterkey}' | base64 -d)
```

Send traffic (batched bridge events flush ~10 s later; one extra request forces
the flush), then confirm the events in FlexPrice:

```bash
# tagged call -> bills on the tag meter; untagged -> base meters (§1.2)
curl -s http://localhost:14000/v1/chat/completions -H "Authorization: Bearer $MK" \
  -H 'Content-Type: application/json' \
  -d '{"model":"mock-gpt","messages":[{"role":"user","content":"hi"}],
       "litellm_metadata":{"tags":["planning"]}}'
sleep 12
curl -s http://localhost:14000/v1/chat/completions -H "Authorization: Bearer $MK" \
  -H 'Content-Type: application/json' \
  -d '{"model":"mock-gpt","messages":[{"role":"user","content":"flush"}]}' >/dev/null

curl -s -G http://api.flexprice.local/v1/events --resolve api.flexprice.local:80:127.0.0.1 \
  -H "x-api-key: $FP_KEY" -H "X-Environment-ID: $FP_ENV" \
  --data-urlencode "external_customer_id=litellm-org:unknown" \
  --data-urlencode "limit=5" | jq -r '.events[] | [.id, .properties.tagged, .properties.tag_planning] | @tsv'
```

Without virtual keys the billing entity is `litellm-org:unknown`; create an
org/key (`POST /organization/new`, `POST /key/generate` with `org_id`/`team_id`
and `max_budget`) to see real `user_api_key_org_id` resolution, and check
`GET /spend/logs/v2?request_tags=planning` for the proxy-side view of the same
calls.

To see the same usage in the UI: open `http://flexprice.local/auth` and **use the
Login tab** — Sign Up creates a brand-new tenant with none of this data. The seed
migration (`V1__seed.sql`) intentionally creates the default-tenant admin without
a password, so bootstrap one locally (dev only) by replacing the `auths` row's
token with a bcrypt hash — note this also retires any key stored in that row:

```bash
HASH=$(htpasswd -bnBC 10 "" 'flexprice123' | tr -d ':\n' | sed 's/^\$2y\$/\$2b\$/')
kubectl -n flexprice exec flexprice-postgresql-0 -- \
  env PGPASSWORD="$PG" psql -U flexprice -d flexprice \
  -c "UPDATE auths SET token='$HASH' WHERE user_id='00000000-0000-0000-0000-000000000000';"
```

Then sign in as `admin@flexprice.dev` / `flexprice123` (local dev credentials) and
pick the **Sandbox** environment. If the dashboard still 403s after login, the
seeded admin is missing its RBAC roles (older seed left `roles` empty) — grant:

```bash
kubectl -n flexprice exec flexprice-postgresql-0 -- env PGPASSWORD="$PG" \
  psql -U flexprice -d flexprice -c \
  "UPDATE users SET roles='[\"super_admin\"]' WHERE id='00000000-0000-0000-0000-000000000000';"
```

and log in again. Usage appears under **Meters → the LLM meter →
usage chart** (filter by the customer `litellm-org:<id>`; events sent without a
provisioned customer show under the meter but not on a customer page until the
customer exists).

## 11. One-shot org lifecycle script

[`setup-org-lifecycle.sh`](./litellm/setup-org-lifecycle.sh) walks the full
commercial loop for one organisation against a running stack, and is safe to
re-run (find-or-create everywhere; deterministic `event_id`s; a fixed
`idempotency_key` guards the top-up):

| Step | What it does | API |
|---|---|---|
| 1 | customer `litellm-org:<ORG_ID>` (find or create) | `POST /v1/customers` |
| 2 | USD prepaid wallet, 1 USD = 1 credit (find or create) | `GET /v1/customers/:id/wallets`, `POST /v1/wallets` |
| 3 | fixed-amount `once` coupon (find or create) | `GET /v1/coupons/code/:code`, `POST /v1/coupons` |
| 4 | top-up N credits **with the coupon** → pending ONE_OFF invoice (subtotal − discount = due) | `POST /v1/wallets/:id/top-up` |
| 5 | settle the invoice offline; pending credits become spendable | `PUT /v1/invoices/:id/payment` `{"payment_status":"SUCCEEDED"}` |
| 6 | push sample `ai.usage` events (untagged + `planning` + `skill`) | `POST /v1/events/bulk` |
| 7 | usage check per meter | `POST /v1/events/usage/meter` |

```bash
FLEXPRICE_API_KEY=<local private key> \
ORG_ID=org_scripted COUPON_CODE=script25 COUPON_OFF=25 CREDITS_TO_TOPUP=100 \
TOPUP_IDEM=org-scripted-topup-100a \
./litellm/setup-org-lifecycle.sh
# verified output: invoice "subtotal 100 - discount 25 = due 75", balance 100,
# usage queryable ~1 min later (step 7 shows 0 if run immediately — consumer lag).
# Re-run with the same TOPUP_IDEM: coupon already spent -> coupon-less top-up,
# existing invoice resolved by idempotency key, events deduped — nothing doubles.
```

Gotchas the script encodes: `GET /v1/wallets/customer/{id}` is **not** mounted
— use `GET /v1/customers/{id}/wallets` (plain array); `payment_status` on an
invoice is PENDING → SUCCEEDED; credits are only spendable after the top-up
invoice settles; step 7's raw aggregation sums all events (meter tag filters
apply in the rollup/billing path, and `meter-usage/query` can lag for a
just-created customer).

**Wallet balance semantics** — "current" vs "ongoing":

- *Current balance* = `GET /v1/wallets/:id/balance/real-time` — settled ledger
  value. Moves on paid top-ups (+) and invoice **finalization** (−). Nothing
  happens to it when events are ingested.
- *Ongoing (accrued) usage* = unbilled meter usage in the open period; an
  estimate shown by `POST /v1/invoices/preview {"subscription_id":...}`. It
  becomes a wallet debit only when the usage invoice finalizes — at period end
  (Temporal billing workflow) or immediately via
  `POST /v1/subscriptions/:id/cancel` with
  `{"cancellation_type":"immediate","cancel_immediately_invoice_policy":"generate_invoice"}`.
- Effective spendable ≈ current − accrued. Surface it either from the preview
  call or from wallet low-balance/usage alerts; don't maintain a parallel
  running total outside FlexPrice.

**Multiple plans per customer**: one subscription = exactly one base plan, plus
`addons: [{"addon_id": ...}]` (plans of `plan_type: ADD_ON`) and ad-hoc
`line_items` — all on the same invoice, debiting the same wallet. For fully
independent billing cycles/invoices, attach several subscriptions to the same
`customer_id` with different `plan_id`s (each cancels/bills on its own anchor).

## Files in this directory

| File | Role |
|---|---|
| [`litellm-config.yaml`](./litellm/litellm-config.yaml) | proxy config with the callback registered |
| [`flexprice_callback.py`](./litellm/flexprice_callback.py) | Bridge A — LiteLLM `CustomLogger` → `/v1/events/bulk` |
| [`poll-spend-logs.sh`](./litellm/poll-spend-logs.sh) | Bridge B — `/spend/logs/v2` poller → `/v1/events/bulk` |
| [`meters.json`](./litellm/meters.json) | the seven meters (POST /v1/meters payloads) |
| [`prices-plan.json`](./litellm/prices-plan.json) | plan + usage prices (POST /v1/plans, /v1/prices) |
| [`events-sample.jsonl`](./litellm/events-sample.jsonl) | five sample events incl. every tag case |
| [`enforce-receiver.py`](./litellm/enforce-receiver.py) | alert webhook → `/key/update` / `/key/block` |
| [`sync-budgets.sh`](./litellm/sync-budgets.sh) | pull-sync budget reconciliation alternative |
| [`litellm-local-values.yaml`](./litellm/litellm-local-values.yaml) | Helm values for the §10 local kind verification |
| [`llm-mock.yaml`](./litellm/llm-mock.yaml) | in-cluster echo "model" (pod+svc) so the smoke needs no provider key |
| [`setup-org-lifecycle.sh`](./litellm/setup-org-lifecycle.sh) | §11 one-shot rerunnable customer→wallet→coupon top-up→usage lifecycle |

These are **examples**, not part of the FlexPrice build/test surface; adapt ids/amounts
before applying.
