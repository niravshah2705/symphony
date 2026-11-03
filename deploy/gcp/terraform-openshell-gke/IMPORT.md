# One-time adoption runbook (IMPORT.md)

The live resources below already exist. This module adopts them into a new
GCS-backed state; **do not** blindly `apply` without the import pass. The old
local state in `~/git/OpenShell/deploy/terraform/gke/terraform.tfstate` is an
archive — never re-apply from that folder once this module is authoritative.

## 1. Init with a remote bucket

```bash
cd deploy/gcp/terraform-openshell-gke
cp terraform.tfvars.example terraform.tfvars   # set cert_email etc.
terraform init \
  -backend-config="bucket=<YOUR_TF_STATE_BUCKET>" \
  -backend-config="prefix=openshell/gke"
```

## 2. Import with `import` blocks (Terraform >= 1.5)

Add an `imports.tf` (temporary) with blocks like these, run `terraform plan`,
review that **no resource shows a create or destroy**, then `terraform apply`:

```hcl
# --- GCP ---
import {
  id = "projects/adlc-9e72f/regions/asia-south1/subnetworks/openshell-subnet"
  to = google_compute_subnetwork.openshell_subnet
}
import {
  id = "projects/adlc-9e72f/regions/asia-south1/routers/openshell-router"
  to = google_compute_router.router
}
import {
  id = "projects/adlc-9e72f/regions/asia-south1/routers/openshell-router/nats/openshell-nat"
  to = google_compute_router_nat.nat
}
import {
  id = "projects/adlc-9e72f/regions/asia-south1/addresses/openshell-ip"
  to = google_compute_address.openshell_ip
}
import {
  id = "projects/adlc-9e72f/global/firewalls/openshell-allow-http-https"
  to = google_compute_firewall.allow_http_https
}
import {
  id = "projects/adlc-9e72f/locations/asia-south1-a/clusters/openshell-multitenant"
  to = google_container_cluster.primary
}
import {
  id = "projects/adlc-9e72f/locations/asia-south1-a/clusters/openshell-multitenant/nodePools/openshell-multitenant-node-pool"
  to = google_container_node_pool.primary_nodes
}

# --- Namespaces (id = <name>) ---
# kubernetes_namespace_v1.openshell / openshell_credentials / cert_manager /
# envoy_gateway_system / tenants["tenant-a"] / tenants["tenant-b"]

# --- Helm (id = <namespace>/<release>) ---
# helm_release.envoy_gateway   -> "envoy-gateway-system/eg"
# helm_release.cert_manager    -> "cert-manager/cert-manager"
# helm_release.openshell       -> "openshell/openshell"
# helm_release.tenant_workspace["tenant-a"] -> "tenant-a/openshell-workspace-tenant-a"
# helm_release.tenant_workspace["tenant-b"] -> "tenant-b/openshell-workspace-tenant-b"

# --- K8s objects (id = <namespace>/<name>) ---
# kubernetes_network_policy_v1.tenant_default_deny / tenant_allow_dns,
# kubernetes_resource_quota_v1.tenant_quota, kubernetes_limit_range_v1.tenant_limit_range,
# kubernetes_role_v1.tenant_admin, kubernetes_role_binding_v1.tenant_admins (per tenant)

# --- kubectl_manifest (id = apiVersion//kind//name[//namespace]; >=1.19) ---
# Double-slash delimited. e.g. "gateway.networking.k8s.io/v1//GatewayClass//eg"
# for kubectl_manifest.gateway_class; cluster-scoped objects omit the namespace
# slot entirely.
```

## 3. Converge & verify

```bash
terraform plan   # must be empty (or only benign in-place updates)
terraform apply
rm imports.tf    # adoption done
```

Resources that fail to import (`kubectl_manifest.agent_sandbox` is the likely
one, since its spec derives from a `latest` URL fetched at plan time): delete
just that import block and let the apply re-converge the manifest — it is a
declarative, idempotent server-side apply, so no cluster disruption occurs.

## 4. Spot checks after adoption

```bash
helm list -A                                   # 5 releases, same versions
kubectl get ns -l openshell.ai/workspace-allowed=true
openshell status                               # gRPC through https://openshell.archagentix.com
node -e 'require("./packages/shared-core/src/agent/openshell.js")
  .getOpenShellStatus({url:"https://openshell.archagentix.com",workspace:"tenant-a"})
  .then(r=>console.log(JSON.stringify(r)))'    # docs/OPENSHELL_INTEGRATION.md Test 1.3
```
