output "cluster_name" {
  description = "The GKE cluster name"
  value       = google_container_cluster.primary.name
}

output "cluster_endpoint" {
  description = "Public endpoint of the GKE control plane"
  value       = google_container_cluster.primary.endpoint
}

output "node_pool_name" {
  description = "Node pool scaled by the start/stop workflow"
  value       = google_container_node_pool.primary_nodes.name
}

output "tenant_namespaces" {
  description = "Atespace -> organization-id, as provisioned by this root"
  value       = local.tenants
}

output "get_credentials_command" {
  description = "Configure kubectl for this cluster"
  value       = "gcloud container clusters get-credentials ${google_container_cluster.primary.name} --zone ${var.zone} --project ${var.project_id}"
}

# ---------------------------------------------------------------------------
# Agent Substrate outputs (empty unless substrate_enabled)
# ---------------------------------------------------------------------------

output "substrate_enabled" {
  description = "Whether the Substrate substrate resources were provisioned"
  value       = var.substrate_enabled
}

output "substrate_worker_pool" {
  description = "Dedicated Substrate worker node pool name"
  value       = var.substrate_enabled ? google_container_node_pool.substrate_nodes[0].name : null
}

output "substrate_credentials_namespace" {
  description = "Namespace the credential-provider Secrets live in"
  value       = var.substrate_enabled ? kubernetes_namespace_v1.substrate_credentials[0].metadata[0].name : null
}

output "substrate_ingress_ip" {
  description = "Static IP of the Substrate Envoy data plane; the A record target for substrate_ingress_hostname"
  value       = var.substrate_enabled && var.substrate_ingress_hostname != "" ? google_compute_address.substrate_ip[0].address : null
}

output "substrate_ingress_dns" {
  description = "DNS record to create so the ingress hostname serves the Envoy data plane"
  value       = var.substrate_enabled && var.substrate_ingress_hostname != "" ? "A record: ${var.substrate_ingress_hostname} -> ${google_compute_address.substrate_ip[0].address}" : null
}

output "substrate_ingress_url" {
  description = "Backend substrateIngressUrl value (atenet-router front)"
  value       = var.substrate_enabled && var.substrate_ingress_hostname != "" ? "https://${var.substrate_ingress_hostname}" : null
}

output "substrate_control_plane_url" {
  description = "Backend substrateUrl value when the ateapi route is published on the same host; null means reach ateapi over VPC egress instead"
  value       = var.substrate_enabled && var.substrate_ingress_hostname != "" && var.substrate_control_plane_public ? "https://${var.substrate_ingress_hostname}" : null
}

output "substrate_snapshot_storage_class" {
  description = "StorageClass bound into the Substrate WorkerPool for actor snapshots"
  value       = var.substrate_enabled ? kubernetes_storage_class_v1.substrate_snapshots[0].metadata[0].name : null
}


# ---------------------------------------------------------------------------
# agentgateway outputs (empty unless agentgateway_enabled)
#
# Two addresses, for two different callers, and the difference is the whole
# point: `agentgateway_url` is what the Cloud Run egress sidecar can put in
# AGENTGATEWAY_PROXY_UPSTREAM (only when a public front exists — a ClusterIP
# origin is unroutable from Cloud Run, so the null here is the reason Stage F
# ships dark), while agentgateway_cluster_origin is for a caller already inside
# the VPC (an actor, a job). Picking the wrong one is a 502 that reads like a
# gateway bug.
# ---------------------------------------------------------------------------

output "agentgateway_enabled" {
  description = "Whether the agentgateway control plane was provisioned"
  value       = var.agentgateway_enabled
}

output "agentgateway_url" {
  description = "Origin for deploy/gcp/terraform's agentgateway_proxy_upstream; null means no public front, so the /agentgw route must stay dark"
  value       = local.agentgateway_front ? "https://${var.agentgateway_ingress_hostname}" : null
}

output "agentgateway_cluster_origin" {
  description = "In-cluster origin of the gateway data plane (Service is named after the Gateway); for VPC-resident callers only"
  value       = var.agentgateway_enabled ? "http://${var.agentgateway_gateway_name}.${var.agentgateway_namespace}.svc.cluster.local:${local.agentgateway_llm_listener.port}" : null
}

output "agentgateway_ingress_ip" {
  description = "Static IP of the agentgateway data plane; the A record target for agentgateway_ingress_hostname"
  value       = local.agentgateway_front ? google_compute_address.agentgateway_ip[0].address : null
}

output "agentgateway_ingress_dns" {
  description = "DNS record to create so the gateway hostname serves its own data plane (the Certificate will not issue until it resolves)"
  value = local.agentgateway_front ? (
    "A record: ${var.agentgateway_ingress_hostname} -> ${google_compute_address.agentgateway_ip[0].address}"
  ) : null
}

output "agentgateway_a2a_status" {
  description = "What the /a2a listener enforces; a reminder that the seam is deliberately closed until there is a second party"
  value = var.agentgateway_enabled ? (
    "deny-all: no backends, no agent cards; a valid org key 403s and a missing key 401s"
  ) : null
}
