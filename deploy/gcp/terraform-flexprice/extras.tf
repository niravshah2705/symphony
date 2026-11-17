# ---------------------------------------------------------------------------
# The two objects the chart cannot render, as Terraform manifests.
#
# These are not a preference for hand-written YAML. Each one replaces a specific
# gap, and each gap is quoted from the upstream template that has it:
#
#   * Nothing in the chart creates the `temporal` DATABASE.
#     templates/infra/temporal.yaml's server expects it to exist already, and
#     temporalio/auto-setup creates SCHEMAS but not the DATABASE — so without this
#     the server CrashLoops on "database does not exist" while Postgres itself
#     reports healthy. In the compose stack a mounted
#     migrations/postgres/init-temporal-db.sh did it, which is a mechanism only the
#     official Postgres image's ENTRYPOINT has and the chart's hand-rolled
#     postgres.yaml mounts nothing.
#   * templates/infra/temporal.yaml renders a server only when BOTH
#     `temporalConfig.external.enabled` and `temporalConfig.enabled` are false. The
#     install needs `external.enabled=true` (that is the only switch that makes the
#     infra templates render nothing, which is what three releases in one namespace
#     requires), so the chart's server is off by construction. Its Service is
#     `<fullname>-temporal` anyway, not the `<fullname>-temporal-frontend:7233` the
#     `flexprice.temporalAddress` helper emits and the `env` block names.
#
# Everything else in this stack is the chart's. If upstream ever gains values keys
# for these two, the answer is to delete this file, not to keep a parallel copy.
# ---------------------------------------------------------------------------

locals {
  # The same client as the server it talks to: `psql` and `createdb` only, no
  # PGDATA, no writes to disk. Mirrors postgres.internal.image so there is one
  # Postgres image in the cluster rather than two.
  db_init_image = "${local.flexprice_infra_registry}postgres:15.3"

  temporal_image = "${local.flexprice_infra_registry}temporalio/auto-setup:1.26.2"

  # Held as a list so the Job's name can hash it (see below).
  db_init_script = [
    "set -e",
    "until pg_isready -h \"$PGHOST\" -p \"$PGPORT\" -U \"$PGUSER\" -d \"$PGDATABASE\"; do",
    "  echo \"waiting for postgres at $PGHOST:$PGPORT\"",
    "  sleep 2",
    "done",
    "if psql -Atc \"SELECT 1 FROM pg_database WHERE datname='temporal'\" | grep -q '^1$'; then",
    "  echo \"database temporal already exists\"",
    "else",
    "  createdb --host=\"$PGHOST\" --username=\"$PGUSER\" temporal",
    "  echo \"created database temporal\"",
    "fi",
    "# auto-setup connects as PGUSER and must own its schema. The cluster role",
    "# here is a superuser (initdb ran with POSTGRES_USER=flexprice), so the",
    "# grant the compose script gives is already implied — assert it anyway,",
    "# because a non-superuser Postgres elsewhere would need it.",
    "psql -Atc 'GRANT ALL PRIVILEGES ON DATABASE temporal TO flexprice' >/dev/null",
    "echo \"db-init complete\"",
  ]

  # A finished Job's pod template is immutable: `kubectl apply` refuses the
  # update, and kubectl_manifest has no force field to ask for a recreate. So
  # the image and the script are hashed into the NAME, which is what the chart
  # itself does to its migration Job — a change is a new object, not a patch,
  # and `ttlSecondsAfterFinished` clears the completed one.
  db_init_hash = substr(sha256("${local.db_init_image}\n${join("\n", local.db_init_script)}"), 0, 8)
}

resource "kubectl_manifest" "flexprice_db_init" {
  count = var.flexprice_enabled ? 1 : 0

  # Waits for the Job to report Complete, so the Temporal Deployment below is
  # created against a database that exists rather than one that is about to.
  wait = true

  yaml_body = yamlencode({
    apiVersion = "batch/v1"
    kind       = "Job"
    metadata = {
      name      = "flexprice-db-init-${local.db_init_hash}"
      namespace = var.namespace
      labels = merge(local.common_labels, {
        "app.kubernetes.io/name"    = "flexprice-db-init"
        "app.kubernetes.io/part-of" = "flexprice"
        "fleet.dev/component"       = "billing"
      })
    }
    spec = {
      backoffLimit            = 10
      ttlSecondsAfterFinished = 3600
      template = {
        metadata = {
          labels = {
            "app.kubernetes.io/name"    = "flexprice-db-init"
            "app.kubernetes.io/part-of" = "flexprice"
          }
        }
        spec = {
          restartPolicy = "Never"
          nodeSelector  = local.flexprice_placement.nodeSelector
          tolerations   = local.flexprice_placement.tolerations
          # Only psql runs here, against a TCP host. The chart's own pod defaults
          # (uid 1000, read-only rootfs) are therefore honoured rather than
          # relaxed, which keeps this pod inside the namespace's `restricted`
          # audit signal.
          securityContext = {
            runAsNonRoot   = true
            runAsUser      = 1000
            fsGroup        = 1000
            seccompProfile = { type = "RuntimeDefault" }
          }
          containers = [{
            name    = "db-init"
            image   = local.db_init_image
            command = ["/bin/sh", "-c"]
            args    = [join("\n", local.db_init_script)]
            env = [
              { name = "PGHOST", value = "flexprice-postgres" },
              { name = "PGPORT", value = "5432" },
              { name = "PGUSER", value = "flexprice" },
              { name = "PGDATABASE", value = "flexprice" },
              {
                name = "PGPASSWORD"
                valueFrom = {
                  secretKeyRef = {
                    name = "flexprice-secrets"
                    key  = "postgres-password"
                  }
                }
              },
            ]
            resources = {
              requests = { cpu = "50m", memory = "64Mi" }
              limits   = { cpu = "200m", memory = "128Mi" }
            }
            securityContext = {
              allowPrivilegeEscalation = false
              readOnlyRootFilesystem   = true
              capabilities             = { drop = ["ALL"] }
            }
          }]
        }
      }
    }
  })

  depends_on = [
    helm_release.flexprice_infra,
    kubernetes_namespace_v1.flexprice,
  ]
}

# ---------------------------------------------------------------------------
# Temporal: the Deployment the chart refuses to render, plus the Service named
# the way the chart's own helper names it.
#
# The Service name is not cosmetic. `include "flexprice.temporalAddress"` is what
# anything still resolving the address the old way produces, so a Service with a
# DIFFERENT name is a dangling endpoint that only the values file's literal hides.
# ---------------------------------------------------------------------------

resource "kubectl_manifest" "flexprice_temporal_service" {
  count = var.flexprice_enabled ? 1 : 0

  yaml_body = yamlencode({
    apiVersion = "v1"
    kind       = "Service"
    metadata = {
      name      = "flexprice-temporal-frontend"
      namespace = var.namespace
      labels = merge(local.common_labels, {
        "app.kubernetes.io/name"      = "flexprice-temporal"
        "app.kubernetes.io/component" = "temporal-frontend"
        "app.kubernetes.io/part-of"   = "flexprice"
      })
    }
    spec = {
      type     = "ClusterIP"
      selector = { "app.kubernetes.io/name" = "flexprice-temporal" }
      ports = [{
        name       = "frontend-rpc"
        port       = 7233
        targetPort = 7233
        protocol   = "TCP"
      }]
    }
  })

  depends_on = [kubernetes_namespace_v1.flexprice]
}

resource "kubectl_manifest" "flexprice_temporal" {
  count = var.flexprice_enabled ? 1 : 0

  # The auto-setup entrypoint writes its rendered config into /etc/temporal and
  # chowns /var/temporal, which a read-only rootfs under a non-root uid refuses.
  # This is the one pod in the stack that needs the relaxation, and it is
  # upstream's own third-party requirement rather than a FlexPrice one — their kind
  # values file relaxes the same pod the same way. The FlexPrice containers keep
  # the chart's non-root, read-only defaults. Hence `baseline` on the namespace
  # (namespaces.tf) and not `restricted`.
  yaml_body = yamlencode({
    apiVersion = "apps/v1"
    kind       = "Deployment"
    metadata = {
      name      = "flexprice-temporal"
      namespace = var.namespace
      labels = merge(local.common_labels, {
        "app.kubernetes.io/name"      = "flexprice-temporal"
        "app.kubernetes.io/component" = "temporal"
        "app.kubernetes.io/part-of"   = "flexprice"
      })
    }
    spec = {
      # Recreate, not RollingUpdate: every auto-setup pod runs the schema-setup
      # step at entrypoint, so a rollout that briefly overlaps two of them has two
      # processes applying versioned schemas to the same database simultaneously.
      strategy = { type = "Recreate" }
      replicas = 1
      selector = {
        matchLabels = { "app.kubernetes.io/name" = "flexprice-temporal" }
      }
      template = {
        metadata = {
          labels = {
            "app.kubernetes.io/name"      = "flexprice-temporal"
            "app.kubernetes.io/component" = "temporal"
          }
        }
        spec = {
          nodeSelector = local.flexprice_placement.nodeSelector
          tolerations  = local.flexprice_placement.tolerations
          securityContext = {
            runAsNonRoot = false
            runAsUser    = 0
          }
          containers = [{
            name            = "temporal"
            image           = local.temporal_image
            imagePullPolicy = "IfNotPresent"
            ports = [
              { name = "frontend-rpc", containerPort = 7233 },
              { name = "membership", containerPort = 7234 },
              { name = "internal-rpc", containerPort = 7235 },
              { name = "metrics", containerPort = 7239 },
            ]
            env = concat([
              { name = "DB", value = "postgres12" },
              { name = "DB_HOST", value = "flexprice-postgres" },
              { name = "DB_PORT", value = "5432" },
              { name = "DB_NAME", value = "temporal" },
              { name = "DB_USER", value = "flexprice" },
              {
                name = "DB_PWD"
                valueFrom = {
                  secretKeyRef = { name = "flexprice-secrets", key = "postgres-password" }
                }
              },
              { name = "POSTGRES_SEEDS", value = "flexprice-postgres" },
              { name = "POSTGRES_USER", value = "flexprice" },
              {
                name = "POSTGRES_PWD"
                valueFrom = {
                  secretKeyRef = { name = "flexprice-secrets", key = "postgres-password" }
                }
              },
              { name = "ENABLE_ES", value = "false" },
              # Absolute schema dirs. Without them the setup step resolves the
              # schema relative to the working directory and fails on a path that
              # exists only in a mounted checkout — which this design does not
              # mount. The chart's own hand-rolled server emits neither of these
              # vars; this is one of the two reasons that template is not the
              # server this stack runs.
              { name = "TEMPORAL_PERSISTENCE_SCHEMA_DIR", value = "/etc/temporal/schema/postgresql/v96/temporal/versioned" },
              { name = "VISIBILITY_SCHEMA_DIR", value = "/etc/temporal/schema/postgresql/v96/visibility/versioned" },
              # Fail fast rather than hang a rollout: the database exists by the
              # time this pod is created, because the db-init Job above is waited
              # on first.
              { name = "DB_CONNECT_RETRIES", value = "10" },
            ])
            resources = {
              requests = { cpu = "100m", memory = "256Mi" }
              limits   = { cpu = "500m", memory = "512Mi" }
            }
            readinessProbe = {
              tcpSocket           = { port = "frontend-rpc" }
              initialDelaySeconds = 20
              periodSeconds       = 5
              timeoutSeconds      = 3
              # Schema setup runs first and takes 15-30s on a cold database; a
              # shorter window just makes the pod flap.
              failureThreshold = 12
            }
            livenessProbe = {
              tcpSocket           = { port = "frontend-rpc" }
              initialDelaySeconds = 90
              periodSeconds       = 10
              timeoutSeconds      = 5
              failureThreshold    = 6
            }
          }]
        }
      }
    }
  })

  depends_on = [
    kubectl_manifest.flexprice_temporal_service,
    kubectl_manifest.flexprice_db_init,
    helm_release.flexprice_infra,
  ]
}
