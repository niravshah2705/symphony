# -----------------------------------------------------------------------------
# Dedicated Laya decision model inference service (Cloud Run v2).
# Internal-only, IAM-gated System 1 non-autoregressive decision model.
# Image = pip `laya[serve]` (laya-serve on :8000, POST /v1/systemone, GET /health),
# served fully offline from the /models gcsfuse mount (laya_models.tf).
# -----------------------------------------------------------------------------

resource "google_service_account" "laya_inference" {
  project      = var.project_id
  account_id   = "laya-inference-sa"
  display_name = "AI Fleet Laya Inference Service"
}

resource "google_cloud_run_v2_service" "laya" {
  project             = var.project_id
  name                = var.laya_service_name
  location            = var.region
  ingress             = var.laya_ingress
  labels              = merge(local.common_labels, { component = "laya-inference" })
  deletion_protection = false

  # The revision readiness wait mirrors the startup probe budget (20m) plus pod
  # retry cycles; the provider default of 20m gave up on a rollout that Cloud
  # Run was still working on (deploy run 41874521806).
  timeouts {
    create = "45m"
    update = "45m"
  }

  template {
    service_account                  = google_service_account.laya_inference.email
    timeout                          = "60s"
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = var.laya_container_concurrency

    scaling {
      min_instance_count = var.laya_min_instances
      max_instance_count = var.laya_max_instances
    }

    # Pre-downloaded Hugging Face hub cache (laya_models.tf), mounted read-only
    # at /models. The service pins a bundle via HF_HUB_CACHE=/models/<version> (the hub cache dir holding models--<org>--<repo> directly).
    dynamic "volumes" {
      for_each = var.laya_models_enabled ? [1] : []
      content {
        name = "laya-models"
        gcs {
          bucket    = google_storage_bucket.laya_models[0].name
          read_only = true
        }
      }
    }

    containers {
      name  = "app"
      image = local.laya_image

      ports {
        container_port = 8000
      }

      # Fully-offline serving of the pip `laya[serve]` image: weights come from
      # the /models GCS mount, never from the Hub. All three checkpoints are
      # preloaded for auto routing; thread caps match the 2-CPU limit.
      # NOTE: never add env name = "PORT" here (reserved by Cloud Run).
      env {
        name  = "HF_HUB_OFFLINE"
        value = "1"
      }
      env {
        name  = "TRANSFORMERS_OFFLINE"
        value = "1"
      }
      env {
        name  = "HF_HUB_CACHE"
        value = "/models/${var.laya_model_version}"
      }
      env {
        name  = "LAYA_PRELOAD"
        value = "1"
      }
      env {
        name  = "LAYA_MODELS"
        value = "english,multilingual,typed-decisions"
      }
      env {
        name  = "LAYA_MAX_LOADED"
        value = "3"
      }
      env {
        name  = "LAYA_DEVICE"
        value = "cpu"
      }
      # Revision-forcing marker: Cloud Run dedupes revisions by template hash, so
      # an identical-template re-apply REUSES the failed revision (00015-khx)
      # instead of launching a new pod. Carrying the pinned bundle version in the
      # template means bumping laya_model_version always creates a fresh revision
      # that re-reads /models/<version>. laya-serve ignores this var; the real pin
      # is HF_HUB_CACHE above.
      env {
        name  = "LAYA_MODEL_BUNDLE"
        value = var.laya_model_version
      }
      env {
        name  = "LAYA_THREADS"
        value = var.laya_cpu
      }
      env {
        name  = "OMP_NUM_THREADS"
        value = var.laya_cpu
      }
      env {
        name  = "MKL_NUM_THREADS"
        value = var.laya_cpu
      }
      env {
        name  = "TORCH_NUM_THREADS"
        value = var.laya_cpu
      }

      resources {
        limits = {
          cpu    = var.laya_cpu
          memory = var.laya_memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      dynamic "volume_mounts" {
        for_each = var.laya_models_enabled ? [1] : []
        content {
          name       = "laya-models"
          mount_path = "/models"
        }
      }

      # GET /health is laya-serve's unauthenticated liveness route. With
      # LAYA_PRELOAD=1 the three checkpoints are built on the CPU before the
      # server listens, and the weights stream over gcsfuse. Measured on the
      # live service (laya-inference-00016): the first checkpoint warned ~3min
      # after boot, so the full preload needs ~10min — well past Cloud Run's
      # 5min default. Budget = 15s x 80 = 20min.
      startup_probe {
        http_get {
          path = "/health"
          port = 8000
        }
        period_seconds    = 15
        timeout_seconds   = 5
        failure_threshold = 80
      }

      liveness_probe {
        http_get {
          path = "/health"
          port = 8000
        }
        period_seconds    = 30
        timeout_seconds   = 3
        failure_threshold = 3
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_storage_bucket.laya_models,
  ]
}

# Grant Invoker only to internal caller service accounts (planner, coder, gateway)
resource "google_cloud_run_v2_service_iam_member" "planner_invokes_laya" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.laya.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.planner.email}"
}

resource "google_cloud_run_v2_service_iam_member" "coder_invokes_laya" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.laya.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.coder.email}"
}

resource "google_cloud_run_v2_service_iam_member" "gateway_invokes_laya" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.laya.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.gateway.email}"
}
