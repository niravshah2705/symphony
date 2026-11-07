# -----------------------------------------------------------------------------
# Observability: log sinks, log-based metrics, alerting policies.
# -----------------------------------------------------------------------------
# OFF by default (`var.observability_enabled = false`): no bucket, no writer, no
# sinks, no metrics, no policies, and the two APIs stay disabled — an opted-out
# deployment is unchanged. Flipping it on is NOT free: user-defined log-based
# metrics are billed as Cloud Monitoring custom metrics, and a GCS sink bills
# storage plus write requests. The set below is deliberately small — four signals
# whose absence was a real incident class, not a dashboard.
#
# WHAT EACH SIGNAL IS THE ANSWER TO
#   egress_cred_unavailable  the sidecar refused to inject a credential, so the
#                            run either failed closed or silently fell back to a
#                            key nobody meant to use. Page: it is the fail-closed
#                            signal of the egress boundary.
#   egress_no_route          a request arrived for a prefix that is not in the
#                            route table. Today that is a 404 by design, and a
#                            rising rate is somebody probing the sidecar as an
#                            open relay.
#   cost_price_fallback      a usage row priced from the fallback rate rather
#                            than the catalog (priceMatch=Default). The money
#                            version of an unmodeled gateway key: a plausible,
#                            wrong number that nobody was told about.
#   balance_under_<paise>    an org's balance crossed an alert threshold. The
#                            values come from alert_thresholds.json, GENERATED from
#                            DEFAULT_ALERT_THRESHOLDS_PAISE in
#                            packages/shared-core/src/billing/ledger.js — the
#                            thresholds are never restated in HCL (the CI test in
#                            deploy/gcp/observability-config.test.js enforces both
#                            halves of that, and that every filter below names a
#                            field the code actually emits). The file is read with
#                            jsondecode(file()) rather than shipped as an
#                            .auto.tfvars.json because this root gitignores
#                            *.tfvars*: those files are where an operator puts real
#                            secrets, and a generated input must not be the
#                            exception that quietly never reaches CI.
#
# WHY FILTERS ARE jsonPayload, AND WHY THAT DEPENDS ON ONE ENV VAR
# Every line here comes from packages/shared-core/src/logger.js, which puts the
# structured payload under `meta`. Cloud Logging only builds `jsonPayload` when
# the stdout line parses as JSON, so `LOG_FORMAT=json` in local.common_env
# (locals.tf) is a hard prerequisite: with text lines, each metric below exists,
# reports zero, and alerts on nothing. That is the silent-failure mode this file
# is most exposed to.
#
# WHAT IS DELIBERATELY NOT HERE
#   - Python services (org, settings). They do not use logger.js, so they emit no
#     `jsonPayload.meta.*` and a metric over them would be permanently zero.
#     Their logs still reach Cloud Run's own logs; they are simply not alertable
#     by this file.
#   - Managed Prometheus / GKE advanced metering. Disabled on purpose in the GKE
#     root: nothing in this repo scrapes or reads those metrics, so the
#     collection is pure per-target cost. Log-based metrics answer the four
#     questions above instead.
#   - Per-route / per-org metric labels. A counter log metric creates one time
#     series per label-value combination, and the `no_route` prefix is
#     attacker-selected — labelling it would hand anyone on the internet a
#     cardinality-billing lever. Breakdown stays in Cloud Logging / the GCS copy.
#   - A latency histogram. Distribution metrics need bucket boundaries, and
#     guessing them for a sidecar that fronts both a 404 and a five-minute agent
#     stream produces a chart that looks authoritative and is not.
#   - Notification channels. The provider cannot create them (email/SMS channels
#     are themselves deprecated), so an operator makes one — a Pub/Sub topic is
#     the durable option — and lists it in var.observability_notification_channels.
#     With an empty list no policy is created: a policy with no channel is a chart
#     that reports success while promising nothing.

locals {
  observability_enabled    = var.observability_enabled
  observability_log_bucket = "${var.project_id}-aifleet-logs"

  # The ledger's thresholds, mirrored into this root by the generator. An empty
  # list is a meaningful state — no balance metrics, no balance alerts — which is
  # exactly what a missing or stale generated file should produce, rather than
  # alerts firing on numbers the ledger no longer uses.
  billing_alert_thresholds_paise = jsondecode(
    file("${path.module}/alert_thresholds.json")
  ).billing_alert_thresholds_paise

  # The Google-managed identity behind every project log sink.
  observability_log_writer = "serviceAccount:service-${local.project_number}@gcp-sa-logging.iam.gserviceaccount.com"

  # Services whose logs are part of the durable trail. The billing service and
  # job together are the money path: a GCS copy of every threshold crossing is
  # what makes a disputed debit answerable after Firestore has pruned the rows.
  observability_sink_services = length(var.observability_log_services) > 0 ? var.observability_log_services : [
    var.gateway_service_name,
    var.planner_service_name,
    var.coder_service_name,
    var.proxy_service_name,
    var.billing_service_name,
    var.provisioner_service_name,
  ]

  # Sinks carry two resource types because Cloud Run logs jobs under
  # cloud_run_job, not cloud_run_revision — one filter cannot name both, and a
  # revision-only filter would quietly miss the hourly auto-recharge run.
  observability_sinks = local.observability_enabled ? merge(
    {
      for name in local.observability_sink_services : "svc-${name}" => {
        filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${name}\""
      }
    },
    {
      "job-${var.billing_job_name}" = {
        filter = "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"${var.billing_job_name}\""
      }
      "job-${var.coder_job_name}" = {
        filter = "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"${var.coder_job_name}\""
      }
    }
  ) : {}

  observability_base_metrics = local.observability_enabled ? {
    fleet_egress_cred_unavailable = {
      filter      = "jsonPayload.meta.decision=\"cred_unavailable\""
      description = "Egress sidecar requests refused because the caller's credential did not resolve (fail-closed)."
    }
    fleet_egress_no_route = {
      filter      = "jsonPayload.meta.decision=\"no_route\""
      description = "Egress sidecar requests for a prefix that is not in the route table (open-relay probing)."
    }
    fleet_cost_price_fallback = {
      filter      = "jsonPayload.meta.priceMatch=\"Default\""
      description = "Usage rows estimated from the fallback rate because the catalog does not model the provider."
    }
  } : {}

  # One metric per configured balance threshold, named after the paise value so
  # the alert's identity carries the number that produced it.
  observability_balance_metrics = local.observability_enabled ? {
    for t in local.billing_alert_thresholds_paise : "fleet_balance_under_${t}" => {
      # thresholdPaise is emitted as a STRING by billing/notify.js; matching a
      # numeric field with a quoted filter is what keeps the two in agreement.
      filter      = "jsonPayload.meta.event=\"balance_threshold_crossed\" AND jsonPayload.meta.thresholdPaise=\"${t}\""
      description = "Org balances that crossed the ${t} paise alert threshold."
    }
  } : {}

  observability_metrics = merge(local.observability_base_metrics, local.observability_balance_metrics)

  # Policies exist only when there is someone to tell.
  observability_alerts = (local.observability_enabled && length(var.observability_notification_channels) > 0) ? merge({
    "egress credential unavailable" = {
      metric   = "fleet_egress_cred_unavailable"
      window_s = 300
      above    = 0
      why      = "The egress sidecar refused to inject a credential. Either a run failed closed, or a tenant is pointed at a key that was never configured. Check jsonPayload.meta.prefix and orgId on the matching log line before anything else."
    }
    "egress route probing" = {
      metric   = "fleet_egress_no_route"
      window_s = 600
      above    = var.observability_no_route_alert_count
      why      = "Requests for prefixes that are not in the route table. A 404 is the designed answer; a rate is somebody testing whether the sidecar will forward anywhere. Confirm the route table has not changed, then look at the source IPs."
    }
    "cost estimate used the fallback rate" = {
      metric   = "fleet_cost_price_fallback"
      window_s = 3600
      above    = 0
      why      = "A usage row was priced by guess because PRICE_PER_MTOK_USD does not model that provider. Add the provider to packages/shared-core/src/billing/pricing.js or the rows keep drifting from what the platform actually paid."
    }
    },
    {
      for t in local.billing_alert_thresholds_paise : "balance under ${t} paise" => {
        metric   = "fleet_balance_under_${t}"
        window_s = 3600
        above    = 0
        why      = "An org's ledger balance crossed ${t} paise. The in-product notification already fired; this is the operator-side signal that the next runner gate will start refusing work for that org."
      }
    }
  ) : {}
}

# The export target for the durable trail. Standard storage, not Nearline: the
# rows anyone is arguing about a month later are the ones worth paying for, and
# the lifecycle rule below is what bounds the bill.
resource "google_storage_bucket" "observability_logs" {
  count                       = local.observability_enabled ? 1 : 0
  project                     = var.project_id
  name                        = local.observability_log_bucket
  location                    = var.region
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  storage_class               = "STANDARD"

  lifecycle_rule {
    condition {
      age = var.observability_log_retention_days
    }
    action {
      type = "Delete"
    }
  }
}

# `writer_identity` is output-only on google_logging_project_sink: a project sink
# writes as the Google-managed Logging service agent, named here the way
# locals.tf names the Pub/Sub agent. This grant — objectCreator on this one
# bucket, nothing else — is therefore the whole sink IAM this root can express.
resource "google_storage_bucket_iam_member" "observability_logs_writer" {
  count  = local.observability_enabled ? 1 : 0
  bucket = google_storage_bucket.observability_logs[0].name
  role   = "roles/storage.objectCreator"
  member = local.observability_log_writer
}

resource "google_logging_project_sink" "observability" {
  for_each = local.observability_sinks

  project     = var.project_id
  name        = each.key
  destination = "storage.googleapis.com/${local.observability_log_bucket}"
  filter      = each.value.filter

  depends_on = [
    google_storage_bucket.observability_logs,
    google_storage_bucket_iam_member.observability_logs_writer,
    google_project_service.observability_apis,
  ]
}

resource "google_logging_metric" "observability" {
  for_each = local.observability_metrics

  project     = var.project_id
  name        = each.key
  filter      = each.value.filter
  description = each.value.description

  metric_descriptor {
    # Counter, not distribution: see the latency-histogram note in the header.
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }

  depends_on = [google_project_service.observability_apis]
}

resource "google_monitoring_alert_policy" "observability" {
  for_each = local.observability_alerts

  project               = var.project_id
  display_name          = "AI Fleet: ${each.key}"
  combiner              = "OR"
  notification_channels = var.observability_notification_channels

  conditions {
    display_name = each.key

    condition_threshold {
      # No resource.type clause: the same decision can be logged from a revision
      # or a job, and pinning the wrong one makes a metric read permanently zero.
      filter          = "metric.type=\"logging.googleapis.com/user/${each.value.metric}\""
      comparison      = "COMPARISON_GT"
      threshold_value = each.value.above
      duration        = "${each.value.window_s}s"

      aggregations {
        alignment_period   = "${each.value.window_s}s"
        per_series_aligner = "ALIGN_SUM"
      }

      # No missing-data setting: a log-based metric writes NOTHING for an interval
      # with no matching entry, and an absent sample cannot satisfy COMPARISON_GT,
      # so a quiet system stays quiet. The failure mode that buys is the opposite
      # one — an emitter that stopped logging looks identical to a healthy system
      # from here, which is why the sinks (a bucket that stops growing is visible)
      # and LOG_FORMAT matter more than any threshold in this file.
    }
  }

  documentation {
    content = "${each.value.why}\n\nMetric: logging.googleapis.com/user/${each.value.metric}\nFilter: ${google_logging_metric.observability[each.value.metric].filter}\nOriginal logs: gs://${local.observability_log_bucket} (and Cloud Logging, resource.type cloud_run_*)."
  }

  # Event counters: gaps in the time series mean a crossing may never be followed
  # by a zero sample, so without this the policy stays OPEN after a resolved
  # incident and trains whoever reads it to ignore the channel.
  alert_strategy {
    auto_close = "${each.value.window_s * 6}s"
  }

  depends_on = [google_logging_metric.observability]
}
