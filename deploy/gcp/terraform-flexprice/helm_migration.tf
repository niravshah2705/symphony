# ---------------------------------------------------------------------------
# Release 2 of 3 — migrations and the Temporal namespace.
#
# This release renders NOTHING that stores data. `local.flexprice_stores_elsewhere`
# switches every infrastructure component to its "someone else runs this" shape,
# which makes templates/infra/*.yaml render nothing at all, so the whole object
# set is: the `-migration` ServiceAccount (templates/jobs/migration-prereqs.yaml
# creates it for the Job to run as, and with `asHook = false` it carries no hook
# annotation at all, so it is an ordinary owned resource rather than something a
# failed upgrade deletes) and the migration Job itself. The app ServiceAccount is
# release 1's and belongs to no object here.
#
# Only THIS release sets `temporalConfig.bootstrapNamespaces`. That is what keeps
# the bootstrap Job's name (`<fullname>-temporal-bootstrap`, unhashed) owned by
# one release — the app release renders zero of it because the gate is
# `len(bootstrapNamespaces) > 0`. It is a post-install/post-upgrade HOOK (unlike
# the migration Job, which `asHook = false` makes an ordinary release resource),
# so it is not in the release manifest and Terraform will never diff it: what
# makes it converge is `wait_for_jobs` below.
#
# Which is the point. The migration Job's init containers wait on
# `flexprice-postgres:5432` and friends, and those Services exist because release 1
# created them — the dependency below is the reason this split exists at all, and
# it is the cold-cluster deadlock that scripts/flexprice-helm.js breaks by
# re-installing one release four times.
#
# The Temporal namespace registration lives HERE rather than in the app release
# for the same ordering reason: the worker's first act is
# `describe temporal schedule "credit-grants-processing"`, and against a missing
# namespace that is a crashloop whose message points at Temporal schedules rather
# than at a bootstrap Job that never ran. `wait = true` makes this release block on
# the post-install hook, so by the time release 3 starts the namespace exists.
# ---------------------------------------------------------------------------

resource "helm_release" "flexprice_migration" {
  count = var.flexprice_enabled ? 1 : 0

  name       = "flexprice-migration"
  repository = "oci://${var.region}-docker.pkg.dev/${var.project_id}/${var.chart_repo}"
  chart      = "flexprice"
  version    = var.chart_version
  namespace  = var.namespace

  create_namespace = false
  atomic           = true
  # A migration that fails must leave no half-configured release behind: the next
  # apply re-runs it from the top, which is safe because every step is
  # IF NOT EXISTS / ON CONFLICT DO NOTHING at this commit.
  cleanup_on_fail = true
  wait            = true
  # `wait` alone is `--wait`, which does NOT consider a Job terminal state as
  # ready; `--wait-for-jobs` is a separate flag and this release is nothing but
  # Jobs. Without it the apply reports success the moment the pods start, release
  # 3 rolls out against a schema that is still migrating, and the namespace
  # bootstrap hook has not necessarily finished — which is the crashloop the
  # README names.
  wait_for_jobs = true
  # Paired with the Job's own activeDeadlineSeconds below, and larger than the
  # infra release's: 241 versioned migrations on a cold database is the slowest
  # thing in this stack.
  timeout      = 1800
  force_update = false
  max_history  = 5

  values = [
    file("${path.module}/values/base.yaml"),
    yamlencode(merge(
      local.flexprice_stores_elsewhere,
      {
        image = local.flexprice_image_ref

        migration = {
          enabled = true
          asHook  = false
          # The Job is the release. `--wait` blocks until a Job completes, so a
          # failed migration fails the apply rather than leaving a Running-looking
          # pod set over an unmigrated schema.
          activeDeadlineSeconds = 1800
          images = {
            postgres   = { registry = local.flexprice_migration_registry }
            busybox    = { registry = local.flexprice_migration_registry }
            clickhouse = { registry = local.flexprice_migration_registry }
          }
        }

        # The chart's own bootstrap Job, aimed at the Service extras.tf created.
        # This is the declarative answer to the script's foreground
        # `registerTemporalNamespace()`, and it is only correct because the
        # address above is not the chart default `temporal-service:7233`.
        # Idempotent by construction: `operator namespace create` output matching
        # "already exists" is filtered and the Job exits 0 either way.
        temporalConfig = merge(local.flexprice_stores_elsewhere.temporalConfig, {
          bootstrapNamespaces = [{
            name        = "default"
            retention   = "72h"
            description = "Default Temporal namespace for Software Factory billing."
          }]
        })
      },
      local.flexprice_placement,
    ))
  ]

  depends_on = [
    helm_release.flexprice_infra,
    kubectl_manifest.flexprice_db_init,
    kubectl_manifest.flexprice_temporal,
  ]
}
