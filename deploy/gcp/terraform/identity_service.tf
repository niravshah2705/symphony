# -----------------------------------------------------------------------------
# Identity verification service — internal, gateway-invoked, Firestore-backed.
# -----------------------------------------------------------------------------

resource "google_service_account" "identity" {
  project      = var.project_id
  account_id   = "identity-verification-sa"
  display_name = "AI Fleet identity verification"
}

resource "google_project_iam_member" "identity_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.identity.email}"
}

resource "google_secret_manager_secret" "identity_hash_pepper" {
  project   = var.project_id
  secret_id = var.identity_hash_pepper_secret_id
  labels    = merge(local.common_labels, { component = "identity-verification" })

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_iam_member" "identity_hash_pepper_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.identity_hash_pepper.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.identity.email}"
}

resource "google_cloud_run_v2_service" "identity" {
  project             = var.project_id
  name                = var.identity_service_name
  location            = var.region
  ingress             = var.internal_ingress
  labels              = merge(local.common_labels, { component = "identity-verification" })
  deletion_protection = false

  template {
    service_account                  = google_service_account.identity.email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = var.container_concurrency

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      name  = "app"
      image = local.identity_image

      ports {
        container_port = 8080
      }

      dynamic "env" {
        for_each = merge(local.common_env, {
          IDENTITY_SERVICE_PORT  = "8080"
          IDENTITY_STORE_BACKEND = "firestore"
          IDENTITY_COLLECTION    = "identity_verification"
          IDENTITY_PROVIDER      = "digilocker"
        })
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name = "IDENTITY_HASH_PEPPER"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.identity_hash_pepper.secret_id
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
    google_project_iam_member.identity_datastore,
    google_secret_manager_secret_iam_member.identity_hash_pepper_accessor,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "gateway_invokes_identity" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.identity.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.gateway.email}"
}
