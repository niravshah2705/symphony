# -----------------------------------------------------------------------------
# Firestore — the shared state backend (STORE_BACKEND=firestore) and the SSE
# event relay (EVENTS_BACKEND=firestore, via onSnapshot).
# -----------------------------------------------------------------------------
# Native mode is required for the document/collection model the store uses. A
# project has exactly one Firestore database; this creates the "(default)" one.

# NOTE: location_id is IMMUTABLE. When moving the stack to another region (e.g.
# India), the database does NOT move with it — see docs/GCP_REGION_MIGRATION.md
# for the export→import (or recreate) runbook. var.firestore_location stays nam5
# by default so `terraform apply` never attempts an (impossible) in-place move.
resource "google_firestore_database" "default" {
  project     = var.project_id
  name        = "(default)"
  location_id = var.firestore_location
  type        = "FIRESTORE_NATIVE"

  # Guard against accidental data loss on destroy — flip to DELETE only when you
  # deliberately want `terraform destroy` to remove the database.
  deletion_policy = "ABANDON"

  depends_on = [google_project_service.services]
}

# Composite index for the org-service "list users in org" query, which filters
# `org_id ==` and orders by `created_at DESC` (services/org: user_repo.list_in_org
# → repositories/base.paginate). Firestore requires a composite index for an
# equality filter combined with an order-by on a different field; without it the
# query raises FAILED_PRECONDITION and the endpoint returns 500 (GET /api/org/users).
# Single-field indexes (used by count and the subcollection lists) are automatic.
resource "google_firestore_index" "org_users_by_created_at" {
  project     = var.project_id
  database    = google_firestore_database.default.name
  collection  = "users"
  query_scope = "COLLECTION"

  fields {
    field_path = "org_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "created_at"
    order      = "DESCENDING"
  }

  depends_on = [google_firestore_database.default]
}
