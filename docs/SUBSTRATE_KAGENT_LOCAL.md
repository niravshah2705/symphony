# kagent on Substrate in the local kind cluster — what gates it, and how one run gets billed

Measured on `kind-flexprice-local` on 2026-11-20, end to end: an agent executed as a
Substrate actor for 173 s, its duration showed up in Prometheus under the Fleet tags,
and the same 173 s landed in FlexPrice as an event and read back off the meter.

Read [`SUBSTRATE_METRICS.md`](./SUBSTRATE_METRICS.md) first — the metric naming
contract (§3 there) and the "tenancy lives in datapoint attributes" finding (§4) are
why §4 below looks the way it does. This file covers the cluster gates that file could
not: it predates kagent being installed on top of Substrate.

Nothing here is inferred from what a kind cluster usually ships. Every line was the
actual blocker or the actual measured value at the time of the run.

## 1. The four gates between "kagent installed" and "agent Ready"

Installed kagent 1.0.0 controller + UI + tools + `WorkerPool/kagent-default` onto a
Substrate 1.0.1 control plane. The WorkerPool registered a gVisor worker immediately;
nothing else worked. In the order the failures appeared:

### 1a. 🔴 `dial ate-api "dns:///api.ate-system.svc:443": context deadline exceeded`

A TCP **timeout**, not a refusal — so the diagnosis is NetworkPolicy, not SPIFFE.
`NetworkPolicy/ate-system/ate-api-server` admits 443 from exactly two sets: ate-system
control-plane pods, and pods in a namespace labelled `ate.dev/api-access: "true"`
(worker pods excluded via `ate.dev/worker-pool DoesNotExist`). No namespace in the
cluster carried the label, so only Substrate's own components could reach its API.

```bash
kubectl label ns kagent      ate.dev/api-access=true
kubectl label ns <org-ns>    ate.dev/api-access=true   # every caller namespace
```

This is the intended knob (the chart comment names "benchmarks, dashboards"), but
nothing in the kagent install instructions mentions it, and a caller namespace added
later silently lands behind the same wall.

### 1b. 🔴 `permission denied for table session_task_event (SQLSTATE 42501)`

The controller's migration ran fine, then the app could not read its own tables.
Migration runs as `kagent_owner` (via `SET ROLE`), the app connects as
`kagent_readwrite_user`, and **nothing grants across that pair** — the bundled
`substrate-podcert` chart authenticates the DB clients but does not create table
privileges. So the schema needs the grants explicitly (`USAGE`, DML on tables,
`USAGE`/`SELECT` on sequences) *plus* `ALTER DEFAULT PRIVILEGES FOR ROLE kagent_owner`,
or the next migration reintroduces the same failure.

### 1c. 🔴 `PermissionDenied: principal "user:spiffe%3A//…/ns/kagent/sa/kagent-controller" lacks "can_get" on "actor_template:<ns>/<name>"`

The mTLS handshake now succeeded and Substrate knew who was calling; it just had no
rights. `ateApi.authorization.bootstrapOwners` defaults to the release's shared
`ate-client` principal, so an external controller is authenticated and unauthorized at
the same time. Three values, all on the **parent** `substrate` release:

| Value | Effect |
|---|---|
| `ateApi.authorization.bootstrapOwners` | kagent-controller may own the atespaces it drives |
| `atenetRouter.ingressAllowedSPIFFEIDs` | empty **denies all** ingress to actors |
| `credentialProvider.namespacePolicies` | maps caller namespace → atespace for per-org secrets |

After this the API log shows `CreateAtespace org-nirav` returning 200 — tenancy, not
just permission.

### 1d. 🔴 `InvalidArgument: [actor_template.snapshot_config.storage_location: Forbidden, actor_template.golden_egress_policy: Forbidden]`

kagent always sends both fields, and both sit behind preview gates. The kagent release
export knows this — `preview: [PerTemplateSnapshotLocation, GoldenEgressPolicy]` is in
its values — but the field is invisible until the ActorTemplate is rejected. With the
gates on, the agent goes `Ready: ActorTemplate golden snapshot is ready`.

### 1e. Two ways this install loses time without losing data

- **Do not split `substrate-podcert` / `substrate-atelet` out of the parent release on
  an existing cluster.** The kagent export ships them as separate OCI charts, but the
  running release already owns those objects, and Helm refuses rather than adopts:
  `ResourceQuota "atelet-critical-pods" … cannot be imported into the current release:
  current value is "substrate"`. Patch the parent release instead. (Export also pins
  1.0.0 while the cluster ran 1.0.1 — the split would have been a downgrade too.)
- **`helm upgrade … | tail` hides a failed release.** The adoption errors above
  surfaced as `STATUS: failed` while the pipeline exited 0. Check `helm list` /
  `helm status`, never the exit code.

## 2. The objects an org actually needs

`kagent.io`-style tenancy is not one resource. What made
`Agent/org-nirav/org-nirav-worker` runnable:

| Object | Notes decided by validation errors |
|---|---|
| `Secret litellm-org-nirav` | the org's LiteLLM **team** key; see §5 of [`LLM_GATEWAY.md`](./LLM_GATEWAY.md) for why a team id and not an org id carries tenancy |
| `ModelConfig litellm-mock` | `openAI.baseUrl` → LiteLLM `/v1`, `provider: OpenAI`, key from the secret in the **same** namespace |
| `WorkerPool org-nirav` | `ActorTemplate` placement pins `kagent.dev/worker-pool-{name,namespace}`, so a cross-namespace pool never matches |
| `Harness default` (in the org ns) | `substrate.workerPoolRef` is namespace-local, **and** `spec.substrate.snapshotPolicy.location` is required (`gs://ate-snapshots/` — the S3 backend uses `gs://` URIs too) |
| `Agent` (in the org ns) | `spec.harnessRef` is required and resolves **in the Agent's own namespace**; a harness in `kagent` reads as `not found` |
| atespace `org-nirav` | created by Substrate itself once §1c is in place — not a cluster object you apply |

Driving it over MCP (`http://kagent-controller.kagent.svc:8083/mcp`, the same server
registered as `RemoteMCPServer/kagent-api`) rather than by hand in the UI:
`create_session` wants `agent` as an **object** `{name,namespace}` and returns a plain
string `session_id`, which `invoke_agent` then takes as a **string**. Both shapes are
rejected with a type error that reads like a schema bug.

## 3. The run

```
session  01a1f643-edb3-721f-a3fc-43748e57605a   (Agent org-nirav/org-nirav-worker)
window   2026-11-20T00:03:27Z → 00:06:20Z   10 turns, last SuspendActor at the end
model    mock-gpt via LiteLLM under team org_nirav
```

173 s comes from the session window bounded by Substrate's own
`Control/SuspendActor` log line, not from the wall clock of the loop. The tier label
`standard-1v1g` is corroborated rather than asserted: the compiled ActorTemplate
carried `resources.limits {cpu_millicores: 1000, memory_bytes: 1073741824}`.

## 4. Prometheus — the series that came out

The orchestrator is not deployed in this cluster, so the emitter was called directly:
`createActorMetrics()` from `packages/shared-core/src/otel/actor-metrics.js`, pointed at
the collector's OTLP HTTP endpoint, fed one RUNNING heartbeat at the measured stop and
one CLOSED datapoint. Same module the runner uses — the numbers are measured, the
process is not the production one.

```
substrate_actor_running_seconds_total{fleet_org_id="org_nirav",substrate_tier="standard-1v1g",
    agent_id="org-nirav-worker",project_id="kagent:metering-demo",user_id="nirav"} 173
substrate_actor_first_seen_timestamp_seconds{…same tags…} 1795133007
substrate_actor_start_timestamp_seconds{…} 0     # 0 by contract once status=CLOSED
```

`sum by (fleet_org_id,substrate_tier,agent_id)(substrate_actor_running_seconds_total{fleet_org_id="org_nirav"})`
answers 173, which is the query the sweeper and the savings panel use.

## 5. FlexPrice — event-based ingest, no integration code

The meter did not exist in this stack (`scripts/flexprice-provision.js` has never been
run against it), so it was created to the spec in `billing-outbox.js` `METERS`:

```json
{"name":"actor-compute","event_name":"fleet.actor_compute",
 "aggregation":{"type":"SUM","field":"duration_seconds"},
 "reset_usage":"BILLING_PERIOD","filters":[{"key":"org_id","values":["org_nirav"]}]}
```

`aggregation` is a nested object with an upper-case `type` — a flat
`aggregation_type`/`aggregation_property` pair returns `validation_error`. Filters use
the **bare** property name (`org_id`, not `properties.org_id`).

The event body is `billing-outbox.toEvent()`'s output verbatim, produced by running the
real module against a temporary file store — `event_id` included, because that key is
the delivery identity and is never hand-written:

```json
{"event_id":"ev:org_nirav:01a1f643-edb3-721f-a3fc-43748e57605a:actor-compute",
 "event_name":"fleet.actor_compute","external_customer_id":"litellm-org:org_nirav",
 "timestamp":"2026-11-20T00:03:27.000Z",
 "properties":{"duration_seconds":173,"org_id":"org_nirav","tier":"standard-1v1g",
               "agent_id":"org-nirav-worker","project_id":"kagent:metering-demo","user_id":"nirav"},
 "source":"ai-fleet-outbox"}
```

`POST /v1/events/bulk` → 202, which per
[`FLEXPRICE_FINDINGS.md`](./FLEXPRICE_FINDINGS.md) §3 proves nothing, so the read-back
is the result:

| Read | Value |
|---|---|
| `/v1/events/usage` SUM `duration_seconds`, customer `litellm-org:org_nirav` | **173** |
| same batch re-POSTed unchanged (blind retry) | **173** — deduped upstream, not double-billed |
| `/v1/events/usage` SUM `total_tokens` on `ai.usage`, same org | **1815** |
| wallet `wallet_01M7V11T8NKQYG932MKE1X8FA5` balance | 100 inr — **unchanged, by design** |

Two traps in the read-back, both consistent with the findings doc: `/v1/events/usage`
silently answers `{"type":"COUNT","value":1}` unless `property_name` is sent alongside
`aggregation_type`, and a `meter_id` on that route is dropped by the binder. And the
balance not moving is the documented money semantics — consumption debits when an
invoice finalizes, never at ingest, which is what keeps the gate from double-counting.

## 6. What this run does *not* prove

Stated because each item reads as success otherwise:

1. **Not the production path.** `recordActorUsage` → outbox → `outbox-drain` never ran
   as a pipeline; there is no orchestrator here. The metrics and the event were emitted
   by the real modules, called by hand, with a measured window.
2. **`external_customer_id` diverges from the contract.** [`BILLING_FLEXPRICE.md`](./BILLING_FLEXPRICE.md)
   §1 says `customer.external_id == org_id`. The LiteLLM callback convention prefixes
   with `litellm-org:`, and this stack has one customer per org under that prefix — so
   the id was rewritten at send time while `properties.org_id` stayed `org_nirav` for
   the meter filter. Reconciling the two spellings is open work, not a solved thing.
3. **No price was attached** to `actor-compute`, so nothing is invoiceable and the
   wallet cannot move. D4 also holds the actor rate at 0, so a demo rate here is not a
   product decision.
4. **kagent's own model calls bill through LiteLLM's callback**, not through Fleet's
   `llm-cost` meter. One run therefore produced two independent event streams; which
   one is authoritative for an org's LLM spend is still the question
   [`BILLING_FLEXPRICE.md`](./BILLING_FLEXPRICE.md) §2 poses.
5. **Single node, single tenant, no egress isolation.** The actor reached LiteLLM
   directly; the egress-proxy and per-org-secret paths were not exercised.

## 7. Reproducing it

```bash
kubectl config use-context kind-flexprice-local
kubectl -n litellm       port-forward svc/litellm 14000:4000 &
kubectl -n otel-system   port-forward svc/prometheus 19090:9090 &
kubectl -n otel-system   port-forward svc/opentelemetry-collector 14318:4318 &
kubectl -n kagent        port-forward svc/kagent-controller 18083:8083 &

# §1 gates (idempotent), then §2 objects, then the run over MCP:
curl -s -X POST http://127.0.0.1:18083/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_session",
       "arguments":{"agent":{"name":"org-nirav-worker","namespace":"org-nirav"},
                    "message":"Job 1"}}}'

# then: emit the measured window through otel/actor-metrics.js, and post the
# billing-outbox.toEvent() body to /v1/events/bulk (read it back with property_name).
```

No credential appears in this file. The FlexPrice key lives in the LiteLLM
Deployment's env and `deploy/flexprice/.env`; the org's LiteLLM key lives only in
`Secret/org-nirav/litellm-org-nirav`.
