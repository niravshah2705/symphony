output "cluster_name" {
  description = "The GKE cluster name"
  value       = google_container_cluster.primary.name
}

output "cluster_endpoint" {
  description = "Public endpoint of the GKE control plane"
  value       = google_container_cluster.primary.endpoint
}

output "static_external_ip" {
  description = "Reserved static IP used by the Envoy Gateway load balancer"
  value       = google_compute_address.openshell_ip.address
}

output "openshell_url" {
  description = "Public HTTPS URL of the OpenShell gateway"
  value       = "https://${var.domain}"
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

output "dns_setup_instructions" {
  description = "DNS requirement for the gateway domain"
  value       = "A record: ${var.domain} -> ${google_compute_address.openshell_ip.address}"
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

