# -----------------------------------------------------------------------------
# Secret Manager — secret CONTAINERS only.
# -----------------------------------------------------------------------------
# Secret VALUES are added out-of-band (never in Terraform state / source):
#   printf %s "<value>" | gcloud secrets versions add <secret-id> --data-file=-
#
# PREREQUISITE: `stream-token-secret` MUST have an enabled version before
# Terraform creates the gateway's proxy-sidecar revision.

resource "google_secret_manager_secret" "stream_token_secret" {
  project   = var.project_id
  secret_id = "stream-token-secret"
  labels    = merge(local.common_labels, { component = "gateway" })

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
