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
the infrastructure layer. It has been torn down and brought back since: as of
2026-11-10 `substrate-check.sh` reports **14 passed, 1 failed**, and the one failure is
cause 9 below, which does not affect sandbox capacity.

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
| Worker pool onto N4 / COS / its own boot disk | PR #270 (merged) + the by-hand `gcloud` fix below | machine type + image type + `boot_disk` in `terraform-substrate-gke/substrate.tf`; `substrate_env.test.js` pins the vars and the quota arithmetic |
| Migrate the recreated database (restart `ate-api-server`) | PR #271, step `Re-migrate the recreated database` | found the hard way: workers were `Running` but `0/1 Ready` with `relation "workers" does not exist` |
| Read-only verification as plain shell | PR #271, `deploy/gcp/substrate-check.sh` | every infrastructure check passes on the live cluster; the one FAIL it reports is cause 9 below, which the script did not look at until #272 |
| Worker pool actually re-provisioned (cause 8's fix) | by hand: `gcloud container node-pools update` × 2 | machine type `n4-standard-4`, 100 GB `hyperdisk-balanced` (3000 IOPS / 140 MiB/s), min 1 / max 4; the E2 node is deleted and `planner-pool` stayed `2/2` throughout |
| Worker nodes onto `COS_CONTAINERD` | by hand: `gcloud container clusters upgrade … --image-type=COS_CONTAINERD --quiet` | `node-pools describe … --format="value(config.imageType)"` → `COS_CONTAINERD`; the surge node `gke-…-substrate-worker-1b371960-tpxz` is Ready on `Container-Optimized OS from Google` and the Ubuntu node it replaced is gone |
| The by-hand cluster state and the Terraform module agree | PR #271, verified by the merge-triggered apply | run [42684395694](https://github.com/niravshah2705/symphony/actions/runs/42684395694) job `reconcile substrate gke`: **"No changes. Your infrastructure matches the configuration"**, `Plan: 0 create, 0 update, 0 delete` — so the node GKE is running is the node the module describes, not just the node someone typed into `gcloud` |
| Backup, force-teardown and restore as two scripts | `deploy/gcp/substrate-cleanup.sh`, `deploy/gcp/substrate-recreate.sh` | the restore ran end-to-end on 2026-11-10: 6 Ready nodes, `postgres-0 2/2`, `planner-pool` `2/2 Ready`, `atelet` on every worker node; the backup ran into `gs://adlc-9e72f-substrate-backup/` with 7/7 objects verified |

## Teardown and restore

The cluster has now been emptied and rebuilt twice by hand, so the pair of scripts
exists to make that a documented operation instead of a sequence of `gcloud` calls
remembered under pressure.

```bash
# 1. Back everything up, then delete the pools (add --dry-run to rehearse,
#    --keep-pools to park at 0 nodes instead of deleting, --backup-only to skip the teardown)
deploy/gcp/substrate-cleanup.sh
# 2. Rebuild from exactly that configuration, then prove a worker pod comes up
deploy/gcp/substrate-recreate.sh --snapshot=gs://<bucket>/<cluster>/<stamp>
deploy/gcp/substrate-check.sh
```

What the cleanup guarantees, because each of these was a bug found while writing it:

- **No teardown without a proven backup.** The dump is gzip-tested, size-checked and
  required to contain `CREATE ROLE` before any `gcloud` delete runs, and the upload is
  verified object-by-object; a failed or short backup aborts the script.
- **The dump is real.** The first run produced 18 `CREATE TABLE` and 22 `COPY` blocks
  from `atepg`, and **0 role password hashes** — those roles authenticate by workload
  certificate — so the bucket holds a restore path without holding a credential.
- **Secret values never leave the cluster.** The namespace export omits `secret` from
  its resource list, `secrets.json` records names and data *keys* only, and a mask pass
  reduces any credential-shaped inline env value to a placeholder and prints how many
  it hit (0 today) so an empty result is visible rather than merely plausible.
- **The PD is the one thing it will not delete.** `data-postgres-0`'s 50 GiB
  `pd-balanced` disk holds every atespace, actor and session key, survives the
  teardown, and is removed only by `--destroy-pvc --yes`.
- **The load balancer is cleaned by its owner, not by the pools.** Deleting every node
  leaves the forwarding rule, target pool and health check provisioned and billing, so
  the script deletes the `LoadBalancer` Service in `envoy-gateway-system` and lets the
  in-cluster service controller release the Compute objects.

The recreate side reads `pools.json` from the snapshot (`gs://` or local) so a restore
reproduces what was running rather than what the script last guessed: machine type,
boot disk type/size/IOPS/throughput, image type, autoscaling bounds, taint and label.
A snapshot prefix it cannot read is a loud warning, not a silent fallback — the
hyperdisk values took three attempts to get right and the defaults are the only other
place they are written down.

One timing lesson is encoded in the verify step: worker pods are **Ready minutes after
they are Running**, because ateworker first waits for atelet to create
`/var/lib/ate/worker-support.sock` and then for an epoch from ateapi. Checking once
right after creation reports a false failure — which is exactly what the first restore
run did, against a pool that was healthy ten seconds later.

## Root causes, all nine

Causes 1-8 each had to be fixed; any subset of them still yields zero sandboxes.
Cause 9 does not stop the substrate from running sandboxes — it stops *this app*
from asking it to, which is why it is the one still open.

| # | Cause | How it hid | Status |
|---|---|---|---|
| 1 | No `WorkerPool` CR existed. `ate-setup` installs the CRD and stops there; upstream creates a pool only with `--demo`. | install reported success; runs never left the queue | fixed by #269 |
| 2 | The worker pool was tainted `substrate.ate.dev/workers=true:NoSchedule`, which nothing tolerates — not `atelet`, not worker pods. | nodes existed but stayed empty; the only clue is a Pending pod's `had taint(s) that did not match the tolerations` | fixed by #269 (taint) + the apply |
| 3 | `substrate-worker-pool` had 0 nodes despite `minNodeCount=1` — nothing demanded capacity. | the autoscaler logs `No scaling options were found … Skip simulation` | fixed: pending worker pods pulled the first node up |
| 4 | `SSD_TOTAL_GB` 500/500 exhausted by the 500Gi claim, so no new disk could provision. Also why the historic `rollout status statefulset/postgres` timed out. | quota exhaustion does not fail fast; the node simply never appears | fixed by the 50Gi rewrite |
| 5 | The deployed planner has **no `SUBSTRATE_*` env**: `substrate_url` defaults to `""`, so `substrate_control_env = {}` in the platform root. | the app silently keeps using the Cloud Run pattern; `GET /api/agent/substrate/status` answers `401` to the CI identity, so it cannot be confirmed from outside | **open** |
| 6 | `ate-api-server` applies Postgres migrations only at startup, so recreating the claim left a healthy-looking control plane on an empty schema. | every pod `Running`; every RPC erroring `relation "workers" does not exist`; workers stuck `Running` but not Ready | fixed by #271 |
| 7 | The substrate GKE apply was gated behind a `terraform fmt` drift. | plan never ran, so no error surfaced | fixed by #268 |
| 8 | #270 gave the worker pool a `pd-balanced` boot disk, and **N4 supports no Persistent Disk type at all** — the pool could not provision a node. | `terraform apply` planned clean, GKE accepted the pool config, and only the MIG's instance creation failed: `[UNSUPPORTED_OPERATION] pd-balanced disk type cannot be used by n4-standard-4 machine type`. The pool stayed on its old template, so capacity kept working and nothing looked broken | fixed: `boot_disk { disk_type = "hyperdisk-balanced" }` |
| 9 | The public ateapi route sends to `Service ate-system/ateapi:8443`, but `ate-setup` v1.0.0 creates that Service as **`api` on port 443 (`grpc`)** — the backend the control-plane front routes to has never existed, so `substrateUrl` cannot be that host. | Every signal the old check read is green: Gateway `Programmed=True`, Route `Accepted=True`, DNS resolves, certificate issued. Only `ResolvedRefs=False / BackendNotFound` says otherwise, and nothing looked at that condition until #272 | **open** — the name and port are wrong in the module defaults, but correcting them switches on an *unauthenticated* public actor control plane; see pending 2 |

## Still pending

1. **Cause 5 — turn the app-side path on.** Decide between setting `substrate_url` in
   the platform Terraform root (all stacks, one value) or writing `substrateUrl` (plus
   `substrateIngressUrl`, `substrateAtespace`, `substrateWorkerPool`, a
   digest-pinned `substratePlannerImage`) into the organization's settings, which is
   the per-tenant path the pattern router reads. Then trigger a planner run with
   `agentPattern=substrate` and watch the actor reach `ACTIVE`.
2. **Cause 9 — give the planner a control plane it is allowed to dial.** Setting
   `substrate_url` is only half of it; the address has to actually reach ateapi, and
   the two ways to do that differ in what they expose:
   - **Private**: Cloud Run Direct VPC egress (or a Serverless VPC Connector) to the
     `api` Service, and `substrate_control_plane_public = false`. Nothing new is
     reachable from the internet, at the cost of a connector on every stack that runs
     agents, and a cluster whose internal LB the connector can actually see.
   - **Public**: keep the existing route, fix its backend to `api:443`, and put an
     authN policy in front of it — an Envoy `SecurityPolicy`/JWT check, or the
     `SUBSTRATE_TOKEN` bearer the client already supports, enforced server-side. This
     is the branch `substrate_control_plane_public`'s own description asks for ("leave
     false until the planner reaches ateapi over VPC egress or an authN policy is
     attached to that route").
   Today the flag is on **and** the route is dead, which fails closed by accident: the
   hostname is published, so whoever fixes the backend name without adding authN
   exposes an unauthenticated API that creates actors, deletes them and mints actor
   JWTs. `substrate_ateapi_service` / `substrate_ateapi_port` therefore should not be
   corrected on their own — they are one change with the authN decision.
3. **Phase 3b**: move the system and substrate node pools off E2 too. That tears down
   `ate-system`, so it needs `gke_allow_destroy=true` and a re-run of the install
   afterwards. Separate PR, deliberate.
4. **`kubectl ate` for actor-level verification** — needs Go, which is not installed
   here (see the by-hand section). Actors are not CRDs — they live in the control-plane
   Postgres and are reached over the ateapi gRPC Control API, so this is the only
   read path that does not go through the app.
5. Noted, deliberately not implemented: the `gc_thresh*` / inotify node sysctls, the
   STS quota, ComputeClasses and capacity buffers, hyperdisk provisioned IOPS. All of
   these only matter past roughly 800 concurrent sandboxes per node.

## By hand, on the live cluster

The four things this fix had to change are all plain `gcloud` / `kubectl` — no
installer, no Go, no Terraform run. What each command is the by-hand form of:

```bash
PROJECT=adlc-9e72f CLUSTER=substrate-multitenant ZONE=asia-south1-a
POOL=substrate-multitenant WORKER_NODE_POOL=substrate-worker-pool

# 1. The worker nodes: N4 + Hyperdisk Balanced + 100 GB, and the autoscaling bounds.
#    gcloud accepts exactly ONE flag group per `node-pools update` call, so the
#    machine/disk group and the autoscaling group are two operations.
gcloud container node-pools update "$WORKER_NODE_POOL" --cluster "$CLUSTER" \
  --zone "$ZONE" --project "$PROJECT" \
  --machine-type=n4-standard-4 --disk-type=hyperdisk-balanced --disk-size=100GB \
  --boot-disk-provisioned-iops=3000 --boot-disk-provisioned-throughput=140
gcloud container node-pools update "$WORKER_NODE_POOL" --cluster "$CLUSTER" \
  --zone "$ZONE" --project "$PROJECT" \
  --enable-autoscaling --min-nodes=1 --max-nodes=4

# 2. The node image. `node-pools update` has no --image-type (not in GA, beta or
#    alpha), and the container v1 discovery document has no nodePools.patch method at
#    all — a PATCH or POST :patch there returns an HTML 404, not a JSON error. The
#    image lives on the *upgrade* command:
gcloud container clusters upgrade "$CLUSTER" --zone "$ZONE" --project "$PROJECT" \
  --node-pool "$WORKER_NODE_POOL" --image-type=COS_CONTAINERD --quiet
#    (--quiet is not optional in a script: the command prompts Y/n and exits 1 with
#     "This prompt could not be answered because you are not in an interactive session")

# 3. The bundled Postgres claim size (the original ask) — this one is NOT a gcloud
#    command: upstream's postgres.yaml hardcodes 500Gi and `ate-setup` has no flag,
#    so the install workflow rewrites the manifest before applying it. By hand it is
#    delete statefulset/postgres + pvc data-postgres-0, re-apply at 50Gi, then restart
#    deploy/ate-api-server so it re-runs migrations against the new database.
kubectl -n ate-system get pvc data-postgres-0 -o jsonpath='{.spec.resources.requests.storage}'

# 4. The WorkerPool (upstream only creates one with --demo): kubectl apply -f -, the
#    manifest in SUBSTRATE_INTEGRATION.md §5.3. Idempotent, so CI and a hand-run
#    apply converge.

# Then verify — read-only, PASS/FAIL per check:
deploy/gcp/substrate-check.sh
```

Three behaviours of this path worth knowing before trusting it:

* **A bad (machine type, disk type) pair is not rejected where it is set.** The
  `node-pools update` call and `terraform apply` both succeed; GKE only asks Compute
  when the MIG creates the instance, so the error surfaces as
  `Instance '…' creation failed: … disk type cannot be used by … machine type`
  minutes later, and the pool silently keeps its old template. The live symptom is a
  worker pool that reports `config.machineType` unchanged, not a failed operation.
* **`gcloud … describe --format="value(config.diskType)"` still works** after the move
  to `boot_disk`: the API mirrors the values into both `config.diskType` /
  `config.diskSizeGb` and `config.bootDisk.diskType` / `.sizeGb`. Read either, not a
  third name.
* **Terraform and this path do not fight.** The provider refreshes node-pool state from
  the API before planning, so a hand-applied change shows as no diff once the module
  defaults match it — which is the whole reason the corrected disk type landed in
  `variables.tf` in the same commit as this list.

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
| Cluster machine types `c3-standard-4` or larger | `n4-standard-4`, and therefore `hyperdisk-balanced` boot disks | `c3-standard-4` does not exist in `asia-south1-a` (only `-lssd` variants), and N4 has no Persistent Disk option to fall back on |
| Postgres on a 500 GiB PD | 50 GiB via a manifest rewrite | upstream hardcodes 500Gi and `ate-setup` has no flag for it; 500Gi consumed the whole regional SSD quota |
| `WorkerPool` only for `--demo` | created by the install workflow, one shared `planner-pool` | the app selects `ate.dev/worker-pool=planner-pool`, so the CR must exist without the demo |
| `cleanup-gcp` deletes everything | it does **not** delete the Postgres PD | its own note: find it with `gcloud compute disks list --filter="description~data-postgres-0"` |

## Corrections worth recording

* **Hyperdisk capacity is not the regional SSD quota — a comment said it was, before
  measuring.** The `substrate_max_nodes = 4` bound and the preflight's
  `disk quota headroom` row were both written assuming `hyperdisk-balanced` bills
  against `SSD_TOTAL_GB` the way `pd-balanced` does. It does not: with the N4 worker
  node live on a 100 GB hyperdisk-balanced boot disk, `SSD_TOTAL_GB` reads 50/500
  (that 50 is the Postgres volume, which `dynamic-rwo` provisions as `pd-balanced`),
  and `gcloud compute regions describe asia-south1` lists no Hyperdisk capacity metric
  at all. So the SSD arithmetic still guards a PD disk type, and for Hyperdisk the
  node count is a cost and `CPUS` decision. Both check implementations now say so
  instead of reporting headroom against a quota the disk never spends.
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
