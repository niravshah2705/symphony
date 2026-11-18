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

# --- FlexPrice --------------------------------------------------------------------
# Containers only: values are added out of band (gcloud secrets versions add) and
# the deploy workflow refuses to plan until each has an enabled version. Only
# billing-sa may read them; no agent, gateway or proxy workload references them.

resource "google_secret_manager_secret" "flexprice" {
  for_each = toset(["flexprice-api-key-ingest", "flexprice-api-key-money"])

  project   = var.project_id
  secret_id = each.value
  labels    = merge(local.common_labels, { component = "billing" })

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_iam_member" "billing_flexprice_accessor" {
  for_each = google_secret_manager_secret.flexprice

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.billing.email}"
}

locals {
  billing_flexprice_env = {
    FLEXPRICE_ENABLED                 = tostring(var.flexprice_enabled)
    FLEXPRICE_BASE_URL                = var.flexprice_base_url
    FLEXPRICE_ENVIRONMENT_ID          = var.flexprice_environment_id
    FLEXPRICE_SUPPLIER_STATE_CODE     = var.flexprice_supplier_state_code
    FLEXPRICE_DEPLOYMENT_MODE         = "production"
    FLEXPRICE_ALLOW_INSECURE_DEFAULTS = "false"
    BILLING_GATE_POLICY               = "enforced"
  }

  # The short names, spelled literally: `secret_key_ref.secret` below takes
  # exactly what `.secret_id` returns, so nothing about the rendered revision
  # changes. What does change is *when* the value is knowable. Indexing the
  # resource collection made every plan that left those containers out of scope
  # read them from state — and while they were absent there, the collection was
  # "object with no attributes" and the plan died on Invalid index. That is a
  # deadlock, not a guard: the CI secret-staging step (6 targets) and the
  # `-refresh-only` record of billing's `moved` blocks both run before the apply
  # that creates the containers, so neither could ever pass.
  #
  # The containers stay managed and ordered regardless: the accessor below
  # iterates the real collection, and both the billing service and the billing
  # job `depends_on` it. Existence is enforced out of band too — the workflow
  # refuses to go on unless each key has an enabled version.
  billing_flexprice_secrets = {
    FLEXPRICE_API_KEY_INGEST = "flexprice-api-key-ingest"
    FLEXPRICE_API_KEY_MONEY  = "flexprice-api-key-money"
  }
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
        for_each = merge(local.common_env, local.billing_flexprice_env, {
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
    google_secret_manager_secret_iam_member.billing_flexprice_accessor,
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
