# -----------------------------------------------------------------------------
# Artifact Registry — shared Docker repository for all service images.
# -----------------------------------------------------------------------------

resource "google_artifact_registry_repository" "docker" {
  project       = var.project_id
  location      = var.region
  repository_id = var.artifact_repo
  format        = "DOCKER"
  description   = "AI Fleet service images."
  labels        = merge(local.common_labels, { component = "registry" })

  # Delete versions older than 1 day that aren't protected by the keep policy
  # below. KEEP takes precedence when a version matches both policies, so the
  # newest N versions of every image package survive regardless of age, and
  # anything younger than 1 day is never deleted.
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      tag_state  = "ANY"
      older_than = "1d"
    }
  }

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.artifact_retention_count
    }
  }

  depends_on = [google_project_service.services]
}
