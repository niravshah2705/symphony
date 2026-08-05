# -----------------------------------------------------------------------------
# Secret Manager — secret CONTAINERS only.
# -----------------------------------------------------------------------------
# Secret VALUES are added out-of-band (never in Terraform state / source):
#   printf %s "<value>" | gcloud secrets versions add <secret-id> --data-file=-
#
# PREREQUISITE: the two secrets mounted as required env — `stream-token-secret`
# and `linear-api-key` — MUST have an enabled version BEFORE `terraform apply`
# creates the Cloud Run revisions, otherwise the revisions fail to start. Add a
# version for any secret in var.extra_secret_ids before you mount it too.

resource "google_secret_manager_secret" "stream_token_secret" {
  project   = var.project_id
  secret_id = "stream-token-secret"
  labels    = var.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret" "linear_api_key" {
  project   = var.project_id
  secret_id = "linear-api-key"
  labels    = var.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

# Extra secrets (provider OAuth, LangSmith, GitHub token, …). Created empty;
# planner-sa + coder-sa are granted accessor in iam.tf so they can be mounted
# once a version exists.
resource "google_secret_manager_secret" "extra" {
  for_each = toset(var.extra_secret_ids)

  project   = var.project_id
  secret_id = each.value
  labels    = var.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}
