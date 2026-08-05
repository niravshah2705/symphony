# -----------------------------------------------------------------------------
# Cloud Scheduler — cadence ticks that drive polling while the services idle at
# zero instances.
# -----------------------------------------------------------------------------
# Each job POSTs an empty JSON body to a /pubsub/*-tick endpoint with an OIDC
# token signed as pubsub-push-sa (which holds run.invoker on both internal
# services). The audience is the receiving service's base URL, matching the
# app's PUBSUB_PUSH_AUDIENCE check.

resource "google_cloud_scheduler_job" "planner_tick" {
  project   = var.project_id
  region    = var.region
  name      = "planner-tick"
  schedule  = var.planner_schedule
  time_zone = var.scheduler_time_zone

  http_target {
    http_method = "POST"
    uri         = "${local.planner_url}/pubsub/planner-tick"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode("{}")

    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = local.planner_url
    }
  }

  depends_on = [
    google_project_service.services,
    google_cloud_run_v2_service.planner,
    google_cloud_run_v2_service_iam_member.push_invokes_planner,
  ]
}

resource "google_cloud_scheduler_job" "coder_tick" {
  project   = var.project_id
  region    = var.region
  name      = "coder-tick"
  schedule  = var.coder_schedule
  time_zone = var.scheduler_time_zone

  http_target {
    http_method = "POST"
    uri         = "${local.coder_url}/pubsub/coder-tick"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode("{}")

    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = local.coder_url
    }
  }

  depends_on = [
    google_project_service.services,
    google_cloud_run_v2_service.coder_control,
    google_cloud_run_v2_service_iam_member.push_invokes_coder,
  ]
}
