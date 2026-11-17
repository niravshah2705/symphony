# `terraform-flexprice` — the FlexPrice billing platform, on GKE, from state

This root installs and reconciles the same FlexPrice stack that
`scripts/flexprice-helm.js` installs into a `kind` cluster on a workstation. It
does not create the cluster: it reads the existing `substrate-multitenant`
cluster (`../terraform-substrate-gke`) with a data source and installs into it,
the way `../terraform-substrate-gke/agentgateway.tf` installs LiteLLM and that
root's fronts build their Gateways.

**Gate first, because it governs everything below.** `docs/FLEXPRICE_AGPL_MEMO.md`
is *NOT CLEARED for production*. Nothing in this root cuts a tenant over: the
root stack's `FLEXPRICE_ENABLED` is the conjunction of `flexprice_enabled` and
`flexprice_billing_cutover_enabled`, and the cutover variable defaults to `false`
(`../terraform/variables.tf`). So this module can build, probe and exercise a
real staging billing platform while **no organization's money moves**. Making it
bill a tenant is a separate, deliberate change with counsel behind it, not a
missing `vars.` entry.

One honest wrinkle in that framing, which is why the memo's §4.3 is the section to
read before opening the gate: this root does not install the upstream chart, it
installs a *patched* one (next section), and the templates it patches live under
`internal/ee/` in the pinned checkout. The edits are packaging metadata and
scheduling knobs rather than product logic, and no patched byte is committed here
— only the transform and the sha256 of its output — but "is a manifest edit a
modification under AGPL" is a legal question, not an engineering one. It is
recorded as question 4 in the memo's §7 and it is a reason the cutover stays a
separate switch.

## What is installed

Three `helm_release`s of one chart in one namespace, plus two `kubectl_manifest`
Jobs, plus the front. They are three because a single install puts the migration
Job's pre-install hook ahead of the Postgres Service it waits for and a cold
cluster deadlocks — the header of `scripts/flexprice-helm.js` records exactly
that, and solves it by re-installing one release four times. Terraform solves it
with `depends_on` instead, which lets each release's values stay stable:

| Release | Enables | Renders |
|---|---|---|
| `flexprice-infra` | the four stores, `dataProtection.retainStorage`, the ServiceAccount | Postgres, ClickHouse, Kafka, Redis StatefulSets + Services, the `flexprice-retained` StorageClass, the SA |
| `flexprice-migration` | `migration.enabled=true`, `asHook=false` | the `-migration` ServiceAccount + the one-shot migration Job, and Temporal's `default` namespace bootstrap Job |
| `flexprice-app` | `api`/`consumer`/`worker` | the three app Deployments and `flexprice-api` |

Each release renders a name exactly once, so `helm.sh/resource-policy` cannot
conflict across them, and `fullnameOverride: flexprice` keeps every object name
identical to the local stack. Two details make that hold rather than merely look
tidy: the namespace bootstrap Job is a *hook* and belongs only to the release that
sets `temporalConfig.bootstrapNamespaces` (the migration one) — a second release
setting it would render the same Job name twice — and `templates/tests/` is not
part of an install manifest at all, so the chart's health-test pod is never an
object Terraform has to own. Objects the chart does not render at all — the
`temporal` **database**, and the hand-rolled Temporal **Deployment + Service** —
are owned here as `kubectl_manifest` (`extras.tf`).

All three run with `atomic`, `cleanup_on_fail`, `wait` and `timeout=900`. Those
four are what retire the script's `healPendingRelease()` and its per-phase pod
recreate dance; their cost is that a failed apply leaves nothing in-cluster to
inspect, which is why `APPLY.md` tells you to have CI dump pod status and events.
The migration release adds `wait_for_jobs`: `--wait` on its own does not treat a
completed Job as ready, and that release is nothing but Jobs.

## What we patch, and why it is honest

The chart is **not** upstream byte-for-byte. `scripts/flexprice-stage-chart.js`
derives a staged copy from the pinned commit (`deploy/flexprice/VERSION`) at every
build and does three things to it:

1. **Strips `dependencies:` and deletes `Chart.lock`.** The four subchart deps
   (bitnami postgresql/kafka/redis + temporal) are all conditioned off in this
   values shape, and Helm refuses to install a chart whose deps are not vendored.
   This is what `flexprice-helm.js` already does locally; it is a packaging fact,
   not a fix.
2. **Widens the fragile probes.** `templates/infra/postgres.yaml` hardcodes
   `timeoutSeconds: 5` / `failureThreshold: 3` (and the same shape in
   `clickhouse.yaml`, `kafka.yaml`, `redis.yaml`) with **no values key**, so a
   `helm_release`'s `set`/`values` cannot reach them — those write values, not
   templates. On a busy node a cold Postgres loses that race and the pod restarts
   forever. The staged chart raises them to `20`/`6` inside `livenessProbe` and
   `readinessProbe`. This is the same widening `relaxInfraProbes()` performed
   out-of-band; doing it at staging is what makes `--force-conflicts` and
   `force_update` unnecessary.
3. **Injects global placement into `postgres`/`kafka`/`redis`.** The node pool is
   tainted `fleet.dev/dedicated=flexprice:NoSchedule`, so a pod must both select
   and tolerate it. Those three templates expose **no** placement key (unlike
   `clickhouse.standalone.*`, `api.*`, `migration.*`, which do), so without this
   the databases would be Pending and only the app pods would land.

The patched chart's `sha256` is recorded in `deploy/flexprice/VERSION` next to the
image digest and chart version. If you are reviewing this and the sha does not
match what CI pushed, you are deploying templates nobody re-derived.

`var.chart_version` is `1.10.0+fleet.1` rather than `1.10.0`, and the build
metadata suffix is the point: Helm resolves a chart by name and version, so a
patched chart published under the untouched upstream version would be
indistinguishable from one pulled from upstream — and `helm list` in a live
namespace is where that difference stops being visible. The staging script
rewrites `version:` in `Chart.yaml` to match, so the packaged chart, the registry
entry and the `helm_release` all carry the same claim about what it is.

## Two things that are not enforced by a plan

* **Registering Temporal's `default` namespace.** At this commit the chart's own
  bootstrap Job does it, which is why the module sets
  `temporalConfig.bootstrapNamespaces` rather than shipping a Job. **If you bump
  the chart and that disappears**, the symptom is not a crash: the app starts, and
  the worker crash-loops with

  ```text
  ensure temporal server schedules: describe temporal schedule
  "credit-grants-processing": Namespace default is not found.
  ```

  A missing namespace is a *silent* data-plane failure — every scheduled
  grant/credit job is refused at describe time — so it is worth checking
  `temporal operator namespace list` after any chart bump.
* **Changing an immutable StatefulSet field** (volume templates, `serviceName`,
  `selector`). No Terraform provider flags fix that; it needs destroy-and-recreate
  of the PVC or pool. `APPLY.md` gives the sequence. Never automate it.
* **Proving a new image actually migrated.** `templates/jobs/migration.yaml` hashes
  `flexprice.env` *plus* `<repository>:<tag | .Chart.AppVersion>` into the Job's
  name, and this chart's `appVersion` is the constant `1.0.0`. So the tag is load
  bearing: `var.image_tag` empty means the Job name moves only when the config
  moves, and a release that changes the image but nothing else re-uses a completed
  Job and skips its versioned migrations — with `/health` still answering 200,
  because `/health` does not read the schema. CI therefore derives the tag from the
  digest it just pushed (`flexprice-helm.js` never had to care; it was always a
  fresh install).

## PodSecurity: `baseline`, not `restricted`

`restricted` refuses the postgres, redis, kafka and temporal pods outright (they
run as uid 0 or need `SETGID`/`CHOWN`). The namespace therefore enforces
`baseline` and only `warn`/`audit` at `restricted`. This is a real reduction
compared with the cluster default and it is documented rather than hidden: the
alternative is a namespace where the databases cannot start.

## Storage and the zonal reality

`dataProtection.retainStorage=true` makes the chart create the
`flexprice-retained` StorageClass (`pd.csi.storage.gke.io`, `pd-ssd`,
`Reclaim=Retain`, `WaitForFirstConsumer`) and claim it for every component
through `flexprice.componentStorageClass`, with `helm.sh/resource-policy: keep` on
the PVCs. Terraform deliberately does **not** also declare that class: one object
with two owners is a conflicting field manager.

The plan said "regional class"; on `asia-south1-a` a regional PD StorageClass is
not available on a zonal cluster, so this is `pd-ssd` and that deviation is
intentional. Sizes mirror the local shape (pg 5Gi, CH 5Gi, Kafka 5Gi, Redis 1Gi).

## Node pool

`flexprice-pool`, autoscaled **min 1** / max 3, `e2-standard-4`. Min 1 is not an
oversight: a parked pool cannot serve a cold Kafka/ClickHouse quorum and the
StatefulSets have nowhere else to land. It is also the reason the pool name must
never appear in `.github/workflows/substrate-cluster-power.yml`'s
`SUBSTRATE_NODE_POOL` / `SUBSTRATE_SYSTEM_NODE_POOL` — the substrate pools sleep
at 03:00, and a parked pool holding a quorum does not come back as a quorum.
`deploy/gcp/flexprice-infra.test.js` pins that absence rather than trusting it.
The cost of all this is a fourth always-on node on a cluster whose other pools
sleep; review it against the cluster's power budget before leaving this running.

## Secrets

Five Secret Manager **containers** (`secrets.tf`) hold no versions in state, the
same rule `../terraform-substrate-gke/agentgateway.tf` follows. CI reads the
enabled versions and applies the Kubernetes Secret `flexprice-secrets`
out-of-band; `secrets.existingSecret` in `values/base.yaml` points the chart at
it. The plane API keys are minted by `scripts/flexprice-provision.js`, never by
Terraform — a key Terraform creates is a key whose rotation is a plan.

`roles/secretmanager.secretVersionManager` is the CI writer role, not
`secretAdmin` or a custom `secretVersionAdd` binding: `secretVersionAdd` is not
bindable at the secret level, so the intuitive grant is the one that fails.

## Public front and the one DNS record

`front.tf` renders the whole front only when `var.ingress_hostname` is non-empty,
so the module is deployable dark: regional static address, a **namespaced
Issuer**, Certificate, `Gateway` (443 + 80, because HTTP-01 must have a plain-HTTP
listener to land on) and an `HTTPRoute` to `flexprice-api:80` on Envoy Gateway
class `eg`.

Its own namespaced `Issuer` is not redundancy. The cluster's shared
`letsencrypt-prod` ClusterIssuer has `solvers[].http01.ingress`-style parentRefs
that name `substrate-ingress` and `agentgateway` only, so a certificate owned here
would never be handed a solver — issuance would sit `Pending` with no error.

**You create one A record:** `flexprice.archagentix.com` (or whatever
`var.ingress_hostname` is) → the `flexprice_ingress_ip` output, in
`var.region`, TTL 300. Nothing in this repo writes Cloud DNS, so issuance stays
`Pending` until that record resolves. `terraform output flexprice_dns_hint`
prints the line to give your registrar.

No Workload Identity: there is no `FLEXPRICE_S3_*`/GCS event storage in this
shape, so nothing reaches a Google API and `serviceAccount.perComponent` stays
false. The only Google IAM grant is `roles/artifactregistry.reader` on the node
Service Account, for the pull.

## Layout

```text
versions.tf        providers + partial gcs backend (init with prefix=substrate/flexprice)
main.tf            data source for the existing cluster; endpoint/CA/token; 3 k8s providers
variables.tf       every input, with the rationale inline
node_pool.tf       flexprice-pool (min 1)
namespaces.tf      flexprice namespace + PodSecurity labels
secrets.tf         five Secret Manager containers
values/base.yaml   the cloud twin of deploy/flexprice/helm/values-kind.yaml
helm_infra.tf      release 1: stores + StorageClass + SA
helm_migration.tf  release 2: migration Job + namespace bootstrap
helm_app.tf        release 3: api / consumer / worker
extras.tf          the temporal database + the Temporal Deployment/Service
registry.tf        the two Artifact Registry repos + the APIs this root needs
iam.tf             node SA pull access
front.tf           address / Issuer / Certificate / Gateway / HTTPRoute
outputs.tf         ingress IP, base URL, dns hint, release + secret inventory
APPLY.md           runbook: ordering, first apply, failure reading, destroy limits
```
