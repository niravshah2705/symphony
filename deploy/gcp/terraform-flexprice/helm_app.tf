# ---------------------------------------------------------------------------
# Release 3 of 3 — the three application modes.
#
# One image, three Deployments, chosen by FLEXPRICE_DEPLOYMENT_MODE which each
# template hardcodes (api | consumer | temporal_worker): the API takes ingest,
# the consumer is the only Kafka consumer and the only writer of ClickHouse, and
# the worker runs the Temporal workflows. They are not replicas of one service,
# so a single `replicaCount` knob across them would be wrong in a way a values
# diff cannot show.
#
# The applications are last because they are the only part of this stack that can
# be replaced without thought: a bad app release rolls back to the previous
# revision, while a bad infra release moves a database. Keeping them in their own
# release is also what lets a config change to the API never re-render a
# StatefulSet — Helm cannot upgrade an immutable StatefulSet field, and an
# app-only change that dragged one in would fail the apply on
# `field spec.template.spec.containers[0].volumeMounts[0].name is immutable`.
# ---------------------------------------------------------------------------

resource "helm_release" "flexprice_app" {
  count = var.flexprice_enabled ? 1 : 0

  name       = "flexprice-app"
  repository = "oci://${var.region}-docker.pkg.dev/${var.project_id}/${var.chart_repo}"
  chart      = "flexprice"
  version    = var.chart_version
  namespace  = var.namespace

  create_namespace = false
  atomic           = true
  cleanup_on_fail  = true
  wait             = true
  timeout          = 900
  force_update     = false
  max_history      = 5

  values = [
    file("${path.module}/values/base.yaml"),
    yamlencode(merge(
      local.flexprice_stores_elsewhere,
      {
        image = local.flexprice_image_ref

        api = { enabled = true }
        # The consumer is the sole ClickHouse writer and the sole Kafka consumer
        # group member here. Two of them would double-apply events unless Kafka
        # rebalanced the group, so a second replica is a change to the topic
        # partition counts in `env`, not a value edit.
        consumer = { enabled = true }
        worker   = { enabled = true }

        # Migrations belong to release 2. Enabling them here as well would render
        # a second Job with the same name-hash suffix (the suffix hashes the
        # rendered environment plus the image, and the environment is shared) —
        # two releases then own one Job, which is a Helm conflict rather than a
        # migration that runs twice.
        migration = { enabled = false }
      },
      local.flexprice_placement,
    ))
  ]

  depends_on = [
    helm_release.flexprice_infra,
    helm_release.flexprice_migration,
    kubectl_manifest.flexprice_temporal,
  ]
}
