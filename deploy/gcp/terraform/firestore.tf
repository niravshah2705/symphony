# -----------------------------------------------------------------------------
# Firestore — the shared state backend (STORE_BACKEND=firestore) and the SSE
# event relay (EVENTS_BACKEND=firestore, via onSnapshot).
# -----------------------------------------------------------------------------
# Native mode is required for the document/collection model the store uses. A
# project has exactly one Firestore database; this creates the "(default)" one.

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
