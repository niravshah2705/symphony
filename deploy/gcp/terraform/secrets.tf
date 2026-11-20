# -----------------------------------------------------------------------------
# Secret Manager — secret CONTAINERS only.
# -----------------------------------------------------------------------------
# Secret VALUES are added out-of-band (never in Terraform state / source):
#   printf %s "<value>" | gcloud secrets versions add <secret-id> --data-file=-
#
# PREREQUISITE: `stream-token-secret` MUST have an enabled version before
# Terraform creates the standalone stream-token broker revision.

resource "google_secret_manager_secret" "stream_token_secret" {
  project   = var.project_id
  secret_id = "stream-token-secret"
  labels    = merge(local.common_labels, { component = "stream-token-broker" })

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

# --- Guest preview broker shared secret ---------------------------------------
# The gateway presents this value and the broker compares it in constant time.
# It is deliberately NOT stream-token-secret and NOT the platform-wide
# INTERNAL_API_TOKEN: that token opens the org and settings services, so
# reusing it here would put a fifth copy of a credential in a workload whose
# only privilege is writing preview paths on one hosting site.
#
# PREREQUISITE: `guest-deployer-internal-token` MUST have an enabled version
# before the broker revision is created — the service fails closed without it
# (`services/guest-deployer/src/deploy-config.js` requires >= 16 characters),
# and Cloud Run will not start a container whose secret has no version.
resource "google_secret_manager_secret" "guest_deployer_internal_token" {
  count = var.guest_deployer_enabled ? 1 : 0

  project   = var.project_id
  secret_id = "guest-deployer-internal-token"
  labels    = merge(local.common_labels, { component = "guest-deployer" })

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

# Extra managed-provider secrets are created empty and consumed only through
# the settings-service resolver; application containers never receive them.
resource "google_secret_manager_secret" "extra" {
  for_each = toset(var.extra_secret_ids)

  project   = var.project_id
  secret_id = each.value
  labels    = merge(local.common_labels, { component = "shared" })

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}
