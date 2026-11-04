# -----------------------------------------------------------------------------
# Billing auto-recharge — hourly Cloud Run JOB, scheduler-triggered.
# -----------------------------------------------------------------------------
# Recharge and alert evaluation deliberately left the 5-minute /pubsub/billing-tick
# path (that tick now only aggregates usage): every tick looped ALL accounts and
# re-issued a Cashfree charge whose success response the code read as a failure, so
# the cooldown never armed and the same org was charged again on the next tick.
#
# A Job fixes the cadence (hourly, matching CONFIG.BILLING.rechargeIntervalMin), the
# blast radius (one task, max_retries 1, non-zero exit only when EVERY org errored),
# and the ordering — services/billing/src/auto-recharge-job.js validates credentials,
# mandate status, threshold and cooldown BEFORE it charges.
#
# Trigger shape: Cloud Run Jobs are not HTTP-addressable and the pinned google /
# google-beta providers (~> 6.0, 6.50.0) have NO push_config.cloud_run_job field — a
# Pub/Sub subscription cannot push to a Job here. So the scheduler POSTs the billing
# SERVICE's /pubsub/billing-recharge-tick (the existing OIDC tick pattern), and the
# service launches one Job execution through the Admin API exactly the way
# coder-control launches the coder-worker Job (iam.tf: coder_runs_worker).

resource "google_cloud_run_v2_job" "billing_auto_recharge" {
  project             = var.project_id
  name                = var.billing_job_name
  location            = var.region
  labels              = merge(local.common_labels, { component = "billing" })
  deletion_protection = false

  template {
    parallelism = 1 # one sweep per execution
    task_count  = 1

    template {
      service_account       = google_service_account.billing.email
      timeout               = var.billing_job_task_timeout
      max_retries           = 1
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

      containers {
        name  = "app"
        image = local.billing_image

        dynamic "env" {
          for_each = merge(local.common_env, {
            STORE_BACKEND       = "firestore"
            BILLING_JOB_DRY_RUN = tostring(var.billing_job_dry_run)
            CASHFREE_ENV        = var.cashfree_env
            CASHFREE_BASE_URL   = var.cashfree_base_url
            ORG_URL             = local.org_url
          })
          content {
            name  = env.key
            value = env.value
          }
        }

        # The org service's billing-context read is guarded by the same shared
        # internal token as the provisioner's write-back. Splat-driven for_each over
        # the count-gated secret so a stack without internal_api_token set simply
        # omits the env — the job then fails closed for that org instead of sending an
        # unauthenticated request.
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

        env {
          name = "CASHFREE_APP_ID"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.cashfree_app_id.secret_id
              version = "latest"
            }
          }
        }

        env {
          name = "CASHFREE_SECRET_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.cashfree_secret_key.secret_id
              version = "latest"
            }
          }
        }

        # Jobs get no autoscaling knobs: one task, sized for a serial sweep with a
        # 10s-per-org HTTP timeout.
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
    google_secret_manager_secret_iam_member.billing_internal_token,
    google_cloud_run_v2_service_iam_member.billing_invokes_org,
  ]
}

# --- Who may run it ------------------------------------------------------------
# The billing SERVICE launches the execution (its tick handler), so billing-sa needs
# run.jobs.run on this job plus actAs on the job's runtime SA — which is billing-sa
# itself. Mirrors coder_runs_worker / coder_actas_self in iam.tf.
resource "google_cloud_run_v2_job_iam_member" "billing_launches_recharge_job" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.billing_auto_recharge.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.billing.email}"
}

resource "google_service_account_iam_member" "billing_actas_self" {
  service_account_id = google_service_account.billing.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.billing.email}"
}

# The Job authenticates to the org service twice over: Cloud Run IAM (this binding —
# the org service is internal + no-allow-unauthenticated) and the app-level
# X-Internal-Token. Without it the OIDC token the job mints is rejected with 403 and
# every org is skipped.
resource "google_cloud_run_v2_service_iam_member" "billing_invokes_org" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.org.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.billing.email}"
}

# Same shared secret the provisioner and the org service hold; accessor only when the
# token exists (see provisioner.tf).
resource "google_secret_manager_secret_iam_member" "billing_internal_token" {
  count     = var.internal_api_token != "" ? 1 : 0
  project   = var.project_id
  secret_id = google_secret_manager_secret.internal_api_token[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.billing.email}"
}

# --- Scheduler ------------------------------------------------------------------
# pubsub_push-sa already holds run.invoker on the billing service
# (push_invokes_billing), so the OIDC token signed here is accepted; the audience is
# the service URL, matching its PUBSUB_PUSH_AUDIENCE.

resource "google_cloud_scheduler_job" "billing_auto_recharge" {
  project   = var.project_id
  region    = var.region
  name      = "${var.billing_job_name}-tick"
  schedule  = var.billing_recharge_schedule
  time_zone = var.scheduler_time_zone

  http_target {
    http_method = "POST"
    uri         = "${local.billing_url}/pubsub/billing-recharge-tick"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode("{}")

    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = local.billing_url
    }
  }

  # The launch call is a single Admin API request; if it fails the org is simply not
  # recharged until the next hour, so one prompt retry is enough.
  retry_config {
    retry_count          = 1
    min_backoff_duration = "30s"
  }

  depends_on = [
    google_project_service.services,
    google_cloud_run_v2_service.billing,
    google_cloud_run_v2_service_iam_member.push_invokes_billing,
    google_cloud_run_v2_job.billing_auto_recharge,
    google_cloud_run_v2_job_iam_member.billing_launches_recharge_job,
  ]
}
