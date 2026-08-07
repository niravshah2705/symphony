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
    "cloudbuild.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "storage.googleapis.com",
    # Firebase — Hosting (SPA), the web app config, and Identity Platform (auth).
    "firebase.googleapis.com",
    "firebasehosting.googleapis.com",
    "identitytoolkit.googleapis.com",
  ]
}

resource "google_project_service" "services" {
  for_each = toset(local.required_apis)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
