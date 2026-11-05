# -----------------------------------------------------------------------------
# Dedicated Laya decision model inference service (Cloud Run v2).
# Internal-only, IAM-gated System 1 non-autoregressive decision model.
# Image = pip `laya[serve]` (laya-serve on :8000, POST /v1/systemone, GET /health),
# served fully offline from the HF checkpoint cache BAKED INTO THE IMAGE
# (deploy/gcp/Dockerfile.laya-inference). No gcsfuse mount at runtime.
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

    # HF_HUB_CACHE points at the hub cache baked into the image
    # (Dockerfile.laya-inference), so weights are read from the container's own
    # disk. laya_models.tf keeps the GCS bucket as the workflow publish/backup
    # target only — nothing is mounted at runtime.

    containers {
      name  = "app"
      image = local.laya_image

      ports {
        container_port = 8000
      }

      # Fully-offline serving of the pip `laya[serve]` image: the three
      # checkpoints are baked into the image's HF cache at build time (see
      # Dockerfile.laya-inference) — no gcsfuse at runtime. The first
      # deployments streamed weights over a GCS volume and never finished
      # preloading inside the startup window (revisions 00015-00018: each CPU
      # build over FUSE took ~3.5min and the port only binds AFTER preload,
      # because laya-serve preloads synchronously). Weights on the container's
      # own disk remove that I/O path entirely. Thread caps match the CPU limit.
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
        value = "/opt/laya-cache"
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
      # The image digest IS the weights pin now (checkpoints baked at build),
      # so every weight change rebuilds → new template → fresh revision; no
      # bundle-version marker needed.
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
          # var.laya_memory must cover all three checkpoints resident as float32
          # (~4.7GB) + runtime overhead: preload is synchronous, so an OOM here
          # kills the instance before the port ever binds (see variables.tf).
          cpu    = var.laya_cpu
          memory = var.laya_memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      # No volume_mounts: weights are baked into the image.

      # GET /health is laya-serve's unauthenticated liveness route. Preload
      # still runs BEFORE the port binds (synchronous in laya-serve), but reads
      # now come from the container image instead of gcsfuse; budget = 15s x 80
      # = 20min leaves headroom for three CPU checkpoint builds.
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
