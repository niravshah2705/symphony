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

      # OpenAI-compatible backend contract. Empty INFERENCE_BASE_URL keeps the
      # service on its deterministic local-embedding fallback.
      env {
        name  = "INFERENCE_BASE_URL"
        value = local.clm_inference_base_url
      }
      env {
        name  = "INFERENCE_EMBEDDING_MODEL"
        value = local.clm_inference_embedding_model
      }
      env {
        name  = "INFERENCE_AUTH_MODE"
        value = var.clm_inference_auth_mode
      }
      env {
        name  = "INFERENCE_TIMEOUT_MS"
        value = tostring(var.clm_inference_timeout_ms)
      }
      dynamic "env" {
        for_each = local.clm_inference_base_url != "" && var.clm_inference_auth_mode == "bearer" && local.inference_api_key_secret_id != "" ? [1] : []
        content {
          name = "INFERENCE_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.inference_api_key[0].secret_id
              version = "latest"
            }
          }
        }
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
