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

  # Delete every version not protected by the keep policy below. KEEP takes
  # precedence when a version matches both policies, leaving the newest N
  # versions of every image package in the shared repository.
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      tag_state = "ANY"
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
