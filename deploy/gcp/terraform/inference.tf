# -----------------------------------------------------------------------------
# STANDALONE DEMO — Ollama + vLLM inference on Cloud Run, backed by the model
# registry in models.tf.
# -----------------------------------------------------------------------------
# This is a spike, not a fleet integration: neither service is wired into
# packages/shared-core/src/egress.js, services/proxy, or any agent runtime —
# nothing in the fleet routes traffic here. Both services are IAM-gated
# (no allUsers invoker) like planner/coder-control, but UNLIKE those services
# no caller service account is granted roles/run.invoker here, since nothing
# in-fleet is meant to call them yet. To exercise a deployed instance by hand:
#
#   gcloud run services add-iam-policy-binding <service-name> \
#     --project <project> --region <region> \
#     --member="user:<you>@example.com" --role="roles/run.invoker"
#   gcloud run services proxy <service-name> --project <project> --region <region>
#
# Both scale to zero (min_instance_count = 0), which means real cold-start
# latency copying model weights off the gcsfuse mount before the first
# request completes — an accepted tradeoff for a demo, not a production
# posture (see docs/GCP_DEPLOY.md "Inference demo").
#
# Gated by inference_ollama_enabled / inference_vllm_enabled (both default
# false) — an existing deployment that doesn't opt in creates nothing here.

# --- Ollama ---------------------------------------------------------------

resource "google_service_account" "inference_ollama" {
  count        = var.inference_ollama_enabled ? 1 : 0
  project      = var.project_id
  account_id   = "inference-ollama-sa"
  display_name = "AI Fleet inference demo (Ollama)"
}

resource "google_cloud_run_v2_service" "inference_ollama" {
  count               = var.inference_ollama_enabled ? 1 : 0
  project             = var.project_id
  name                = var.inference_ollama_service_name
  location            = var.region
  ingress             = var.internal_ingress # IAM-gated; see header comment — no invoker bindings are granted
  labels              = merge(local.common_labels, { component = "inference-ollama" })
  deletion_protection = false

  template {
    service_account                  = google_service_account.inference_ollama[0].email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2" # required for the gcsfuse volume below
    max_instance_request_concurrency = 1                            # CPU-bound model server: serialize generations, don't share cores across requests

    scaling {
      min_instance_count = 0 # scale-to-zero accepted for this demo (see header comment) — real cold-start cost
      max_instance_count = var.max_instances
    }

    # Versioned model bundle mounted read-only via gcsfuse (models.tf). Only
    # present when the bucket + mount are both enabled.
    dynamic "volumes" {
      for_each = var.models_enabled && var.models_mount_enabled ? [1] : []
      content {
        name = "models"
        gcs {
          bucket    = google_storage_bucket.models[0].name
          read_only = true
        }
      }
    }

    containers {
      name  = "app"
      image = var.inference_ollama_image

      # gcsfuse is a poor fit for GGUF's mmap/random-read pattern, so copy the
      # pinned version's models to local disk once at cold start, then serve
      # locally — mirrors deploy/gcp/inference-vllm-entrypoint.sh's reasoning.
      command = ["/bin/sh", "-c"]
      args = [<<-EOT
        set -e
        mkdir -p /root/.ollama/models
        if [ -d "/models/ollama/$MODEL_VERSION" ]; then
          echo "Copying pinned model version $MODEL_VERSION from the gcsfuse mount to local disk..."
          cp -r "/models/ollama/$MODEL_VERSION/." /root/.ollama/models/
        else
          echo "WARNING: /models/ollama/$MODEL_VERSION not found (models_mount_enabled off, empty bucket, or version not yet published by publish-models.yml) — starting with no local models." >&2
        fi
        exec ollama serve
      EOT
      ]

      ports {
        container_port = 11434 # Ollama's default API port
      }

      env {
        name  = "MODEL_VERSION"
        value = var.ollama_model_version
      }

      dynamic "volume_mounts" {
        for_each = var.models_enabled && var.models_mount_enabled ? [1] : []
        content {
          name       = "models"
          mount_path = "/models"
        }
      }

      startup_probe {
        http_get {
          path = "/"
          port = 11434
        }
        period_seconds    = 5
        timeout_seconds   = 3
        failure_threshold = 60 # copying + loading model weights on cold start can take a while
      }

      resources {
        limits = {
          cpu    = var.inference_ollama_cpu
          memory = var.inference_ollama_memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }
    }
  }

  depends_on = [google_project_service.services]
}

# --- vLLM (best-effort — see variables.tf's inference_vllm_enabled description) ---

resource "google_service_account" "inference_vllm" {
  count        = var.inference_vllm_enabled ? 1 : 0
  project      = var.project_id
  account_id   = "inference-vllm-sa"
  display_name = "AI Fleet inference demo (vLLM, best-effort/CPU)"
}

resource "google_cloud_run_v2_service" "inference_vllm" {
  count               = var.inference_vllm_enabled ? 1 : 0
  project             = var.project_id
  name                = var.inference_vllm_service_name
  location            = var.region
  ingress             = var.internal_ingress # IAM-gated; see header comment — no invoker bindings are granted
  labels              = merge(local.common_labels, { component = "inference-vllm" })
  deletion_protection = false

  lifecycle {
    precondition {
      condition     = var.inference_vllm_image != ""
      error_message = "inference_vllm_image must be set to a pushed image (build deploy/gcp/Dockerfile.inference-vllm via build-vllm-cpu-base.sh first — there is no public CPU image to default to) before inference_vllm_enabled can be turned on."
    }
  }

  template {
    service_account                  = google_service_account.inference_vllm[0].email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2" # required for the gcsfuse volume below
    max_instance_request_concurrency = 1                            # CPU-bound model server: serialize generations, don't share cores across requests

    scaling {
      min_instance_count = 0 # scale-to-zero accepted for this demo (see header comment) — real cold-start cost
      max_instance_count = var.max_instances
    }

    dynamic "volumes" {
      for_each = var.models_enabled && var.models_mount_enabled ? [1] : []
      content {
        name = "models"
        gcs {
          bucket    = google_storage_bucket.models[0].name
          read_only = true
        }
      }
    }

    containers {
      name  = "app"
      image = var.inference_vllm_image # deploy/gcp/inference-vllm-entrypoint.sh handles the local-disk copy + `vllm serve`

      ports {
        container_port = 8080
      }

      env {
        name  = "MODEL_VERSION"
        value = var.vllm_model_version
      }
      env {
        name  = "MODEL_NAME"
        value = var.vllm_model_name
      }

      dynamic "volume_mounts" {
        for_each = var.models_enabled && var.models_mount_enabled ? [1] : []
        content {
          name       = "models"
          mount_path = "/models"
        }
      }

      startup_probe {
        http_get {
          path = "/health" # vLLM's OpenAI-compatible server
          port = 8080
        }
        period_seconds    = 5
        timeout_seconds   = 3
        failure_threshold = 60 # copying + loading model weights on cold start can take a while
      }

      resources {
        limits = {
          cpu    = var.inference_vllm_cpu
          memory = var.inference_vllm_memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }
    }
  }

  depends_on = [google_project_service.services]
}
