# -----------------------------------------------------------------------------
# Enable the required Google Cloud APIs.
# -----------------------------------------------------------------------------
# disable_on_destroy = false so a `terraform destroy` of this stack never turns
# APIs off project-wide (they may back other workloads).

locals {
  required_apis = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "pubsub.googleapis.com",
    "cloudscheduler.googleapis.com",
    "firestore.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudkms.googleapis.com",
    "cloudbuild.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "storage.googleapis.com",
    # Firebase — Hosting (SPA), the web app config, and Identity Platform (auth).
    "firebase.googleapis.com",
    "firebasehosting.googleapis.com",
    "identitytoolkit.googleapis.com",
    # Cloud SQL for PostgreSQL — the agent memory store (memory.tf).
    "sqladmin.googleapis.com",
  ]
}

resource "google_project_service" "services" {
  for_each = toset(local.required_apis)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# Observability APIs, gated with the module (observability.tf). Enabling an API
# is a project-wide side effect that outlives a `terraform destroy` here, so it
# does not happen unless the operator asked for observability.
locals {
  observability_apis = var.observability_enabled ? [
    "logging.googleapis.com",
    "monitoring.googleapis.com",
  ] : []
}

resource "google_project_service" "observability_apis" {
  for_each = toset(local.observability_apis)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
