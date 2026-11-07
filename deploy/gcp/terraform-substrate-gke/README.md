# Substrate GKE — Terraform

Infrastructure-as-code for the GKE cluster that runs the [Agent
Substrate](https://github.com/agent-substrate/substrate) control plane, its
worker pools, and the in-cluster fronts that publish them. This is the platform
half of the substrate pattern; the application half (Cloud Run services, the
egress sidecar, the per-tenant stack) lives in `../terraform/` and the two
stacks share no state and no variables.

OpenShell — the sandbox gateway this folder was originally a port of — is
retired. Nothing here installs it, and `substrate_enabled` is no longer an
optional second substrate: it is the only execution substrate, so `false` means
the cluster cannot run agents at all. See
[`../../../docs/SUBSTRATE_INTEGRATION.md`](../../../docs/SUBSTRATE_INTEGRATION.md)
for what the pattern is and what this module deliberately does *not* install.

## What it provisions

1. **Networking** — required APIs, `substrate-subnet` (pods `10.20.0.0/14`,
   services `10.24.0.0/20`), Cloud Router + NAT, and the
   `substrate-allow-http-https` firewall rule. Public addresses belong to the
   plane that serves them, so they are reserved in `substrate.tf` (and
   `agentgateway.tf`) rather than here.
2. **GKE** — zonal private cluster with Dataplane V2, Workload Identity,
   REGULAR release channel, Managed Prometheus + advanced datapath
   observability (see `../../../docs/GCP_DEPLOY.md` for what reads those
   series), and
   two node pools:
   - `substrate-node-pool` (e2-standard-2, autoscaling 2–8, UBUNTU_CONTAINERD)
     — tenant capacity, the part `stop` takes to zero first.
   - `substrate-system-node-pool` (e2-standard-2, autoscaling 1–3) — holds the
     platform add-ons, sized to the ~1 CPU / 2.3 GiB of requests they actually
     need. The power workflow drains and parks it last.
3. **In-cluster platform** — Envoy Gateway + GatewayClass, cert-manager + the
   Let's Encrypt issuers, tenant namespaces with deny-all + DNS
   NetworkPolicies, quotas, limit ranges and RBAC. Every singleton is pinned to
   the system pool with
   `nodeSelector: cloud.google.com/gke-nodepool: substrate-system-node-pool` —
   a label GKE writes on every node, so the pinning cannot silently no-op.
4. **CI permissions** — `ci_rbac.tf` binds the power workflow's identity to a
   ClusterRole that can cordon, drain and delete pods, for operators who grant
   a pool-scoped IAM role instead of `roles/container.admin`. Set
   `power_ci_sa_email` to that identity or the binding is skipped.
5. **Agent Substrate (`substrate.tf`)** — a dedicated `substrate-worker-pool`
   (tainted `substrate.ate.dev/workers`, gVisor runs on the stock
   UBUNTU_CONTAINERD image), the `substrate-credentials` and
   `substrate-snapshots` namespaces, a PD `StorageClass` + `VolumeSnapshotClass`
   for atelet suspend/resume snapshots, a scoped Role/RoleBinding letting the
   atenet-egress service account read Secrets **only** in
   `substrate-credentials`, and (when `substrate_ingress_hostname` is set) a
   cert-manager Certificate + Envoy Gateway + HTTPRoute fronting the
   atenet-router actor data plane. The `ate-system` control plane itself
   (`ateapi`, `atelet`, `atecontroller`, `ate-idp-server`, `atenet-*`, CRDs) is
   installed by the upstream substrate installer, **not** here.
6. **agentgateway (`agentgateway.tf`)** — the in-cluster L7 front for LLM
   traffic and the `/a2a` seam: two pinned OCI charts, its own static address
   and Certificate when published, a per-Gateway `AgentgatewayParameters`
   (system-pool pinned, JSON logs), one whole `AgentgatewayPolicy` (Strict
   virtual-key auth + model allowlist + the `user_id` metric), and LiteLLM
   reached as a custom provider with `providerOverride: litellm`. Off by
   default, and it renders **names and hashes only** — the environment-init
   job's `gw.virtualkey` step is the only writer of live material. See that
   file's header for why it sits *behind* the existing `litellm` mode instead
   of beside it, and `docs/LLM_GATEWAY.md` for the two halves that must both
   be asked for.

## Usage

```bash
cp terraform.tfvars.example terraform.tfvars   # edit project_id + cert_email
terraform init -backend-config="bucket=<STATE_BUCKET>" -backend-config="prefix=substrate/gke"
terraform plan && terraform apply
```

Read [`APPLY.md`](./APPLY.md) before the first apply on a real project — it
covers the throwaway-project rehearsal and what a non-empty *second* plan means.

## Start / stop

`.github/workflows/substrate-cluster-power.yml` owns every node pool's node
count. `stop` walks the pools in order — tenant, then substrate (when configured),
then system — and for each one forces `--min-nodes=0 --max-nodes=0` *before*
cordoning and draining its nodes, then waits until no Ready node is left in that
pool. Once all pools are empty it parks the bounds at `min 0 / max 8` (tenant),
`min 0 / max 6` (substrate) and `min 0 / max 3` (system) so the next `start`, or
an incoming actor, can raise them. `start` does the reverse order — system pool
first so the add-ons have somewhere to land — and waits for the running minimum
in each pool before declaring the cluster up. The control plane and the static
IPs survive both states; the Envoy gateways and cert-manager do not, because
they run on the system pool. **While the cluster is stopped no public hostname
serves anything and no TLS renewal is attempted** — that node spend is in scope
too now.

Setting `--min-nodes=0` alone used to be the whole stop, and it did nothing: the
autoscaler refuses to evict a bare Pod and treats the platform add-ons on the
same node as unmovable, so the pool sat at 4 nodes while the run reported
success against the `minNodeCount` it had just written. Two consequences to keep
in mind:

- **The add-ons must be off the tenant pool before the tenant pool drains.** The
  workflow's placement preflight refuses to drain while any pinned pod still runs
  on a non-system node, because evicting Envoy Gateway or cert-manager from a
  tenant node makes the autoscaler buy that node back. Converge this module first
  (`gh workflow run deploy.yml -f gke_reconcile=true`) before the first `stop`.
  The add-ons' own PodDisruptionBudgets cannot block the last drain: every pool is
  already at `max 0`, so there is nowhere to evict them to, and the workflow falls
  back to `kubectl drain --disable-eviction`.
- **Autoscaling stays enabled, parked at `min 0 / max N`.** Never
  `--no-enable-autoscaling --num-nodes=0`: deploy.yml's `gke_reconcile` job
  reads every pool's live bounds and feeds them to Terraform, and a pool with
  autoscaling off reports none (this pool's `initialNodeCount` is null), so it
  would plan the pool down to `max_nodes=1` — or, for the system pool, back up to
  `system_min_nodes = 1` and silently wake a node on a stopped cluster.

Manual run, and the opt-in nightly schedule:

```bash
gh workflow run substrate-cluster-power.yml -f action=stop
gh variable set SUBSTRATE_CLUSTER_AUTOSTOP --body true    # enables the IST schedule
```

Both workflows authenticate as `GCP_DEPLOYER_SA` (`gh-deployer`), which
`deploy/gcp/bootstrap.sh` grants `roles/container.admin`,
`roles/compute.viewer` and the project's `substrateStaticIpAdmin` custom role
(`compute.addresses.create` and `setLabels` among others — viewer can read the
static IPs the module owns but cannot create one, and a missing grant 403s the
substrate apply mid-resource, because the address is labelled in a second call
once it exists). `container.admin` is what maps the identity to Kubernetes
`cluster-admin`, so drain works without
`ci_rbac.tf`. Set `power_ci_sa_email`
to that address if you prefer the explicit ClusterRole binding — it must match
the `GCP_DEPLOYER_SA` secret byte for byte, because the auth webhook presents
that email as the Kubernetes user name.

## Reconcile / resize in CI

The `gke_reconcile` job in `.github/workflows/deploy.yml` is continuous
deployment for this module: every push to main that touches
`deploy/gcp/terraform-substrate-gke/**` plans and then applies, same posture as
the Cloud Run stack it runs beside (own state prefix, no images). The one hard
brake is destructive — a plan containing any delete refuses to apply unless the
run is re-dispatched with `gke_allow_destroy=true`, so a merge can converge a
cluster but cannot take one apart.

```bash
gh workflow run deploy.yml -f gke_reconcile=true -f gke_plan_only=true  # inspect, do not converge
gh workflow run deploy.yml -f gke_reconcile=true                        # converge now
```

Resizing the nodes is just changing `machine_type` here (or
`-var=machine_type=...`) and letting that job apply it. Two things the job
handles for you, and that any manual apply must too:

- **Live autoscaling bounds.** It reads each pool's current min/max and passes
  them back, so a reconcile does not silently start a parked cluster (the power
  workflow parks min at 0; the module default is 2).
- **Refresh.** It plans the whole module with `-refresh=true`, so a change made
  outside Terraform shows up as drift instead of quietly staying applied. That
  works because `gh-deployer` holds `roles/container.admin`, which GKE maps to
  Kubernetes `cluster-admin` (so the helm releases and manifests in this state
  are readable), and `roles/compute.viewer`, which `bootstrap.sh` grants —
  without the latter a refresh 403s on the subnet, router, NAT, address and
  firewall objects, and an applied node-pool change 403s while it polls the
  instance group manager. Nothing is `-target`ed: an enumerated target list
  stops covering the stack the moment the module grows a resource.

## Known hardening TODOs

- `master_authorized_networks_cidr` is `0.0.0.0/0`. Restrict to operator/CI
  egress ranges.
- Node pools run on the default compute service account; switch to a dedicated
  SA with least-privilege (`logging.logWriter`, `metrics.writer`,
  `monitoring.viewer`, `monitoring.agent`) plus Workload Identity bindings.
