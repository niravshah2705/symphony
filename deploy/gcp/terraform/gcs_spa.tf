# -----------------------------------------------------------------------------
# GCS bucket hosting the SPA (static frontend).
# -----------------------------------------------------------------------------
# Cloud Build syncs public/ here (with a generated config.js) — see the repo-root
# cloudbuild.yaml. The gateway is API-only in the cloud; the browser loads the
# SPA from this bucket and calls the gateway cross-origin (CORS allowlisted via
# the gateway's SPA_ORIGIN).

resource "google_storage_bucket" "spa" {
  project  = var.project_id
  name     = var.spa_bucket_name
  location = var.region
  labels   = var.labels

  # Uniform bucket-level access — no per-object ACLs (infra checklist).
  uniform_bucket_level_access = true
  force_destroy               = var.spa_bucket_force_destroy

  # SPA client-side routing: serve index.html for the root AND for unknown paths
  # so deep links resolve to the app shell.
  website {
    main_page_suffix = "index.html"
    not_found_page   = "index.html"
  }

  # Allow the browser to fetch static assets cross-origin (defense-in-depth; the
  # real API CORS is enforced by the gateway).
  cors {
    origin          = ["*"]
    method          = ["GET", "HEAD"]
    response_header = ["*"]
    max_age_seconds = 3600
  }

  depends_on = [google_project_service.services]
}

# INTENTIONAL public read: this bucket serves the public SPA, so allUsers get
# objectViewer. This is the ONLY allUsers grant besides the public gateway; the
# internal services and their buckets never get it.
resource "google_storage_bucket_iam_member" "spa_public_read" {
  bucket = google_storage_bucket.spa.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}
