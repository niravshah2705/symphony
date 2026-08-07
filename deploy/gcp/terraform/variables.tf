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
  description = "Artifact Registry Docker repository name (holds the gateway/planner/coder images)."
  default     = "ai-fleet"
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

variable "org_image_tag" {
  type        = string
  description = "Per-service image tag override for the org service (FastAPI/Firestore)."
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

variable "org_service_name" {
  type    = string
  default = "org-service"
}

variable "coder_job_name" {
  type        = string
  description = "Cloud Run Job name. MUST match the CODER_JOB_NAME env the coder-control service uses to launch it."
  default     = "coder-worker"
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

variable "max_instances" {
  type        = number
  description = "Per-service max Cloud Run instances (min is always 0 for scale-to-zero / no idle cost)."
  default     = 3
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

variable "dead_letter_topic" {
  type    = string
  default = "agent-requests-deadletter"
}

variable "max_delivery_attempts" {
  type        = number
  description = "Push deliveries before a message is routed to the dead-letter topic."
  default     = 5
}

variable "ack_deadline_seconds" {
  type        = number
  description = "Push ack deadline. Handlers ack immediately and do work out-of-band (job/scheduler), so this stays small."
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
  type    = string
  default = "2"
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
  description = "Additional Secret Manager secret IDs to create (provider OAuth, LangSmith, GitHub token, etc.). Versions are added out-of-band. planner-sa + coder-sa are granted accessor on these."
  default     = ["github-token", "langsmith-api-key"]
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
  description = "Optional: restrict app login to this email domain; empty = any verified user."
  default     = ""
}

variable "google_one_tap_client_id" {
  type        = string
  description = "Optional: public Google OAuth Web client id for the Google One Tap sign-in prompt (…apps.googleusercontent.com). Public, not a secret. Empty = the SPA uses the Firebase Google popup only."
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
