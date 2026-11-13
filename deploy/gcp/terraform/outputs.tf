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

output "identity_service_uri" {
  description = "Identity verification service URL — internal and gateway-invoked only."
  value       = google_cloud_run_v2_service.identity.uri
}

output "billing_service_uri" {
  description = "Billing and Cashfree service URL — internal and gateway-invoked only."
  value       = google_cloud_run_v2_service.billing.uri
}

output "laya_service_uri" {
  description = "Laya decision model inference service URL — internal only."
  value       = google_cloud_run_v2_service.laya.uri
}

output "clm_service_uri" {
  description = "CLM contrastive inference service URL — internal only."
  value       = google_cloud_run_v2_service.clm.uri
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

output "memory_db_instance" {
  description = "Terraform-created Cloud SQL Postgres instance holding AI-compressed agent memories (null when memory_enabled = false). Name defaults to '<project_id>-aifleet-memory'."
  value       = one(google_sql_database_instance.memory[*].name)
}

output "memory_db_connection_name" {
  description = "Cloud SQL connection name (project:region:instance) the planner/coder mount as the /cloudsql unix socket."
  value       = one(google_sql_database_instance.memory[*].connection_name)
}

output "artifact_registry_repo" {
  description = "Artifact Registry Docker repo path (images are pushed here as <repo>/<service>:<tag>)."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker.repository_id}"
}

output "observability_log_bucket" {
  description = "GCS bucket holding the durable export of the fleet's structured logs, including every balance-threshold crossing (null when observability_enabled = false). Retired after var.observability_log_retention_days."
  value       = one(google_storage_bucket.observability_logs[*].name)
}

output "observability_log_sink_writer" {
  description = "The identity every observability sink writes the bucket as, and the member holding storage.objectCreator on it. Google-managed, so it is reported rather than created here."
  value       = local.observability_enabled ? local.observability_log_writer : null
}

output "observability_metrics" {
  description = "Log-based metric names created in this project (logging.googleapis.com/user/<name>). Empty when observability is off, or when the balance thresholds arrived as an empty list. The keys are what the alert policies and any dashboard must reference."
  value       = sort(keys(google_logging_metric.observability))
}

output "observability_alert_policies" {
  description = "Display names of the alerting policies actually created. Empty with a non-empty observability_metrics list means var.observability_notification_channels is empty — the signals are collected but nothing will tell anyone."
  value       = sort([for policy in google_monitoring_alert_policy.observability : policy.display_name])
}

output "substrate" {
  description = "What this root told its services about the substrate control plane. configured=false means no SUBSTRATE_* env was emitted at all and the pattern is inert, which is the default; the routing keys are reported so an operator can see which organizations a shared deployment will actually place, and a binding that resolves elsewhere shows up here instead of only as a mid-run refusal. actor_endpoint=false while substrate_actor_mode=true means one of the four gate conditions failed, and actor_invoker shows whether anyone was named who is allowed to call at all."
  value = {
    configured        = local.substrate_enabled
    url               = var.substrate_url
    ingress_url       = var.substrate_ingress_url
    atespace          = var.substrate_atespace
    allowed_atespaces = var.substrate_allowed_atespaces
    atespace_by_org   = var.substrate_atespace_by_org
    worker_pool       = var.substrate_worker_pool
    actor_endpoint    = length(local.substrate_actor_env) > 0
    actor_invoker     = var.substrate_actor_member
    env_keys          = sort(keys(local.substrate_env))
    services          = local.substrate_enabled ? ["planner", "coder-control", "provisioner"] : []
  }
}

output "environment_init" {
  description = "The login-triggered environment-initialization switch as the org service will see it, plus the split that makes it safe to turn on: the receiver (topic, push subscription, provisioner service) exists for init, provisioner_enabled or provisioning_enabled, while the project-wide tenant-stack roles exist only for provisioning_enabled. receiver_exists and stack_roles_granted differ by design; equal means someone switched on more than they meant to."
  value = {
    enabled             = var.environment_init_enabled
    provisioning_topic  = var.provisioning_topic
    receiver_exists     = local.tenant_jobs_on
    org_can_publish     = local.tenant_jobs_on
    stack_roles_granted = local.provisioning_on
    steps               = ["org.seed", "org.atespace.bind", "substrate.atespace", "deploy.stack"]
  }
}

output "billing_jobs" {
  description = "Billing Cloud Run Job and Cloud Scheduler job names, keyed by job."
  value = {
    for k, j in google_cloud_run_v2_job.billing : k => {
      job       = j.name
      scheduler = google_cloud_scheduler_job.billing_job[k].name
    }
  }
}
