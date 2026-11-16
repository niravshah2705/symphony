# `deploy/flexprice/kind` — the telemetry contract actor billing stands on

This directory exists because actor-session billing reads Prometheus, and
Prometheus in this cluster is **not** something we deploy: `otel-system` already
ran `prometheus`, `opentelemetry-collector` and `jaeger` before any billing code
was written. The finding in [`docs/SUBSTRATE_METRICS.md`](../../../docs/SUBSTRATE_METRICS.md)
is that we need to install **nothing** for the duration-based model — but two
filters in that pre-existing config decide whether a billing metric exists at
all, and both fail silently. So this directory holds copies of those two configs
plus a guard, rather than new workloads.

```bash
scripts/kind-metrics-install.sh            # verify the contracts, change nothing
scripts/kind-metrics-install.sh --report   # what is installed, and what we skipped on purpose
scripts/kind-metrics-install.sh --dry-run  # verify, then rehearse --apply without mutating
scripts/kind-metrics-install.sh --snapshot # rewrite the in-tree copies from the cluster
scripts/kind-metrics-install.sh --apply    # push the in-tree copies and roll the pods
```

## The two files here

| File | What it is |
|---|---|
| `prometheus-configmap.yaml` | live copy of `otel-system/prometheus-config` — the scrape jobs |
| `otel-collector-configmap.yaml` | live copy of `otel-system/opentelemetry-collector-config` — pipelines + count connectors |
| `kustomization.yaml` | the two above, for `--apply` |

They are **generated, not maintained**: capture them with `--snapshot`. The
default mode fails when the cluster and these copies disagree, which is the point
— a hand-patched cluster and a repo that says something different is how a
billing metric goes missing with every test still green. If another tree owns the
real source of these (the collector config's comments reference
`benchmarking/telemetry/meter.yaml`, which is not in this worktree), then
`--snapshot` after changing it there, and commit the result.

## Contract 1 — metric names are load-bearing

`otel-collector-self` ends with:

```yaml
metric_relabel_configs:
  - source_labels: [__name__]
    action: keep
    regex: (substrate|otelcol)_.*
```

Prometheus anchors a `keep` regex completely. A metric named
`agent_substrate_start_timestamp_seconds` is therefore **accepted** over OTLP —
`HTTP 200`, and it increments `substrate_datapoints_total`, so the collector
proves it got the data — and then discarded when Prometheus scrapes. No error is
returned to the writer and no target goes unhealthy. The series just does not
exist, which in billing terms looks exactly like "this actor never ran".

That is why `packages/shared-core/src/billing/substrate-session.js` freezes the
names as `ACTOR_SESSION_METRICS`, why a unit test asserts the prefix, and why the
guard re-reads that same constant and checks it against the regex actually in
force in the cluster. One list, checked two ways.

## Contract 2 — only two namespaces are discovered

```yaml
kubernetes_sd_configs:
  - role: pod
    namespaces:
      names: [ate-system, otel-system]
```

plus a `keep` on the `prometheus.io/scrape: "true"` pod annotation. A new
namespace is invisible; a new exporter without the annotation is never scraped.
We currently add no scrape target at all — our metrics arrive by OTLP push to the
existing collector — but the `kubernetes-pods` job is how `ate_actor_stats_*`
(the reconciliation oracle) arrives, so `ate-system` disappearing from that list
silently removes the ability to sanity-check an org's bill against CPU its
atespace actually burnt.

## Why `--apply` includes a rollout

Both ConfigMaps are mounted into their pods, so `kubectl apply` alone updates the
object and leaves the running config stale. The script restarts
`deploy/prometheus` and `deploy/opentelemetry-collector` and waits, because an
apply that quietly does not take effect is worse than one that errors.

## What is deliberately not here

`node-exporter`, `kube-state-metrics`, standalone cAdvisor, OpenCost — all absent
from the cluster and all skipped on purpose, since the model bills session
seconds × tier rather than measured cpu/mem-hours. `--report` prints the reasoning
per component, and §6 of `docs/SUBSTRATE_METRICS.md` is the restart point if that
requirement ever changes.
