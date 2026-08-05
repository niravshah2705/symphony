# -----------------------------------------------------------------------------
# Derived values
# -----------------------------------------------------------------------------

data "google_project" "this" {
  project_id = var.project_id
}

locals {
  # Project number backs both the Pub/Sub service agent identity and Cloud Run's
  # deterministic URL format.
  project_number = data.google_project.this.number

  # Artifact Registry image references (Cloud Build supplies var.image_tag).
  image_base    = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_repo}"
  gateway_image = "${local.image_base}/${var.gateway_service_name}:${var.image_tag}"
  planner_image = "${local.image_base}/${var.planner_service_name}:${var.image_tag}"
  coder_image   = "${local.image_base}/${var.coder_service_name}:${var.image_tag}"

  # Cloud Run's deterministic per-project URL:
  #   https://<service>-<project_number>.<region>.run.app
  # Using this (instead of each service's own .uri) lets a service reference its
  # OWN url in its OWN env — e.g. PUBSUB_PUSH_AUDIENCE = the service's URL —
  # without a Terraform self-reference cycle, and keeps the push-subscription and
  # scheduler OIDC audiences identical to what the service expects.
  # If your project still gets legacy hash-style run.app URLs, set the relevant
  # override variable (api_base_url) and adjust as needed.
  run_url_suffix = "${local.project_number}.${var.region}.run.app"
  gateway_url    = var.api_base_url != "" ? var.api_base_url : "https://${var.gateway_service_name}-${local.run_url_suffix}"
  planner_url    = "https://${var.planner_service_name}-${local.run_url_suffix}"
  coder_url      = "https://${var.coder_service_name}-${local.run_url_suffix}"

  # Pub/Sub's Google-managed service agent — needs publisher on the dead-letter
  # topic, subscriber on the source subscriptions, and token-creator on the push
  # service account so it can mint OIDC push tokens.
  pubsub_agent = "serviceAccount:service-${local.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"

  # Env shared by every service/job (packages/shared/src/config.js cloud profile).
  common_env = {
    NODE_ENV             = "production"
    STORE_BACKEND        = "firestore"
    MESSAGING_MODE       = "pubsub"
    EVENTS_BACKEND       = "firestore"
    GCP_PROJECT_ID       = var.project_id
    GCP_REGION           = var.region
    PUBSUB_PLANNER_TOPIC = var.planner_topic
    PUBSUB_CODER_TOPIC   = var.coder_topic
    AI_FLEET_DATA_DIR    = "/tmp"
  }
}
