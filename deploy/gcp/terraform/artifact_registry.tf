# -----------------------------------------------------------------------------
# Artifact Registry — Docker repository for the three service images.
# -----------------------------------------------------------------------------

resource "google_artifact_registry_repository" "docker" {
  project       = var.project_id
  location      = var.region
  repository_id = var.artifact_repo
  format        = "DOCKER"
  description   = "AI Fleet service images (gateway, planner, coder)."
  labels        = var.labels

  # Keep storage cost near zero: retain only the most recent images.
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  depends_on = [google_project_service.services]
}
