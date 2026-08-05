# -----------------------------------------------------------------------------
# Pub/Sub — request topics + OIDC push subscriptions + dead-letter.
# -----------------------------------------------------------------------------
# The gateway publishes planner/coder requests; push subscriptions deliver them
# to the internal services' /pubsub/* endpoints. Every push carries an OIDC
# token signed as pubsub-push-sa; the receiving service verifies signature,
# audience, and the pusher email (packages/shared/src/messaging/oidc.js).

# --- Topics -------------------------------------------------------------------

resource "google_pubsub_topic" "planner" {
  project = var.project_id
  name    = var.planner_topic
  labels  = var.labels

  depends_on = [google_project_service.services]
}

resource "google_pubsub_topic" "coder" {
  project = var.project_id
  name    = var.coder_topic
  labels  = var.labels

  depends_on = [google_project_service.services]
}

resource "google_pubsub_topic" "dead_letter" {
  project = var.project_id
  name    = var.dead_letter_topic
  labels  = var.labels

  depends_on = [google_project_service.services]
}

# --- Dead-letter wiring for the Pub/Sub service agent -------------------------
# To route undeliverable messages, the Pub/Sub service agent must be able to
# publish to the DLQ topic and to ack (subscribe) on the source subscriptions.

resource "google_pubsub_topic_iam_member" "agent_publish_dlq" {
  project = var.project_id
  topic   = google_pubsub_topic.dead_letter.name
  role    = "roles/pubsub.publisher"
  member  = local.pubsub_agent
}

resource "google_pubsub_subscription_iam_member" "agent_sub_planner" {
  project      = var.project_id
  subscription = google_pubsub_subscription.planner_push.name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_agent
}

resource "google_pubsub_subscription_iam_member" "agent_sub_coder" {
  project      = var.project_id
  subscription = google_pubsub_subscription.coder_push.name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_agent
}

# --- Push subscriptions -------------------------------------------------------
# The OIDC audience is the receiving service's base URL — what Cloud Run's IAM
# layer expects AND what the app checks against PUBSUB_PUSH_AUDIENCE.

resource "google_pubsub_subscription" "planner_push" {
  project = var.project_id
  name    = "${var.planner_topic}-push"
  topic   = google_pubsub_topic.planner.id
  labels  = var.labels

  ack_deadline_seconds = var.ack_deadline_seconds

  push_config {
    push_endpoint = "${local.planner_url}/pubsub/planner"
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = local.planner_url
    }
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter.id
    max_delivery_attempts = var.max_delivery_attempts
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  # The internal service and its invoker binding must exist first.
  depends_on = [
    google_cloud_run_v2_service.planner,
    google_cloud_run_v2_service_iam_member.push_invokes_planner,
    google_service_account_iam_member.pubsub_agent_token_creator,
  ]
}

resource "google_pubsub_subscription" "coder_push" {
  project = var.project_id
  name    = "${var.coder_topic}-push"
  topic   = google_pubsub_topic.coder.id
  labels  = var.labels

  ack_deadline_seconds = var.ack_deadline_seconds

  push_config {
    push_endpoint = "${local.coder_url}/pubsub/coder"
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = local.coder_url
    }
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter.id
    max_delivery_attempts = var.max_delivery_attempts
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  depends_on = [
    google_cloud_run_v2_service.coder_control,
    google_cloud_run_v2_service_iam_member.push_invokes_coder,
    google_service_account_iam_member.pubsub_agent_token_creator,
  ]
}
