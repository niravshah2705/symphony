# -----------------------------------------------------------------------------
# Cloud Run — gateway (public). The planner/coder/tester services and the
# coder-worker Job are retired: the browser agent surface + durable pipeline now
# run on the orchestrator (pipeline.tf) and agent execution runs as substrate
# actors (deploy/gcp/Dockerfile.substrate-actor).
# -----------------------------------------------------------------------------
# By default all services scale from zero to one instance, accept up to 1000
# concurrent requests per instance, and throttle idle CPU. The defaults remain
# configurable through the scaling/concurrency variables in variables.tf.

locals {
  # Skills registry (skills.tf). Terraform CREATES the bucket when skills_enabled.
  # The read-only gcsfuse MOUNT (+ SKILLS_ROOT env) is a SEPARATE toggle,
  # skills_mount_enabled, default OFF: the fuse mount under gen2 previously
  # failed the heavy dual-role coder-control startup probe, so the mount stayed
  # opt-in until that's validated. Mount off → services use the vendored skills
  # baked into the image (packages/shared/src/config.js resolveSkillsSrc). The
  # mount requires the bucket, so it is ANDed with skills_enabled.
  skills_enabled       = var.skills_enabled
  skills_mount_enabled = var.skills_mount_enabled && var.skills_enabled
  skills_env = local.skills_mount_enabled ? {
    SKILLS_ROOT    = "/skills"
    SKILLS_VERSION = var.skills_version
  } : {}

  # Agent memory store (memory.tf) — Cloud SQL for PostgreSQL. Terraform CREATES
  # the instance when memory_enabled. The orchestrator gets a cloud_sql volume
  # mounted at /cloudsql (the Auth Proxy socket) + the connection string
  # delivered below. MEMORY_ENABLED is intentionally NOT set here: a reachable
  # database only makes the store AVAILABLE; activation stays an explicit
  # per-org opt-in (the middleware also honors a per-org memoryEnabled setting).
  #
  # The connection string is delivered as a mounted SECRET FILE, not a secret
  # env: per-tenant provisioning requires agent primaries to be secret-env-free
  # (packages/shared-core/src/provisioning/index.js requireSecretFreePrimary).
  memory_enabled = var.memory_enabled
  memory_env = local.memory_enabled ? {
    MEMORY_DATABASE_URL_FILE = "/secrets/memory-db/url"
  } : {}

  # Plain (non-secret) env per service. Secrets are mounted as separate env
  # blocks below via secret_key_ref.
  gateway_env = merge(local.common_env, {
    AUTH_MODE        = "firebase" # gateway verifies the Firebase ID token
    TRUST_PROXY_HOPS = "1"        # direct Cloud Run ingress; req.ip is advisory locale only
    SPA_ORIGIN       = var.spa_origin
    API_BASE_URL     = local.gateway_url
    # The agent surface (browser-facing /api/agent/*, /api/coder/*) and the
    # durable pipeline control plane are the SAME service now — the retired
    # planner/coder URLs must not come back: CONFIG.SERVICES.agentUrl is what
    # services/gateway proxies to.
    AGENT_URL        = local.orchestrator_url
    ORCHESTRATOR_URL = local.orchestrator_url
    ORG_URL          = local.org_url      # org service (proxied at /api/org/*)
    SETTINGS_URL     = local.settings_url # settings service (proxied at /api/settings-policy/*)
    IDENTITY_URL     = local.identity_url # identity verification service (proxied at /api/identity/*)
    BILLING_URL      = local.billing_url  # billing service (proxied at /api/billing/*)
    # Use the provider-returned origin rather than reconstructing the run.app
    # hostname: Cloud Run ID-token audiences must match the deployed service
    # URL exactly, including projects that still use a legacy hash-style URL.
    STREAM_TOKEN_SERVICE_URL = google_cloud_run_v2_service.stream_token_broker.uri
    FIREBASE_PROJECT_ID      = var.project_id
    FIREBASE_API_KEY         = data.google_firebase_web_app_config.default.api_key
    # RBAC (packages/shared/src/authz.js): least-privilege default role for a
    # signed-in user with no role claim yet. Roles are otherwise Firebase custom
    # claims (services/gateway/scripts/set-user-role.js).
    AUTH_DEFAULT_ROLE = var.auth_default_role
    # Firebase web config is PUBLIC (apiKey/authDomain/projectId) — served to the
    # browser via /api/auth/config, NOT a secret. Only set the optional keys when
    # non-empty so the gateway falls back to its own defaults otherwise.
    },
    var.firebase_auth_domain != "" ? { FIREBASE_AUTH_DOMAIN = var.firebase_auth_domain } : {},
    var.firebase_allowed_domain != "" ? { FIREBASE_ALLOWED_DOMAIN = var.firebase_allowed_domain } : {},
    length(concat(local.custom_domains, local.marketing_domains, local.secrets_domains)) > 0 ? { FIREBASE_CUSTOM_DOMAIN = join(",", concat(local.custom_domains, local.marketing_domains, local.secrets_domains)) } : {},
    var.auth_admin_emails != "" ? { AUTH_ADMIN_EMAILS = var.auth_admin_emails } : {},
    # Sign-in providers. Both are public config (the Azure client secret lives only
    # in the Firebase console). Only set the Microsoft flag when enabled so the
    # gateway keeps its default (Google-only) otherwise.
    var.auth_microsoft_enabled ? { AUTH_MICROSOFT_ENABLED = "true" } : {},
    var.microsoft_tenant != "" ? { MICROSOFT_TENANT = var.microsoft_tenant } : {},
    # GOOGLE_ONE_TAP_CLIENT_ID is NOT here — it is delivered from Secret Manager
    # (google_secret_manager_secret.google_one_tap_client_id) as a secret env on
    # the gateway container below, only when a value is configured.
  )

  # Egress-proxy sidecar: agent containers route every
  # third-party call to the co-located proxy over loopback (which injects the
  # real credential), so they hold NO raw provider key. `egress_env` is merged
  # into the agent containers; the sidecar container + its secret env is added to
  # each service below. There is intentionally no direct-mode fallback.
  egress_env = { EGRESS_PROXY_URL = "http://127.0.0.1:4030" }

  # Plain env for the proxy sidecar. It imports @ai-fleet/shared/config (which
  # requires AUTH_MODE + the Firebase web config at load) and reads the
  # per-namespace store for OAuth token sets, so it needs the common cloud env
  # plus its own port and the shared settings URL for the per-org secret S2S.
  proxy_plain_env = merge(
    local.common_env,
    {
      PROXY_PORT         = "4030"
      PROXY_BIND_HOST    = "0.0.0.0"
      PROXY_CAPABILITIES = "egress"
      SETTINGS_URL       = local.settings_url
    },
    trimspace(var.omlx_proxy_upstream) != "" ? {
      OMLX_PROXY_UPSTREAM = trimspace(var.omlx_proxy_upstream)
    } : {},
    trimspace(var.ollama_proxy_upstream) != "" ? {
      OLLAMA_PROXY_UPSTREAM = trimspace(var.ollama_proxy_upstream)
    } : {},
    trimspace(var.lmstudio_proxy_upstream) != "" ? {
      LMSTUDIO_PROXY_UPSTREAM = trimspace(var.lmstudio_proxy_upstream)
    } : {},
    trimspace(var.openswe_proxy_upstream) != "" ? {
      OPENSWE_PROXY_UPSTREAM = trimspace(var.openswe_proxy_upstream)
    } : {},
    # Self-hosted LiteLLM gateway (litellm.tf). The real origin lives ONLY here on
    # the sidecar — an agent container must not learn it, because model-generated
    # code in the coder could otherwise drive an arbitrary target through the
    # /litellm passthrough. Empty while var.litellm_enabled is false, so the route
    # fails closed instead of relaying. Operators additionally set
    # LITELLM_GATEWAY_ENABLED on the agent services to admit the browser flag,
    # exactly as LLM_GATEWAY_ENABLED is supplied out-of-band today.
    trimspace(local.litellm_url) != "" ? {
      LITELLM_PROXY_UPSTREAM = local.litellm_url
    } : {},
    # agentgateway (the in-cluster L7 front for LLM, MCP and A2A). Same rule as
    # LiteLLM, one gateway later: the origin lives ONLY on the sidecar, because
    # the /agentgw route forwards any sub-path and model-generated code in the
    # coder would otherwise drive an arbitrary target through a front that holds
    # a real provider key.
    #
    # Empty by default, which IS the dark state — the egress route fails closed
    # 502 rather than defaulting onto someone else's gateway. There is no
    # agentgateway_enabled here to disagree with that: the address is rendered by
    # the substrate root, so this root only ever receives it.
    trimspace(var.agentgateway_proxy_upstream) != "" ? {
      AGENTGATEWAY_PROXY_UPSTREAM = trimspace(var.agentgateway_proxy_upstream)
    } : {},
  )

  # The agent workloads' env (the retired planner/coder_control/coder_worker
  # maps) now lives in pipeline.tf as local.orchestrator_env — the orchestrator
  # absorbed the planner's browser surface, the legacy planner queue, and the
  # plan/code/test stage handlers. Deliberately absent here: nothing under
  # deploy/gcp may reintroduce PLANNER_*/CODER_*/TESTER_* env names; the
  # substrate-env contract tests pin which names exist on which service.
}

# --- Google One Tap client id (Secret Manager) --------------------------------
# The Google OAuth Web client id used by the One Tap prompt. It is technically a
# PUBLIC value (served to the browser via /api/auth/config), but per operator
# preference it is managed in Secret Manager alongside the other config secrets
# and injected as a secret env. Created + versioned by Terraform from the tfvar
# only when a value is provided; otherwise the SPA falls back to the Google popup.
# NOTE: Terraform cannot mint an OAuth client id — create the Web client in the
# GCP console (APIs & Services → Credentials) with the SPA origin as an
# Authorized JavaScript origin, then pass its id as google_one_tap_client_id.
resource "google_secret_manager_secret" "google_one_tap_client_id" {
  count     = var.google_one_tap_client_id != "" ? 1 : 0
  project   = var.project_id
  secret_id = "google-one-tap-client-id"
  labels    = merge(local.common_labels, { component = "gateway" })

  replication {
    auto {}
  }

  # The count is driven by a repo variable, so an empty GOOGLE_ONE_TAP_CLIENT_ID
  # reads as "turn One Tap off" and destroys the container — taking its versions
  # and the gateway's accessor with it. The console-minted client id cannot be
  # recovered from state, so refusing the plan is the cheaper failure. Deliberate
  # removal: flip the lifecycle off or `terraform state rm` it first.
  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_version" "google_one_tap_client_id" {
  count       = var.google_one_tap_client_id != "" ? 1 : 0
  secret      = google_secret_manager_secret.google_one_tap_client_id[0].id
  secret_data = var.google_one_tap_client_id
}

resource "google_secret_manager_secret_iam_member" "gateway_one_tap" {
  count     = var.google_one_tap_client_id != "" ? 1 : 0
  project   = var.project_id
  secret_id = google_secret_manager_secret.google_one_tap_client_id[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.gateway.email}"
}

# --- Egress-proxy sidecar IAM -------------------------------------------------
# The sidecar runs under the workload's service account (Cloud Run v2 shares the
# service SA across all its containers), so the settings-resolver invoker
# bindings live with the services that carry a sidecar: see
# google_cloud_run_v2_service_iam_member.pipeline_proxy_invokes_settings in
# pipeline.tf (orchestrator). The internal resolver token is
# placed directly on the sidecar container; granting Secret Manager access to
# the shared identity would let model-generated app code retrieve it through
# the metadata server.

# --- Gateway (PUBLIC) ---------------------------------------------------------
locals {
  # Direct VPC egress as a 0/1-element list, so the block below disappears from
  # the template entirely when switched off rather than rendering an empty
  # vpc_access (which the API would still record as a request for VPC config).
  gateway_vpc_access = var.gateway_vpc_egress_enabled ? [1] : []
}

resource "google_cloud_run_v2_service" "gateway" {
  project  = var.project_id
  name     = var.gateway_service_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"
  labels   = merge(local.common_labels, { component = "gateway" })
  # Off so a region move (or teardown) can replace the service. This app is
  # stateless per-service; state lives in Firestore, not the Cloud Run resource.
  deletion_protection = false

  lifecycle {
    precondition {
      condition     = var.min_instances <= var.max_instances
      error_message = "min_instances must be less than or equal to max_instances."
    }
    precondition {
      condition     = var.container_concurrency == 1 || try(tonumber(var.cloud_run_service_cpu) >= 1, false)
      error_message = "container_concurrency values above 1 require cloud_run_service_cpu to be at least 1 vCPU."
    }
    precondition {
      condition     = !var.gateway_vpc_egress_enabled || (var.vpc_network != "" && var.vpc_subnet != "")
      error_message = "gateway_vpc_egress_enabled needs both vpc_network and vpc_subnet; with either empty the service would keep its current (no-VPC) configuration while reading as switched on."
    }
  }

  template {
    # The gateway serves long-lived SSE connections (/api/agent/stream,
    # /api/agent/workspace-stream — see services/gateway/src/sse.js) that must
    # outlive Cloud Run's 300s default request timeout. Unconditional, since the
    # gateway's streaming need is unrelated to the pipeline-orchestrator feature
    # flag.
    # 3600s is Cloud Run v2's maximum allowed request timeout for services.
    service_account = google_service_account.gateway.email
    timeout         = "3600s"

    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = var.container_concurrency

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      name  = "app"
      image = local.gateway_image

      ports {
        container_port = 8080
      }

      dynamic "env" {
        for_each = local.gateway_env
        content {
          name  = env.key
          value = env.value
        }
      }

      # Public Google One Tap client id, delivered from Secret Manager only when
      # configured. Absent → the SPA uses the Firebase Google popup.
      dynamic "env" {
        for_each = var.google_one_tap_client_id != "" ? [1] : []
        content {
          name = "GOOGLE_ONE_TAP_CLIENT_ID"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.google_one_tap_client_id[0].secret_id
              version = "latest"
            }
          }
        }
      }

      resources {
        limits = {
          cpu    = var.cloud_run_service_cpu
          memory = "512Mi"
        }
        cpu_idle          = true # throttle CPU when idle → no idle cost
        startup_cpu_boost = true
      }
    }

    # Direct VPC egress — gen2's connector-less way onto a VPC. The block is
    # `network_interfaces` (plural) in the provider; the singular
    # `network_interface` is not a valid argument here. `connector` (a paid
    # Serverless VPC Access connector) is deliberately unused — same
    # destination, plus a throughput ceiling and another resource to babysit.
    dynamic "vpc_access" {
      for_each = local.gateway_vpc_access
      content {
        egress = var.vpc_egress_mode

        network_interfaces {
          network    = var.vpc_network
          subnetwork = var.vpc_subnet
        }
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_firestore_database.default,
    google_project_iam_member.gateway_datastore,
    google_secret_manager_secret_version.google_one_tap_client_id,
    google_secret_manager_secret_iam_member.gateway_one_tap,
    google_cloud_run_v2_service.stream_token_broker,
    google_cloud_run_v2_service_iam_member.gateway_invokes_stream_token_broker,
    google_cloud_run_v2_service.identity,
    google_cloud_run_v2_service_iam_member.gateway_invokes_identity,
  ]
}

