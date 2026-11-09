# Substrate status — what landed, what is still open

A working snapshot of the fix that started as "make the Postgres disk 50 GB so the
service can start". Taken on 2026-11-10 against
`adlc-9e72f / substrate-multitenant / asia-south1-a`, substrate `v1.0.0`.

For the design and the operator-facing tables see
[`SUBSTRATE_INTEGRATION.md`](./SUBSTRATE_INTEGRATION.md); this file is only the
progress ledger and the by-hand path.

## Bottom line

**Sandbox capacity is live.** A `WorkerPool` exists, its 2 workers are Ready and
registered, `atelet` runs on the worker node, and the bundled Postgres claim is 50Gi.
The original ask — "fix everything until we see a sandbox getting created" — is met at
the infrastructure layer.

**Not yet proven:** an actor created by *this app* reaching `ACTIVE`. The planner
deployment still has no `SUBSTRATE_*` environment (see cause 5 below), so the
application-side path is dark even though the substrate is able to serve one.

Run `deploy/gcp/substrate-check.sh` to reproduce every claim in this file.

## Completed

| What | Where it lives | Evidence |
|---|---|---|
| Postgres claim 500Gi → 50Gi | PR #267 (`Set the bundled Postgres volume size` step) + install run [42675810014](https://github.com/niravshah2705/symphony/actions/runs/42675810014) | `data-postgres-0  50Gi  Bound  dynamic-rwo`; `SSD_TOTAL_GB` freed for worker disks |
| `terraform fmt` drift that had gated every substrate apply | PR #268 | apply runs plan again |
| `WorkerPool` created by the install workflow | PR #269, step `Create the WorkerPool` | `planner-pool  2  2  2  gvisor-default  True` in `substrate-workers` |
| Worker node pool taint `substrate.ate.dev/workers=true` → `ate.dev/sandboxClass=gvisor` | PR #269 + GKE apply run [42674849918](https://github.com/niravshah2705/symphony/actions/runs/42674849918) (plan was `0 to add, 1 to change, 0 to destroy`) | `gcloud container node-pools describe … --format="value(config.taints)"` shows the sandboxClass key; an `atelet` pod is on the worker node |
| Preflight rows that see all four capacity causes | PR #269 (`WorkerPool created`, `worker node pool placement`, `disk quota headroom`) | preflight run [42672938739](https://github.com/niravshah2705/symphony/actions/runs/42672938739) reported the two FAILs before they were fixed and reports them green now |
| Worker pool onto N4 / COS / its own boot disk | PR #270 (open) | `substrate_env.test.js` pins machine type, image type, disk vars and the quota arithmetic |
| Migrate the recreated database (restart `ate-api-server`) | PR #271, step `Re-migrate the recreated database` | found the hard way: workers were `Running` but `0/1 Ready` with `relation "workers" does not exist` |
| Read-only verification as plain shell | PR #271, `deploy/gcp/substrate-check.sh` | 12 checks pass on the live cluster |

## Root causes, all seven

Every one of these had to be fixed; any subset still yields zero sandboxes.

| # | Cause | How it hid | Status |
|---|---|---|---|
| 1 | No `WorkerPool` CR existed. `ate-setup` installs the CRD and stops there; upstream creates a pool only with `--demo`. | install reported success; runs never left the queue | fixed by #269 |
| 2 | The worker pool was tainted `substrate.ate.dev/workers=true:NoSchedule`, which nothing tolerates — not `atelet`, not worker pods. | nodes existed but stayed empty; the only clue is a Pending pod's `had taint(s) that did not match the tolerations` | fixed by #269 (taint) + the apply |
| 3 | `substrate-worker-pool` had 0 nodes despite `minNodeCount=1` — nothing demanded capacity. | the autoscaler logs `No scaling options were found … Skip simulation` | fixed: pending worker pods pulled the first node up |
| 4 | `SSD_TOTAL_GB` 500/500 exhausted by the 500Gi claim, so no new disk could provision. Also why the historic `rollout status statefulset/postgres` timed out. | quota exhaustion does not fail fast; the node simply never appears | fixed by the 50Gi rewrite |
| 5 | The deployed planner has **no `SUBSTRATE_*` env**: `substrate_url` defaults to `""`, so `substrate_control_env = {}` in the platform root. | the app silently keeps using the Cloud Run pattern; `GET /api/agent/substrate/status` answers `401` to the CI identity, so it cannot be confirmed from outside | **open** |
| 6 | `ate-api-server` applies Postgres migrations only at startup, so recreating the claim left a healthy-looking control plane on an empty schema. | every pod `Running`; every RPC erroring `relation "workers" does not exist`; workers stuck `Running` but not Ready | fixed by #271 |
| 7 | The substrate GKE apply was gated behind a `terraform fmt` drift. | plan never ran, so no error surfaced | fixed by #268 |

## Still pending

1. **Cause 5 — turn the app-side path on.** Decide between setting `substrate_url` in
   the platform Terraform root (all stacks, one value) or writing `substrateUrl` (plus
   `substrateIngressUrl`, `substrateAtespace`, `substrateWorkerPool`, a
   digest-pinned `substratePlannerImage`) into the organization's settings, which is
   the per-tenant path the pattern router reads. Then trigger a planner run with
   `agentPattern=substrate` and watch the actor reach `ACTIVE`.
2. **Apply PR #270** (`deploy.yml` with `gke_reconcile=true`, plan first) — only after
   the 50Gi claim landed, which it has. Expect a node-pool replacement; the pool holds
   one node, so do it before actors are running.
3. **Phase 3b**: move the system and substrate node pools off E2 too. That tears down
   `ate-system`, so it needs `gke_allow_destroy=true` and a re-run of the install
   afterwards. Separate PR, deliberate.
4. **`kubectl ate` for actor-level verification** — needs Go, which is not installed
   here (see the by-hand section).
5. Noted, deliberately not implemented: the `gc_thresh*` / inotify node sysctls, the
   STS quota, ComputeClasses and capacity buffers, hyperdisk provisioned IOPS. All of
   these only matter past roughly 800 concurrent sandboxes per node.

## Following the official guide by hand

The guide is
[install-overview-substrate](https://docs.cloud.google.com/kubernetes-engine/ai-ml/install-overview-substrate).
It is written for a human at a terminal, and we do not follow it verbatim. Here is
exactly which parts we can run as shell and which we cannot.

**Cannot run here: the installer itself.** The guide's one command is

```bash
curl -sSL https://raw.githubusercontent.com/ai-on-gke/substrate-gke/main/install.sh | bash
```

and it needs Git, **Go**, `make`, Docker + buildx, `jq`, ADC
(`gcloud auth application-default login`) and `gcloud auth configure-docker
REGION-docker.pkg.dev` — and it explicitly refuses Cloud Shell because 5 GB of
persistent disk is not enough. This machine has Docker, jq and gcloud but **no Go**,
so `ate-setup` cannot be built locally. CI is therefore the installer's host:
`substrate-control-plane.yml` does the same thing with `actions/setup-go@v7` and
Workload Identity Federation instead of ADC. Two consequences worth knowing:

* The guide's `install.sh` is interactive (images, project, cluster, bucket, SPIFFE
  IDs). Our workflow passes those as the `SUBSTRATE_*` repo variables instead, so a
  re-run is non-interactive and diffable.
* The guide builds images from source into an `ate-images` Artifact Registry repo;
  we pull the release images from `ghcr.io/agent-substrate/substrate` at a pinned
  tag. The `release images present` preflight row is what substitutes for the build.

**Can run here, and does: everything after the install.** These are the guide's own
verification commands plus the checks for the things the guide does not cover:

```bash
kubectl get pods -n ate-system
kubectl get pods -n podcertificate-controller-system
kubectl get workerpools.ate.dev -A
kubectl -n substrate-workers get pods -l ate.dev/worker-pool=planner-pool -o wide
kubectl -n ate-system get pods -l app=atelet -o wide
kubectl -n ate-system get pvc data-postgres-0
gcloud container node-pools describe substrate-worker-pool \
  --cluster=substrate-multitenant --zone=asia-south1-a --format="value(config.taints)"
gcloud compute regions describe asia-south1 --format="value(quotas)" | jq '.quotas[] | select(.metric=="SSD_TOTAL_GB")'
deploy/gcp/substrate-check.sh          # all of the above, PASS/FAIL, read-only
```

`substrate-check.sh` is read-only: it never creates, applies, deletes or restarts
anything, so it is safe to run against a production cluster and safe to wire into an
alert. It takes `PROJECT` / `CLUSTER` / `ZONE` / `POOL` / `WORKER_NODE_POOL` /
`POSTGRES_CLAIM_GB` overrides and exits non-zero on a FAIL.

**The WorkerPool, which the guide says nothing about for non-demo installs.** The
manifest the install applies is `docs/SUBSTRATE_INTEGRATION.md` §5.3; the same object
can be created by hand with `kubectl apply -f -` and is idempotent, so
`mode=install` and a hand-run apply converge to the same state.

**`kubectl ate`** — the plugin that reads actors and workers straight from `ateapi`,
and the only comfortable way to confirm an actor reached `ACTIVE` from a terminal:

```bash
brew install go
git clone --depth 1 --branch v1.0.0 https://github.com/agent-substrate/substrate.git /tmp/substrate
(cd /tmp/substrate && go install ./cmd/kubectl-ate)
export PATH="$PATH:$(go env GOPATH)/bin"
kubectl ate get actors          # over gRPC to ateapi, needs the Control-plane route
```

Note the guide's own caveat: requests sent from a laptop are refused by the ingress
router, which admits only clients with a Pod certificate whose SPIFFE ID is on its
allowlist. `kubectl ate get actors` talks to the control plane, not the data plane, so
it works; sending traffic *to* an actor does not, unless it comes from an allowlisted
workload (or through the public `substrate.archagentix.com` front with its own auth).

## Deviations from the guide, and why

| Guide | Here | Why |
|---|---|---|
| `install.sh` on a local machine | `substrate-control-plane.yml` `mode=install` | no Go locally; CI has the toolchain and keyless auth, and the run is auditable |
| Build images from source into `ate-images` | release images from ghcr, tag pinned by `SUBSTRATE_VERSION` | no local Docker build in CI for this; the `release images present` row checks every image the install needs |
| Installer creates the cluster and its node pools | Terraform creates them (`terraform-substrate-gke`) | the pools need labels, taints and an actor-egress IAM binding the installer does not model |
| Cluster machine types `c3-standard-4` or larger | `n4-standard-4` | `c3-standard-4` does not exist in `asia-south1-a` (only `-lssd` variants) |
| Postgres on a 500 GiB PD | 50 GiB via a manifest rewrite | upstream hardcodes 500Gi and `ate-setup` has no flag for it; 500Gi consumed the whole regional SSD quota |
| `WorkerPool` only for `--demo` | created by the install workflow, one shared `planner-pool` | the app selects `ate.dev/worker-pool=planner-pool`, so the CR must exist without the demo |
| `cleanup-gcp` deletes everything | it does **not** delete the Postgres PD | its own note: find it with `gcloud compute disks list --filter="description~data-postgres-0"` |

## Two corrections worth recording

* **"The database holds nothing of value" was wrong when it was said.** The pre-install
  check ran `psql -c '\dt'`, which lists only the session `search_path` — and the
  control plane's tables live in the `substrate` **schema**, not `public`. The old
  database was migrated and populated; the 50Gi rewrite did delete real atespace and
  actor metadata. Snapshots in GCS survived and the app re-provisions its atespace, so
  no user work was lost, but the reading it was justified with was not sound. Use
  `select schemaname, count(*) from pg_tables group by 1` for this check, which is what
  `substrate-check.sh` relies on for the schema row.
* **Some Actions runs fail with no jobs at all.** On 2026-11-09, two runs triggered by
  the #269 merge ended `failure` with zero jobs, and two dispatched runs of the same
  workflow minutes apart got the full job set. `gh` prints "This run likely failed
  because of a workflow file issue" whenever a run fails without jobs, which is a
  guess, not a diagnosis — every workflow file in the repo parses clean
  (`npx js-yaml .github/workflows/*.yml`), all jobs that ran succeeded, and job-minutes
  for the month were nowhere near the plan limit. Treat a zero-job failure as transient
  and re-dispatch; investigate as a workflow bug only if the same trigger fails twice
  in a row with the file unchanged.
