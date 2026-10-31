# -----------------------------------------------------------------------------
# Hosted inference backends (Ollama + vLLM on Cloud Run) for the fleet's
# Laya (routing/decision) and CLM (contrastive/embedding) services.
# -----------------------------------------------------------------------------
# Contract: Laya/CLM call an OpenAI-compatible endpoint described entirely by
# environment variables (see laya_inference.tf / clm_inference.tf):
#
#   INFERENCE_BASE_URL   e.g. https://inference-vllm-<hash>/v1
#   INFERENCE_API_KEY    bearer key from Secret Manager (vLLM `--api-key`)
#   INFERENCE_AUTH_MODE  bearer | iam | none
#   INFERENCE_MODEL / INFERENCE_EMBEDDING_MODEL
#
# The default fleet path is vLLM (it enforces a real API key). Ollama is kept
# as an alternate engine; because Ollama has no native API-key support it is
# IAM-gated and Laya/CLM must use INFERENCE_AUTH_MODE=iam when pointed at it.
#
# Network posture: every backend uses INGRESS_TRAFFIC_INTERNAL_ONLY. The vLLM
# services additionally allow unauthenticated Cloud Run invocation so the
# vLLM-level API key can be the single Authorization credential (Cloud Run IAM
# and vLLM both use `Authorization: Bearer`, so the two cannot coexist on one
# request). Ollama keeps Cloud Run IAM and grants run.invoker only to Laya/CLM.
#
# Both vLLM services mount the versioned model registry (models.tf) read-only
# and pin a version per engine, so publishing a new bundle never disturbs a
# running deployment. Ollama copies its pinned bundle to local disk at start.

locals {
  laya_inference_base_url = var.laya_inference_base_url != "" ? var.laya_inference_base_url : (
    var.inference_vllm_enabled ? "${one(google_cloud_run_v2_service.inference_vllm[*].uri)}/v1" : ""
  )
  clm_inference_base_url = var.clm_inference_base_url != "" ? var.clm_inference_base_url : (
    var.inference_vllm_embed_enabled ? "${one(google_cloud_run_v2_service.inference_vllm_embed[*].uri)}/v1" : (
      var.inference_vllm_enabled ? "${one(google_cloud_run_v2_service.inference_vllm[*].uri)}/v1" : ""
    )
  )
  laya_inference_model          = var.laya_inference_model != "" ? var.laya_inference_model : var.vllm_model_name
  clm_inference_embedding_model = var.clm_inference_embedding_model != "" ? var.clm_inference_embedding_model : var.vllm_embed_model_name
  inference_api_key_secret_id   = var.inference_api_key_secret_id
}

# -----------------------------------------------------------------------------
# Shared bearer key — PRE-EXISTING secret, not Terraform-managed (same posture
# as secrets.tf: values never enter state/source). Create it once:
#   printf %s "$KEY" | gcloud secrets create inference-api-key --data-file=-
# Cloud Run resolves `latest` at revision start, so a version MUST exist before
# the Laya/CLM/vLLM revisions are created.
# -----------------------------------------------------------------------------

locals {
  inference_enabled = var.inference_ollama_enabled || var.inference_vllm_enabled || var.inference_vllm_embed_enabled || local.laya_inference_base_url != "" || local.clm_inference_base_url != ""
}

resource "google_secret_manager_secret_iam_member" "laya_reads_inference_key" {
  count     = local.inference_enabled && local.inference_api_key_secret_id != "" && var.laya_inference_auth_mode == "bearer" ? 1 : 0
  project   = var.project_id
  secret_id = local.inference_api_key_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.laya_inference.email}"
}

resource "google_secret_manager_secret_iam_member" "clm_reads_inference_key" {
  count     = local.inference_enabled && local.inference_api_key_secret_id != "" && var.clm_inference_auth_mode == "bearer" ? 1 : 0
  project   = var.project_id
  secret_id = local.inference_api_key_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.clm_inference.email}"
}

# --- Ollama (alternate engine, IAM-gated) ------------------------------------

resource "google_service_account" "inference_ollama" {
  count        = var.inference_ollama_enabled ? 1 : 0
  project      = var.project_id
  account_id   = "inference-ollama-sa"
  display_name = "AI Fleet inference backend (Ollama)"
}

resource "google_cloud_run_v2_service" "inference_ollama" {
  count               = var.inference_ollama_enabled ? 1 : 0
  project             = var.project_id
  name                = var.inference_ollama_service_name
  location            = var.region
  ingress             = var.internal_ingress
  labels              = merge(local.common_labels, { component = "inference-ollama" })
  deletion_protection = false

  template {
    service_account = google_service_account.inference_ollama[0].email
    # gen2 is required for the gcsfuse volume below.
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
    # CPU-bound model server: serialize generations, don't share cores across requests.
    max_instance_request_concurrency = 1

    scaling {
      min_instance_count = 0
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
      image = var.inference_ollama_image

      # gcsfuse is a poor fit for GGUF's mmap/random-read pattern, so copy the
      # pinned version's models to local disk once at cold start, then serve
      # locally.
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
        container_port = 11434
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
        failure_threshold = 60
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

# Ollama has no API-key middleware; only the fleet inference services may call
# it (they mint an ID token — INFERENCE_AUTH_MODE=iam).
resource "google_cloud_run_v2_service_iam_member" "laya_invokes_ollama" {
  count    = var.inference_ollama_enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.inference_ollama[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.laya_inference.email}"
}

resource "google_cloud_run_v2_service_iam_member" "clm_invokes_ollama" {
  count    = var.inference_ollama_enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.inference_ollama[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.clm_inference.email}"
}

# --- vLLM: Gemma chat/completions (Laya's default backend) -------------------

resource "google_service_account" "inference_vllm" {
  count        = var.inference_vllm_enabled || var.inference_vllm_embed_enabled ? 1 : 0
  project      = var.project_id
  account_id   = "inference-vllm-sa"
  display_name = "AI Fleet inference backend (vLLM)"
}

resource "google_secret_manager_secret_iam_member" "vllm_reads_inference_key" {
  count     = local.inference_api_key_secret_id != "" && (var.inference_vllm_enabled || var.inference_vllm_embed_enabled) ? 1 : 0
  project   = var.project_id
  secret_id = local.inference_api_key_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.inference_vllm[0].email}"
}

resource "google_cloud_run_v2_service" "inference_vllm" {
  count               = var.inference_vllm_enabled ? 1 : 0
  project             = var.project_id
  name                = var.inference_vllm_service_name
  location            = var.region
  ingress             = var.internal_ingress
  labels              = merge(local.common_labels, { component = "inference-vllm" })
  deletion_protection = false

  lifecycle {
    precondition {
      condition     = var.inference_vllm_image != ""
      error_message = "inference_vllm_image must be set to a pushed image (build deploy/gcp/Dockerfile.inference-vllm via build-vllm-cpu-base.sh first — there is no public CPU image to default to) before inference_vllm_enabled can be turned on."
    }
    precondition {
      condition     = local.inference_api_key_secret_id != ""
      error_message = "inference_vllm services require inference_api_key_secret_id (vLLM enforces --api-key; the value must be added to Secret Manager out-of-band before apply)."
    }
  }

  template {
    service_account                  = google_service_account.inference_vllm[0].email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = 1

    scaling {
      min_instance_count = 0
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
      image = var.inference_vllm_image

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
      dynamic "env" {
        for_each = local.inference_api_key_secret_id != "" ? [1] : []
        content {
          name = "INFERENCE_API_KEY"
          value_source {
            secret_key_ref {
              secret  = local.inference_api_key_secret_id
              version = "latest"
            }
          }
        }
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
          path = "/health"
          port = 8080
        }
        period_seconds    = 5
        timeout_seconds   = 3
        failure_threshold = 60
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

# --- vLLM: EmbeddingGemma (CLM's default backend) ----------------------------

resource "google_cloud_run_v2_service" "inference_vllm_embed" {
  count               = var.inference_vllm_embed_enabled ? 1 : 0
  project             = var.project_id
  name                = var.inference_vllm_embed_service_name
  location            = var.region
  ingress             = var.internal_ingress
  labels              = merge(local.common_labels, { component = "inference-vllm-embed" })
  deletion_protection = false

  lifecycle {
    precondition {
      condition     = var.inference_vllm_image != ""
      error_message = "inference_vllm_image must be set before inference_vllm_embed_enabled can be turned on."
    }
    precondition {
      condition     = local.inference_api_key_secret_id != ""
      error_message = "inference_vllm services require inference_api_key_secret_id (vLLM enforces --api-key; the value must be added to Secret Manager out-of-band before apply)."
    }
  }

  template {
    service_account                  = google_service_account.inference_vllm[0].email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = 1

    scaling {
      min_instance_count = 0
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
      image = var.inference_vllm_image

      ports {
        container_port = 8080
      }

      env {
        name  = "MODEL_VERSION"
        value = var.vllm_model_version
      }
      env {
        name  = "MODEL_NAME"
        value = var.vllm_embed_model_name
      }
      env {
        name  = "VLLM_EXTRA_ARGS"
        value = var.vllm_embed_extra_args
      }
      dynamic "env" {
        for_each = local.inference_api_key_secret_id != "" ? [1] : []
        content {
          name = "INFERENCE_API_KEY"
          value_source {
            secret_key_ref {
              secret  = local.inference_api_key_secret_id
              version = "latest"
            }
          }
        }
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
          path = "/health"
          port = 8080
        }
        period_seconds    = 5
        timeout_seconds   = 3
        failure_threshold = 60
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

# vLLM enforces the bearer key itself (--api-key). Cloud Run auth would use the
# same Authorization header, so these two services allow unauthenticated
# invocation at the platform layer; ingress stays internal-only and the API key
# is the application-level gate.
resource "google_cloud_run_v2_service_iam_member" "inference_vllm_public" {
  count    = var.inference_vllm_enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.inference_vllm[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "inference_vllm_embed_public" {
  count    = var.inference_vllm_embed_enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.inference_vllm_embed[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
