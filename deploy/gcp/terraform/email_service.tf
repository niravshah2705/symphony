# -----------------------------------------------------------------------------
# Shared transactional email service — internal, Pub/Sub-driven, never cloned
# into per-tenant agent stacks. SMTP credentials exist only on email-sa.
# -----------------------------------------------------------------------------

locals {
  email_public_app_url   = trimsuffix(trimspace(var.email_public_app_url), "/")
  email_smtp_secret_refs = var.email_smtp_auth_enabled ? toset(["enabled"]) : toset([])
}

resource "google_service_account" "email" {
  project      = var.project_id
  account_id   = "email-sa"
  display_name = "AI Fleet shared transactional email"
}

# Durable best-effort idempotency claims live in a service-owned Firestore
# collection. The service never reads tenant application data.
resource "google_project_iam_member" "email_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.email.email}"
}

resource "google_secret_manager_secret" "email_smtp_user" {
  project   = var.project_id
  secret_id = "email-smtp-user"
  labels    = merge(local.common_labels, { component = "email" })
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret" "email_smtp_password" {
  project   = var.project_id
  secret_id = "email-smtp-password"
  labels    = merge(local.common_labels, { component = "email" })
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

# Older revisions briefly managed SMTP values as Terraform secret-version
# resources. Forget any such instances without destroying the live versions;
# credentials are operational Secret Manager data from this revision onward.
removed {
  from = google_secret_manager_secret_version.email_smtp_user
  lifecycle {
    destroy = false
  }
}

removed {
  from = google_secret_manager_secret_version.email_smtp_password
  lifecycle {
    destroy = false
  }
}

resource "google_secret_manager_secret_iam_member" "email_smtp_user_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.email_smtp_user.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.email.email}"
}

resource "google_secret_manager_secret_iam_member" "email_smtp_password_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.email_smtp_password.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.email.email}"
}

resource "google_cloud_run_v2_service" "email" {
  project             = var.project_id
  name                = var.email_service_name
  location            = var.region
  ingress             = var.internal_ingress
  labels              = merge(local.common_labels, { component = "email" })
  deletion_protection = false

  template {
    service_account                  = google_service_account.email.email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = var.container_concurrency

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = local.email_image

      ports {
        container_port = 8080
      }

      dynamic "env" {
        for_each = merge(local.common_env, {
          EMAIL_SERVICE_PORT           = "8080"
          EMAIL_SMTP_HOST              = var.email_smtp_host
          EMAIL_SMTP_PORT              = tostring(var.email_smtp_port)
          EMAIL_SMTP_SECURE            = tostring(var.email_smtp_secure)
          EMAIL_SMTP_REQUIRE_TLS       = tostring(var.email_smtp_require_tls)
          EMAIL_FROM                   = var.email_from
          PUBLIC_APP_URL               = local.email_public_app_url
          EMAIL_IDEMPOTENCY_COLLECTION = "email_service__deliveries"
          PUBSUB_PUSH_AUDIENCE         = local.email_url
          PUBSUB_PUSH_SA               = google_service_account.pubsub_push.email
        })
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.email_smtp_secret_refs
        content {
          name = "EMAIL_SMTP_USER"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.email_smtp_user.secret_id
              version = "latest"
            }
          }
        }
      }

      dynamic "env" {
        for_each = local.email_smtp_secret_refs
        content {
          name = "EMAIL_SMTP_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.email_smtp_password.secret_id
              version = "latest"
            }
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

  lifecycle {
    precondition {
      condition     = local.email_public_app_url != ""
      error_message = "email_public_app_url must be set to the HTTPS base URL of the SPA that this deployment actually publishes."
    }
  }

  depends_on = [
    google_project_service.services,
    google_firestore_database.default,
    google_project_iam_member.email_datastore,
    google_secret_manager_secret_iam_member.email_smtp_user_accessor,
    google_secret_manager_secret_iam_member.email_smtp_password_accessor,
  ]
}

# Only Pub/Sub's push identity invokes the delivery endpoint. Producers publish
# to the topic and never receive run.invoker or the SMTP credentials.
resource "google_cloud_run_v2_service_iam_member" "push_invokes_email" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.email.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_push.email}"
}

resource "google_pubsub_topic" "email" {
  project = var.project_id
  name    = var.email_topic
  labels  = merge(local.common_labels, { component = "email" })

  depends_on = [google_project_service.services]
}

# Organization invitations and planner-owned billing notifications share the
# delivery service, while SMTP access remains isolated on email-sa.
resource "google_pubsub_topic_iam_member" "email_publishers" {
  for_each = {
    org     = google_service_account.org.email
    planner = google_service_account.planner.email
  }
  project = var.project_id
  topic   = google_pubsub_topic.email.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${each.value}"
}

resource "google_pubsub_subscription" "email_push" {
  project = var.project_id
  name    = "${var.email_topic}-push"
  topic   = google_pubsub_topic.email.id
  labels  = merge(local.common_labels, { component = "email" })

  # SMTP handshakes can exceed the agents' short 30-second handler deadline.
  # Keep this above all configured transport timeouts to avoid concurrent pushes.
  ack_deadline_seconds = 120

  push_config {
    push_endpoint = "${local.email_url}/pubsub/email"
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = local.email_url
    }
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter.id
    max_delivery_attempts = 5
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  depends_on = [
    google_cloud_run_v2_service.email,
    google_cloud_run_v2_service_iam_member.push_invokes_email,
    google_service_account_iam_member.pubsub_agent_token_creator,
  ]
}

# The Pub/Sub service agent needs subscriber on every source subscription to
# forward exhausted deliveries to the shared dead-letter topic.
resource "google_pubsub_subscription_iam_member" "agent_sub_email" {
  project      = var.project_id
  subscription = google_pubsub_subscription.email_push.name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_agent
}
