# -----------------------------------------------------------------------------
# Organization service (services/org) — FastAPI + Firestore, internal + IAM-gated.
# -----------------------------------------------------------------------------
# Reached only through the gateway's OIDC-authenticated reverse proxy
# (/api/org/* -> /api/v1/*). It runs its own Firebase-OIDC auth + org-scoped
# RBAC. Shares the project's Firestore, namespaced under `org_service__...`, so
# it adds no database cost. Scales to zero.

resource "google_service_account" "org" {
  project      = var.project_id
  account_id   = "org-sa"
  display_name = "Organization service"
}

resource "google_project_iam_member" "org_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.org.email}"
}

# Local-JWT signing secret. The service requires it (>=32 chars) even though the
# platform uses Firebase OIDC; the value is seeded out-of-band (deploy.sh / gcloud).
resource "google_secret_manager_secret" "org_jwt_secret" {
  project   = var.project_id
  secret_id = "org-jwt-secret"
  labels    = merge(local.common_labels, { component = "org" })

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_iam_member" "org_jwt_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.org_jwt_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.org.email}"
}

resource "google_cloud_run_v2_service" "org" {
  project             = var.project_id
  name                = var.org_service_name
  location            = var.region
  ingress             = var.internal_ingress # IAM-gated; only the gateway SA invokes it
  labels              = merge(local.common_labels, { component = "org" })
  deletion_protection = false

  template {
    service_account = google_service_account.org.email

    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }

    containers {
      image = local.org_image

      ports {
        container_port = 8000
      }

      env {
        name  = "APP_ENV"
        value = "production"
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "FIRESTORE_NAMESPACE"
        value = "org_service"
      }
      # Accept the platform's Firebase ID tokens (issuer/JWKS/audience derived).
      env {
        name  = "IDP_ENABLED"
        value = "true"
      }
      env {
        name  = "IDP_FIREBASE_PROJECT"
        value = var.project_id
      }
      env {
        name = "JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.org_jwt_secret.secret_id
            version = "latest"
          }
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
  }

  depends_on = [
    google_project_service.services,
    google_firestore_database.default,
    google_project_iam_member.org_datastore,
    google_secret_manager_secret_iam_member.org_jwt_accessor,
  ]
}

# Only the gateway SA may invoke the org service (OIDC). No allUsers invoker.
resource "google_cloud_run_v2_service_iam_member" "gateway_invokes_org" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.org.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.gateway.email}"
}
