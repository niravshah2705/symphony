# -----------------------------------------------------------------------------
# Central Grafana Cloud observability collector.
# -----------------------------------------------------------------------------
# Existing services continue writing to stdout/stderr; Cloud Logging receives
# those entries without application changes. A project sink selects only the AI
# Fleet Cloud Run service/job names (shared + deterministic tenant prefixes),
# publishes them to Pub/Sub, and one private Alloy instance pulls the logs while
# polling native Cloud Monitoring metrics. No Grafana credential is ever mounted
# into an agent runtime.
#
# Bootstrap is intentionally two-stage:
#   1. apply with grafana_monitoring_enabled=false (default), which creates the
#      empty grafana-cloud-access-token secret container;
#   2. add a token version out-of-band, supply its exact numeric version plus the
#      non-secret Grafana connection fields, and enable the feature.

locals {
  grafana_alloy_service_name = "grafana-alloy"
  grafana_alloy_tag          = var.alloy_image_tag != "" ? var.alloy_image_tag : var.image_tag
  grafana_alloy_image        = "${local.image_base}/${local.grafana_alloy_service_name}:${local.grafana_alloy_tag}"

  # Include only services that this Terraform configuration actually creates,
  # plus the central collector itself. Tenant service names are handled by the
  # deterministic regex below because those resources are created at runtime by
  # the provisioner rather than represented in Terraform state.
  grafana_shared_cloud_run_services = distinct(concat(
    [
      var.gateway_service_name,
      var.planner_service_name,
      var.coder_service_name,
      var.org_service_name,
      var.settings_service_name,
      var.email_service_name,
      local.grafana_alloy_service_name,
    ],
    local.pipeline_on ? [
      var.orchestrator_service_name,
      var.tester_service_name,
      var.deployer_service_name,
    ] : [],
    local.provisioning_on ? [var.provisioner_service_name] : [],
  ))

  grafana_cloud_run_service_regex = "^(${join("|", local.grafana_shared_cloud_run_services)}|(gw|pl|cc|po|pt|pd)-t[a-z0-9]{1,48})$"
  grafana_cloud_run_job_regex     = "^(${var.coder_job_name}|cw-t[a-z0-9]{1,48})$"

  # Shared Pub/Sub resources are exact names. Dedicated tenant resources use
  # the naming contract in packages/shared-core/src/provisioning/naming.js.
  grafana_shared_pubsub_resources = distinct(concat(
    [
      var.planner_topic,
      "${var.planner_topic}-push",
      var.coder_topic,
      "${var.coder_topic}-push",
      var.dead_letter_topic,
      var.email_topic,
      "${var.email_topic}-push",
      "grafana-cloud-logs",
      "grafana-cloud-logs-alloy",
    ],
    local.pipeline_on ? [
      var.pipeline_plan_topic,
      "${var.pipeline_plan_topic}-push",
      var.pipeline_code_topic,
      "${var.pipeline_code_topic}-push",
      var.pipeline_test_topic,
      "${var.pipeline_test_topic}-push",
      var.pipeline_deploy_topic,
      "${var.pipeline_deploy_topic}-push",
      var.pipeline_plan_results_topic,
      "${var.pipeline_plan_results_topic}-push",
      var.pipeline_code_results_topic,
      "${var.pipeline_code_results_topic}-push",
      var.pipeline_test_results_topic,
      "${var.pipeline_test_results_topic}-push",
      var.pipeline_deploy_results_topic,
      "${var.pipeline_deploy_results_topic}-push",
    ] : [],
    local.provisioning_on ? [
      var.provisioning_topic,
      "${var.provisioning_topic}-push",
    ] : [],
  ))
  # Pub/Sub names can contain `.` and `+`, both of which are RE2 operators.
  # Escape them before composing the exact-name allowlist.
  grafana_shared_pubsub_resource_patterns = [
    for name in local.grafana_shared_pubsub_resources : replace(replace(name, ".", "\\."), "+", "\\+")
  ]
  grafana_tenant_pubsub_regex   = "(planner|coder|pipeline-plan|pipeline-code|pipeline-test|pipeline-deploy|pipeline-plan-results|pipeline-code-results|pipeline-test-results|pipeline-deploy-results)-t[a-z0-9]{1,48}(-push)?"
  grafana_pubsub_resource_regex = "^(${join("|", local.grafana_shared_pubsub_resource_patterns)}|${local.grafana_tenant_pubsub_regex})$"

  # Dots are the only regex metacharacter GCS bucket names may contain.
  grafana_gcs_bucket_names = distinct(concat(
    [var.spa_bucket_name],
    var.skills_enabled ? [local.skills_bucket_name] : [],
    var.registry_enabled ? [var.registry_bucket_name] : [],
  ))
  grafana_gcs_bucket_regex          = "^(${join("|", [for name in local.grafana_gcs_bucket_names : replace(name, ".", "\\.")])})$"
  grafana_artifact_repository_regex = "^${replace(replace(var.artifact_repo, ".", "\\."), "+", "\\+")}$"

  grafana_cloud_run_log_filter = <<-EOT
    (
      resource.type = "cloud_run_revision"
      AND resource.labels.service_name =~ "${local.grafana_cloud_run_service_regex}"
    )
    OR
    (
      resource.type = "cloud_run_job"
      AND resource.labels.job_name =~ "${local.grafana_cloud_run_job_regex}"
    )
  EOT
}

# The secret CONTAINER exists unconditionally so a token can be seeded before
# the first enabled apply. Terraform never creates or reads a secret version.
resource "google_secret_manager_secret" "grafana_cloud_access_token" {
  project   = var.project_id
  secret_id = "grafana-cloud-access-token"
  labels    = merge(local.common_labels, { component = "monitoring" })

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

# --- Logs: Cloud Logging -> project sink -> Pub/Sub pull subscription ---------

resource "google_pubsub_topic" "grafana_cloud_logs" {
  count   = var.grafana_monitoring_enabled ? 1 : 0
  project = var.project_id
  name    = "grafana-cloud-logs"
  labels  = merge(local.common_labels, { component = "monitoring" })

  depends_on = [google_project_service.services]
}

resource "google_logging_project_sink" "grafana_cloud_run" {
  count                  = var.grafana_monitoring_enabled ? 1 : 0
  project                = var.project_id
  name                   = "grafana-cloud-run-logs"
  destination            = "pubsub.googleapis.com/${google_pubsub_topic.grafana_cloud_logs[0].id}"
  filter                 = local.grafana_cloud_run_log_filter
  unique_writer_identity = true

  depends_on = [google_project_service.services]
}

# A unique sink writer prevents a project-wide logging principal from gaining
# publish access. The binding is scoped to this one monitoring topic.
resource "google_pubsub_topic_iam_member" "grafana_log_sink_publisher" {
  count   = var.grafana_monitoring_enabled ? 1 : 0
  project = var.project_id
  topic   = google_pubsub_topic.grafana_cloud_logs[0].name
  role    = "roles/pubsub.publisher"
  member  = google_logging_project_sink.grafana_cloud_run[0].writer_identity

  # Make the durable consumer exist before the sink can first publish. This
  # avoids dropping entries during the initial enabled apply.
  depends_on = [google_pubsub_subscription.grafana_cloud_logs]
}

resource "google_pubsub_subscription" "grafana_cloud_logs" {
  count   = var.grafana_monitoring_enabled ? 1 : 0
  project = var.project_id
  name    = "grafana-cloud-logs-alloy"
  topic   = google_pubsub_topic.grafana_cloud_logs[0].id
  labels  = merge(local.common_labels, { component = "monitoring" })

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  retain_acked_messages      = false

  # Monitoring is intentionally long-lived; do not expire the subscription if
  # the collector is temporarily unavailable for more than 31 days.
  expiration_policy {
    ttl = ""
  }

}

# --- Collector identity and least-privilege access ----------------------------

resource "google_service_account" "grafana_alloy" {
  count        = var.grafana_monitoring_enabled ? 1 : 0
  project      = var.project_id
  account_id   = "grafana-alloy-sa"
  display_name = "AI Fleet Grafana Alloy collector"

  depends_on = [google_project_service.services]
}

resource "google_project_iam_member" "grafana_alloy_monitoring_viewer" {
  count   = var.grafana_monitoring_enabled ? 1 : 0
  project = var.project_id
  role    = "roles/monitoring.viewer"
  member  = "serviceAccount:${google_service_account.grafana_alloy[0].email}"
}

resource "google_pubsub_subscription_iam_member" "grafana_alloy_log_subscriber" {
  count        = var.grafana_monitoring_enabled ? 1 : 0
  project      = var.project_id
  subscription = google_pubsub_subscription.grafana_cloud_logs[0].name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.grafana_alloy[0].email}"
}

resource "google_secret_manager_secret_iam_member" "grafana_alloy_token_accessor" {
  count     = var.grafana_monitoring_enabled ? 1 : 0
  project   = var.project_id
  secret_id = google_secret_manager_secret.grafana_cloud_access_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.grafana_alloy[0].email}"
}

# --- One private, always-on Cloud Run collector -------------------------------

resource "google_cloud_run_v2_service" "grafana_alloy" {
  count               = var.grafana_monitoring_enabled ? 1 : 0
  project             = var.project_id
  name                = local.grafana_alloy_service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  labels              = merge(local.common_labels, { component = "monitoring" })
  deletion_protection = false

  template {
    service_account                  = google_service_account.grafana_alloy[0].email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = 1

    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    containers {
      name  = "alloy"
      image = local.grafana_alloy_image

      # Preserve the image ENTRYPOINT. Alloy's CLI receives the subcommand and
      # flags as args; the custom image bakes the configuration at this path.
      args = [
        "run",
        "--server.http.listen-addr=0.0.0.0:8080",
        "--storage.path=/tmp/alloy",
        "/etc/alloy/config.alloy",
      ]

      ports {
        name           = "http1"
        container_port = 8080
      }

      dynamic "env" {
        for_each = {
          GCP_PROJECT_ID                    = var.project_id
          GCP_REGION                        = var.region
          DEPLOYMENT_ENVIRONMENT            = var.environment
          GRAFANA_METRICS_URL               = trimspace(var.grafana_metrics_remote_write_url)
          GRAFANA_METRICS_USERNAME          = trimspace(var.grafana_metrics_username)
          GRAFANA_LOKI_URL                  = trimspace(var.grafana_loki_push_url)
          GRAFANA_LOKI_USERNAME             = trimspace(var.grafana_loki_username)
          GRAFANA_LOG_SUBSCRIPTION          = google_pubsub_subscription.grafana_cloud_logs[0].name
          GRAFANA_CLOUD_RUN_SERVICE_REGEX   = local.grafana_cloud_run_service_regex
          GRAFANA_CLOUD_RUN_JOB_REGEX       = local.grafana_cloud_run_job_regex
          GRAFANA_PUBSUB_RESOURCE_REGEX     = local.grafana_pubsub_resource_regex
          GRAFANA_GCS_BUCKET_REGEX          = local.grafana_gcs_bucket_regex
          GRAFANA_ARTIFACT_REPOSITORY_REGEX = local.grafana_artifact_repository_regex
        }
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name = "GRAFANA_CLOUD_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.grafana_cloud_access_token.secret_id
            version = trimspace(var.grafana_cloud_token_version)
          }
        }
      }

      startup_probe {
        http_get {
          path = "/-/ready"
          port = 8080
        }
        period_seconds    = 3
        timeout_seconds   = 1
        failure_threshold = 20
      }

      liveness_probe {
        http_get {
          path = "/-/ready"
          port = 8080
        }
        period_seconds    = 30
        timeout_seconds   = 2
        failure_threshold = 3
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        # Alloy polls and drains Pub/Sub between HTTP requests, so it requires
        # instance-based CPU allocation rather than request-only throttling.
        cpu_idle          = false
        startup_cpu_boost = true
      }
    }
  }

  lifecycle {
    precondition {
      condition     = trimspace(var.grafana_metrics_username) != ""
      error_message = "grafana_metrics_username is required when grafana_monitoring_enabled=true."
    }
    precondition {
      condition     = trimspace(var.grafana_loki_push_url) != ""
      error_message = "grafana_loki_push_url is required when grafana_monitoring_enabled=true."
    }
    precondition {
      condition     = trimspace(var.grafana_loki_username) != ""
      error_message = "grafana_loki_username is required when grafana_monitoring_enabled=true."
    }
    precondition {
      condition     = can(regex("^[1-9][0-9]*$", trimspace(var.grafana_cloud_token_version)))
      error_message = "an exact positive grafana_cloud_token_version is required when grafana_monitoring_enabled=true."
    }
  }

  depends_on = [
    google_project_iam_member.grafana_alloy_monitoring_viewer,
    google_pubsub_subscription_iam_member.grafana_alloy_log_subscriber,
    google_secret_manager_secret_iam_member.grafana_alloy_token_accessor,
  ]
}

# No google_cloud_run_v2_service_iam_member is intentionally declared for this
# service. It is not a UI or scrape endpoint; probes run inside Cloud Run and
# the collector only needs outbound access to GCP and Grafana Cloud.
