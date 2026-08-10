# -----------------------------------------------------------------------------
# Cloud Run — gateway (public), planner (internal), coder-control (internal),
# and the coder-worker Job.
# -----------------------------------------------------------------------------
# All services scale to zero (min_instance_count = 0) and idle CPU is throttled,
# so an idle deployment costs nothing.

locals {
  # Skills registry (skills.tf). Terraform CREATES the bucket when skills_enabled.
  # The read-only gcsfuse MOUNT (+ gen2 exec env + SKILLS_ROOT env) is a SEPARATE
  # toggle, skills_mount_enabled, default OFF: the fuse mount under gen2 currently
  # fails the coder-control startup probe (heavy dual-role image), so the mount is
  # opt-in until that's validated. Mount off → services use the vendored skills
  # baked into the image (packages/shared/src/config.js resolveSkillsSrc). The
  # mount requires the bucket, so it is ANDed with skills_enabled.
  skills_enabled       = var.skills_enabled
  skills_mount_enabled = var.skills_mount_enabled && var.skills_enabled
  skills_env = local.skills_mount_enabled ? {
    SKILLS_ROOT    = "/skills"
    SKILLS_VERSION = var.skills_version
  } : {}

  # Plain (non-secret) env per service. Secrets are mounted as separate env
  # blocks below via secret_key_ref.
  gateway_env = merge(local.common_env, {
    AUTH_MODE           = "firebase" # gateway verifies the Firebase ID token
    SPA_ORIGIN          = var.spa_origin
    API_BASE_URL        = local.gateway_url
    PLANNER_URL         = local.planner_url # proxied read endpoints
    CODER_URL           = local.coder_url
    ORG_URL             = local.org_url      # org service (proxied at /api/org/*)
    SETTINGS_URL        = local.settings_url # settings service (proxied at /api/settings-policy/*)
    FIREBASE_PROJECT_ID = var.project_id
    FIREBASE_API_KEY    = data.google_firebase_web_app_config.default.api_key
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

  # Egress-proxy sidecar: when enabled, the agent containers route every
  # third-party call to the co-located proxy over loopback (which injects the
  # real credential), so they hold NO raw provider key. `egress_env` is merged
  # into the agent containers; the sidecar container + its secret env is added to
  # each service below. proxy_enabled ANDs a var so a deployment without the
  # proxy image built keeps the direct (pre-sidecar) behavior.
  proxy_enabled = var.egress_proxy_enabled
  egress_env    = local.proxy_enabled ? { EGRESS_PROXY_URL = "http://127.0.0.1:4030" } : {}

  # Plain env for the proxy sidecar. It imports @ai-fleet/shared/config (which
  # requires AUTH_MODE + the Firebase web config at load) and reads the
  # per-namespace store for OAuth token sets, so it needs the common cloud env
  # plus its own port and the shared settings URL for the per-org secret S2S.
  proxy_plain_env = merge(local.common_env, {
    PROXY_PORT   = "4030"
    SETTINGS_URL = local.settings_url
  })

  planner_env = merge(local.common_env, {
    # The planner listens on PLANNER_PORT, not PORT — bind Cloud Run's port.
    PLANNER_PORT         = "8080"
    PUBSUB_PUSH_AUDIENCE = local.planner_url
    PUBSUB_PUSH_SA       = google_service_account.pubsub_push.email
  }, local.skills_env, local.egress_env)

  coder_control_env = merge(local.common_env, {
    # The coder-control listens on CODER_SERVICE_PORT, not PORT.
    CODER_SERVICE_PORT   = "8080"
    CODER_ROLE           = "control"
    CODER_JOB_NAME       = var.coder_job_name
    PUBSUB_PUSH_AUDIENCE = local.coder_url
    PUBSUB_PUSH_SA       = google_service_account.pubsub_push.email
    CODER_REPO_URL       = var.coder_repo_url
    # Peer-service URLs are PARAMETERS of the coder deployment (never browser-
    # facing): the coder calls settings (effective config) and org/planner S2S.
    # Without these the cloud coder falls back to localhost. A per-tenant coder is
    # given its own PLANNER_URL + the SHARED ORG_URL/SETTINGS_URL the same way.
    PLANNER_URL  = local.planner_url
    ORG_URL      = local.org_url
    SETTINGS_URL = local.settings_url
  }, local.skills_env, local.egress_env)

  coder_worker_env = merge(local.common_env, {
    CODER_ROLE = "worker"
    # The worker clones/builds/tests under /tmp (the only reliably-writable path
    # for the non-root container).
    HOME                         = "/tmp"
    CODER_WORKSPACE_ROOT         = "/tmp/coder-workspaces"
    CODER_PLANNED_WORKSPACE_ROOT = "/tmp/coder-git-workspace"
    CODER_REPO_URL               = var.coder_repo_url
    # The worker also resolves effective settings + org/planner S2S (see above).
    PLANNER_URL  = local.planner_url
    ORG_URL      = local.org_url
    SETTINGS_URL = local.settings_url
    # ISSUE_ID (+ CONVERSATION_ID) are supplied per-execution by coder-control
    # as container overrides — see packages/shared/src/messaging/jobs.js.
  }, local.skills_env, local.egress_env)
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
# The sidecar runs under the planner/coder service accounts (Cloud Run v2 shares
# the service SA across all its containers). When the proxy is enabled it needs:
#   - accessor on the shared internal token (to call the settings per-org S2S), and
#   - run.invoker on the shared settings service (the IAM-gated S2S target).
# Accessors on the managed provider secrets (linear + extra_secret_ids) are
# already granted to planner-sa/coder-sa in iam.tf.
locals {
  proxy_sa_members = var.egress_proxy_enabled ? {
    planner = google_service_account.planner.email
    coder   = google_service_account.coder.email
  } : {}
}

# Gated on egress_proxy_enabled via proxy_sa_members (a non-sensitive map); the
# token secret id is pulled with one() so this never indexes a count=0 resource.
# (var.internal_api_token is sensitive and cannot appear in for_each.) If the
# proxy is enabled the internal token MUST be configured — see the variable.
resource "google_secret_manager_secret_iam_member" "proxy_internal_token" {
  for_each  = local.proxy_sa_members
  project   = var.project_id
  secret_id = one(google_secret_manager_secret.internal_api_token[*].secret_id)
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value}"
}

resource "google_cloud_run_v2_service_iam_member" "proxy_invokes_settings" {
  for_each = local.proxy_sa_members
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.settings.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${each.value}"
}

# --- Gateway (PUBLIC) ---------------------------------------------------------
resource "google_cloud_run_v2_service" "gateway" {
  project  = var.project_id
  name     = var.gateway_service_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"
  labels   = merge(local.common_labels, { component = "gateway" })
  # Off so a region move (or teardown) can replace the service. This app is
  # stateless per-service; state lives in Firestore, not the Cloud Run resource.
  deletion_protection = false

  template {
    service_account = google_service_account.gateway.email

    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }

    containers {
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

      # Secret env (Secret Manager). Versions must exist before deploy.
      env {
        name = "STREAM_TOKEN_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.stream_token_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "LINEAR_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.linear_api_key.secret_id
            version = "latest"
          }
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
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true # throttle CPU when idle → no idle cost
        startup_cpu_boost = true
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_firestore_database.default,
    google_project_iam_member.gateway_datastore,
    google_secret_manager_secret_iam_member.gateway_stream_token,
    google_secret_manager_secret_iam_member.gateway_linear,
    google_secret_manager_secret_version.google_one_tap_client_id,
    google_secret_manager_secret_iam_member.gateway_one_tap,
  ]
}

# --- Planner (non-public, IAM-gated) ------------------------------------------
# ingress defaults to INGRESS_TRAFFIC_ALL but there is NO allUsers invoker — only
# gateway-sa and pubsub-push-sa hold roles/run.invoker (see iam.tf), so every
# request must carry a valid OIDC token (Cloud Run platform auth, not app-level
# token validation). This lets the gateway's OIDC-authenticated reverse-proxy
# reach the read endpoints over run.app AND lets Pub/Sub push / Cloud Scheduler
# in — all without a VPC (no cost). For network-layer isolation instead, set
# var.internal_ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY" and add Direct VPC egress
# to the gateway (Cloud Run gen2, no paid connector):
#   template { vpc_access { network_interfaces { network=... subnetwork=... }
#                          egress = "ALL_TRAFFIC" } }
resource "google_cloud_run_v2_service" "planner" {
  project             = var.project_id
  name                = var.planner_service_name
  location            = var.region
  ingress             = var.internal_ingress # IAM-gated; see note above
  labels              = merge(local.common_labels, { component = "planner" })
  deletion_protection = false

  template {
    service_account = google_service_account.planner.email

    # gcsfuse GCS volume mounts run on the gen2 execution environment. null (the
    # platform default) when the skills registry is disabled.
    execution_environment = local.skills_mount_enabled ? "EXECUTION_ENVIRONMENT_GEN2" : null

    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }

    # Versioned skills bundle mounted read-only via gcsfuse (skills.tf). Only
    # present when a bucket is configured.
    dynamic "volumes" {
      for_each = local.skills_mount_enabled ? [1] : []
      content {
        name = "skills"
        gcs {
          bucket    = google_storage_bucket.skills[0].name
          read_only = true
        }
      }
    }

    containers {
      name  = "app"
      image = local.planner_image

      ports {
        container_port = 8080
      }

      dynamic "env" {
        for_each = local.planner_env
        content {
          name  = env.key
          value = env.value
        }
      }

      # Direct mode keeps the Linear key on the agent; proxy mode relocates it to
      # the sidecar so this container holds no provider secret.
      dynamic "env" {
        for_each = local.proxy_enabled ? [] : [1]
        content {
          name = "LINEAR_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.linear_api_key.secret_id
              version = "latest"
            }
          }
        }
      }

      # Mount the skills bundle at SKILLS_ROOT (/skills). resolveSkillsSrc pins
      # /skills/<SKILLS_VERSION>.
      dynamic "volume_mounts" {
        for_each = local.skills_mount_enabled ? [1] : []
        content {
          name       = "skills"
          mount_path = "/skills"
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }
    }

    dynamic "containers" {
      for_each = local.proxy_enabled ? [1] : []
      content {
        name  = "egress-proxy"
        image = local.proxy_image

        dynamic "env" {
          for_each = local.proxy_plain_env
          content {
            name  = env.key
            value = env.value
          }
        }
        # Managed keys are resolved by the settings service (single source) and
        # returned over the S2S below — the sidecar mounts no provider secret.
        # Shared token for the per-org secret S2S to the settings service.
        dynamic "env" {
          for_each = toset(google_secret_manager_secret.internal_api_token[*].secret_id)
          content {
            name = "INTERNAL_API_TOKEN"
            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
            }
          }
        }
        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
          cpu_idle = true
        }
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_firestore_database.default,
    google_project_iam_member.planner_datastore,
    google_secret_manager_secret_iam_member.planner_linear,
    google_storage_bucket.skills,
  ]
}

# --- Coder-control (non-public, IAM-gated — see the planner note) -------------
resource "google_cloud_run_v2_service" "coder_control" {
  project             = var.project_id
  name                = var.coder_service_name
  location            = var.region
  ingress             = var.internal_ingress # IAM-gated; see the planner note above
  labels              = merge(local.common_labels, { component = "coder-control" })
  deletion_protection = false

  template {
    service_account = google_service_account.coder.email

    # gcsfuse GCS volume mounts run on the gen2 execution environment. null (the
    # platform default) when the skills registry is disabled.
    execution_environment = local.skills_mount_enabled ? "EXECUTION_ENVIRONMENT_GEN2" : null

    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }

    # Versioned skills bundle mounted read-only via gcsfuse (skills.tf). Only
    # present when a bucket is configured.
    dynamic "volumes" {
      for_each = local.skills_mount_enabled ? [1] : []
      content {
        name = "skills"
        gcs {
          bucket    = google_storage_bucket.skills[0].name
          read_only = true
        }
      }
    }

    containers {
      name  = "app"
      image = local.coder_image

      ports {
        container_port = 8080
      }

      dynamic "env" {
        for_each = local.coder_control_env
        content {
          name  = env.key
          value = env.value
        }
      }

      # Direct mode keeps the Linear key on the agent; proxy mode relocates it to
      # the sidecar so this container holds no provider secret.
      dynamic "env" {
        for_each = local.proxy_enabled ? [] : [1]
        content {
          name = "LINEAR_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.linear_api_key.secret_id
              version = "latest"
            }
          }
        }
      }

      # Mount the skills bundle at SKILLS_ROOT (/skills). resolveSkillsSrc pins
      # /skills/<SKILLS_VERSION>.
      dynamic "volume_mounts" {
        for_each = local.skills_mount_enabled ? [1] : []
        content {
          name       = "skills"
          mount_path = "/skills"
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }
    }

    dynamic "containers" {
      for_each = local.proxy_enabled ? [1] : []
      content {
        name  = "egress-proxy"
        image = local.proxy_image

        dynamic "env" {
          for_each = local.proxy_plain_env
          content {
            name  = env.key
            value = env.value
          }
        }
        dynamic "env" {
          for_each = toset(google_secret_manager_secret.internal_api_token[*].secret_id)
          content {
            name = "INTERNAL_API_TOKEN"
            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
            }
          }
        }
        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
          cpu_idle = true
        }
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_firestore_database.default,
    google_project_iam_member.coder_datastore,
    google_secret_manager_secret_iam_member.coder_linear,
    google_storage_bucket.skills,
  ]
}

# --- Coder-worker (Cloud Run JOB) ---------------------------------------------
# Same image as coder-control; CODER_ROLE=worker selects the job entrypoint.
# Launched one execution per ticket by coder-control (with ISSUE_ID override);
# runs the ticket to completion (up to 24h), then exits.
resource "google_cloud_run_v2_job" "coder_worker" {
  project             = var.project_id
  name                = var.coder_job_name
  location            = var.region
  labels              = merge(local.common_labels, { component = "coder-worker" })
  deletion_protection = false

  template {
    parallelism = 1 # one ticket per execution
    task_count  = 1

    template {
      service_account = google_service_account.coder.email
      timeout         = var.coder_job_task_timeout
      max_retries     = 1

      # gcsfuse GCS volume mounts run on the gen2 execution environment. The
      # worker is where the coder agent actually installs skills, so it needs the
      # same versioned mount as the services. null when the registry is disabled.
      execution_environment = local.skills_mount_enabled ? "EXECUTION_ENVIRONMENT_GEN2" : null

      dynamic "volumes" {
        for_each = local.skills_mount_enabled ? [1] : []
        content {
          name = "skills"
          gcs {
            bucket    = google_storage_bucket.skills[0].name
            read_only = true
          }
        }
      }

      containers {
        name  = "app"
        image = local.coder_image

        dynamic "env" {
          for_each = local.coder_worker_env
          content {
            name  = env.key
            value = env.value
          }
        }

        # Direct mode keeps the Linear key on the agent; proxy mode relocates it
        # to the sidecar so this container holds no provider secret.
        dynamic "env" {
          for_each = local.proxy_enabled ? [] : [1]
          content {
            name = "LINEAR_API_KEY"
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.linear_api_key.secret_id
                version = "latest"
              }
            }
          }
        }

        # Mount the skills bundle at SKILLS_ROOT (/skills). resolveSkillsSrc pins
        # /skills/<SKILLS_VERSION>.
        dynamic "volume_mounts" {
          for_each = local.skills_mount_enabled ? [1] : []
          content {
            name       = "skills"
            mount_path = "/skills"
          }
        }

        resources {
          limits = {
            cpu    = var.coder_job_cpu
            memory = var.coder_job_memory
          }
        }
      }

      dynamic "containers" {
        for_each = local.proxy_enabled ? [1] : []
        content {
          name  = "egress-proxy"
          image = local.proxy_image

          dynamic "env" {
            for_each = local.proxy_plain_env
            content {
              name  = env.key
              value = env.value
            }
          }
          dynamic "env" {
            for_each = toset(google_secret_manager_secret.internal_api_token[*].secret_id)
            content {
              name = "INTERNAL_API_TOKEN"
              value_source {
                secret_key_ref {
                  secret  = env.value
                  version = "latest"
                }
              }
            }
          }
          resources {
            limits = {
              cpu    = var.coder_job_cpu
              memory = var.coder_job_memory
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_firestore_database.default,
    google_project_iam_member.coder_datastore,
    google_secret_manager_secret_iam_member.coder_linear,
    google_storage_bucket.skills,
  ]
}
