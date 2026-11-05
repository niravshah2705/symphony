# -----------------------------------------------------------------------------
# Self-hosted LiteLLM proxy — platform LLM gateway with request tracing (PoC).
# -----------------------------------------------------------------------------
# OFF by default (`var.litellm_enabled = false`): nothing here is created and the
# per-request `X-AI-Fleet-Llm-Gateway: litellm` flag stays inert server-side, so
# an un opted-in deployment is unchanged byte-for-byte.
#
# WHY ONE SERVICE WITH THREE CONTAINERS
# LiteLLM needs Postgres (virtual keys, spend logs, Admin UI) and Redis (router
# state shared across its uvicorn workers). Standing up Cloud SQL for a PoC costs
# more than the gateway is worth, so both run as sidecar containers in the same
# Cloud Run service — multi-container Cloud Run shares one network namespace, so
# 127.0.0.1 connects them with no VPC connector and no inbound TCP exposed.
#
# EPHEMERAL STATE — THE TRADE-OFF THIS BUYS, STATED EXPLICITLY
# Cloud Run has no persistent local disk. `emptyDir` is per-instance and is
# destroyed on every redeploy, restart, and scale-to-zero, so spend logs, trace
# rows AND minted virtual keys disappear when the instance dies.
#
# What still works after a wipe: the model catalog, which lives in the image's
# config.yaml rather than the DB. Authentication does NOT survive automatically,
# and that is deliberate — see the paragraph below about the master key.
#
# What does NOT work: per-org virtual keys. `/key/generate` returns a fresh `sk-`
# token every call, so re-minting an `org:<id>` alias after a wipe produces the same
# ALIAS but a different TOKEN — and the token is the credential the egress sidecar
# reads from the org vault. There is no internal S2S WRITE endpoint on the settings
# service (routes_internal.py is resolve-only; its one PUT is codex-token-specific),
# so nothing running inside this service can hand the new token back. Per-org key
# attribution therefore requires either (a) a persistent Postgres, or (b) a new
# operator-authenticated secret-write RPC. Until then spend is attributed per key,
# so an operator mints one model-scoped virtual key per opted-in org by hand and
# writes it to that org's vault as `litellmApiKey`. After a wipe those runs fail
# closed (proxy 502) until re-minted.
#
# DO NOT put LITELLM_MASTER_KEY in an org vault, even though it would survive every
# restart. The /litellm route forwards ANY sub-path to the gateway, so a coder
# container — which executes model-generated code — could spend that credential on
# privileged RPCs: /key/generate to mint unlimited keys, /global/spend/logs and
# /user/info to read every other org's usage, /config/key-list to enumerate them.
# Failing closed after a redeploy is the better failure; an admin credential inside
# the egress isolation boundary is the failure this whole sidecar exists to prevent.
#
# If last-week's-spend-by-org becomes a requirement this design cannot answer it at
# all — move Postgres to Cloud SQL (memory.tf's google_sql_database_instance is the
# in-repo template) or schedule a pg_dump to GCS (safe for a flat dump file; gcsfuse
# is NOT safe for a live PGDATA).
#
# `max_instance_count = 1` is STRUCTURAL, not a preference: two instances would
# mean two independent Postgres and two independent Redis — split-brain virtual
# keys and spend logs.

resource "google_service_account" "litellm" {
  count        = var.litellm_enabled ? 1 : 0
  project      = var.project_id
  account_id   = "ai-fleet-litellm-sa"
  display_name = "AI Fleet LiteLLM Gateway"
}

# Master key guards the Admin UI and every privileged /key/* RPC; the salt key
# encrypts whatever LiteLLM stores in Postgres. Losing the salt makes every
# provider key held IN THE DATABASE unreadable — which is why config.yaml keeps
# provider credentials in `os.environ/` and out of the DB entirely. Both are
# containers whose VALUES are seeded out-of-band (see secrets.tf), e.g.
#   printf %s "<value>" | gcloud secrets versions add litellm-master-key --data-file=-
resource "google_secret_manager_secret" "litellm_master_key" {
  count   = var.litellm_enabled ? 1 : 0
  project = var.project_id

  secret_id = var.litellm_master_key_secret_id
  labels    = merge(local.common_labels, { component = "litellm" })

  replication {
    auto {}
  }

  # Rotating or recreating either key orphans the encrypted DB content. Terraform
  # refuses to destroy these even on `terraform destroy`; an operator must
  # `terraform state rm` deliberately, which is the intended speed bump.
  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret" "litellm_salt_key" {
  count   = var.litellm_enabled ? 1 : 0
  project = var.project_id

  secret_id = var.litellm_salt_key_secret_id
  labels    = merge(local.common_labels, { component = "litellm" })

  replication {
    auto {}
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.services]
}

# Postgres password + the full DSN, both derived from ONE generated password so
# they cannot drift apart. LiteLLM only accepts a complete DATABASE_URL, and a
# URL cannot interpolate another secret_key_ref, so the DSN has to be its own
# secret version — built here rather than seeded out-of-band because Terraform
# already owns the password.
resource "random_password" "litellm_postgres_password" {
  count   = var.litellm_enabled ? 1 : 0
  length  = 32
  special = false
}

resource "google_secret_manager_secret" "litellm_postgres_password" {
  count   = var.litellm_enabled ? 1 : 0
  project = var.project_id

  secret_id = "${var.litellm_service_name}-postgres-password"
  labels    = merge(local.common_labels, { component = "litellm" })

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_version" "litellm_postgres_password" {
  count = var.litellm_enabled ? 1 : 0

  secret      = google_secret_manager_secret.litellm_postgres_password[0].id
  secret_data = random_password.litellm_postgres_password[0].result
}

resource "google_secret_manager_secret" "litellm_database_url" {
  count   = var.litellm_enabled ? 1 : 0
  project = var.project_id

  secret_id = "${var.litellm_service_name}-database-url"
  labels    = merge(local.common_labels, { component = "litellm" })

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_version" "litellm_database_url" {
  count = var.litellm_enabled ? 1 : 0

  secret      = google_secret_manager_secret.litellm_database_url[0].id
  secret_data = "postgresql://postgres:${random_password.litellm_postgres_password[0].result}@127.0.0.1:5432/${var.litellm_database_name}"
}

locals {
  litellm_enabled_count = var.litellm_enabled ? 1 : 0

  # secret_id => accessor binding, so one for_each covers every mount.
  litellm_secret_mounts = var.litellm_enabled ? merge(
    {
      LITELLM_MASTER_KEY = google_secret_manager_secret.litellm_master_key[0].secret_id
      LITELLM_SALT_KEY   = google_secret_manager_secret.litellm_salt_key[0].secret_id
      DATABASE_URL       = google_secret_manager_secret.litellm_database_url[0].secret_id
    },
    var.litellm_provider_secrets,
  ) : {}
}

resource "google_secret_manager_secret_iam_member" "litellm_secret_accessor" {
  for_each = local.litellm_secret_mounts

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.litellm[0].email}"
}

# The gateway pays the provider bills, so it — unlike the agent containers —
# holds raw provider keys. They default to the secret ids the settings service
# already mounts as managed keys (var.extra_secret_ids includes anthropic-api-key
# / openai-api-key), so no duplicate secret is created and the platform keeps ONE
# anthropic key to rotate.
resource "google_secret_manager_secret_iam_member" "litellm_provider_key_accessor" {
  for_each = var.litellm_enabled ? var.litellm_provider_secrets : {}

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.litellm[0].email}"
}

resource "google_cloud_run_v2_service" "litellm" {
  count   = local.litellm_enabled_count
  project = var.project_id

  name                = var.litellm_service_name
  location            = var.region
  ingress             = var.litellm_ingress
  labels              = merge(local.common_labels, { component = "litellm" })
  deletion_protection = false

  template {
    service_account       = google_service_account.litellm[0].email
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

    # LiteLLM streams long agent completions; 20 minutes covers a normal
    # deep-agent turn with headroom (Cloud Run's ceiling is 60m).
    timeout                          = "1200s"
    max_instance_request_concurrency = var.litellm_container_concurrency

    scaling {
      min_instance_count = var.litellm_min_instances
      # MUST be 1 while Postgres and Redis are per-instance emptyDir (see header).
      max_instance_count = 1
    }

    # Postgres WAL on `medium = "memory"` stays inside the instance RAM envelope
    # (R5). If the shared envelope shows memory pressure, switch to "disk" —
    # still ephemeral either way, so nothing else changes.
    volumes {
      name = "pgdata"
      empty_dir {
        medium     = var.litellm_pg_volume_medium
        size_limit = var.litellm_pg_volume_size
      }
    }

    volumes {
      name = "redisdata"
      empty_dir {
        medium     = "disk"
        size_limit = var.litellm_redis_volume_size
      }
    }

    # --- Postgres sidecar (no `ports` block: only `app` receives ingress) -----
    containers {
      name  = "postgres"
      image = local.litellm_db_image

      env {
        name  = "PGDATA"
        value = "/var/lib/postgresql/data/pgdata"
      }
      env {
        name  = "POSTGRES_DB"
        value = var.litellm_database_name
      }
      env {
        name = "POSTGRES_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.litellm_postgres_password[0].secret_id
            version = "latest"
          }
        }
      }

      volume_mounts {
        name       = "pgdata"
        mount_path = "/var/lib/postgresql/data"
      }

      resources {
        limits = {
          cpu    = var.litellm_db_cpu
          memory = var.litellm_db_memory
        }
        # cpu_idle = false: this sidecar must keep serving while `app` handles
        # requests, and an idle instance would silently drop connections.
        cpu_idle          = false
        startup_cpu_boost = true
      }

      startup_probe {
        tcp_socket {
          port = 5432
        }
        period_seconds    = 3
        timeout_seconds   = 2
        failure_threshold = 60
      }
      liveness_probe {
        tcp_socket {
          port = 5432
        }
        period_seconds    = 30
        timeout_seconds   = 3
        failure_threshold = 3
      }
    }

    # --- Redis sidecar (router state across LiteLLM's uvicorn workers) ---------
    containers {
      name  = "redis"
      image = local.litellm_redis_image

      # AOF off + no RDB: everything Redis holds here is router cooldown/cache
      # state that is rebuilt on boot, so persisting it to an emptyDir buys
      # nothing and would only slow the restart we are designing for.
      command = ["redis-server"]
      args = [
        "--appendonly", "no",
        "--save", "",
        "--bind", "127.0.0.1",
        "--maxmemory", var.litellm_redis_maxmemory,
        "--maxmemory-policy", "allkeys-lru",
      ]

      volume_mounts {
        name       = "redisdata"
        mount_path = "/data"
      }

      resources {
        limits = {
          cpu    = var.litellm_redis_cpu
          memory = var.litellm_redis_memory
        }
        cpu_idle = false
      }

      startup_probe {
        tcp_socket {
          port = 6379
        }
        period_seconds    = 3
        timeout_seconds   = 2
        failure_threshold = 20
      }
      liveness_probe {
        tcp_socket {
          port = 6379
        }
        period_seconds    = 30
        timeout_seconds   = 3
        failure_threshold = 3
      }
    }

    # --- LiteLLM proxy --------------------------------------------------------
    containers {
      name       = "app"
      image      = local.litellm_image
      depends_on = ["postgres", "redis"]

      # The ONLY container declaring `ports`, so the only one receiving ingress.
      ports {
        container_port = 4000
      }

      # Cloud Run v2 owns the `PORT` env var and REJECTS a service that defines it,
      # so the bind port is passed as the CLI flag instead — overriding `args`
      # replaces the image's CMD entirely, which also pins the port against an
      # upstream default changing. `command` is left alone: the image's entrypoint
      # is the relative `docker/prod_entrypoint.sh` (resolved from WORKDIR /app) and
      # an override would have to know that layout.
      args = ["--port", "4000"]

      # DATABASE_URL, LITELLM_MASTER_KEY and LITELLM_SALT_KEY all arrive through
      # the dynamic block below (local.litellm_secret_mounts) — declaring
      # DATABASE_URL here too would duplicate the env name, which Cloud Run v2
      # rejects at apply time.
      env {
        name  = "REDIS_HOST"
        value = "127.0.0.1"
      }
      env {
        name  = "REDIS_PORT"
        value = "6379"
      }
      # deploy/litellm/config.yaml is COPYed into /app/config.yaml by
      # deploy/gcp/Dockerfile.litellm-app (the upstream image is a digest-pinned
      # base we only overlay). CONFIG_FILE_PATH is LiteLLM's own env fallback for
      # `--config`, so an operator can retarget it — e.g. to a GCS-hosted config
      # — without a rebuild.
      env {
        name  = "CONFIG_FILE_PATH"
        value = var.litellm_config_path
      }
      # Run `litellm --migrate` on boot: the schema must be rebuilt after every
      # emptyDir wipe, which is the normal case here rather than an exception.
      env {
        name  = "STORE_MODEL_IN_DB"
        value = "False"
      }
      dynamic "env" {
        for_each = local.litellm_secret_mounts
        content {
          name = env.key
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
          cpu    = var.litellm_cpu
          memory = var.litellm_memory
        }
        # Must stay false: container_concurrency > 1 on a service that has to
        # warm-serve streamed agent turns (same precondition as cloud_run.tf).
        cpu_idle          = false
        startup_cpu_boost = true
      }

      # LiteLLM waits for its sidecar Postgres and runs migrations on boot, so
      # this probe carries the whole init budget.
      startup_probe {
        http_get {
          path = "/health/liveliness"
          port = 4000
        }
        period_seconds    = 5
        timeout_seconds   = 3
        failure_threshold = 60
      }
      liveness_probe {
        http_get {
          path = "/health/liveliness"
          port = 4000
        }
        period_seconds    = 30
        timeout_seconds   = 3
        failure_threshold = 3
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_secret_manager_secret_iam_member.litellm_secret_accessor,
    google_secret_manager_secret_iam_member.litellm_provider_key_accessor,
  ]
}

# Who may call the gateway: each agent service's co-located egress sidecar is the
# actual client, so the agent SAs need invoker. Internal ingress + run.invoker keeps
# this off the public
# internet — a reachable LiteLLM would be a master-key-only endpoint anyone could
# spend against.
resource "google_cloud_run_v2_service_iam_member" "litellm_invoker" {
  for_each = var.litellm_enabled ? toset([
    google_service_account.planner.email,
    google_service_account.coder.email,
    google_service_account.gateway.email,
    google_service_account.litellm[0].email,
  ]) : toset([])

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.litellm[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${each.value}"
}

# -----------------------------------------------------------------------------
# Wiring into the existing egress boundary.
#
# The agent containers get NO upstream URL and NO LiteLLM key: in proxy mode
# CONFIG.LITELLM.claudeBaseUrl is derived from EGRESS_PROXY_URL + the `/litellm`
# prefix, so `LITELLM_PROXY_UPSTREAM` is set on the SIDECAR only (see
# local.proxy_plain_env in cloud_run.tf) and `LITELLM_GATEWAY_ENABLED` on the
# agent side merely admits the browser flag. That keeps the credential domains
# disjoint: agent -> sidecar carries the org's LiteLLM virtual key (or the
# sentinel), LiteLLM -> providers carries a platform provider key.
# -----------------------------------------------------------------------------
