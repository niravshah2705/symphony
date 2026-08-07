# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "gateway_uri" {
  description = "Public gateway URL (Cloud Run assigned). Cloud Build injects this into the SPA's config.js as window.__API_BASE__."
  value       = google_cloud_run_v2_service.gateway.uri
}

output "gateway_url_deterministic" {
  description = "Deterministic gateway URL used for API_BASE_URL / OIDC audiences. Equals gateway_uri on projects using the per-project-number run.app format."
  value       = local.gateway_url
}

output "planner_uri" {
  description = "Planner URL — IAM-gated (no allUsers invoker); only gateway-sa and pubsub-push-sa can call it via OIDC."
  value       = google_cloud_run_v2_service.planner.uri
}

output "coder_control_uri" {
  description = "Coder-control URL — IAM-gated (no allUsers invoker); only gateway-sa and pubsub-push-sa can call it via OIDC."
  value       = google_cloud_run_v2_service.coder_control.uri
}

output "coder_worker_job" {
  description = "Cloud Run Job name launched per ticket by coder-control."
  value       = google_cloud_run_v2_job.coder_worker.name
}

output "spa_bucket" {
  description = "GCS bucket hosting the SPA."
  value       = google_storage_bucket.spa.name
}

output "spa_public_url" {
  description = "Public URL of the SPA entry point."
  value       = "https://storage.googleapis.com/${google_storage_bucket.spa.name}/index.html"
}

output "spa_website_url" {
  description = "GCS website endpoint (serves index.html for unknown paths for SPA routing)."
  value       = "http://${google_storage_bucket.spa.name}.storage.googleapis.com"
}

output "skills_bucket" {
  description = "GCS bucket holding versioned agent-skill bundles (null when the skills registry is disabled). Mounted read-only on planner + coder at /skills; the runtime pins var.skills_version."
  value       = one(google_storage_bucket.skills[*].name)
}

output "skills_version_pinned" {
  description = "Skills bundle version the planner/coder currently pin (SKILLS_VERSION). Bump var.skills_version after publishing a new bundle to roll the deployment forward."
  value       = local.skills_enabled ? var.skills_version : null
}

output "artifact_registry_repo" {
  description = "Artifact Registry Docker repo path (images are pushed here as <repo>/<service>:<tag>)."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker.repository_id}"
}
