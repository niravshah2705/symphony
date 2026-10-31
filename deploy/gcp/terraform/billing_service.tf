# -----------------------------------------------------------------------------
# Billing service — internal, gateway-invoked, Firestore-backed microservice.
# Handles usage aggregation, auto-renew threshold execution, and Cashfree payments.
# -----------------------------------------------------------------------------

resource "google_service_account" "billing" {
  project      = var.project_id
  account_id   = "billing-sa"
  display_name = "AI Fleet Billing Service"
}

resource "google_project_iam_member" "billing_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.billing.email}"
}

resource "google_secret_manager_secret" "cashfree_app_id" {
  project   = var.project_id
  secret_id = var.cashfree_app_id_secret_id
  labels    = merge(local.common_labels, { component = "billing" })

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret" "cashfree_secret_key" {
  project   = var.project_id
  secret_id = var.cashfree_secret_key_secret_id
  labels    = merge(local.common_labels, { component = "billing" })

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_iam_member" "billing_cashfree_app_id_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.cashfree_app_id.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.billing.email}"
}

resource "google_secret_manager_secret_iam_member" "billing_cashfree_secret_key_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.cashfree_secret_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.billing.email}"
}

resource "google_cloud_run_v2_service" "billing" {
  project             = var.project_id
  name                = var.billing_service_name
  location            = var.region
  ingress             = var.internal_ingress
  labels              = merge(local.common_labels, { component = "billing" })
  deletion_protection = false

  template {
    service_account                  = google_service_account.billing.email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = var.container_concurrency

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      name  = "app"
      image = local.billing_image

      ports {
        container_port = 8080
      }

      dynamic "env" {
        for_each = merge(local.common_env, {
          BILLING_SERVICE_PORT  = "8080"
          STORE_BACKEND         = "firestore"
          BILLING_SWEEP_ENABLED = "true"
          CASHFREE_ENV          = var.cashfree_env
          CASHFREE_BASE_URL     = var.cashfree_base_url
        })
        content {
          name  = env.key
          value = env.value
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

      startup_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }
        period_seconds    = 3
        timeout_seconds   = 1
        failure_threshold = 10
      }

      liveness_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }
        period_seconds    = 30
        timeout_seconds   = 2
        failure_threshold = 3
      }

      resources {
        limits = {
          cpu    = var.cloud_run_service_cpu
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_firestore_database.default,
    google_project_iam_member.billing_datastore,
    google_secret_manager_secret_iam_member.billing_cashfree_app_id_accessor,
    google_secret_manager_secret_iam_member.billing_cashfree_secret_key_accessor,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "gateway_invokes_billing" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.billing.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.gateway.email}"
}

resource "google_cloud_run_v2_service_iam_member" "push_invokes_billing" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.billing.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_push.email}"
}
