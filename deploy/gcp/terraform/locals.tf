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

  # Labels merged onto every labelable resource. Each resource additionally sets
  # a `component` label (e.g. gateway/planner/spa) so billing can be broken down
  # per component in the console's cost-by-label view / BigQuery billing export.
  common_labels = merge(var.labels, { environment = var.environment, tenancy = "shared" })

  # Skills registry (skills.tf). Terraform CREATES the bucket; the name defaults to
  # a stable derived value so the operator no longer pre-creates it. An empty
  # var.skills_bucket_name (the default) → derived "<project_id>-aifleet-skills";
  # a non-empty value is an explicit override. The same name is used by the CI
  # publish workflow (derived the same way) — no repo-var dependency for the name.
  skills_bucket_name = var.skills_bucket_name != "" ? var.skills_bucket_name : "${var.project_id}-aifleet-skills"

  # Artifact Registry image references. Each service resolves its own tag,
  # falling back to var.image_tag when no per-service override is set — this is
  # what lets the CD pipeline roll ONE service (its tag = new SHA) while every
  # other service keeps its currently-deployed tag, making apply a no-op for them.
  image_base   = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_repo}"
  gateway_tag  = var.gateway_image_tag != "" ? var.gateway_image_tag : var.image_tag
  planner_tag  = var.planner_image_tag != "" ? var.planner_image_tag : var.image_tag
  coder_tag    = var.coder_image_tag != "" ? var.coder_image_tag : var.image_tag
  org_tag      = var.org_image_tag != "" ? var.org_image_tag : var.image_tag
  settings_tag = var.settings_image_tag != "" ? var.settings_image_tag : var.image_tag
  proxy_tag    = var.proxy_image_tag != "" ? var.proxy_image_tag : var.image_tag

  gateway_image  = "${local.image_base}/${var.gateway_service_name}:${local.gateway_tag}"
  planner_image  = "${local.image_base}/${var.planner_service_name}:${local.planner_tag}"
  coder_image    = "${local.image_base}/${var.coder_service_name}:${local.coder_tag}"
  org_image      = "${local.image_base}/${var.org_service_name}:${local.org_tag}"
  settings_image = "${local.image_base}/${var.settings_service_name}:${local.settings_tag}"
  proxy_image    = "${local.image_base}/${var.proxy_service_name}:${local.proxy_tag}"

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
  org_url        = "https://${var.org_service_name}-${local.run_url_suffix}"
  settings_url   = "https://${var.settings_service_name}-${local.run_url_suffix}"

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
    # The shared config (packages/shared/src/config.js) requires AUTH_MODE=firebase
    # when NODE_ENV=production and validates the Firebase web config at load. Only
    # the gateway actually enforces app-auth, but planner/coder/worker import the
    # same config, so they must satisfy the guard too. The Firebase web config is
    # PUBLIC (not a secret); internal services build it but never use it.
    AUTH_MODE           = "firebase"
    FIREBASE_PROJECT_ID = var.project_id
    FIREBASE_API_KEY    = data.google_firebase_web_app_config.default.api_key
  }
}
