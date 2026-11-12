# Substrate actor metrics — what the local cluster actually has

Measured on `kind-kind` on 2026-11-12. Every "verified" line below was produced by
`scripts/kind-otel-roundtrip.sh` or the `kubectl`/Prometheus queries quoted with
it; nothing here is inferred from what a kind cluster usually ships.

Read this before writing any code that bills actor compute. Two of the findings
below silently produce *no data* rather than an error, which is the worst failure
mode a billing pipeline can have.

## 0. Answers by plan item

The Phase 0 plan asked seven cluster questions (items 21–27). Where each is answered:

| Item | Question, compressed | Answer lives in | Status |
|---|---|---|---|
| 21 | What is in `otel-system`, and does the collector have a metrics pipeline | §1, §2, §3 | ✅ inventoried from the live ConfigMaps |
| 22 | Is node-exporter / KSM / cAdvisor / OpenCost installed, and what do we add | §6 | ✅ none installed; we add nothing for billing, and each skip is a decision |
| 23 | Is the kubelet's embedded cAdvisor (`:10250`) scrapable here | §6a | ✅ measured: TCP yes, endpoint serves data, **RBAC is the only gate** |
| 24 | Do the `ate*` components already publish actor cost we should read | §5 | ✅ they publish per-atespace CPU/mem, which cannot answer project/user — oracle, not emitter |
| 25 | What labels do actor CRDs carry; do actors surface as pods | §5 ("Why the pod-metrics route is closed") | ✅ no `actors.ate.dev` CRD exists in this deployment at all |
| 26 | Prove an orphaned session accrues, then gets swept | §7 for the query half, §8 for the rest | 🔶 query half proven; the kill-the-planner half needs the Phase 1 emitter |
| 27 | Tier name and its ₹/hour | §8 | 🔶 `standard-1v1g` chosen; the rate is operator input |

**Item 24 is the plan's re-plan trigger** ("if ate-system already publishes actor
cost we should read instead of computing"). It does not: the series it publishes are
cgroup CPU/mem per atespace and control-plane call latency, there is no per-actor or
per-run label anywhere in them (§5), and cost is not computed there at all. So the
duration-based model in the plan stands, and `ate_actor_stats_*` moves to the
reconciliation seat that LiteLLM occupies in `reconcile-gateway-spend.js`.

## 1. Cluster identity

| | |
|---|---|
| Context | `kind-kind` (current) |
| Nodes | one: `kind-control-plane`, `172.20.0.2`, Kubernetes v1.37.0, containerd 2.3.4, linuxkit/arm64 |
| Substrate namespaces | `ate-system` (control plane), `ate-demo-sandbox` (worker pool), `ate-demo-counter` (second pool) |
| Telemetry namespace | `otel-system`: `prometheus`, `opentelemetry-collector`, `jaeger` |
| Other contexts available | three GKE clusters (`substrate-multitenant`, `my-gke-dev-cluster`, `autopilot-cluster-1`) — not used by this document |

Single node means there is no per-node pool pricing dimension locally, so nothing
here will tell you whether a rate that varies by machine type is applied
correctly. That has to be settled on the GKE side (the tainted `substrate_nodes`
pool in `deploy/gcp/terraform-substrate-gke/substrate.tf`).

## 2. Already installed, digest-pinned, and reusable

Both telemetry components are pinned by digest in their pod specs, so the stack
this document describes is reproducible:

```
prom/prometheus:v3.15.1@sha256:fa330227…                 args: --config.file=/etc/prometheus/prometheus.yml
otel/opentelemetry-collector-contrib:0.163.2@sha256:7f22d2a6…
```

Prometheus is a plain `Deployment` + `ConfigMap` (`otel-system/prometheus-config`),
**not** kube-prometheus-stack. That matters operationally: the scrape config is
one YAML blob we can patch in-tree rather than values spread across Helm
templates and CRDs.

Two scrape jobs, both fully healthy at measurement time (all 6 targets `up=1`):

| Job | Targets | Scope |
|---|---|---|
| `kubernetes-pods` | 4 pods on `:9090` | `kubernetes_sd` limited to namespaces **`ate-system` and `otel-system`**, kept by `prometheus.io/scrape: "true"` pod annotation |
| `otel-collector-self` | `:8889` and `:8888` | the collector's own read ports |

**Anything we want scraped must either carry the `prometheus.io/scrape`
annotation on a port and live in one of those two namespaces, or the ConfigMap
must be extended.** A new namespace is invisible to this Prometheus.

The collector runs traces (→ Jaeger), metrics (→ its own Prometheus exporter on
`:8889`) and logs pipelines, plus three `count` connectors that produce
`substrate_spans_total`, `substrate_datapoints_total` and
`substrate_actor_state_changes_total`.

## 3. 🔴 Finding: metric names are a hard contract (verified)

The `otel-collector-self` job ends with:

```yaml
metric_relabel_configs:
  - source_labels: [__name__]
    action: keep
    regex: (substrate|otelcol)_.*
```

Prometheus anchors a `keep` regex completely (implicit `^…$`). So a metric pushed
to the collector whose name does not begin with `substrate_` or `otelcol_` is
**accepted** — the OTLP write returns `HTTP 200`, it even increments
`substrate_datapoints_total`, proving the collector received and processed it —
and then **discarded at scrape time**. No error, no rejected-write response, no
absent-target alert. The series simply never exists.

Verified by pushing both spellings of the same gauge:

```
[1] push agent_substrate_* (the name the reference cost formula uses) -> HTTP 200
[2] push substrate_actor_start_timestamp_seconds                      -> HTTP 200
  collector accepted our datapoints (substrate_datapoints_total) 4
  agent_substrate_start_timestamp_seconds visible in prometheus  NO - dropped at scrape time
  substrate_actor_start_timestamp_seconds visible in prometheus  YES
  naming contract: actor-session metrics MUST be named substrate_* (or otelcol_*)
```

**Consequence:** actor session metrics are named `substrate_actor_*`, not the
`agent_substrate_*` of the reference design. The names are frozen as constants in
`packages/shared-core/src/billing/substrate-session.js` (`ACTOR_SESSION_METRICS`)
and a unit test asserts every one matches `/^(substrate|otelcol)_/`, so a future
rename cannot reintroduce this. The existing `substrate_actor_state_changes_total`
from the count connector shows the house convention already goes the same way.

## 4. 🟠 Finding: `service.name` does not become a `service_name` label (verified)

The collector's Prometheus exporter maps the OTel **resource** attribute
`service.name` to a `job` label. Prometheus then overwrites `job` with the scrape
job's own name and renames the original to `exported_job`. So:

```
substrate_actor_start_timestamp_seconds{
  agent_id="probe-1", fleet_org_id="org-probe", substrate_tier="standard-1v1g",
  exported_job="fleet-billing-probe",        # <- what service.name turned into
  job="otel-collector-self",                 # <- the scrape job won
  otel_scope_name="fleet.probe", pod="opentelemetry-collector-…", instance="10.244.0.16:8889"
}
```

Only the `count` connector's series carry `service_name`, because that connector
sets it as a datapoint **attribute** rather than a resource attribute.

**Consequence:** a query of the form `{service_name="…"}` against a metric we push
returns zero rows and looks exactly like "the emitter is broken". Carry tenancy in
**datapoint attributes** (`fleet_org_id`, `substrate_tier`, `agent_id`) and filter
on those. This is also why org attribution must be an explicit attribute: nothing
in the resource→label path will do it for us.

## 5. What the substrate control plane already publishes (do not re-emit)

159 series names exist in this Prometheus. The relevant ones, all from
`atelet` / `ate-api-server` / `atenet-router` on `:9090`:

| Metric | Kind | Labels that matter | Use |
|---|---|---|---|
| `ate_actor_stats_cpu_time_seconds_total` | counter | `ate_template_atespace`, `ate_template_name`, `ate_workerpool_name`, `ate_sandbox_class=gvisor`, `ate_stats_source=cgroup` | measured CPU **per atespace**, from cgroups |
| `ate_actor_stats_memory_working_set_bytes` | gauge | same | live working set per atespace |
| `ate_actor_stats_sampled_actors` | gauge | same | how many actors the row aggregates over |
| `ate_actor_lifecycle_operation_duration_seconds` | histogram | `ate_actor_operation_name` (create/resume/delete/…), `error_type` | control-plane call latency, **not** running time |
| `ate_actor_checkpoint_duration_seconds`, `ate_actor_restore_duration_seconds` | histogram | template | snapshot cost |
| `ate_workerpool_workers` | gauge | `ate_worker_state` (idle/partial/at_capacity/unschedulable) | capacity, for the savings panel |
| `substrate_actor_state_changes_total` | counter | `ate.actor.state` | actor state transitions — **0 series, see below** |

Observed values at measurement time:

```
sum by (ate_template_atespace) (increase(ate_actor_stats_cpu_time_seconds_total[24h]))
  ate-demo-counter  = 18.3 cpu-sec/24h
  ate-demo-sandbox  = 13.7 cpu-sec/24h
```

### The granularity limit that decides the design

`ate_actor_stats_*` is aggregated **per ActorTemplate/atespace**, not per actor:
`count(ate_actor_stats_cpu_time_seconds_total)` is 2, while
`ate_actor_stats_sampled_actors` is 1 — one series covering however many actors
ran in that atespace. There is no `actor_id` label and no per-run series.

So measured CPU can attribute spend to an **org** (atespace ⇒ org), but it cannot
answer "which project, which user, which run". The usage dashboard requires both,
so:

- **session duration + org/project/user attribution → the runner.** It is the only
  place all four are known together, and `substrate-runner.js` already performs
  create→resume→prompt→suspend→delete with a `finally` block, so the STOP side of
  the state machine exists in-process today (it records no duration yet).
- **`ate_actor_stats_*` → the reconciliation oracle.** Same role LiteLLM plays in
  `reconcile-gateway-spend.js`: evidence that a billed session is implausible
  (org charged for 3 hours, atespace burned 18 CPU-seconds) or that CPU was burnt
  with no session claiming it. Never an emitter — emitting from both would
  double-bill.

### Why the "read it from pod metrics instead" route is closed

Actors are **not Kubernetes objects** in this deployment:

```
$ kubectl get crd | grep ate.dev
csidriverconfigs.ate.dev   Cluster
sandboxconfigs.ate.dev     Cluster
workerpools.ate.dev        Namespaced
$ kubectl get actors.ate.dev -A
error: the server doesn't have a resource type "actors"
```

The only pods are the long-lived `WorkerPool` replicas
(`ate-demo-sandbox/sandbox-workerpool-*`, 2/2 Ready). Actors are records in the
`ate-system` Postgres, driven over gRPC against `substrate.ateapi.v1.Control` —
which is why `substrate.js` can report only `state, workerPod, workerPool,
nodeName` for an actor. There is no pod, so there are no pod labels to invent.

## 6. Deliberately not installed (this is a decision, not an oversight)

Confirmed absent — the Prometheus target list holds exactly the 6 targets of §2,
and there are **no** `container_*`, `kube_*`, `node_*` or `cadvisor_*` series:

| Component | Status | Why |
|---|---|---|
| node-exporter | **skipped** | node-level CPU/RAM is not a billing input for a duration × tier model |
| kube-state-metrics | **skipped** | would be needed for pod-lifecycle attribution; actors are not pods (§5) |
| cAdvisor (standalone) | **skipped** | `ate_actor_stats_*` already gives gVisor-internal CPU/mem from cgroups, which is closer to what an actor actually used than cadvisor's pod view |
| OpenCost | **skipped** | its model is shared-infrastructure cost allocation; the actor model is per-session duration |
| kubelet `/metrics/cadvisor` (`:10250`) | **not scraped; reachable, RBAC-gated** | no target exists for it, and its SA may not `get nodes/proxy` — see §6a for the measurement. Not required by the chosen model, so the grant is not made |

**If the requirement changes to "bill measured cpu/mem-hours", this section is the
restart point**: that model needs kube-state-metrics (or the kubelet endpoint)
scraped, and it still will not give per-project or per-user attribution, so the
runner stays in the loop regardless.

## 6a. Item 23, measured: the kubelet cAdvisor endpoint is reachable and unauthorized

The row above said "not scraped, untested". Tested 2026-11-12, four commands:

| Check | Command | Result |
|---|---|---|
| Does the endpoint serve data? | `kubectl get --raw /api/v1/nodes/kind-control-plane/proxy/metrics/cadvisor` | **yes** — `cadvisor_version_info{kernelVersion="7.0.12-linuxkit",…}` and the `container_*` families |
| Can the in-cluster Prometheus use it? | `kubectl auth can-i get nodes/proxy --as=system:serviceaccount:otel-system:prometheus` | **no** — RBAC denies it |
| Is the node port routable from a pod? | `nc -vz -w3 172.20.0.2 10250` from `deploy/prometheus` | **open** — TCP connects |
| Does the pod's own HTTP client work against it? | `wget --no-check-certificate https://…:10250/metrics/cadvisor` | reset — and this is *not* a network verdict |

So: the signal is there, the network path is there, and **the only gate is RBAC**. The
last row is a client artifact — that image's `wget` is BusyBox 1.38, which is not
negotiating the kubelet's TLS here, so a reset from it says nothing about whether a
real Prometheus scrape config would succeed. Do not read it as "blocked".

What turning it on would actually cost: a ClusterRole granting `get` on
`nodes/proxy`, a binding for `system:serviceaccount:otel-system:prometheus`, and a
job that scrapes the **apiserver proxy URL** rather than the node IP (that is the
route the RBAC governs; the node IP needs its own bearer token and CA instead). Not
free, and bought for a model we are not billing on — which is why it stays uninstalled
with this measurement attached instead of either "untested" or a speculative yes.

## 7. The one gap in the reference formula, and where it stands

`substrate_actor_state_changes_total` exists as a connector but has **0 series** —
nothing is emitting actor state-change logs into the collector yet. The pipeline
is plumbed and waiting; the emitter is the missing piece, and it is ours to write.

Also missing, and genuinely not obtainable from what exists: the moment an actor
started. `ate_actor_lifecycle_operation_duration_seconds` measures how long the
*create/resume calls* took, not how long the actor ran. So the timestamp gauge in
the reference formula must be published by us, which is exactly what
`substrate_actor_start_timestamp_seconds` is for.

The reference accrual query, run against the probe series (§3), works as designed
once the metric is named correctly and the rate is excluded:

```
(time() - max by (substrate_tier,fleet_org_id) (substrate_actor_start_timestamp_seconds{fleet_org_id="org-probe"} > 0))
  {"fleet_org_id":"org-probe","substrate_tier":"standard-1v1g"} accrued_sec = 22.9
```

**The rate is deliberately not a metric.** The reference design carried
`substrate_hourly_rate` as a Prometheus series joined with
`group_left()`. That would put a price in Prometheus, in Node and in FlexPrice
simultaneously — three copies of one truth, and a price change would need a
cluster redeploy. Rates live in the FlexPrice price catalog; Prometheus supplies
duration only. So `agent_substrate_completed_cost_total` never exists as a metric
either: completed cost is what FlexPrice says it is.

## 8. Open

| # | Item | Blocker |
|---|---|---|
| 26 | Prove an orphaned session accrues and is then swept | needs the real emitter from Phase 1; the probe proves the *query* half works, not that a killed planner leaves the series stale in the way `settleOrphans` assumes |
| 27 | The ₹/hour for `standard-1v1g`, and where it is edited | operator input; `priceActorUsage` throws rather than defaulting, so nothing mis-bills while this is open |
| — | Per-tenant atespace ⇒ org mapping for the **shared** stack | `ate_template_atespace` values seen here are demo pools (`ate-demo-sandbox`, `ate-demo-counter`). Whether a shared-stack atespace name is derived from `org_id` deterministically is unverified, and without it the reconciliation oracle cannot attribute CPU to an org at all |

## 9. Re-verifying

```bash
./scripts/kind-otel-roundtrip.sh        # KUBE_CONTEXT=… to point elsewhere
```

Read-only except for one synthetic OTLP datapoint per run, written under
`fleet_org_id=org-probe`; no product code path emits that label, so its series can
be ignored or deleted without affecting anything real.
