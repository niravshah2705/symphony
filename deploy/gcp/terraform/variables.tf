# -----------------------------------------------------------------------------
# Input variables
# -----------------------------------------------------------------------------

variable "project_id" {
  type        = string
  description = "Target GCP project ID."
}

variable "region" {
  type        = string
  description = "Region for Cloud Run, Artifact Registry, Pub/Sub-adjacent resources, and Scheduler."
  default     = "us-central1"
}

variable "firestore_location" {
  type        = string
  description = "Firestore location. May be a region (e.g. us-central1) or a multi-region (nam5, eur3). Cannot be changed after the database is created."
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
  description = "Image tag Cloud Build pushes and Terraform deploys (e.g. the commit SHA). Combined with the Artifact Registry path in locals.tf to form each container.image."
  default     = "latest"
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

variable "firebase_api_key" {
  type        = string
  description = "Public Firebase Web API key — NOT a secret; exposed to the browser via /api/auth/config."
  default     = ""
}

variable "firebase_auth_domain" {
  type        = string
  description = "Firebase auth domain. Empty = the gateway defaults to <project_id>.firebaseapp.com."
  default     = ""
}

variable "firebase_allowed_domain" {
  type        = string
  description = "Optional: restrict app login to this email domain; empty = any verified user."
  default     = ""
}

variable "labels" {
  type        = map(string)
  description = "Labels applied to labelable resources."
  default = {
    app        = "ai-fleet"
    managed-by = "terraform"
  }
}
