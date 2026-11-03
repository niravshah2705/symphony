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
  description = "Configured tenant namespaces"
  value       = var.tenants
}

output "get_credentials_command" {
  description = "Configure kubectl for this cluster"
  value       = "gcloud container clusters get-credentials ${google_container_cluster.primary.name} --zone ${var.zone} --project ${var.project_id}"
}

output "dns_setup_instructions" {
  description = "DNS requirement for the gateway domain"
  value       = "A record: ${var.domain} -> ${google_compute_address.openshell_ip.address}"
}
