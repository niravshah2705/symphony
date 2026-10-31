# -----------------------------------------------------------------------------
# Agent memory store (claude-mem, harness-agnostic) — Cloud SQL for PostgreSQL.
# -----------------------------------------------------------------------------
# The MemoryMiddleware (packages/shared/src/agent/memory-middleware.js) captures
# + AI-compresses each finished agent run and injects durable memory into future
# ones. Persistence is one Cloud SQL Postgres database; the planner + coder talk
# to it over the Cloud Run /cloudsql unix socket (Cloud SQL Auth Proxy is created
# by Cloud Run from the cloud_sql volume — no VPC connector, no public network
# rule). Tenant isolation is a row-level `org_key` column (a stable digest of the
# workspace organization), NOT a per-tenant database:
#
#   agent_memories(id, org_key, scope, title, body, tags, source, ref_id,
#                  created_at, embedding bytea)
#
# The table is created lazily by the runtime
# (packages/shared/src/agent/memory-store/postgres-backend.js), so no
# migration job is required. Embeddings are float32 LE bytea + in-process
# cosine — no pgvector extension, no Chroma sidecar.
#
# COST: Cloud SQL does NOT scale to zero. A db-f1-micro ZONAL instance with a
# 10 GB SSD is the cheapest useful tier; leave memory_enabled = false to keep
# the stack at $0. deletion_protection defaults true — it holds real memories.
#
# The password + composed connection string live in Secret Manager and are
# mounted as MEMORY_DATABASE_URL on the agent containers (cloud_run.tf).

resource "random_password" "memory_db" {
  count   = var.memory_enabled ? 1 : 0
  length  = 32
  special = false # the value is embedded in a connection-string URL
}

resource "google_sql_database_instance" "memory" {
  count = var.memory_enabled ? 1 : 0

  project          = var.project_id
  name             = local.memory_db_instance_name
  region           = var.region
  database_version = var.memory_db_version

  # Real compressed agent memories live here; require an explicit opt-out
  # before `terraform destroy` can drop them.
  deletion_protection = var.memory_db_deletion_protection

  settings {
    tier      = var.memory_db_tier
    edition   = "ENTERPRISE"
    disk_size = var.memory_db_disk_size_gb
    disk_type = "PD_SSD"

    disk_autoresize   = true
    availability_type = "ZONAL"
    user_labels       = merge(local.common_labels, { component = "memory" })

    # Public IP with NO authorized networks: only the Cloud SQL Auth Proxy
    # (IAM-authenticated, created by Cloud Run's cloud_sql volume) can reach it.
    # The runtime never opens a direct TCP connection.
    ip_configuration {
      ipv4_enabled = true
    }

    backup_configuration {
      enabled    = var.memory_db_backups_enabled
      start_time = "03:00"
    }

    insights_config {
      query_insights_enabled = false
    }
  }

  depends_on = [google_project_service.services]
}

resource "google_sql_database" "memory" {
  count = var.memory_enabled ? 1 : 0

  project  = var.project_id
  instance = google_sql_database_instance.memory[0].name
  name     = var.memory_db_name
}

resource "google_sql_user" "memory" {
  count = var.memory_enabled ? 1 : 0

  project  = var.project_id
  instance = google_sql_database_instance.memory[0].name
  name     = var.memory_db_user
  password = random_password.memory_db[0].result
}

# --- Connection string (Secret Manager) --------------------------------------
# host query param pins the Cloud Run /cloudsql unix socket. Matches the
# cloud_sql volume mount path in cloud_run.tf.
resource "google_secret_manager_secret" "memory_database_url" {
  count = var.memory_enabled ? 1 : 0

  project   = var.project_id
  secret_id = "memory-database-url"
  labels    = merge(local.common_labels, { component = "memory" })

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_version" "memory_database_url" {
  count = var.memory_enabled ? 1 : 0

  secret = google_secret_manager_secret.memory_database_url[0].id
  secret_data = format(
    "postgresql://%s:%s@/%s?host=/cloudsql/%s",
    urlencode(google_sql_user.memory[0].name),
    urlencode(random_password.memory_db[0].result),
    google_sql_database.memory[0].name,
    google_sql_database_instance.memory[0].connection_name,
  )
}

# --- Access: Cloud SQL client + the connection-string secret ------------------
# coder-sa is shared by coder-control AND the coder-worker Job, so one grant
# covers the worker that actually persists memories.
resource "google_project_iam_member" "planner_memory_db_client" {
  count = var.memory_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.planner.email}"
}

resource "google_project_iam_member" "coder_memory_db_client" {
  count = var.memory_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.coder.email}"
}

resource "google_secret_manager_secret_iam_member" "planner_memory_database_url" {
  count = var.memory_enabled ? 1 : 0

  project   = var.project_id
  secret_id = google_secret_manager_secret.memory_database_url[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.planner.email}"
}

resource "google_secret_manager_secret_iam_member" "coder_memory_database_url" {
  count = var.memory_enabled ? 1 : 0

  project   = var.project_id
  secret_id = google_secret_manager_secret.memory_database_url[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.coder.email}"
}
