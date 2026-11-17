# ---------------------------------------------------------------------------
# Release 1 of 3 — the stores.
#
# Why three releases in one namespace instead of one release in three phases,
# which is what scripts/flexprice-helm.js does on kind with `--set` flags:
#
#   * The script's phases are an ORDERING mechanism wearing a values flag. It
#     installs one release four times, each time flipping enablement, because a
#     single install puts the migration Job's pre-install hook ahead of the
#     Postgres Service it waits for and the cold cluster deadlocks (the header of
#     that script records it). Terraform expresses ordering as dependencies,
#     which is what `depends_on` below is for, and then each release's values are
#     STABLE — a values change is an upgrade, not a phase transition.
#   * One release re-rendered with `api.enabled=false` deletes the API Deployment.
#     So the phases cannot share a release without Terraform observing create-
#     then-destroy churn on the object it is trying to converge.
#   * Disjoint object sets make `helm.sh/resource-policy` conflicts impossible.
#     `fullnameOverride: flexprice` keeps every NAME identical to the local stack,
#     and each of the three renders a name exactly once: stores + StorageClass +
#     ServiceAccount here, the migration Job + namespace Job next, the three app
#     Deployments + their Service last.
#
# `atomic = true` + `wait = true` + `cleanup_on_fail = true` are what retire the
# script's `healPendingRelease()`: a release that cannot converge is rolled back
# and removed rather than left at `pending-install` for the next run to discover.
# The cost is honest — a failed apply leaves NOTHING behind to inspect in-cluster,
# so the CI job dumps pod status and events on failure (APPLY.md "Reading a
# failed apply").
# ---------------------------------------------------------------------------

locals {
  # Registry routing. Empty prefix keeps upstream references, which is how this
  # cluster already pulls Envoy Gateway and cert-manager images. Set it once
  # Docker Hub's per-IP anonymous throttling actually bites — see the variable.
  flexprice_infra_registry = var.image_registry_prefix == "" ? "" : "${var.image_registry_prefix}/"

  # The migration Job's three wait-for init containers take an explicit
  # `registry` (values.yaml ships `docker.io` for each), which composes as
  # `<registry>/<repository>:<tag>` — a different shape from the infrastructure
  # images above, hence a separate local rather than the same prefix string.
  flexprice_migration_registry = var.image_registry_prefix == "" ? "docker.io" : var.image_registry_prefix

  # "The stores exist, in another release."
  #
  # Every non-infra release must render zero infrastructure objects, and each
  # component expresses that in its own key: postgres/kafka/redis flip
  # `external.enabled` (the gate on templates/infra/*.yaml) and ClickHouse switches
  # `mode`. Setting them is not enough on its own — the migration Job's wait
  # containers and any helper that still resolves an address read
  # `clickhouse.address`, `kafkaConfig.brokers` and `redisConfig.host` in external
  # mode, and those values.yaml defaults are `kafka-service:9092` /
  # `redis-service`, which exist nowhere. Left inherited, an init container loops
  # `nc -z` against a name that will never resolve and the Job dies on its
  # deadline with the databases sitting Ready. So the addresses are mirrored here
  # as literals, and they are the same literals the `env` block gives the app.
  flexprice_stores_elsewhere = {
    postgres = { external = { enabled = true } }
    clickhouse = {
      mode    = "external"
      address = "flexprice-clickhouse:9000"
    }
    kafkaConfig = {
      external = { enabled = true }
      brokers  = ["flexprice-kafka:9092"]
    }
    redisConfig = {
      external = { enabled = true }
      host     = "flexprice-redis"
      port     = 6379
    }
    # The hand-rolled server is not rendered by any release (extras.tf owns it),
    # and the address stays pointed at the Service extras.tf creates so anything
    # still using `flexprice.temporalAddress` reaches a live frontend.
    temporalConfig = {
      external = { enabled = true }
      address  = "flexprice-temporal-frontend:7233"
    }
  }

  flexprice_image_ref = {
    repository = "${var.region}-docker.pkg.dev/${var.project_id}/${var.image_repo}/flexprice-app"
    tag        = var.image_tag
    digest     = var.image_digest
    # Never `Never`: that is a kind-cluster answer (the script loaded the image
    # into docker's daemon by hand). Every image here is pulled by a node, and a
    # node that cannot pull leaves the pod in ErrImagePull with the reason two
    # layers of YAML away from the registry permission that caused it.
    pullPolicy = "IfNotPresent"
  }

  # Placement. The pool is tainted NO_SCHEDULE, so a pod that does not both
  # select and tolerate it is unschedulable — and the chart reads placement from
  # two different places: `default .Values.nodeSelector .Values.api.nodeSelector`
  # for the app Deployments and the migration Job, but `.Values.clickhouse.standalone
  # .nodeSelector` ONLY for ClickHouse, while postgres/kafka/redis read the global
  # pair through the staged chart's injected block. All three spellings are set,
  # because half a placement story is a Pending pod.
  flexprice_placement = {
    nodeSelector = { "cloud.google.com/gke-nodepool" = var.node_pool_name }
    tolerations = [{
      key      = "fleet.dev/dedicated"
      operator = "Equal"
      value    = "flexprice"
      effect   = "NoSchedule"
    }]
  }
}

resource "helm_release" "flexprice_infra" {
  count = var.flexprice_enabled ? 1 : 0

  name       = "flexprice-infra"
  repository = "oci://${var.region}-docker.pkg.dev/${var.project_id}/${var.chart_repo}"
  chart      = "flexprice"
  version    = var.chart_version
  namespace  = var.namespace

  # This root owns the namespace, its Pod Security labels and its tags; a chart
  # that recreated the object would drop all three on the next upgrade.
  create_namespace = false

  atomic          = true
  cleanup_on_fail = true
  wait            = true
  timeout         = 900
  force_update    = false
  max_history     = 5

  values = [
    file("${path.module}/values/base.yaml"),
    yamlencode(merge({
      image = local.flexprice_image_ref

      # The only release that creates the ServiceAccount; the other two name it
      # without creating it, which `flexprice.serviceAccountName` honours exactly.
      serviceAccount = { create = true },

      # Data protection belongs to the release that owns the volumes. The
      # StorageClass is cluster-scoped: enabling it here and nowhere else is what
      # keeps three releases from each claiming one object.
      dataProtection = {
        retainStorage = true
        storageClass = {
          name        = var.storage_class_name
          provisioner = "pd.csi.storage.gke.io"
          parameters = {
            # pd-ssd, not pd-balanced: these are the databases every request
            # waits on, and the probe timeouts the staged chart widened are
            # measuring the same disk latency that a throughput-bursting
            # balanced disk adds to them.
            type = "pd-ssd"
          }
        }
      }

      postgres = {
        internal = {
          image       = { repository = "${local.flexprice_infra_registry}postgres" }
          persistence = { size = var.postgres_size }
        }
      }
      clickhouse = {
        standalone = {
          # Reads its own placement keys and NOTHING global
          # (templates/infra/clickhouse.yaml), so this one is not inherited.
          image        = { repository = "${local.flexprice_infra_registry}clickhouse/clickhouse-server" }
          persistence  = { size = var.clickhouse_size }
          nodeSelector = local.flexprice_placement.nodeSelector
          tolerations  = local.flexprice_placement.tolerations
        }
      }
      kafkaConfig = {
        internal = {
          image       = { repository = "${local.flexprice_infra_registry}confluentinc/cp-kafka" }
          persistence = { size = var.kafka_size }
        }
      }
      redisConfig = {
        internal = {
          image       = { repository = "${local.flexprice_infra_registry}redis" }
          persistence = { size = var.redis_size }
        }
      }
    }, local.flexprice_placement))
  ]

  depends_on = [
    kubernetes_namespace_v1.flexprice,
    google_artifact_registry_repository.flexprice_chart,
  ]
}
