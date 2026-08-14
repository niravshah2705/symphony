# -----------------------------------------------------------------------------
# Settings-policy service (services/settings) — FastAPI + Firestore, internal +
# IAM-gated.
# -----------------------------------------------------------------------------
# Reached only through the gateway's OIDC-authenticated reverse proxy
# (/api/settings-policy/* -> /api/v1/*). It runs its own Firebase-OIDC auth +
# org-scoped RBAC and stores the org→project→user settings cascade. Shares the
# project's Firestore, namespaced under `settings_service__...`, so it adds no
# database cost. Scales to zero.

resource "google_service_account" "settings" {
  project      = var.project_id
  account_id   = "settings-sa"
  display_name = "Settings policy service"
}

check "settings_operator_ingress" {
  assert {
    condition = (
      trimspace(var.settings_operator_invoker) == "" ||
      var.settings_ingress == "INGRESS_TRAFFIC_ALL"
    )
    error_message = "A direct settings_operator_invoker requires settings_ingress=INGRESS_TRAFFIC_ALL; Cloud Run IAM remains the authorization boundary."
  }
}

resource "google_project_iam_member" "settings_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.settings.email}"
}

# Local-JWT signing secret. The service requires it (>=32 chars) even though the
# platform uses Firebase OIDC. Terraform generates and seeds it (a stable random
# value stored in Secret Manager + the remote state) so the settings revision
# always has a version to mount — no out-of-band seeding step, no CD ordering
# hazard. Mirrors the org-jwt pattern exactly.
resource "google_secret_manager_secret" "settings_jwt_secret" {
  project   = var.project_id
  secret_id = "settings-jwt-secret"
  labels    = merge(local.common_labels, { component = "settings" })

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

# Generated once and kept stable across applies. 48 chars satisfies the
# service's >=32 minimum.
resource "random_password" "settings_jwt_secret" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret_version" "settings_jwt_secret" {
  secret      = google_secret_manager_secret.settings_jwt_secret.id
  secret_data = random_password.settings_jwt_secret.result
}

resource "google_secret_manager_secret_iam_member" "settings_jwt_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.settings_jwt_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.settings.email}"
}

# Root HMAC key for deriving one bearer per organization. Only settings verifies
# and the provisioner derives these values; agent/proxy service accounts never
# receive the root key and therefore cannot forge a different tenant's token.
resource "random_password" "org_s2s_signing_key" {
  length  = 64
  special = false
}

resource "google_secret_manager_secret" "org_s2s_signing_key" {
  project   = var.project_id
  secret_id = "org-s2s-signing-key"
  labels    = merge(local.common_labels, { component = "settings" })

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_version" "org_s2s_signing_key" {
  secret      = google_secret_manager_secret.org_s2s_signing_key.id
  secret_data = random_password.org_s2s_signing_key.result
}

resource "google_secret_manager_secret_iam_member" "settings_org_s2s_signing_key" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.org_s2s_signing_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.settings.email}"
}

resource "google_cloud_run_v2_service" "settings" {
  project  = var.project_id
  name     = var.settings_service_name
  location = var.region
  # The direct operator CLI reaches this run.app endpoint with a Cloud Run OIDC
  # token. Network ingress is therefore independent from authorization: there
  # is still deliberately no allUsers binding below.
  ingress             = var.settings_ingress
  labels              = merge(local.common_labels, { component = "settings" })
  deletion_protection = false

  template {
    service_account                  = google_service_account.settings.email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = var.container_concurrency

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = local.settings_image

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
        value = "settings_service"
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
      # Membership and the selected native org/project context are authoritative
      # in the org service; settings no longer relies on a duplicated user.org_id.
      env {
        name  = "ORG_URL"
        value = local.org_url
      }
      env {
        name = "JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.settings_jwt_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "ORG_S2S_SIGNING_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.org_s2s_signing_key.secret_id
            version = "latest"
          }
        }
      }
      # KMS key for per-org secret envelope encryption. Present only when the
      # vault is enabled (var.secret_vault_kms_enabled); otherwise absent, so the
      # settings service uses its in-memory KMS fake. Splat over the 0/1 key.
      dynamic "env" {
        for_each = google_kms_crypto_key.org_secrets[*].id
        content {
          name  = "KMS_KEY_NAME"
          value = env.value
        }
      }
      # Shared token the settings service requires on the proxy's per-org secret
      # resolve (GET /internal/s2s/orgs/{id}/secrets). Same value the proxy sends.
      # One env block per existing internal-api-token secret (0 or 1) — splat
      # avoids indexing a count=0 resource.
      dynamic "env" {
        for_each = toset(google_secret_manager_secret.internal_api_token[*].secret_id)
        content {
          name = "INTERNAL_API_TOKEN"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      # Platform-managed provider keys — the single managed-key source. The
      # settings resolver returns these for a 'managed' selection so the proxy
      # has one resolution path. Each id must have a version (else startup fails).
      dynamic "env" {
        for_each = var.managed_provider_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
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
    google_project_iam_member.settings_datastore,
    google_secret_manager_secret_iam_member.settings_jwt_accessor,
    google_secret_manager_secret_iam_member.settings_org_s2s_signing_key,
    google_secret_manager_secret_version.org_s2s_signing_key,
    google_secret_manager_secret_version.settings_jwt_secret,
    google_kms_crypto_key_iam_member.settings_org_secrets,
    google_secret_manager_secret_iam_member.settings_internal_token,
    google_secret_manager_secret_iam_member.settings_managed_secrets,
  ]
}

# The settings service reads the shared internal token to verify the egress
# proxy's per-org secret resolve. Created whenever the token is configured.
resource "google_secret_manager_secret_iam_member" "settings_internal_token" {
  count     = var.internal_api_token != "" ? 1 : 0
  project   = var.project_id
  secret_id = google_secret_manager_secret.internal_api_token[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.settings.email}"
}

# settings-sa reads the platform-managed provider keys it mounts + resolves.
resource "google_secret_manager_secret_iam_member" "settings_managed_secrets" {
  for_each  = toset(values(var.managed_provider_secrets))
  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.settings.email}"
}

# Only the gateway SA may invoke the settings service (OIDC). No allUsers invoker.
resource "google_cloud_run_v2_service_iam_member" "gateway_invokes_settings" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.settings.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.gateway.email}"
}

# Optional human/group/service identity used by `adlc admin codex import`.
# Reaching the URL still requires Cloud Run IAM, and the settings application
# independently verifies the forwarded Firebase principal + operator role.
resource "google_cloud_run_v2_service_iam_member" "operator_invokes_settings" {
  count    = trimspace(var.settings_operator_invoker) != "" ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.settings.name
  role     = "roles/run.invoker"
  member   = trimspace(var.settings_operator_invoker)
}

# Settings resolves every Firebase caller's selected membership/project through
# the canonical org service. No browser can invoke either internal service.
resource "google_cloud_run_v2_service_iam_member" "settings_invokes_org" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.org.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.settings.email}"
}
