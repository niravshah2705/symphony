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

output "stream_token_broker_uri" {
  description = "Private stream-token broker URL. Only gateway-sa may invoke its mint/verify RPCs through Cloud Run IAM."
  value       = google_cloud_run_v2_service.stream_token_broker.uri
}

output "stream_token_legacy_gateway_secret_access_enabled" {
  description = "Migration warning: true means gateway-sa temporarily retains direct access to stream-token-secret for unreconciled tenant sidecars. The completed isolation state is false."
  value       = var.stream_token_legacy_gateway_secret_access
}

output "planner_uri" {
  description = "Planner URL — IAM-gated (no allUsers invoker); only gateway-sa and pubsub-push-sa can call it via OIDC."
  value       = google_cloud_run_v2_service.planner.uri
}

output "coder_control_uri" {
  description = "Coder-control URL — IAM-gated (no allUsers invoker); only gateway-sa and pubsub-push-sa can call it via OIDC."
  value       = google_cloud_run_v2_service.coder_control.uri
}

output "pipeline_orchestrator_uri" {
  description = "IAM-gated durable pipeline control-plane URL (null while the rollout flag is off)."
  value       = one(google_cloud_run_v2_service.orchestrator[*].uri)
}

output "pipeline_tester_uri" {
  description = "IAM-gated brokered tester URL (null while the rollout flag is off)."
  value       = one(google_cloud_run_v2_service.tester[*].uri)
}

output "pipeline_deployer_uri" {
  description = "IAM-gated brokered deployer URL (null while the rollout flag is off)."
  value       = one(google_cloud_run_v2_service.deployer[*].uri)
}

output "pipeline_topics" {
  description = "Dedicated durable pipeline topics. Empty while the rollout flag is off."
  value = var.pipeline_orchestrator_enabled ? {
    plan           = google_pubsub_topic.pipeline_plan[0].name
    code           = google_pubsub_topic.pipeline_code[0].name
    test           = google_pubsub_topic.pipeline_test[0].name
    deploy         = google_pubsub_topic.pipeline_deploy[0].name
    plan_results   = google_pubsub_topic.pipeline_results["plan"].name
    code_results   = google_pubsub_topic.pipeline_results["code"].name
    test_results   = google_pubsub_topic.pipeline_results["test"].name
    deploy_results = google_pubsub_topic.pipeline_results["deploy"].name
  } : {}
}

output "settings_operator_url" {
  description = "IAM-gated settings URL used by the direct operator CLI. This is never granted to allUsers."
  value       = google_cloud_run_v2_service.settings.uri
}

output "email_service_uri" {
  description = "Shared transactional email service URL — internal and Pub/Sub-invoked only."
  value       = google_cloud_run_v2_service.email.uri
}

output "email_topic_name" {
  description = "Pub/Sub topic that accepts allow-listed transactional email jobs."
  value       = google_pubsub_topic.email.name
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
  description = "Terraform-created GCS bucket holding versioned agent-skill bundles (null when skills_enabled = false). Name defaults to '<project_id>-aifleet-skills'. Mounted read-only on planner + coder at /skills; the runtime pins var.skills_version. The CI publish workflow targets this same name."
  value       = one(google_storage_bucket.skills[*].name)
}

output "skills_version_pinned" {
  description = "Skills bundle version the planner/coder currently pin (SKILLS_VERSION). Bump var.skills_version after publishing a new bundle to roll the deployment forward."
  value       = local.skills_enabled ? var.skills_version : null
}

output "registry_bucket" {
  description = "Terraform-created GCS bucket holding versioned harness-native rootfs artifacts, v2 descriptors, and inert resources (null when registry_enabled = false). Fixed name from var.registry_bucket_name (default 'aifleet-registry')."
  value       = one(google_storage_bucket.registry[*].name)
}

output "artifact_registry_repo" {
  description = "Artifact Registry Docker repo path (images are pushed here as <repo>/<service>:<tag>)."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker.repository_id}"
}
