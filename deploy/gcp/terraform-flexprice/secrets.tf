# -----------------------------------------------------------------------------
# Secret Manager — five containers, zero values, zero versions.
#
# Same rule as ../terraform-substrate-gke/agentgateway.tf and the root's
# secrets.tf: Terraform renders Secret *names* only. Whatever has `container.admin`
# can read state, and state that contains a database password is a leak with a
# plan-approval workflow attached to it. The values are written by the CI job
# (which holds the versions-grant below) and are then mirrored into the
# Kubernetes Secret `flexprice-secrets` by `kubectl apply` — never by Helm, since
# `secrets.existingSecret` is what makes templates/app/secret.yaml render nothing.
#
# Nothing in the FlexPrice stack reads Secret Manager at runtime. The pods read
# the Kubernetes Secret; the chart resolves every sensitive key through
# `secretEnv` (see values/base.yaml), which emits a secretKeyRef rather than a
# value. So these five grants are a CI-to-SM path and nothing else — there is no
# workload identity to hand out.
# -----------------------------------------------------------------------------

locals {
  # The key names inside the Kubernetes Secret are the chart's contract, not
  # ours: templates/infra/*.yaml reference `postgres-password` and
  # `clickhouse-password` literally, and `secretEnv` maps the remaining three.
  # These are Secret Manager ids, one per key — `flexprice-` + the key name, so
  # the mirror step in CI can read the id off the key it is filling and a
  # rotation touches one object.
  flexprice_secret_ids = {
    postgres-password   = "flexprice-postgres-password"
    clickhouse-password = "flexprice-clickhouse-password"
    auth-secret         = "flexprice-auth-secret"
    encryption-key      = "flexprice-encryption-key"
    api-key-keys        = "flexprice-api-key-keys"
  }
}

resource "google_secret_manager_secret" "flexprice" {
  for_each = var.flexprice_enabled ? local.flexprice_secret_ids : {}

  project   = var.project_id
  secret_id = each.value
  labels    = merge(local.common_labels, { component = "flexprice" })

  replication {
    auto {}
  }
}

# Writer: the CI identity that seeds and rotates values. `secretVersionAdd` is
# not bindable at secret scope (the fine-grained version roles only attach to a
# version, which does not exist yet — the same wall substrate_token.tf records),
# so secretVersionManager is the smallest role Secret Manager accepts. It also
# grants versions.access, which the job needs to read the value back when it
# mirrors it into the Kubernetes Secret.
resource "google_secret_manager_secret_iam_member" "flexprice_ci_writer" {
  for_each = var.flexprice_enabled ? google_secret_manager_secret.flexprice : {}

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretVersionManager"
  # Spelled from project_id rather than read through a data source: gh-deployer
  # is created by deploy/gcp/bootstrap.sh, outside this state.
  member = "serviceAccount:gh-deployer@${var.project_id}.iam.gserviceaccount.com"
}
