# -----------------------------------------------------------------------------
# Guest preview broker — private Cloud Run service with an independent identity.
# -----------------------------------------------------------------------------
#
# Same shape as the stream-token broker: the public gateway may invoke it, but
# only this service's own service account can write the guest hosting site, and
# the image exposes no egress relay and no tenant route. The gateway reaches it
# through services/gateway/src/guest-deployer-client.js with a dedicated shared
# secret, never INTERNAL_API_TOKEN.
#
# Everything here is gated on var.guest_deployer_enabled. That is not shyness:
# a broker without a Firebase project publishes nowhere, and a gateway that
# still points at one hands visitors a URL that 404s. With the gate off the
# gateway receives no GUEST_DEPLOYER_URL, so the demo renders the preview step
# as skipped and the rest of the flow still works.

resource "google_service_account" "guest_deployer" {
  count = local.guest_deployer_enabled ? 1 : 0

  project      = var.project_id
  account_id   = "guest-deployer-sa"
  display_name = "Software Factory guest preview broker (dedicated hosting writer)"
}

# The dedicated project: Firebase-enabled, and it holds exactly one Hosting site
# for throwaway guest content. Site ids are capped per project, which is why the
# previews do not join the app project's app/www/secrets sites.
resource "google_firebase_project" "guest" {
  count = local.guest_deployer_enabled ? 1 : 0

  provider = google-beta
  project  = var.guest_firebase_project

  depends_on = [google_project_service.guest_firebase_apis]
}

resource "google_firebase_hosting_site" "guest_previews" {
  count = local.guest_deployer_enabled ? 1 : 0

  provider = google-beta
  project  = var.guest_firebase_project
  site_id  = var.guest_firebase_site

  depends_on = [google_firebase_project.guest]
}

# The broker's ONLY privilege. hostingAdmin on the guest project — not on
# var.project_id, and not roles/firebase.admin: it must not be able to touch the
# SPA site, the marketing site, or Identity Platform. The app project grants this
# SA nothing at all, which is what makes the gateway's missing credential real.
resource "google_project_iam_member" "guest_deployer_hosting" {
  count = local.guest_deployer_enabled ? 1 : 0

  project = var.guest_firebase_project
  role    = "roles/firebase.hostingAdmin"
  member  = "serviceAccount:${google_service_account.guest_deployer[0].email}"

  depends_on = [google_firebase_project.guest]
}

resource "google_secret_manager_secret_iam_member" "guest_deployer_token_accessor" {
  count = local.guest_deployer_enabled ? 1 : 0

  project   = var.project_id
  secret_id = google_secret_manager_secret.guest_deployer_internal_token[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.guest_deployer[0].email}"
}

# The caller side of the same secret. The gateway presents it and the broker
# compares it; neither side can read the other's credentials with it, which is
# the entire reason it is not INTERNAL_API_TOKEN.
resource "google_secret_manager_secret_iam_member" "gateway_guest_deployer_token" {
  count = local.guest_deployer_enabled ? 1 : 0

  project   = var.project_id
  secret_id = google_secret_manager_secret.guest_deployer_internal_token[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.gateway.email}"
}

resource "google_cloud_run_v2_service" "guest_deployer" {
  count = local.guest_deployer_enabled ? 1 : 0

  project             = var.project_id
  name                = var.guest_service_name
  location            = var.region
  ingress             = var.internal_ingress
  labels              = merge(local.common_labels, { component = "guest-deployer" })
  deletion_protection = false

  lifecycle {
    precondition {
      condition     = trimspace(var.guest_firebase_project) != ""
      error_message = "guest_deployer_enabled needs guest_firebase_project: without a dedicated project the broker would publish guest HTML wherever the ambient credential points."
    }
    precondition {
      condition     = var.guest_preview_ttl_ms == var.guest_session_ttl_ms
      error_message = "guest_preview_ttl_ms and guest_session_ttl_ms must be equal — the transcript links a URL, and two values mean the transcript outlives the site it promises."
    }
  }

  template {
    service_account                  = google_service_account.guest_deployer[0].email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = var.container_concurrency

    scaling {
      min_instance_count = var.guest_deployer_min_instances
      max_instance_count = var.max_instances
    }

    containers {
      name  = "app"
      image = local.guest_image

      ports {
        container_port = 8080
      }

      # The broker binds loopback by default for local safety; Cloud Run needs
      # the container to accept ingress on all interfaces. Deployment-only opt-in,
      # exactly as the stream-token broker sets its own bind host.
      env {
        name  = "GUEST_DEPLOY_BIND_HOST"
        value = "0.0.0.0"
      }

      dynamic "env" {
        for_each = merge(local.common_env, {
          GUEST_FIREBASE_PROJECT = var.guest_firebase_project
          GUEST_FIREBASE_SITE    = var.guest_firebase_site
          GUEST_HOSTING_CHANNEL  = var.guest_hosting_channel
          GUEST_PREVIEW_TTL_MS   = tostring(var.guest_preview_ttl_ms)
          GUEST_PREVIEW_BASE_URL = local.guest_preview_origin
          # The broker keeps its own ledger of live previews (releases.js) under
          # SOFTWARE_FACTORY_DATA_DIR, which common_env already pins to /tmp —
          # the deployer derives GUEST_DEPLOY_DATA_DIR from it rather than
          # spelling a second path that can disagree. The ledger is explicitly
          # NOT the app store: no Firestore, no org keying, and a restart
          # re-releases from this file.
        })
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name = "GUEST_DEPLOY_INTERNAL_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.guest_deployer_internal_token[0].secret_id
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
    google_project_service.guest_firebase_apis,
    google_firebase_hosting_site.guest_previews,
    google_project_iam_member.guest_deployer_hosting,
    google_secret_manager_secret_iam_member.guest_deployer_token_accessor,
  ]
}

# The gateway may exercise only the broker's narrow deploy/release RPCs; there is
# no allUsers binding here, so a visitor can never reach this service directly.
resource "google_cloud_run_v2_service_iam_member" "gateway_invokes_guest_deployer" {
  count = local.guest_deployer_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.guest_deployer[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.gateway.email}"
}
