# -----------------------------------------------------------------------------
# Dedicated CLM (Contrastive Language Model) inference service (Cloud Run v2).
# Internal-only, IAM-gated dual-encoder decision & embedding model.
# -----------------------------------------------------------------------------

resource "google_service_account" "clm_inference" {
  project      = var.project_id
  account_id   = "clm-inference-sa"
  display_name = "AI Fleet CLM Inference Service"
}

resource "google_cloud_run_v2_service" "clm" {
  project             = var.project_id
  name                = var.clm_service_name
  location            = var.region
  ingress             = var.clm_ingress
  labels              = merge(local.common_labels, { component = "clm-inference" })
  deletion_protection = false

  template {
    service_account                  = google_service_account.clm_inference.email
    timeout                          = "60s"
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = var.clm_container_concurrency

    scaling {
      min_instance_count = var.clm_min_instances
      max_instance_count = var.clm_max_instances
    }

    containers {
      name  = "app"
      image = local.clm_image

      ports {
        container_port = 8080
      }

      env {
        name  = "PORT"
        value = "8080"
      }

      resources {
        limits = {
          cpu    = var.clm_cpu
          memory = var.clm_memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      startup_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }
        period_seconds    = 5
        timeout_seconds   = 2
        failure_threshold = 24
      }

      liveness_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }
        period_seconds    = 30
        timeout_seconds   = 3
        failure_threshold = 3
      }
    }
  }

  depends_on = [google_project_service.services]
}

# Grant Invoker only to internal caller service accounts (planner, coder, gateway)
resource "google_cloud_run_v2_service_iam_member" "planner_invokes_clm" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.clm.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.planner.email}"
}

resource "google_cloud_run_v2_service_iam_member" "coder_invokes_clm" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.clm.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.coder.email}"
}

resource "google_cloud_run_v2_service_iam_member" "gateway_invokes_clm" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.clm.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.gateway.email}"
}
