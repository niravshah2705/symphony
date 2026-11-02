# OpenShell GKE — Terraform

Infrastructure-as-code for the multi-tenant NVIDIA OpenShell gateway on GKE.
Ported from the imperative installers in the OpenShell repo (`setup_openshell_gke.py`,
`deploy.sh`) and its draft Terraform (`OpenShell/deploy/terraform/gke`), then
corrected against the **live** cluster `openshell-multitenant`.

This folder is separate from `../terraform/` (the scale-to-zero Cloud Run
deployment); the two stacks do not share state or variables.

## What it provisions

1. **Networking** — required APIs, `openshell-subnet` (pods `10.20.0.0/14`,
   services `10.24.0.0/20`), Cloud Router + NAT, static IP `openshell-ip`,
   firewall `openshell-allow-http-https`.
2. **GKE** — zonal private cluster with Dataplane V2, Workload Identity,
   REGULAR release channel, and two node pools:
   - `openshell-multitenant-node-pool` (e2-standard-2, autoscaling 2–8,
     UBUNTU_CONTAINERD) — sandbox capacity, the part `stop` takes to zero.
   - `openshell-system-node-pool` (e2-standard-2, autoscaling 1–3) — always on,
     sized to the ~1 CPU / 2.3 GiB of requests the platform add-ons actually
     need.
3. **In-cluster platform** — agent-sandbox controller, Envoy Gateway +
   GatewayClass/EnvoyProxy on the static IP, cert-manager + Let's Encrypt
   issuers, Gateway/HTTPRoute + gRPC traffic policies, OpenShell gateway
   (`operator` workspace mode), tenant namespaces with deny-all + DNS
   NetworkPolicies, quotas, limit ranges, RBAC, per-tenant
   `openshell-workspace` Helm releases (chart vendored in `charts/`).
   Every singleton in that list is pinned to the system pool with
   `nodeSelector: cloud.google.com/gke-nodepool: openshell-system-node-pool` —
   a label GKE writes on every node, so the pinning cannot silently no-op.
4. **CI permissions** — `ci_rbac.tf` binds the power workflow's identity to a
   ClusterRole that can cordon, drain and delete pods, for operators who grant
   a pool-scoped IAM role instead of `roles/container.admin`. Set
   `power_ci_sa_email` to that identity or the binding is skipped.

## Usage

```bash
cp terraform.tfvars.example terraform.tfvars   # edit cert_email etc.
terraform init -backend-config="bucket=<STATE_BUCKET>" -backend-config="prefix=openshell/gke"
terraform plan && terraform apply
```

**Existing cluster already deployed?** Follow [`IMPORT.md`](./IMPORT.md) first —
it adopts the live resources into remote state so the plan stays empty.

## Start / stop

`.github/workflows/openshell-cluster-power.yml` owns the tenant pool's node
count. `stop` cordons and drains every node in the tenant pool, forces the pool to
`--min-nodes=0 --max-nodes=0` so the instances go immediately, waits until no
Ready node is left in the pool, then parks the bounds at `min 0 / max 8` so a
future sandbox can still wake capacity. `start` restores `min 2 / max 8` and
waits for that many Ready nodes. The control plane, static IP and Envoy
listener stay up in both states; the system pool keeps the gateway reachable.

Setting `--min-nodes=0` alone used to be the whole stop, and it did nothing:
the autoscaler refuses to evict a bare Pod (the OpenShell runtime creates them
without a controller) and treats the platform add-ons on the same node as
unmovable, so the pool sat at 4 nodes while the run reported success against
the `minNodeCount` it had just written. Two consequences to keep in mind:

- **`stop` needs the system pool in place first.** The workflow's placement
  preflight refuses to drain while any pinned pod still runs on a tenant node,
  because evicting Envoy Gateway or cert-manager off the last node makes the
  autoscaler buy that node back. Converge this module first
  (`gh workflow run openshell-gke-sync.yml -f apply=true`) before the first
  `stop`.
- **Autoscaling stays enabled, parked at `min 0 / max 8`.** Never
  `--no-enable-autoscaling --num-nodes=0`: `openshell-gke-sync.yml` reads the
  live pool's bounds and feeds them to Terraform, and a pool with autoscaling
  off reports none (this pool's `initialNodeCount` is null), so it would plan
  the pool down to `max_nodes=1`.

Manual run, and the opt-in nightly schedule:

```bash
gh workflow run openshell-cluster-power.yml -f action=stop
gh variable set OPENSHELL_CLUSTER_AUTOSTOP --body true    # enables the IST schedule
```

Both workflows authenticate as `GCP_DEPLOYER_SA` (`gh-deployer`), which
`deploy/gcp/bootstrap.sh` grants `roles/container.admin` and
`roles/compute.viewer` — the former is what maps the identity to Kubernetes
`cluster-admin`, so drain works without `ci_rbac.tf`. Set `power_ci_sa_email`
to that address if you prefer the explicit ClusterRole binding — it must match
the `GCP_DEPLOYER_SA` secret byte for byte, because the auth webhook presents
that email as the Kubernetes user name.

## Reconcile / resize in CI

`deploy.yml` only path-filters `deploy/gcp/terraform/**`, so this stack has its
own reconciler: `.github/workflows/openshell-gke-sync.yml`. It plans on every
push to main that touches this directory (diff lands in the run summary) and
applies only when dispatched with `apply=true`, refusing to apply a plan that
deletes anything unless `allow_destroy=true` is also set.

```bash
gh workflow run openshell-gke-sync.yml                      # plan only
gh workflow run openshell-gke-sync.yml -f apply=true        # converge
```

Resizing the nodes is just changing `machine_type` here (or
`-var=machine_type=...`) and letting that workflow apply it. Two things the
workflow handles for you, and that any manual apply must too:

- **Live autoscaling bounds.** It reads the pool's current min/max and passes
  them back, so a reconcile does not silently start a parked cluster (the power
  workflow parks min at 0; the module default is 2).
- **Refresh.** It plans with `-refresh=false`, comparing config against the
  adopted state, because a full refresh 403s on the Compute objects in that
  state for a `gh-deployer` that holds only `roles/container.admin`. Grant it
  `roles/compute.viewer` (`bootstrap.sh` does now) and tick `refresh` to see
  real live drift instead.

## Known hardening TODOs

- `master_authorized_networks_cidr` is `0.0.0.0/0` (matches live). Restrict to
  operator/CI egress ranges.
- `data.http` for the agent-sandbox manifest tracks `latest`; pin a release URL
  before using this for greenfield installs.
- Node pool runs on the default compute service account; switch to a
  dedicated SA with least-privilege (`logging.logWriter`, `metrics.writer`,
  `monitoring.viewer`, `monitoring.agent`) plus Workload Identity bindings.
