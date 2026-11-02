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
   REGULAR release channel; node pool `openshell-multitenant-node-pool`
   (e2-standard-4, autoscaling 2–8, UBUNTU_CONTAINERD).
3. **In-cluster platform** — agent-sandbox controller, Envoy Gateway +
   GatewayClass/EnvoyProxy on the static IP, cert-manager + Let's Encrypt
   issuers, Gateway/HTTPRoute + gRPC traffic policies, OpenShell gateway
   (`operator` workspace mode), tenant namespaces with deny-all + DNS
   NetworkPolicies, quotas, limit ranges, RBAC, per-tenant
   `openshell-workspace` Helm releases (chart vendored in `charts/`).

## Usage

```bash
cp terraform.tfvars.example terraform.tfvars   # edit cert_email etc.
terraform init -backend-config="bucket=<STATE_BUCKET>" -backend-config="prefix=openshell/gke"
terraform plan && terraform apply
```

**Existing cluster already deployed?** Follow [`IMPORT.md`](./IMPORT.md) first —
it adopts the live resources into remote state so the plan stays empty.

## Start / stop

`.github/workflows/openshell-cluster-power.yml` scales the node pool:
`stop` → min 0 / max 8 (zero node cost, control plane + gateway IP remain;
pending sandbox pods auto-wake capacity), `start` → min 2 / max 8.
Manual via `gh workflow run openshell-cluster-power.yml -f action=stop`.
The nightly IST schedule is opt-in via repo variable
`OPENSHELL_CLUSTER_AUTOSTOP=true` and authenticates as `GCP_DEPLOYER_SA`
(`gh-deployer`), which `deploy/gcp/bootstrap.sh` grants `roles/container.admin`.

## Known hardening TODOs

- `master_authorized_networks_cidr` is `0.0.0.0/0` (matches live). Restrict to
  operator/CI egress ranges.
- `data.http` for the agent-sandbox manifest tracks `latest`; pin a release URL
  before using this for greenfield installs.
- Node pool runs on the default compute service account; switch to a
  dedicated SA with least-privilege (`logging.logWriter`, `metrics.writer`,
  `monitoring.viewer`, `monitoring.agent`) plus Workload Identity bindings.
