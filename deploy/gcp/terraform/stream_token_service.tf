# -----------------------------------------------------------------------------
# Stream-token broker — private Cloud Run service with an independent identity.
# -----------------------------------------------------------------------------
#
# The public gateway is allowed to invoke this service, but only the broker's
# runtime service account can read the HMAC key. The broker reuses the reviewed
# proxy image through a dedicated entrypoint that exposes no egress-relay routes.

resource "google_cloud_run_v2_service" "stream_token_broker" {
  project             = var.project_id
  name                = var.stream_token_service_name
  location            = var.region
  ingress             = var.internal_ingress
  labels              = merge(local.common_labels, { component = "stream-token-broker" })
  deletion_protection = false

  lifecycle {
    precondition {
      condition     = var.stream_token_min_instances <= var.max_instances
      error_message = "stream_token_min_instances must be less than or equal to max_instances."
    }
    precondition {
      condition     = var.container_concurrency == 1 || try(tonumber(var.cloud_run_proxy_cpu) >= 1, false)
      error_message = "container_concurrency values above 1 require cloud_run_proxy_cpu to be at least 1 vCPU."
    }
  }

  template {
    service_account                  = google_service_account.stream_token_broker.email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = var.container_concurrency

    scaling {
      min_instance_count = var.stream_token_min_instances
      max_instance_count = var.max_instances
    }

    containers {
      name    = "stream-token-broker"
      image   = local.proxy_image
      command = ["node"]
      args    = ["services/proxy/src/stream-token-server.js"]

      ports {
        container_port = 8080
      }

      # The broker entrypoint defaults to loopback for local safety. Cloud Run
      # requires the ingress container to bind all interfaces, so this explicit
      # deployment-only opt-in is intentionally absent from local/sidecar paths.
      env {
        name  = "STREAM_TOKEN_BIND_HOST"
        value = "0.0.0.0"
      }

      env {
        name = "STREAM_TOKEN_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.stream_token_secret.secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }
        initial_delay_seconds = 0
        timeout_seconds       = 3
        period_seconds        = 3
        failure_threshold     = 20
      }

      resources {
        limits = {
          cpu    = var.cloud_run_proxy_cpu
          memory = "256Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_secret_manager_secret_iam_member.stream_token_broker,
  ]
}
