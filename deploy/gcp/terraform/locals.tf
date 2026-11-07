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

  # Laya checkpoint registry (laya_models.tf) — same derived-default-with-
  # override convention; the publish-laya-models CI workflow derives the same name.
  laya_models_bucket_name = var.laya_models_bucket_name != "" ? var.laya_models_bucket_name : "${var.project_id}-aifleet-laya-models"

  # Chat attachments bucket (gcs_attachments.tf) — same derived-default-with-
  # override convention as the skills bucket above.
  attachments_bucket_name = var.attachments_bucket_name != "" ? var.attachments_bucket_name : "${var.project_id}-aifleet-attachments"

  # Agent memory Cloud SQL instance (memory.tf) — same derived-default-with-
  # override convention. Instance names must be lowercase alphanumeric/hyphen
  # and unique within the project.
  memory_db_instance_name = var.memory_db_instance_name != "" ? var.memory_db_instance_name : "${var.project_id}-aifleet-memory"

  # Artifact Registry image references. Each service resolves its own tag,
  # falling back to var.image_tag when no per-service override is set — this is
  # what lets the CD pipeline roll ONE service (its tag = new SHA) while every
  # other service keeps its currently-deployed tag, making apply a no-op for them.
  image_base       = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_repo}"
  gateway_tag      = var.gateway_image_tag != "" ? var.gateway_image_tag : var.image_tag
  planner_tag      = var.planner_image_tag != "" ? var.planner_image_tag : var.image_tag
  coder_tag        = var.coder_image_tag != "" ? var.coder_image_tag : var.image_tag
  orchestrator_tag = var.orchestrator_image_tag != "" ? var.orchestrator_image_tag : var.image_tag
  tester_tag       = var.tester_image_tag != "" ? var.tester_image_tag : var.image_tag
  deployer_tag     = var.deployer_image_tag != "" ? var.deployer_image_tag : var.image_tag
  org_tag          = var.org_image_tag != "" ? var.org_image_tag : var.image_tag
  settings_tag     = var.settings_image_tag != "" ? var.settings_image_tag : var.image_tag
  email_tag        = var.email_image_tag != "" ? var.email_image_tag : var.image_tag
  identity_tag     = var.identity_image_tag != "" ? var.identity_image_tag : var.image_tag
  billing_tag      = var.billing_image_tag != "" ? var.billing_image_tag : var.image_tag
  proxy_tag        = var.proxy_image_tag != "" ? var.proxy_image_tag : var.image_tag
  laya_tag         = var.laya_image_tag != "" ? var.laya_image_tag : var.image_tag
  clm_tag          = var.clm_image_tag != "" ? var.clm_image_tag : var.image_tag

  gateway_image      = "${local.image_base}/${var.gateway_service_name}:${local.gateway_tag}"
  planner_image      = "${local.image_base}/${var.planner_service_name}:${local.planner_tag}"
  coder_image        = "${local.image_base}/${var.coder_service_name}:${local.coder_tag}"
  orchestrator_image = "${local.image_base}/${var.orchestrator_service_name}:${local.orchestrator_tag}"
  tester_image       = "${local.image_base}/${var.tester_service_name}:${local.tester_tag}"
  deployer_image     = "${local.image_base}/${var.deployer_service_name}:${local.deployer_tag}"
  org_image          = "${local.image_base}/${var.org_service_name}:${local.org_tag}"
  settings_image     = "${local.image_base}/${var.settings_service_name}:${local.settings_tag}"
  email_image        = "${local.image_base}/${var.email_service_name}:${local.email_tag}"
  identity_image     = "${local.image_base}/${var.identity_service_name}:${local.identity_tag}"
  billing_image      = "${local.image_base}/${var.billing_service_name}:${local.billing_tag}"
  proxy_image        = "${local.image_base}/${var.proxy_service_name}:${local.proxy_tag}"
  laya_image         = "${local.image_base}/${var.laya_service_name}:${local.laya_tag}"
  clm_image          = "${local.image_base}/${var.clm_service_name}:${local.clm_tag}"

  # Cloud Run's deterministic per-project URL:
  #   https://<service>-<project_number>.<region>.run.app
  # Using this (instead of each service's own .uri) lets a service reference its
  # OWN url in its OWN env — e.g. PUBSUB_PUSH_AUDIENCE = the service's URL —
  # without a Terraform self-reference cycle, and keeps the push-subscription and
  # scheduler OIDC audiences identical to what the service expects.
  # If your project still gets legacy hash-style run.app URLs, set the relevant
  # override variable (api_base_url) and adjust as needed.
  run_url_suffix   = "${local.project_number}.${var.region}.run.app"
  gateway_url      = var.api_base_url != "" ? var.api_base_url : "https://${var.gateway_service_name}-${local.run_url_suffix}"
  planner_url      = "https://${var.planner_service_name}-${local.run_url_suffix}"
  coder_url        = "https://${var.coder_service_name}-${local.run_url_suffix}"
  orchestrator_url = "https://${var.orchestrator_service_name}-${local.run_url_suffix}"
  tester_url       = "https://${var.tester_service_name}-${local.run_url_suffix}"
  deployer_url     = "https://${var.deployer_service_name}-${local.run_url_suffix}"
  org_url          = "https://${var.org_service_name}-${local.run_url_suffix}"
  settings_url     = "https://${var.settings_service_name}-${local.run_url_suffix}"
  email_url        = "https://${var.email_service_name}-${local.run_url_suffix}"
  identity_url     = "https://${var.identity_service_name}-${local.run_url_suffix}"
  billing_url      = "https://${var.billing_service_name}-${local.run_url_suffix}"
  laya_url         = "https://${var.laya_service_name}-${local.run_url_suffix}"
  clm_url          = "https://${var.clm_service_name}-${local.run_url_suffix}"

  # Pub/Sub's Google-managed service agent — needs publisher on the dead-letter
  # topic, subscriber on the source subscriptions, and token-creator on the push
  # service account so it can mint OIDC push tokens.
  pubsub_agent = "serviceAccount:service-${local.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"

  # Env shared by every service/job (packages/shared/src/config.js cloud profile).
  common_env = merge({
    NODE_ENV                      = "production"
    STORE_BACKEND                 = "firestore"
    MESSAGING_MODE                = "pubsub"
    EVENTS_BACKEND                = "firestore"
    GCP_PROJECT_ID                = var.project_id
    GCP_REGION                    = var.region
    PUBSUB_PLANNER_TOPIC          = var.planner_topic
    PUBSUB_CODER_TOPIC            = var.coder_topic
    PUBSUB_PIPELINE_PLAN_TOPIC    = var.pipeline_plan_topic
    PUBSUB_PIPELINE_CODE_TOPIC    = var.pipeline_code_topic
    PUBSUB_PIPELINE_TEST_TOPIC    = var.pipeline_test_topic
    PUBSUB_PIPELINE_DEPLOY_TOPIC  = var.pipeline_deploy_topic
    PIPELINE_ORCHESTRATOR_ENABLED = tostring(var.pipeline_orchestrator_enabled)
    PIPELINE_DEPLOYMENT_ENABLED   = tostring(var.pipeline_deployment_enabled)
    AI_FLEET_DATA_DIR             = "/tmp"
    # One JSON object per stdout line (packages/shared-core/src/logger.js). This is
    # NOT cosmetic and not optional: Cloud Logging only builds `jsonPayload` from a
    # line it can parse as JSON, so every log-based metric filter in
    # observability.tf — and therefore every egress / cost / balance alert — is
    # permanently, silently zero on a text-formatted deployment. Local dev keeps
    # the human-readable default by leaving the variable unset.
    LOG_FORMAT = "json"
    # The shared config (packages/shared/src/config.js) requires AUTH_MODE=firebase
    # when NODE_ENV=production and validates the Firebase web config at load. Only
    # the gateway actually enforces app-auth, but planner/coder/worker import the
    # same config, so they must satisfy the guard too. The Firebase web config is
    # PUBLIC (not a secret); internal services build it but never use it.
    AUTH_MODE           = "firebase"
    FIREBASE_PROJECT_ID = var.project_id
    FIREBASE_API_KEY    = data.google_firebase_web_app_config.default.api_key
    # Langfuse Cloud tracing (packages/shared/src/agent/langfuse.js). Both values
    # are PUBLIC config — the ingest key pair is resolved by the egress sidecar, so
    # no agent container receives it. `environment` partitions dev/staging/prod
    # traffic inside the one managed project; the base URL only changes data region
    # (or a self-hosted instance) and stays at the code default when unset.
    LANGFUSE_ENVIRONMENT = var.langfuse_environment
    },
    # Optional data-region / self-hosted override, set only when configured so the
    # code default (https://cloud.langfuse.com) applies otherwise.
    trimspace(var.langfuse_base_url) != "" ? { LANGFUSE_BASE_URL = trimspace(var.langfuse_base_url) } : {},
  )

  # Normalized custom domains: bare hostnames (e.g. "platform.archagentix.com") without scheme or trailing slash.
  # This guarantees compatibility with Firebase Hosting custom domain IDs and Identity Platform authorized domains.
  custom_domains = distinct([
    for d in var.custom_domain :
    trimsuffix(trimprefix(trimprefix(trimspace(d), "https://"), "http://"), "/")
    if length(trimsuffix(trimprefix(trimprefix(trimspace(d), "https://"), "http://"), "/")) > 0
  ])

  # Marketing site (www.archagentix.com) — a SEPARATE Firebase Hosting site in
  # this project, published by .github/workflows/deploy-www.yml via the hosting
  # target "www" (firebase.json target -> .firebaserc binds it to this site_id).
  # "-marketing" not "-www": the Hosting API rejects site ids ending in "-www"
  # ("invalid name"), and firebase.json may not carry both site and target.
  # The domain attaches here, not to the app site, so it never enters
  # local.custom_domains (that list binds domains to the DEFAULT/app site).
  marketing_site_id = "${var.project_id}-marketing"
  marketing_domains = var.marketing_custom_domain == "" ? [] : [var.marketing_custom_domain]

  # Secret Share site (secrets.archagentix.com) — a third Hosting site in this
  # project, published by .github/workflows/deploy-secrets.yml via the hosting
  # target "secrets" (firebase.json target -> .firebaserc binds the site id).
  # Static zero-knowledge share pages; its domain joins the gateway CORS
  # allowlist and Identity Platform authorized domains so the optional
  # "Sign in with ArchAgentix" flow works on that origin.
  secrets_site_id = "${var.project_id}-secrets"
  secrets_domains = var.secrets_custom_domain == "" ? [] : [var.secrets_custom_domain]

  # --- Self-hosted LiteLLM gateway (litellm.tf) -------------------------------
  # All three images are built by CI from deploy/gcp/Dockerfile.litellm-{app,db,redis},
  # which pin their upstreams BY DIGEST — Cloud Run can only pull from Artifact
  # Registry, so a docker.litellm.ai / docker.io reference is undeployable here.
  # Tags follow the fleet convention (per-service override, else var.image_tag),
  # so a LiteLLM-only deploy rolls only LiteLLM and leaves every other service a
  # no-op. Upstream version identity lives in the Dockerfiles, not these tags.
  litellm_tag         = var.litellm_image_tag != "" ? var.litellm_image_tag : var.image_tag
  litellm_db_tag      = var.litellm_db_image_tag != "" ? var.litellm_db_image_tag : var.image_tag
  litellm_redis_tag   = var.litellm_redis_image_tag != "" ? var.litellm_redis_image_tag : var.image_tag
  litellm_image       = "${local.image_base}/litellm:${local.litellm_tag}"
  litellm_db_image    = "${local.image_base}/litellm-db:${local.litellm_db_tag}"
  litellm_redis_image = "${local.image_base}/litellm-redis:${local.litellm_redis_tag}"
  # Deterministic run.app URL (same trick as clm_url) so this value can be published
  # into local.proxy_plain_env without a self-reference cycle on the service's own .uri.
  litellm_url = var.litellm_enabled ? (
    var.litellm_base_url != "" ? var.litellm_base_url : "https://${var.litellm_service_name}-${local.run_url_suffix}"
  ) : ""
}
