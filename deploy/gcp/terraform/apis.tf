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

# Guest preview APIs — enabled in the DEDICATED guest project, not here. The
# app project's firebasehosting.googleapis.com above is what serves the SPA;
# the broker writes a different project's site, so that project needs Firebase
# itself (google_firebase_project.guest) plus the Hosting API before a version
# can be created. Gated with the broker for the same reason enabling an API is
# gated with observability: it is a project-wide side effect, and here it is a
# side effect on a project this stack otherwise does not touch. The project must
# be named: an empty id here would plan against whatever default application
# credentials resolve to, which is the app project. guest_deployer_service.tf's
# precondition is what actually refuses the plan.
locals {
  guest_firebase_apis = (var.guest_deployer_enabled && trimspace(var.guest_firebase_project) != "") ? [
    "firebase.googleapis.com",
    "firebasehosting.googleapis.com",
  ] : []
}

resource "google_project_service" "guest_firebase_apis" {
  for_each = toset(local.guest_firebase_apis)

  project            = var.guest_firebase_project
  service            = each.value
  disable_on_destroy = false
}
