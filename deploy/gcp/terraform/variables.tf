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

variable "identity_image_tag" {
  type        = string
  description = "Per-service image tag override for the identity verification service."
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

variable "identity_service_name" {
  type        = string
  description = "Cloud Run service name for DigiLocker / APAAR identity verification."
  default     = "identity-verification"
}

variable "identity_hash_pepper_secret_id" {
  type        = string
  description = "Secret Manager secret id containing the HMAC pepper for PAN / APAAR claim hashes. The secret value is seeded out of band by bootstrap/deploy scripts."
  default     = "identity-hash-pepper"
}

variable "billing_image_tag" {
  type        = string
  description = "Per-service image tag override for the billing service."
  default     = ""
}

variable "billing_service_name" {
  type        = string
  description = "Cloud Run service name for billing and Cashfree payments."
  default     = "billing"
}

# --- Laya & CLM Inference Services ------------------------------------------

variable "laya_image_tag" {
  type        = string
  description = "Per-service image tag override for the dedicated Laya inference service."
  default     = ""
}

variable "laya_service_name" {
  type        = string
  description = "Cloud Run service name for dedicated Laya inference."
  default     = "laya-inference"
}

variable "laya_ingress" {
  type        = string
  description = "Ingress for Laya inference service. Defaults to INGRESS_TRAFFIC_INTERNAL_ONLY."
  default     = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  validation {
    condition     = contains(["INGRESS_TRAFFIC_ALL", "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER", "INGRESS_TRAFFIC_INTERNAL_ONLY"], var.laya_ingress)
    error_message = "laya_ingress must be a valid Cloud Run v2 ingress value."
  }
}

variable "laya_cpu" {
  type        = string
  description = "CPU allocated to Laya container (1, 2, or 4 vCPU)."
  default     = "2"
}

variable "laya_memory" {
  type        = string
  description = <<-EOT
    Memory allocated to Laya container. The three preloaded checkpoints are
    ~2.3GB of fp16 weights on disk (english ~0.84GB, multilingual ~0.64GB,
    typed-decisions ~0.85GB), but CPU inference materializes them as float32 —
    ~4.7GB resident — plus ~0.4GB torch/runtime overhead and a transient copy
    of each checkpoint while it is built. 4Gi was OOM-killed during preload of
    the SECOND checkpoint on revisions 00016-00018: each instance logged exactly
    one `Agent(repo)` build, then exited silently ~5min later with no traceback,
    so the port never bound and the startup probe timed out. Floor is 8Gi.
  EOT
  default     = "8Gi"
}

variable "laya_min_instances" {
  type        = number
  description = "Minimum instances for Laya inference service."
  default     = 0
}

variable "laya_max_instances" {
  type        = number
  description = "Maximum instances for Laya inference service."
  default     = 5
}

variable "laya_container_concurrency" {
  type        = number
  description = "Container concurrency for Laya inference service."
  default     = 80
}

variable "clm_image_tag" {
  type        = string
  description = "Per-service image tag override for the dedicated CLM inference service."
  default     = ""
}

variable "clm_service_name" {
  type        = string
  description = "Cloud Run service name for dedicated CLM inference."
  default     = "clm-inference"
}

variable "clm_ingress" {
  type        = string
  description = "Ingress for CLM inference service. Defaults to INGRESS_TRAFFIC_INTERNAL_ONLY."
  default     = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  validation {
    condition     = contains(["INGRESS_TRAFFIC_ALL", "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER", "INGRESS_TRAFFIC_INTERNAL_ONLY"], var.clm_ingress)
    error_message = "clm_ingress must be a valid Cloud Run v2 ingress value."
  }
}

variable "clm_cpu" {
  type        = string
  description = "CPU allocated to CLM container (2, 4, or 8 vCPU)."
  default     = "4"
}

variable "clm_memory" {
  type        = string
  description = "Memory allocated to CLM container."
  default     = "8Gi"
}

variable "clm_min_instances" {
  type        = number
  description = "Minimum instances for CLM inference service."
  default     = 0
}

variable "clm_max_instances" {
  type        = number
  description = "Maximum instances for CLM inference service."
  default     = 5
}

variable "clm_container_concurrency" {
  type        = number
  description = "Container concurrency for CLM inference service."
  default     = 80
}

variable "cashfree_app_id_secret_id" {
  type        = string
  description = "Secret Manager secret id containing the Cashfree App ID."
  default     = "cashfree-app-id"
}

variable "cashfree_secret_key_secret_id" {
  type        = string
  description = "Secret Manager secret id containing the Cashfree Secret Key."
  default     = "cashfree-secret-key"
}

variable "cashfree_env" {
  type        = string
  description = "Cashfree environment: sandbox or production."
  default     = "sandbox"
}

variable "cashfree_base_url" {
  type        = string
  description = "Cashfree base API URL (e.g. https://sandbox.cashfree.com or https://api.cashfree.com)."
  default     = "https://sandbox.cashfree.com"
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
  description = "Minimum warm stream-token broker instances. Default 0 keeps idle cost at zero but can cause transient stream-token failures on a cold start; set to 1 to keep an instance warm and avoid Cloud Run cold starts exceeding the gateway's strict broker RPC deadline."
  default     = 0

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

variable "agentgateway_proxy_upstream" {
  type        = string
  description = "Trusted operator-configured agentgateway origin used only by egress proxy containers (the in-cluster L7 front for LLM, MCP and A2A; for example http://agentgateway-gateway.substrate.svc.cluster.local:9900). Browser/request settings can never select this target. Empty leaves the /agentgw route dark — it fails closed rather than defaulting onto a gateway key."
  default     = ""

  validation {
    condition     = trimspace(var.agentgateway_proxy_upstream) == "" || can(regex("^https?://[^/?#@[:space:]]+(?::[0-9]{1,5})?/?$", trimspace(var.agentgateway_proxy_upstream)))
    error_message = "agentgateway_proxy_upstream must be empty or a path-free HTTP(S) origin without credentials, query, or fragment."
  }
}

variable "managed_provider_secrets" {
  type        = map(string)
  description = "Platform-managed provider keys mounted on the SETTINGS service as ENV_NAME => Secret Manager secret id. The settings service resolves these for a 'managed' selection and returns them over the internal S2S so the egress proxy has ONE resolution path (managed + customer). Hosted LLMs require the matching GEMINI_API_KEY, HUGGINGFACE_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY entry. Agent traces go to Langfuse Cloud, which requires LANGFUSE_PUBLIC_KEY => langfuse-public-key and LANGFUSE_SECRET_KEY => langfuse-secret-key; the egress proxy reassembles the Basic pair from these, so no agent container ever holds them. Each id MUST have an enabled version before it is mounted (else the settings revision fails to start)."
  default     = { GITHUB_TOKEN = "github-token" }
}

# --- Per-tenant provisioning (Phase 1, gated OFF by default) ------------------

variable "provisioning_enabled" {
  type        = bool
  description = "Grant the provisioner the per-tenant-stack roles (run.admin / pubsub.admin / cloudscheduler.admin / act-as on the runtime SAs) and create its service + topic/subscription/IAM. OFF keeps every org on the shared stack (no per-tenant infra)."
  default     = false
}

variable "provisioner_enabled" {
  type        = bool
  description = "Create the provisioner service, its topic and its push subscription WITHOUT the project-wide tenant-stack roles. This is the receiver for `substrate-atespace` requests on a deployment that runs actors but never stands up a per-tenant Cloud Run stack. provisioning_enabled implies it; it never implies provisioning_enabled."
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
  description = "Legacy optional IAM member allowed to invoke the settings service directly for operator-only CLI calls (for example user:admin@example.com or group:platform@example.com). Kept for backward compatibility; new callers should prefer settings_operator_invokers. Empty grants nobody through this input."
  default     = ""

  validation {
    condition = (
      trimspace(var.settings_operator_invoker) == "" ||
      can(regex("^(user|group|serviceAccount):[^[:space:]]+$", trimspace(var.settings_operator_invoker)))
    )
    error_message = "settings_operator_invoker must be empty or a user:, group:, or serviceAccount: IAM member."
  }
}

variable "settings_operator_invokers" {
  type        = set(string)
  description = "Additional IAM members allowed to invoke the settings service directly for operator-only CLI calls. These are additive to settings_operator_invoker; duplicates are removed."
  default     = []

  validation {
    condition = alltrue([
      for member in var.settings_operator_invokers :
      can(regex("^(user|group|serviceAccount):[^[:space:]]+$", trimspace(member)))
    ])
    error_message = "settings_operator_invokers entries must be user:, group:, or serviceAccount: IAM members."
  }
}

variable "e2e_approver_service_account" {
  type        = string
  description = "Optional bare service-account email used by the protected live E2E workflow to invoke the IAM-gated settings operator surface. Terraform adds the serviceAccount: prefix. Empty grants no E2E identity."
  default     = ""

  validation {
    condition = (
      trimspace(var.e2e_approver_service_account) == "" ||
      can(regex("^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*\\.iam\\.gserviceaccount\\.com$", trimspace(var.e2e_approver_service_account)))
    )
    error_message = "e2e_approver_service_account must be empty or a bare *.iam.gserviceaccount.com email address."
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
  default     = 1000

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
  description = "Billing usage-aggregation sweep tick — POSTs to /pubsub/billing-tick. Aggregation/watermark/prune only; money moved to the hourly billing_recharge_schedule Job."
  default     = "*/5 * * * *"
}

variable "billing_recharge_schedule" {
  type        = string
  description = "Auto-recharge + alert tick — publishes to the billing auto-recharge Job. Hourly to match CONFIG.BILLING.rechargeIntervalMin (60)."
  default     = "0 * * * *"
}

variable "scheduler_time_zone" {
  type    = string
  default = "Etc/UTC"
}

# --- Billing auto-recharge Job knobs -------------------------------------------

variable "billing_job_name" {
  type        = string
  description = "Cloud Run Job that evaluates every auto-recharge opt-in org and fires its Cashfree charge once per tick. Must match google_pubsub_subscription.push_config.cloud_run_job.service."
  default     = "billing-auto-recharge"
}

variable "billing_job_task_timeout" {
  type        = string
  description = "Max wall-clock for one auto-recharge Job task — it walks every candidate org serially, validating before each charge. Cloud Run Job task timeout maxes at 24h."
  default     = "600s"
}

variable "billing_job_dry_run" {
  type        = bool
  description = "Run the auto-recharge Job's selection and validation but charge nothing. The pre-flight switch for a first deploy; flip to false once the summary looks right."
  default     = false
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

variable "langfuse_environment" {
  type        = string
  description = "Langfuse `environment` partition for traces written by this deployment (dev/staging/prod). Non-secret; org and project are trace tags, so one managed project holds every tenant."
  default     = "prod"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._-]{0,39}$", var.langfuse_environment))
    error_message = "langfuse_environment must be a lowercase slug of at most 40 characters ([a-z0-9._-])."
  }
}

variable "langfuse_base_url" {
  type        = string
  description = "Optional Langfuse origin override for data residency or a self-hosted instance (e.g. https://us.cloud.langfuse.com). Empty keeps the https://cloud.langfuse.com default. Not a secret — the key pair never appears here."
  default     = ""

  validation {
    condition     = trimspace(var.langfuse_base_url) == "" || can(regex("^https://[^/?#@[:space:]]+$", trimspace(var.langfuse_base_url)))
    error_message = "langfuse_base_url must be empty or a path-free HTTPS origin without credentials, query, or fragment."
  }
}

variable "extra_secret_ids" {
  type        = list(string)
  description = "Additional Secret Manager secret IDs to create (provider OAuth, Langfuse tracing keys, GitHub token, managed LLM keys, etc.). Versions are added out-of-band and mounted only on the settings service through managed_provider_secrets; agent identities receive no accessor role."
  default     = ["github-token", "langsmith-api-key", "langfuse-public-key", "langfuse-secret-key", "gemini-api-key", "huggingface-api-key", "anthropic-api-key", "openai-api-key"]
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

# --- Chat attachments (GCS bucket, gcs_attachments.tf) -----------------------
# Unlike skills, there is no vendored fallback for this feature — it's always
# created, no enabled toggle.

variable "attachments_bucket_name" {
  type        = string
  description = "OPTIONAL override for the attachments bucket name. Empty ('') derives a stable default of '<project_id>-aifleet-attachments' (see locals.tf). Terraform CREATES this bucket. Set only to pin a custom globally-unique name."
  default     = ""
}

variable "attachments_bucket_force_destroy" {
  type        = bool
  description = "Allow `terraform destroy` to delete the attachments bucket even if it still holds objects. Default false: this bucket holds real tenant file content, unlike the skills/SPA buckets."
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

# --- Laya checkpoint registry (GCS bucket, publish/audit target) -------------
# See laya_models.tf. Mirrors the skills registry: Terraform CREATES and OWNS
# the bucket and the name defaults to the derived
# "<project_id>-aifleet-laya-models". The runtime does NOT mount it — the
# checkpoints ship inside the image (Dockerfile.laya-inference).

variable "laya_models_enabled" {
  type        = bool
  description = "Create the Terraform-managed Laya checkpoint bucket (+ IAM), used by .github/workflows/publish-laya-models.yml as the versioned publish/audit target. false removes the bucket only — laya-inference no longer mounts it, so this does not affect serving."
  default     = true
}

variable "laya_models_bucket_name" {
  type        = string
  description = "OPTIONAL override for the Laya models bucket name. Empty ('') derives a stable default of '<project_id>-aifleet-laya-models' (see locals.tf). Terraform CREATES this bucket. Set only to pin a custom globally-unique name. Ignored when laya_models_enabled = false."
  default     = ""
}

variable "laya_models_bucket_force_destroy" {
  type        = bool
  description = "Allow `terraform destroy` to delete the Laya models bucket even if it still holds objects (multi-GB weight snapshots; re-publish via the CI workflow)."
  default     = false
}

variable "laya_model_version" {
  type        = string
  description = "Laya checkpoint bundle version published to the GCS bucket by .github/workflows/publish-laya-models.yml. The RUNTIME no longer reads this: checkpoints ship inside the image (Dockerfile.laya-inference bakes HF_HUB_CACHE=/opt/laya-cache and the image digest pins the weights). Kept so the bucket stays versioned as the publish/backup target."
  default     = "v1"
}

variable "laya_models_publisher_member" {
  type        = string
  description = "Optional IAM member (e.g. serviceAccount:gh-deployer@PROJECT.iam.gserviceaccount.com) granted objectAdmin on the Laya models bucket so the CI publish workflow can push new bundles. Empty = no grant (manage the deployer SA's write access out-of-band)."
  default     = ""
}

# --- Agent memory store (Cloud SQL Postgres, memory.tf) ----------------------
# The MemoryMiddleware persists AI-compressed agent memories here and injects
# them into future runs. Agents WRITE at runtime over the Cloud Run /cloudsql
# unix socket (Cloud SQL Auth Proxy; no VPC connector). Opt-in, off by default —
# Cloud SQL does not scale to zero, so enabling it adds a fixed monthly cost.

variable "memory_enabled" {
  type        = bool
  description = "Create the Terraform-managed Cloud SQL for PostgreSQL memory instance (+ database/user/URL secret) and wire MEMORY_DATABASE_URL + the /cloudsql socket into planner/coder. false disables the feature entirely and keeps the stack at $0."
  default     = false
}

variable "memory_db_version" {
  type        = string
  description = "Cloud SQL Postgres engine version (POSTGRES_16 / POSTGRES_17)."
  default     = "POSTGRES_16"
}

variable "memory_db_tier" {
  type        = string
  description = "Cloud SQL machine tier. db-f1-micro is the cheapest usable tier; raise it for higher traffic/concurrency. See https://cloud.google.com/sql/pricing."
  default     = "db-f1-micro"
}

variable "memory_db_disk_size_gb" {
  type        = number
  description = "Initial SSD size for the memory instance. Autoresize is on, so this is a floor, not a cap."
  default     = 10
}

variable "memory_db_backups_enabled" {
  type        = bool
  description = "Enable automated daily backups of the memory database."
  default     = true
}

variable "memory_db_deletion_protection" {
  type        = bool
  description = "Block `terraform destroy` of the memory instance. Default true: it holds real compressed agent memories. Set false only for a deliberate teardown."
  default     = true
}

variable "memory_db_instance_name" {
  type        = string
  description = "OPTIONAL override for the Cloud SQL instance name. Empty ('') derives '<project_id>-aifleet-memory' (see locals.tf). Lowercase letters, digits, hyphens only."
  default     = ""
}

variable "memory_db_name" {
  type        = string
  description = "Database name inside the memory instance."
  default     = "aifleet_memory"
}

variable "memory_db_user" {
  type        = string
  description = "Database user the runtime connects as (password is generated into Secret Manager)."
  default     = "aifleet_memory"
}

# --- Harness registry bucket (see registry.tf) -------------------------------
# The weekly sync-harness-registry workflow publishes versioned, harness-native
# rootfs artifacts plus their v2 descriptors and inert non-ECC resources here.
# Terraform CREATES and OWNS the bucket; registry_bucket_name is an optional
# override for a custom globally-unique name.

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

variable "custom_domain" {
  type        = list(string)
  description = "Custom domain(s) for Firebase Hosting."
  default     = []
}

variable "marketing_custom_domain" {
  type        = string
  description = "Custom domain attached to the marketing Hosting site (<project>-marketing), served from .github/workflows/deploy-www.yml. Empty = domain not attached (DNS still points elsewhere, e.g. the legacy Hostinger FTP host)."
  default     = "www.archagentix.com"
}

variable "secrets_custom_domain" {
  type        = string
  description = "Custom domain attached to the Secret Share Hosting site (<project>-secrets), served from .github/workflows/deploy-secrets.yml. Empty = domain not attached."
  default     = "secrets.archagentix.com"
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

# --- Self-hosted LiteLLM gateway (litellm.tf) --------------------------------
# A PoC: per-request opt-in gateway with request tracing, running Postgres and
# Redis as sidecars on emptyDir so no Cloud SQL instance is stood up. Everything
# here is gated OFF by default.

variable "litellm_enabled" {
  type        = bool
  description = "Create the LiteLLM gateway service + its secrets/IAM. OFF means the `litellm` value of the per-request X-AI-Fleet-Llm-Gateway flag is inert server-side (CONFIG.LITELLM.enabled stays false) and no gateway infra exists."
  default     = false
}

variable "litellm_service_name" {
  type        = string
  description = "Cloud Run service name for the LiteLLM proxy. Also prefixes its generated Secret Manager ids."
  default     = "ai-fleet-litellm"
}

# The three LiteLLM images are published by CI from deploy/gcp/Dockerfile.litellm-{app,db,redis},
# each of which pins its upstream BY DIGEST, so the version identity lives in the
# Dockerfile and these tags behave like every other service: empty falls back to
# var.image_tag (the commit SHA CI just pushed). Re-pin a Dockerfile to upgrade.

variable "litellm_image_tag" {
  type        = string
  description = "Per-service image tag override for the LiteLLM app overlay (deploy/gcp/Dockerfile.litellm-app). Empty → var.image_tag."
  default     = ""
}

variable "litellm_db_image_tag" {
  type        = string
  description = "Per-service image tag override for the postgres sidecar (deploy/gcp/Dockerfile.litellm-db). Empty → var.image_tag. LiteLLM itself runs the schema migrations from the app container."
  default     = ""
}

variable "litellm_redis_image_tag" {
  type        = string
  description = "Per-service image tag override for the redis sidecar mirror (deploy/gcp/Dockerfile.litellm-redis). Empty → var.image_tag."
  default     = ""
}

variable "litellm_base_url" {
  type        = string
  description = "Override for the gateway's own URL, published to the agent sidecars as LITELLM_PROXY_UPSTREAM. Empty uses Cloud Run's deterministic run.app URL."
  default     = ""
}

variable "litellm_ingress" {
  type        = string
  description = "Cloud Run v2 ingress for the gateway. INTERNAL_ONLY is the safe default: a public LiteLLM would be a master-key-only endpoint anyone could spend against."
  default     = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  validation {
    condition     = contains(["INGRESS_TRAFFIC_ALL", "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER", "INGRESS_TRAFFIC_INTERNAL_ONLY"], var.litellm_ingress)
    error_message = "litellm_ingress must be a valid Cloud Run v2 ingress value."
  }
}

variable "litellm_container_concurrency" {
  type        = string
  description = "Max concurrent requests per LiteLLM instance. >1 requires resources.cpu_idle = false on the app container (enforced in litellm.tf). Streaming agent turns also share the instance with Postgres and Redis."
  default     = "80"

  validation {
    condition     = can(tonumber(var.litellm_container_concurrency)) && tonumber(var.litellm_container_concurrency) >= 1
    error_message = "litellm_container_concurrency must be a number >= 1."
  }
}

variable "litellm_min_instances" {
  type        = string
  description = "Minimum instances. Kept at 1 for the PoC because every cold start re-initialises an EMPTY database and re-runs LiteLLM's migrations; scale-to-zero would make each first request after an idle window pay that init. max_instance_count is pinned to 1 structurally, not from this variable."
  default     = "1"
}

variable "litellm_cpu" {
  type        = string
  description = "CPU limit for the LiteLLM app container. Must be >= 1 when container_concurrency > 1."
  default     = "1"
}

variable "litellm_memory" {
  type        = string
  description = "Memory for the LiteLLM app container. LiteLLM + uvicorn workers + (with medium=memory) Postgres buffers all draw from this one envelope — raise before chasing OOMs."
  default     = "2Gi"
}

variable "litellm_db_cpu" {
  type        = string
  description = "CPU limit for the Postgres sidecar."
  default     = "1"
}

variable "litellm_db_memory" {
  type        = string
  description = "Memory limit for the Postgres sidecar."
  default     = "512Mi"
}

variable "litellm_redis_cpu" {
  type        = string
  description = "CPU limit for the Redis sidecar."
  default     = "1"
}

variable "litellm_redis_memory" {
  type        = string
  description = "Memory limit for the Redis sidecar."
  default     = "256Mi"
}

variable "litellm_redis_maxmemory" {
  type        = string
  description = "Redis maxmemory (bytes) passed on the command line; must sit below litellm_redis_memory so Redis evicts before the container is OOM-killed."
  default     = "200000000"
}

variable "litellm_pg_volume_medium" {
  type        = string
  description = "emptyDir medium for PGDATA. \"memory\" is free but counts against the instance RAM limit; switch to \"disk\" under memory pressure (ephemeral either way)."
  default     = "memory"

  validation {
    condition     = contains(["memory", "disk"], var.litellm_pg_volume_medium)
    error_message = "litellm_pg_volume_medium must be \"memory\" or \"disk\"."
  }
}

variable "litellm_pg_volume_size" {
  type        = string
  description = "emptyDir size limit for PGDATA. Postgres writes spend-log rows into it for the life of the instance."
  default     = "1Gi"
}

variable "litellm_redis_volume_size" {
  type        = string
  description = "emptyDir size limit for the Redis data mount. AOF is disabled, so this only ever holds Redis's transient dump target."
  default     = "256Mi"
}

variable "litellm_database_name" {
  type        = string
  description = "Postgres database name LiteLLM stores keys, spend logs, and trace rows in."
  default     = "litellm"
}

variable "litellm_master_key_secret_id" {
  type        = string
  description = "Secret Manager id holding LiteLLM's master key (Admin UI password + privileged /key/* RPC auth). Created with prevent_destroy; its VALUE is seeded out-of-band."
  default     = "litellm-master-key"
}

variable "litellm_salt_key_secret_id" {
  type        = string
  description = "Secret Manager id holding LiteLLM's salt key (encrypts DB-stored credentials). Created with prevent_destroy; its VALUE is seeded out-of-band. Rotating it orphans every provider key stored in the DB, which is why config.yaml keeps provider keys in os.environ/."
  default     = "litellm-salt-key"
}

variable "litellm_provider_secrets" {
  type        = map(string)
  description = "ENV_NAME => Secret Manager id for the provider keys the gateway pays with (e.g. ANTHROPIC_API_KEY = \"anthropic-api-key\"). Unlike the agent containers, the gateway legitimately holds these; they reuse the ids already managed for var.managed_provider_secrets so there is one key to rotate."
  default = {
    ANTHROPIC_API_KEY = "anthropic-api-key"
    OPENAI_API_KEY    = "openai-api-key"
  }
}


variable "litellm_config_path" {
  type        = string
  description = "Path to LiteLLM's config.yaml inside the app image (built from deploy/litellm/config.yaml). Override to point at a GCS-hosted config without a rebuild."
  default     = "/app/config.yaml"
}

# -----------------------------------------------------------------------------
# Observability (observability.tf) — off by default; every resource is gated.
# -----------------------------------------------------------------------------

variable "observability_enabled" {
  type        = bool
  description = "Create the log bucket, per-service sinks, log-based metrics and alerting policies. OFF means nothing in observability.tf exists and the Logging/Monitoring APIs stay disabled; ON costs money (user-defined log-based metrics bill as Monitoring custom metrics, the GCS sink bills storage plus writes)."
  default     = false
}

variable "observability_log_services" {
  type        = list(string)
  description = "Cloud Run service names whose revision logs are exported to the log bucket. Empty (the default) uses the *_service_name variables, so a renamed service follows its sink without a second edit; a non-empty list is an explicit override — which then DOES have to be edited when a service is renamed."
  default     = []
}

variable "observability_log_retention_days" {
  type        = number
  description = "Days a log object lives in the export bucket before the lifecycle rule deletes it. This is the durable copy of the money events, so shortening it below a billing cycle makes a disputed debit unanswerable; lengthening it is pure storage cost."
  default     = 400

  validation {
    condition     = var.observability_log_retention_days >= 30 && var.observability_log_retention_days <= 3650
    error_message = "observability_log_retention_days must be between 30 and 3650 days."
  }
}

variable "observability_notification_channels" {
  type        = list(string)
  description = "Cloud Monitoring notification channel resource names (projects/<p>/notificationChannels/<id>) the alert policies address. The provider cannot create channels — email/SMS channels are deprecated upstream, so make a Pub/Sub topic channel by hand and let a subscriber fan out. Empty creates NO alert policy at all, because a policy with no channel reports success while promising nothing."
  default     = []
}

variable "observability_no_route_alert_count" {
  type        = number
  description = "How many unmatched-prefix egress requests in the alert window constitute probing worth waking someone for. One 404 is a mis-set base URL; a burst is somebody testing whether the sidecar forwards anywhere. Route prefixes are never logged verbatim, so the count is all this signal can carry."
  default     = 25

  validation {
    condition     = var.observability_no_route_alert_count >= 1
    error_message = "observability_no_route_alert_count must be at least 1."
  }
}

# -----------------------------------------------------------------------------
# Substrate agent pattern — where the actor control plane is, and who may use it
# -----------------------------------------------------------------------------
# The control plane itself is a different root (deploy/gcp/terraform-substrate-gke).
# This root's whole job for the pattern is to tell its services which address to
# dial and which namespaces they
# are allowed to touch. substrate.tf emits NONE of these as env while
# substrate_url is blank, which is the state the code already calls "not
# configured" (DEFAULT_SUBSTRATE_URL = '' in
# packages/shared-core/src/agent/substrate.js): the pattern stays inert rather
# than half-wired, and a request that asks for it fails up front instead of
# mid-run. An empty by default is also what keeps a shared-stack deployment from
# accidentally naming a namespace it does not own.

variable "substrate_url" {
  type        = string
  description = "gRPC address of the substrate control plane (CreateActor / AssignActor / ListActors). Empty leaves the substrate agent pattern unconfigured."
  default     = ""
}

variable "substrate_ingress_url" {
  type        = string
  description = "Public front door an actor session is reached through (the substrate ingress host). Empty means the deployment derives it from substrate_url; the two differ because the control plane is cluster-internal while actors are addressed from outside."
  default     = ""
}

variable "substrate_atespace" {
  type        = string
  description = "The atespace this deployment pins. A per-tenant stack sets its own; a shared stack normally leaves this empty and uses substrate_atespace_by_org instead, because one deployment that defaults every org into one space is a tenant sharing another tenant's namespace."
  default     = ""

  validation {
    condition     = var.substrate_atespace == "" || can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.substrate_atespace))
    error_message = "substrate_atespace must be a lowercase DNS-label-like name (letters, digits, interior hyphens)."
  }
}

variable "substrate_allowed_atespaces" {
  type        = list(string)
  description = "Atespaces a caller may SELECT. Deliberately empty by default: resolveSubstrateAtespace honors a request-supplied name only when it appears here, so the fail-open behaviour (any name a request guesses) is the thing being switched on, not off."
  default     = []

  validation {
    condition     = alltrue([for name in var.substrate_allowed_atespaces : can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", name))])
    error_message = "Every substrate_allowed_atespaces entry must be a lowercase DNS-label-like name."
  }
}

variable "substrate_atespace_by_org" {
  type        = map(string)
  description = "The org→atespace binding table for a deployment fronting several tenants, rendered as `org=space,...`. Keys are organization ids as the product stores them; the init run (org.atespace.bind, then the provisioner) owns writing the real thing, so this is the shared-stack bootstrap, not the source of truth."
  default     = {}

  validation {
    condition = alltrue([
      for org, space in var.substrate_atespace_by_org :
      length(trim(org, " ")) > 0 && can(regex("^[^,=]+$", org)) && can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", space))
    ])
    error_message = "substrate_atespace_by_org needs a non-empty org key with no comma or equals sign, and a lowercase DNS-label-like atespace per entry. The binding reaches the container as one `org=space,...` string, so a separator inside a key splits the pair; parseOrgAtespaces drops anything malformed instead of failing, and a dropped binding is a run that refuses at runtime with no trace of the typo."
  }
}

variable "substrate_worker_pool" {
  type        = string
  description = "Name of the WorkerPool an actor run is scheduled onto, sent as workerSelector {ate.dev/worker-pool = this}. It matches the WorkerPool CR's name (ate-controller labels the pool's pods with it), NOT any node label — and the substrate GKE root creates no WorkerPool: the install workflow does (docs/SUBSTRATE_INTEGRATION.md §5.3), so this must agree with SUBSTRATE_WORKER_POOL there or every actor sits Pending."
  default     = "planner-pool"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.substrate_worker_pool))
    error_message = "substrate_worker_pool must be a lowercase DNS-label-like name; resolveSubstrateWorkerPool rewrites anything else into a guess."
  }
}

variable "substrate_planner_image" {
  type        = string
  description = "Container image an actor workspace is created from. Empty falls back to the per-run image a caller names, which the planner takes from org settings. It is NOT the Cloud Run planner image: an actor needs the agent toolchain in the image, while the Cloud Run service only serves HTTP."
  default     = ""
}

variable "substrate_timeout_ms" {
  type        = number
  description = "Deadline for one substrate control-plane call, in milliseconds. A worker start is the slow path: it can pull an image."
  default     = 60000

  validation {
    condition     = var.substrate_timeout_ms >= 1000 && var.substrate_timeout_ms <= 900000
    error_message = "substrate_timeout_ms must be between 1000 and 900000 (15 minutes)."
  }
}

variable "substrate_actor_ttl_ms" {
  type        = number
  description = "How long an idle actor is kept warm before it is considered gone, in milliseconds. Raising it costs idle gVisor sandboxes; lowering it makes a slow run look like a dead one."
  default     = 120000

  validation {
    condition     = var.substrate_actor_ttl_ms >= 1000
    error_message = "substrate_actor_ttl_ms must be at least 1000."
  }
}

variable "substrate_jwks_url" {
  type        = string
  description = "JWKS the planner uses to verify a substrate actor's own JWT at POST /internal/substrate/actor. Empty disables that endpoint (it stays closed unless BOTH substrate_actor_mode and this are set) — which is the safe half-state, since the endpoint accepts a prompt on behalf of an org."
  default     = ""
}

variable "substrate_actor_mode" {
  type        = bool
  description = "Accept actor-originated dispatches on the planner. Paired with substrate_jwks_url: the endpoint refuses to open for a deployment that cannot verify the token it would be trusting."
  default     = false
}

variable "substrate_actor_member" {
  type        = string
  description = "The IAM member a substrate actor invokes the planner as — a Google service account email, or the Workload Identity Federation principal of the cluster identity the actors run under (the same identity SUBSTRATE_TRUST_DOMAIN describes). It is the receiving half of substrate_actor_mode: empty creates no invoker binding, so the router is mounted but nobody can reach it. You cannot open /internal/plan/run without naming WHO may call it."
  default     = ""
}

variable "substrate_actor_jwt_audience" {
  type        = string
  description = "audience a substrate actor JWT must carry to be accepted by the planner's /internal/plan/run. It is whatever the control plane stamps, not a value invented here; the default matches substrate-runner's own default."
  default     = "substrate-router"
}

variable "substrate_trust_domain" {
  type        = string
  description = "SPIFFE trust domain an actor identity is issued under (the prefix of its JWT sub). The substrate root names it; a mismatch fails verification closed."
  default     = "cluster.local"
}

variable "environment_init_enabled" {
  type        = bool
  description = "Sign-in opens a durable environment-init run for the caller's org and walks its steps in the background (bind the org's atespace, ask the cluster for it, ensure the dedicated stack). OFF keeps a login free of infrastructure side effects. It is a separate switch from provisioning_enabled because the atespace step is useful on a substrate deployment that is not standing up a whole per-tenant stack — see substrate.tf for why the topic + provisioner must then exist anyway."
  default     = false
}
