# -----------------------------------------------------------------------------
# Input variables
# -----------------------------------------------------------------------------

variable "project_id" {
  type        = string
  description = "Target GCP project ID."
}

variable "region" {
  type        = string
  description = "Region for Cloud Run, Artifact Registry, Pub/Sub-adjacent resources, and Scheduler. Default is asia-south1 (Mumbai, India)."
  default     = "asia-south1"
}

variable "firestore_location" {
  type        = string
  description = "Firestore location. May be a region (e.g. asia-south1) or a multi-region (nam5, eur3). IMMUTABLE — cannot be changed after the database is created; relocating it needs a data migration (see docs/GCP_REGION_MIGRATION.md). Kept at nam5 so an apply never tries to move the existing database in place."
  default     = "nam5"
}

# --- Artifact Registry --------------------------------------------------------

variable "artifact_repo" {
  type        = string
  description = "Artifact Registry Docker repository name for all AI Fleet service images."
  default     = "ai-fleet"
}

variable "artifact_retention_count" {
  type        = number
  description = "Number of most recent versions to retain for each image package in the Artifact Registry repository. The proxy package backs both agent sidecars and the stream-token broker, so the default preserves a multi-revision rollback window across their coordinated rollout. Older tagged and untagged versions are deleted by the cleanup policy."
  default     = 5

  validation {
    condition     = var.artifact_retention_count >= 1 && floor(var.artifact_retention_count) == var.artifact_retention_count
    error_message = "artifact_retention_count must be a positive integer."
  }
}

variable "image_tag" {
  type        = string
  description = "Fallback image tag for ALL services (e.g. the commit SHA). deploy.sh / a full manual apply sets this. Combined with the Artifact Registry path in locals.tf to form each container.image. Per-service overrides below take precedence when set."
  default     = "latest"
}

# --- Per-service image tag overrides -----------------------------------------
# The CD pipeline rebuilds only the service(s) whose code changed and passes that
# service's new tag here, while passing each UNCHANGED service its currently-
# deployed tag — so `terraform apply` rolls one service without disturbing the
# others. Empty ("") falls back to var.image_tag (see locals.tf).

variable "gateway_image_tag" {
  type    = string
  default = ""
}

variable "planner_image_tag" {
  type    = string
  default = ""
}

variable "coder_image_tag" {
  type        = string
  description = "Tag for coder-control AND the coder-worker Job (they share one image)."
  default     = ""
}

variable "orchestrator_image_tag" {
  type        = string
  description = "Per-service image tag for the lightweight durable pipeline orchestrator."
  default     = ""
}

variable "tester_image_tag" {
  type        = string
  description = "Per-service image tag for the brokered pipeline tester."
  default     = ""
}

variable "deployer_image_tag" {
  type        = string
  description = "Per-service image tag for the brokered pipeline deployer."
  default     = ""
}

variable "org_image_tag" {
  type        = string
  description = "Per-service image tag override for the org service (FastAPI/Firestore)."
  default     = ""
}

variable "settings_image_tag" {
  type        = string
  description = "Per-service image tag override for the settings-policy service (FastAPI/Firestore)."
  default     = ""
}

variable "email_image_tag" {
  type        = string
  description = "Per-service image tag override for the shared transactional email service."
  default     = ""
}

# --- Cloud Run service / job names -------------------------------------------

variable "gateway_service_name" {
  type    = string
  default = "gateway"
}

variable "planner_service_name" {
  type    = string
  default = "planner"
}

variable "coder_service_name" {
  type    = string
  default = "coder-control"
}

variable "orchestrator_service_name" {
  type    = string
  default = "pipeline-orchestrator"
}

variable "tester_service_name" {
  type    = string
  default = "pipeline-tester"
}

variable "deployer_service_name" {
  type    = string
  default = "pipeline-deployer"
}

variable "org_service_name" {
  type    = string
  default = "org-service"
}

variable "settings_service_name" {
  type    = string
  default = "settings-service"
}

variable "email_service_name" {
  type    = string
  default = "email-service"
}

variable "coder_job_name" {
  type        = string
  description = "Cloud Run Job name. MUST match the CODER_JOB_NAME env the coder-control service uses to launch it."
  default     = "coder-worker"
}

# --- Mandatory egress proxy + stream-token broker ----------------------------

variable "secret_vault_kms_enabled" {
  type        = bool
  description = "Provision the Cloud KMS keyring/key for per-org secret envelope encryption and wire KMS_KEY_NAME into the settings service. OFF keeps the settings service on its in-memory KMS fake (the encrypted vault is dev-only). Turning it ON requires the deployer service account to hold roles/cloudkms.admin (cloudkms.keyRings.create)."
  default     = false
}

variable "proxy_service_name" {
  type    = string
  default = "proxy"
}

variable "stream_token_service_name" {
  type        = string
  description = "Private Cloud Run service that owns the stream-token signing secret and exposes only the IAM-gated mint/verify RPCs."
  default     = "stream-token-broker"
}

variable "stream_token_min_instances" {
  type        = number
  description = "Minimum warm stream-token broker instances. The default of 1 avoids Cloud Run cold starts exceeding the gateway's strict broker RPC deadline; setting 0 reduces idle cost but can cause transient stream-token failures."
  default     = 1

  validation {
    condition     = var.stream_token_min_instances >= 0 && floor(var.stream_token_min_instances) == var.stream_token_min_instances
    error_message = "stream_token_min_instances must be a non-negative integer."
  }
}

variable "stream_token_legacy_gateway_secret_access" {
  type        = bool
  description = "TEMPORARY migration gate. Keep true while any existing tenant gateway revision still runs the legacy stream-token sidecar; set false only after every tenant has been reconciled to the shared broker. The completed state grants the signing secret only to stream-token-broker-sa."
  default     = true
}

variable "proxy_image_tag" {
  type        = string
  description = "Image tag override for the proxy package used by agent egress sidecars and the standalone stream-token broker. Keeping one immutable tag makes both capability-specific entrypoints come from the same reviewed artifact."
  default     = ""
}

variable "omlx_proxy_upstream" {
  type        = string
  description = "Trusted operator-configured oMLX origin used only by egress proxy containers (for example http://omlx.internal:8000). Browser/request settings can never select this target. Empty disables oMLX in proxied cloud runtimes."
  default     = ""

  validation {
    condition     = trimspace(var.omlx_proxy_upstream) == "" || can(regex("^https?://[^/?#@[:space:]]+(?::[0-9]{1,5})?/?$", trimspace(var.omlx_proxy_upstream)))
    error_message = "omlx_proxy_upstream must be empty or a path-free HTTP(S) origin without credentials, query, or fragment."
  }
}

variable "ollama_proxy_upstream" {
  type        = string
  description = "Trusted operator-configured Ollama origin used only by egress proxy containers. Empty disables Ollama in proxied cloud runtimes."
  default     = ""

  validation {
    condition     = trimspace(var.ollama_proxy_upstream) == "" || can(regex("^https?://[^/?#@[:space:]]+(?::[0-9]{1,5})?/?$", trimspace(var.ollama_proxy_upstream)))
    error_message = "ollama_proxy_upstream must be empty or a path-free HTTP(S) origin without credentials, query, or fragment."
  }
}

variable "lmstudio_proxy_upstream" {
  type        = string
  description = "Trusted operator-configured LM Studio origin used only by egress proxy containers. Empty disables LM Studio in proxied cloud runtimes."
  default     = ""

  validation {
    condition     = trimspace(var.lmstudio_proxy_upstream) == "" || can(regex("^https?://[^/?#@[:space:]]+(?::[0-9]{1,5})?/?$", trimspace(var.lmstudio_proxy_upstream)))
    error_message = "lmstudio_proxy_upstream must be empty or a path-free HTTP(S) origin without credentials, query, or fragment."
  }
}

variable "openswe_proxy_upstream" {
  type        = string
  description = "Trusted operator-configured OpenSWE LangGraph origin used only by egress proxy containers. Empty disables OpenSWE in proxied cloud runtimes."
  default     = ""

  validation {
    condition     = trimspace(var.openswe_proxy_upstream) == "" || can(regex("^https?://[^/?#@[:space:]]+(?::[0-9]{1,5})?/?$", trimspace(var.openswe_proxy_upstream)))
    error_message = "openswe_proxy_upstream must be empty or a path-free HTTP(S) origin without credentials, query, or fragment."
  }
}

variable "managed_provider_secrets" {
  type        = map(string)
  description = "Platform-managed provider keys mounted on the SETTINGS service as ENV_NAME => Secret Manager secret id. The settings service resolves these for a 'managed' selection and returns them over the internal S2S so the egress proxy has ONE resolution path (managed + customer). Hosted LLMs require the matching GEMINI_API_KEY, HUGGINGFACE_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY entry. Each id MUST have an enabled version before it is mounted (else the settings revision fails to start)."
  default     = { GITHUB_TOKEN = "github-token" }
}

# --- Per-tenant provisioning (Phase 1, gated OFF by default) ------------------

variable "provisioning_enabled" {
  type        = bool
  description = "Create the provisioner service + its topic/subscription/IAM. OFF keeps every org on the shared stack (no per-tenant infra)."
  default     = false
}

variable "provisioner_service_name" {
  type    = string
  default = "provisioner"
}

variable "provisioner_image_tag" {
  type        = string
  description = "Per-service image tag override for the provisioner (Node)."
  default     = ""
}

variable "provisioning_topic" {
  type        = string
  description = "Pub/Sub topic the org service publishes tenant-provision requests to."
  default     = "tenant-provision-requests"
}

variable "internal_api_token" {
  type        = string
  description = "Shared secret guarding the org service's S2S deployment write-back (X-Internal-Token). Provisioner + org service must share it."
  default     = ""
  sensitive   = true
}

# --- Ingress / scaling --------------------------------------------------------

variable "internal_ingress" {
  type        = string
  description = <<-EOT
    Ingress for the non-public services (planner, coder-control). Default is
    INGRESS_TRAFFIC_ALL, but they remain IAM-gated (no allUsers invoker) — every
    caller MUST present an OIDC token for gateway-sa or pubsub-push-sa. This lets
    the gateway reverse-proxy its read endpoints over the run.app hostname with an
    OIDC ID token (see services/gateway/src/proxy.js) without a VPC.
    For network-layer isolation instead, set INGRESS_TRAFFIC_INTERNAL_ONLY and add
    Direct VPC egress to the gateway (see the note in cloud_run.tf) — no paid
    connector on Cloud Run gen2, but it needs a VPC subnet.
  EOT
  default     = "INGRESS_TRAFFIC_ALL"
}

variable "settings_ingress" {
  type        = string
  description = "Ingress for the IAM-gated settings service. ALL permits the direct operator CLI over run.app; the service still has no allUsers invoker binding."
  default     = "INGRESS_TRAFFIC_ALL"

  validation {
    condition     = contains(["INGRESS_TRAFFIC_ALL", "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER", "INGRESS_TRAFFIC_INTERNAL_ONLY"], var.settings_ingress)
    error_message = "settings_ingress must be a valid Cloud Run v2 ingress value."
  }
}

variable "settings_operator_invoker" {
  type        = string
  description = "Optional IAM member allowed to invoke the settings service directly for operator-only CLI calls (for example user:admin@example.com or group:platform@example.com). Empty grants nobody."
  default     = ""

  validation {
    condition = (
      trimspace(var.settings_operator_invoker) == "" ||
      can(regex("^(user|group|serviceAccount):[^[:space:]]+$", trimspace(var.settings_operator_invoker)))
    )
    error_message = "settings_operator_invoker must be empty or a user:, group:, or serviceAccount: IAM member."
  }
}

variable "min_instances" {
  type        = number
  description = "Minimum Cloud Run instances per service. Keep at 0 for scale-to-zero / no idle cost."
  default     = 0

  validation {
    condition     = var.min_instances >= 0 && floor(var.min_instances) == var.min_instances
    error_message = "min_instances must be a non-negative integer."
  }
}

variable "max_instances" {
  type        = number
  description = "Maximum Cloud Run instances per service."
  default     = 1

  validation {
    condition     = var.max_instances >= 1 && floor(var.max_instances) == var.max_instances
    error_message = "max_instances must be a positive integer."
  }
}

variable "container_concurrency" {
  type        = number
  description = "Maximum concurrent requests per Cloud Run service instance. Values above 1 require service containers with at least 1 vCPU."
  default     = 10

  validation {
    condition     = var.container_concurrency >= 1 && var.container_concurrency <= 1000 && floor(var.container_concurrency) == var.container_concurrency
    error_message = "container_concurrency must be an integer from 1 through 1000."
  }
}

variable "cloud_run_service_cpu" {
  type        = string
  description = "vCPU limit for gen2 Cloud Run service app containers. Supported values are 1 or 2 because some services have fixed 512Mi memory limits; the 1-vCPU default supports container_concurrency > 1."
  default     = "1"

  validation {
    condition     = contains(["1", "2"], var.cloud_run_service_cpu)
    error_message = "cloud_run_service_cpu must be 1 or 2 vCPU because these gen2 Cloud Run services include fixed 512Mi containers."
  }
}

variable "cloud_run_proxy_cpu" {
  type        = string
  description = "vCPU limit for egress-proxy sidecars and the standalone stream-token broker on gen2 Cloud Run. Supported values are 1 or 2; Cloud Run Jobs use coder_job_proxy_cpu."
  default     = "1"

  validation {
    condition     = contains(["1", "2"], var.cloud_run_proxy_cpu)
    error_message = "cloud_run_proxy_cpu must be 1 or 2 vCPU because these gen2 Cloud Run sidecars use fixed 512Mi memory limits."
  }
}

# --- Pub/Sub topics -----------------------------------------------------------

variable "planner_topic" {
  type    = string
  default = "planner-requests"
}

variable "coder_topic" {
  type    = string
  default = "coder-requests"
}

# Durable pipeline command/result topics are deliberately distinct from the
# legacy planner/coder request topics. Reusing either legacy topic would fan a
# typed StageCommand into the autonomous-label handlers.
variable "pipeline_plan_topic" {
  type    = string
  default = "pipeline-plan-commands"
}

variable "pipeline_code_topic" {
  type    = string
  default = "pipeline-code-commands"
}

variable "pipeline_test_topic" {
  type    = string
  default = "pipeline-test-commands"
}

variable "pipeline_deploy_topic" {
  type    = string
  default = "pipeline-deploy-commands"
}

variable "pipeline_plan_results_topic" {
  type    = string
  default = "pipeline-plan-results"
}

variable "pipeline_code_results_topic" {
  type    = string
  default = "pipeline-code-results"
}

variable "pipeline_test_results_topic" {
  type    = string
  default = "pipeline-test-results"
}

variable "pipeline_deploy_results_topic" {
  type    = string
  default = "pipeline-deploy-results"
}

variable "pipeline_orchestrator_enabled" {
  type        = bool
  description = "Create and enable the durable fixed-stage pipeline topology. False preserves the legacy autonomous label flow and creates no pipeline Cloud Run/Pub/Sub resources."
  default     = false
}

variable "pipeline_deployment_enabled" {
  type        = bool
  description = "Allow the deploy stage after the full plan/code/test/deploy sequence. False is the fail-closed default."
  default     = false
}

variable "email_topic" {
  type        = string
  description = "Shared Pub/Sub topic carrying allow-listed transactional email jobs."
  default     = "email-delivery"
}

variable "dead_letter_topic" {
  type    = string
  default = "agent-requests-deadletter"
}

variable "max_delivery_attempts" {
  type        = number
  description = "Push deliveries before a message is routed to the dead-letter topic."
  default     = 5
}

# --- Shared transactional email ----------------------------------------------

variable "email_smtp_host" {
  type        = string
  description = "SMTP server hostname. Empty leaves the email service deployed but not ready."
  default     = ""
}

variable "email_smtp_port" {
  type        = number
  description = "SMTP server port. Use 465 with email_smtp_secure=true or normally 587 with STARTTLS."
  default     = 587
  validation {
    condition     = var.email_smtp_port >= 1 && var.email_smtp_port <= 65535
    error_message = "email_smtp_port must be between 1 and 65535."
  }
}

variable "email_smtp_secure" {
  type        = bool
  description = "Use implicit TLS for the SMTP connection (normally port 465)."
  default     = false
}

variable "email_smtp_require_tls" {
  type        = bool
  description = "Require STARTTLS when implicit TLS is disabled."
  default     = true
}

variable "email_smtp_auth_enabled" {
  type        = bool
  description = "Mount the latest email-smtp-user and email-smtp-password versions. Enable only after both secrets have an enabled version; values remain outside Terraform state."
  default     = false
}

variable "email_from" {
  type        = string
  description = "Fixed From address used by every allow-listed email template. Empty makes readiness fail closed."
  default     = ""
}

variable "email_public_app_url" {
  type        = string
  description = "HTTPS base URL of the SPA actually published by this deployment, used to construct invitation links. Entry points must set it explicitly."
  default     = ""

  validation {
    condition = (
      trimspace(var.email_public_app_url) == "" ||
      can(regex("^https://[^/?#]+(/[^?#]*)?$", trimspace(var.email_public_app_url)))
    )
    error_message = "email_public_app_url must be empty during a targeted bootstrap or an absolute HTTPS URL without a query string or fragment."
  }
}

variable "ack_deadline_seconds" {
  type        = number
  description = "Push ack deadline for short control-plane handlers. Synchronous pipeline command subscriptions use the Pub/Sub maximum (600s) separately."
  default     = 30
}

# --- Cloud Scheduler cadences (cron) -----------------------------------------

variable "planner_schedule" {
  type        = string
  description = "Planner cadence tick — POSTs to /pubsub/planner-tick."
  default     = "*/5 * * * *"
}

variable "coder_schedule" {
  type        = string
  description = "Coder board-poll tick — POSTs to /pubsub/coder-tick."
  default     = "*/2 * * * *"
}

variable "billing_schedule" {
  type        = string
  description = "Billing usage-aggregation sweep tick — POSTs to /pubsub/billing-tick."
  default     = "*/5 * * * *"
}

variable "scheduler_time_zone" {
  type    = string
  default = "Etc/UTC"
}

# --- Coder worker Job knobs ---------------------------------------------------

variable "coder_job_task_timeout" {
  type        = string
  description = "Max wall-clock for one coder ticket (a worker runs one ticket to completion). Cloud Run Job task timeout maxes at 24h."
  default     = "86400s"
}

variable "coder_job_cpu" {
  type        = string
  description = "vCPU limit for the coder-worker app container. Cloud Run Job containers require at least 1 vCPU."
  default     = "1"
}

variable "coder_job_proxy_cpu" {
  type        = string
  description = "vCPU limit for the coder-worker egress-proxy sidecar. Kept independent so increasing worker CPU does not overprovision the proxy; Cloud Run Job containers require at least 1 vCPU."
  default     = "1"
}

variable "coder_job_memory" {
  type    = string
  default = "4Gi"
}

variable "coder_repo_url" {
  type        = string
  description = "Optional default repo the coder clones (CODER_REPO_URL). Usually set per-project instead; leave empty to rely on per-project config."
  default     = ""
}

# --- Secrets ------------------------------------------------------------------

variable "extra_secret_ids" {
  type        = list(string)
  description = "Additional Secret Manager secret IDs to create (provider OAuth, LangSmith, GitHub token, managed LLM keys, etc.). Versions are added out-of-band and mounted only on the settings service through managed_provider_secrets; agent identities receive no accessor role."
  default     = ["github-token", "langsmith-api-key", "gemini-api-key", "huggingface-api-key", "anthropic-api-key", "openai-api-key"]
}

# --- SPA (GCS bucket) ---------------------------------------------------------

variable "spa_bucket_name" {
  type        = string
  description = "Globally-unique GCS bucket name that hosts the SPA (public read)."
}

variable "spa_bucket_force_destroy" {
  type        = bool
  description = "Allow `terraform destroy` to delete the bucket even if it still holds objects."
  default     = true
}

variable "spa_origin" {
  type        = string
  description = "Browser origin the SPA is served from, used as the gateway CORS allowlist (SPA_ORIGIN). For direct GCS hosting the browser Origin is the scheme+host only. Override for a custom domain / CDN in front of the bucket."
  default     = "https://storage.googleapis.com"
}

# --- Skills registry (GCS bucket, gcsfuse mount) -----------------------------
# See skills.tf. Terraform CREATES and OWNS the bucket. skills_enabled toggles the
# whole feature (bucket + mounts + SKILLS_ROOT env); when off, planner/coder fall
# back to the vendored skills baked into the image. The bucket name defaults to a
# stable derived value ("<project_id>-aifleet-skills") — skills_bucket_name is an
# OPTIONAL override, no longer a pre-existing bucket the operator must supply.

variable "skills_enabled" {
  type        = bool
  description = "Create the Terraform-managed skills registry GCS bucket (+ IAM). true creates and owns the bucket; false disables the feature entirely. The read-only gcsfuse MOUNT is a separate toggle (skills_mount_enabled)."
  default     = true
}

variable "skills_mount_enabled" {
  type        = bool
  description = "Mount the skills bucket read-only via gcsfuse (+ SKILLS_ROOT/SKILLS_VERSION env) on planner/coder. Default OFF: the fuse mount under the gen2 execution environment currently fails the coder-control startup probe (heavy dual-role image) and needs validation (and an initially-populated bucket + a resolveSkillsSrc empty-mount fallback) before enabling. Requires skills_enabled. Off → services use the vendored skills baked into the image."
  default     = false
}

variable "skills_bucket_name" {
  type        = string
  description = "OPTIONAL override for the skills bucket name. Empty ('') derives a stable default of '<project_id>-aifleet-skills' (see locals.tf). Terraform CREATES this bucket — it is NOT assumed to pre-exist. Set only to pin a custom globally-unique name. Ignored when skills_enabled = false."
  default     = ""
}

variable "skills_bucket_force_destroy" {
  type        = bool
  description = "Allow `terraform destroy` to delete the skills bucket even if it still holds objects."
  default     = false
}

variable "skills_version" {
  type        = string
  description = "Skills bundle version the runtime PINS (SKILLS_VERSION). The planner/coder read /skills/<skills_version>/<skill>/SKILL.md, so bumping the published bundle to a new version does NOT affect a deployment until this is bumped — older pinned versions keep working. Must match a published `<version>/` prefix in the bucket."
  default     = "v1"
}

variable "skills_publisher_member" {
  type        = string
  description = "Optional IAM member (e.g. serviceAccount:gh-deployer@PROJECT.iam.gserviceaccount.com) granted objectAdmin on the skills bucket so the CI publish workflow can push new bundles. Empty = no grant (manage the deployer SA's write access out-of-band)."
  default     = ""
}

# --- Harness registry bucket (see registry.tf) -------------------------------
# The weekly sync-harness-registry workflow publishes a versioned dual-format
# (original + generic) bundle here. Terraform CREATES and OWNS the bucket; the
# name defaults to "<project_id>-aifleet-registry". registry_bucket_name is an
# optional override for a custom globally-unique name.

variable "registry_enabled" {
  type        = bool
  description = "Create the Terraform-managed harness-registry GCS bucket (+ IAM). true creates and owns the bucket; false disables the feature entirely."
  default     = true
}

variable "registry_bucket_name" {
  type        = string
  description = "Fixed name of the harness-registry GCS bucket (NOT derived from project_id). Terraform CREATES this bucket — it is NOT assumed to pre-exist. GCS bucket names are GLOBALLY unique, so override this if the default is already taken. The sync-harness-registry CI workflow uses this same fixed name (REGISTRY_BUCKET repo-var override). Ignored when registry_enabled = false."
  default     = "aifleet-registry"
}

variable "registry_bucket_force_destroy" {
  type        = bool
  description = "Allow `terraform destroy` to delete the registry bucket even if it still holds objects."
  default     = false
}

variable "registry_publisher_member" {
  type        = string
  description = "Optional IAM member (e.g. serviceAccount:gh-deployer@PROJECT.iam.gserviceaccount.com) granted objectAdmin on the registry bucket so the sync-harness-registry CI workflow can push new bundles. Empty = no grant (manage the deployer SA's write access out-of-band)."
  default     = ""
}

# --- Gateway public URL / Firebase auth --------------------------------------

variable "api_base_url" {
  type        = string
  description = "Override the gateway's public base URL (API_BASE_URL). Leave empty to derive Cloud Run's deterministic per-project URL (see locals.tf). Set this if your project uses the legacy hash-style run.app URLs."
  default     = ""
}

# NOTE: the Firebase Web API key is no longer a variable — Terraform reads it
# straight from the managed web app via data.google_firebase_web_app_config (see
# firebase.tf), so no FIREBASE_API_KEY repo var / manual copy is needed.

variable "firebase_auth_domain" {
  type        = string
  description = "Firebase auth domain. Empty = the gateway defaults to <project_id>.firebaseapp.com."
  default     = ""
}

variable "auth_admin_emails" {
  type        = string
  description = "Comma-separated emails granted the ADMIN role at sign-in (bootstrap). Other roles are assigned as Firebase custom claims via services/gateway/scripts/set-user-role.js. Set on the gateway only."
  default     = ""
}

variable "auth_default_role" {
  type        = string
  description = "Role a signed-in user gets before any role claim is assigned: admin | operator | viewer (least-privilege default)."
  default     = "viewer"
}

variable "firebase_allowed_domain" {
  type        = string
  description = "Optional: restrict app login to this email domain; empty = any verified user (Google OR Microsoft)."
  default     = ""
}

variable "auth_microsoft_enabled" {
  type        = bool
  description = "Show the 'Continue with Microsoft' button (signInWithPopup, microsoft.com provider). Requires enabling the Microsoft provider in the Firebase console with an Azure app id + secret (console-managed, not in Terraform — the secret cannot be read back). Google stays enabled unless disabled separately."
  default     = false
}

variable "microsoft_tenant" {
  type        = string
  description = "Optional Azure AD tenant for the Microsoft provider: 'common' (any account, the SDK default when empty), 'organizations' (work/school only), or a specific tenant id. A tenant id is PUBLIC (served via /api/auth/config), not a secret."
  default     = ""
}

variable "google_one_tap_client_id" {
  type        = string
  description = "Google OAuth Web client id for the One Tap sign-in prompt (…apps.googleusercontent.com). Create the Web client in the console (Terraform cannot mint it); its value is stored in Secret Manager (google-one-tap-client-id) and injected into the gateway. Empty = the SPA uses the Firebase Google popup only."
  default     = ""
}

variable "labels" {
  type        = map(string)
  description = "Base labels merged onto every labelable resource (for billing cost attribution). Each resource also gets a per-resource `component` label; see locals.common_labels."
  default = {
    app        = "ai-fleet"
    managed-by = "terraform"
  }
}

variable "environment" {
  type        = string
  description = "Deployment environment label (e.g. prod, staging) — added to every resource for billing breakdown by environment."
  default     = "prod"
}
