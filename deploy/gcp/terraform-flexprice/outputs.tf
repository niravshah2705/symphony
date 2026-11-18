# ---------------------------------------------------------------------------
# Outputs. Everything a caller needs to point at this stack, and the one line
# that tells the operator what they still owe.
# ---------------------------------------------------------------------------

locals {
  # The URL an outside caller uses. With no hostname there is no public front, so
  # there is no URL to hand out — an empty string here is the honest answer, and
  # the billing service must not be pointed at a cluster-internal DNS name it
  # cannot resolve.
  flexprice_base_url = local.flexprice_front_enabled ? "https://${var.ingress_hostname}" : ""
}

output "flexprice_namespace" {
  description = "Namespace the three releases live in."
  value       = var.flexprice_enabled ? kubernetes_namespace_v1.flexprice[0].metadata[0].name : ""
}

output "flexprice_api_service" {
  description = "In-cluster address of the FlexPrice API. What a caller inside this VPC cluster uses."
  value       = var.flexprice_enabled ? "http://flexprice-api.${var.namespace}.svc.cluster.local:80" : ""
}

output "flexprice_ingress_ip" {
  description = "Regional static address for the public front. Create the A record for var.ingress_hostname at this IP; nothing in this repo writes Cloud DNS."
  value       = local.flexprice_front_enabled ? google_compute_address.flexprice_ip[0].address : ""
}

output "flexprice_base_url" {
  description = "The URL to give the root stack's flexprice_base_url variable. Empty while no hostname is configured."
  value       = local.flexprice_base_url
}

# The operator's action item, as output rather than as a line in a README they
# have to find. Certificate issuance is pending on this and nothing else: the
# Certificate reports a Ready condition that says nothing useful until the record
# resolves, and the symptom an operator sees is a hostname that never serves.
output "flexprice_dns_hint" {
  description = "The DNS record that must exist before the front works, in one line."
  value = local.flexprice_front_enabled ? (
    "A record: ${var.ingress_hostname} -> ${google_compute_address.flexprice_ip[0].address} (region ${var.region}, TTL 300). Until it resolves, HTTP-01 cannot be answered and flexprice_base_url serves nothing."
    ) : (
    "No public front: set ingress_hostname to get an address, an Issuer, a Certificate and a Gateway."
  )
}

output "flexprice_releases" {
  description = "The three Helm releases, their chart version and revision. For a reconcile that stopped converging: version says which staged chart landed, revision says how many times."
  value = var.flexprice_enabled ? {
    infra = {
      chart    = helm_release.flexprice_infra[0].metadata[0].version
      revision = helm_release.flexprice_infra[0].metadata[0].revision
    }
    migration = {
      chart    = helm_release.flexprice_migration[0].metadata[0].version
      revision = helm_release.flexprice_migration[0].metadata[0].revision
    }
    app = {
      chart    = helm_release.flexprice_app[0].metadata[0].version
      revision = helm_release.flexprice_app[0].metadata[0].revision
    }
    # What the chart's own app_version reports. `1.0.0` for every 1.10.x chart,
    # so it is NOT a check on which FlexPrice binary is running — image_digest
    # is. Surfaced anyway because a release whose app_version moved is a chart
    # whose templates moved too.
    app_version = helm_release.flexprice_app[0].metadata[0].app_version
  } : {}
}

output "flexprice_secret_ids" {
  description = "Secret Manager ids whose VALUES the CI job seeds. Names only — no version, no material ever appears here or in state."
  value       = var.flexprice_enabled ? { for k, s in google_secret_manager_secret.flexprice : k => s.secret_id } : {}
}

output "flexprice_node_pool" {
  description = "The dedicated pool. Recorded so a reviewer can confirm it is not one of the names the substrate power workflow parks."
  value       = var.flexprice_enabled ? google_container_node_pool.flexprice[0].name : ""
}
