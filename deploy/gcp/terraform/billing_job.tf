# -----------------------------------------------------------------------------
# Billing Jobs — one Cloud Run Job per money/accounting sweep, each started by
# Cloud Scheduler calling the Run Admin API (jobs/<name>:run) directly.
# -----------------------------------------------------------------------------
# Every Job overrides the image CMD (which starts the HTTP server) with its own
# entrypoint, runs one task with max_retries 1, and receives only the secrets
# its entrypoint reads. FlexPrice env + keys come from local.billing_flexprice_*
# in billing_service.tf; Cashfree secrets go to the recharge Job only.

locals {
  billing_jobs = {
    recharge = {
      name     = var.billing_job_name
      script   = "services/billing/src/auto-recharge-job.js"
      schedule = var.billing_recharge_schedule
      cashfree = true
      internal = true
      env = {
        BILLING_JOB_DRY_RUN = tostring(var.billing_job_dry_run)
        CASHFREE_ENV        = var.cashfree_env
        CASHFREE_BASE_URL   = var.cashfree_base_url
        ORG_URL             = local.org_url
      }
    }
    platform-charge = {
      name     = "${var.billing_job_name_prefix}-platform-charge"
      script   = "services/billing/src/platform-charge-job.js"
      schedule = var.billing_platform_charge_schedule
      cashfree = false
      internal = false
      env      = {}
    }
    credit-expiry = {
      name     = "${var.billing_job_name_prefix}-credit-expiry"
      script   = "services/billing/src/credit-expiry-job.js"
      schedule = var.billing_credit_expiry_schedule
      cashfree = false
      internal = false
      env      = {}
    }
    reconcile = {
      name     = "${var.billing_job_name_prefix}-reconcile"
      script   = "services/billing/src/reconcile-gateway-spend.js"
      schedule = var.billing_reconcile_schedule
      cashfree = false
      internal = true
      env = merge(
        { SETTINGS_URL = local.settings_url },
        local.litellm_url != "" ? { LITELLM_URL = local.litellm_url } : {},
      )
    }
  }

  billing_job_cashfree_secrets = {
    CASHFREE_APP_ID     = google_secret_manager_secret.cashfree_app_id.secret_id
    CASHFREE_SECRET_KEY = google_secret_manager_secret.cashfree_secret_key.secret_id
  }
}

moved {
  from = google_cloud_run_v2_job.billing_auto_recharge
  to   = google_cloud_run_v2_job.billing["recharge"]
}

resource "google_cloud_run_v2_job" "billing" {
  for_each = local.billing_jobs

  project             = var.project_id
  name                = each.value.name
  location            = var.region
  labels              = merge(local.common_labels, { component = "billing", billing_job = each.key })
  deletion_protection = false

  template {
    parallelism = 1
    task_count  = 1

    template {
      service_account       = google_service_account.billing.email
      timeout               = var.billing_job_task_timeout
      max_retries           = 1
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

      containers {
        name    = "app"
        image   = local.billing_image
        command = ["node"]
        args    = [each.value.script]

        dynamic "env" {
          for_each = merge(local.common_env, local.billing_flexprice_env, {
            STORE_BACKEND = "firestore"
          }, each.value.env)
          content {
            name  = env.key
            value = env.value
          }
        }

        dynamic "env" {
          for_each = local.billing_flexprice_secrets
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

        dynamic "env" {
          for_each = each.value.cashfree ? local.billing_job_cashfree_secrets : {}
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

        # Count-gated secret: absent token => env omitted => the Job fails closed.
        dynamic "env" {
          for_each = each.value.internal ? toset(google_secret_manager_secret.internal_api_token[*].secret_id) : toset([])
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
        }
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_firestore_database.default,
    google_project_iam_member.billing_datastore,
    google_secret_manager_secret_iam_member.billing_cashfree_app_id_accessor,
    google_secret_manager_secret_iam_member.billing_cashfree_secret_key_accessor,
    google_secret_manager_secret_iam_member.billing_flexprice_accessor,
    google_secret_manager_secret_iam_member.billing_internal_token,
    google_cloud_run_v2_service_iam_member.billing_invokes_org,
    google_cloud_run_v2_service_iam_member.billing_invokes_settings,
  ]
}

# Org service is internal + IAM-gated; the Jobs also send X-Internal-Token.
resource "google_cloud_run_v2_service_iam_member" "billing_invokes_org" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.org.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.billing.email}"
}

# The reconcile Job resolves the LiteLLM key through the settings S2S resolver.
resource "google_cloud_run_v2_service_iam_member" "billing_invokes_settings" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.settings.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.billing.email}"
}

resource "google_secret_manager_secret_iam_member" "billing_internal_token" {
  count     = var.internal_api_token != "" ? 1 : 0
  project   = var.project_id
  secret_id = google_secret_manager_secret.internal_api_token[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.billing.email}"
}

# --- Scheduler -----------------------------------------------------------------
# A dedicated identity whose only grant is run.invoker on each billing Job.

resource "google_service_account" "billing_scheduler" {
  project      = var.project_id
  account_id   = "billing-scheduler-sa"
  display_name = "AI Fleet Billing Job Scheduler"
}

resource "google_cloud_run_v2_job_iam_member" "billing_scheduler_runs_job" {
  for_each = local.billing_jobs

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.billing[each.key].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.billing_scheduler.email}"
}

moved {
  from = google_cloud_scheduler_job.billing_auto_recharge
  to   = google_cloud_scheduler_job.billing_job["recharge"]
}

resource "google_cloud_scheduler_job" "billing_job" {
  for_each = local.billing_jobs

  project   = var.project_id
  region    = var.region
  name      = "${each.value.name}-tick"
  schedule  = each.value.schedule
  time_zone = var.scheduler_time_zone

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.billing[each.key].name}:run"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode("{}")

    oauth_token {
      service_account_email = google_service_account.billing_scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  retry_config {
    retry_count          = 1
    min_backoff_duration = "30s"
  }

  depends_on = [
    google_project_service.services,
    google_cloud_run_v2_job_iam_member.billing_scheduler_runs_job,
  ]
}
