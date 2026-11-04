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

  timeouts {
    create = "30m"
    delete = "30m"
  }

  lifecycle {
    ignore_changes = [fields]
  }

  depends_on = [google_firestore_database.default]
}

# Vector search composite index for chat-attachment RAG retrieval
# (packages/shared-core/src/attachments/store.js: searchAttachmentChunks).
# COLLECTION_GROUP scope because chunks live nested under
# organizations/{orgId}/projects/{projectId}/conversations/{conversationId}/
# attachments/{attachmentId}/chunks/{chunkId} — retrieval queries across ALL
# of a conversation's attachments via db.collectionGroup('chunks'). The
# conversationId equality pre-filter MUST be in the same composite index as
# the vector field for Firestore to accept
# .where('conversationId','==',id).findNearest(...); the equality field is
# listed BEFORE the vector field, per Firestore's documented field order for
# pre-filtered vector indexes.
#
# Verified: `terraform validate` against the pinned provider (google 6.50.0,
# versions.tf) accepts this `vector_config`/`flat {}` block. Not yet verified:
# an actual `apply` against real GCP — if the API itself rejects the request
# for any reason, create the index once manually via `gcloud firestore
# indexes composite create` instead (see the docs/GCP_REGION_MIGRATION.md-style
# runbook convention for a similar
# manual step).
resource "google_firestore_index" "attachment_chunks_by_conversation_and_embedding" {
  project     = var.project_id
  database    = google_firestore_database.default.name
  collection  = "chunks"
  query_scope = "COLLECTION_GROUP"

  fields {
    field_path = "conversationId"
    order      = "ASCENDING"
  }
  fields {
    field_path = "embedding"
    vector_config {
      dimension = 768 # matches EMBEDDING_DIMENSION in packages/shared-core/src/attachments/embed.js
      flat {}
    }
  }

  timeouts {
    create = "30m"
    delete = "30m"
  }

  lifecycle {
    ignore_changes = [fields]
  }

  depends_on = [google_firestore_database.default]
}

# Composite index for the Secret Share "My shares" query
# (secrets/app.mjs listShares): equality on ownerUid + range on expiresAt — the
# expiresAt filter is mandated by the read rule in firestore.rules. Two
# where() clauses on different fields are not answerable by single-field
# indexes, so this index is required or the query fails FAILED_PRECONDITION.
resource "google_firestore_index" "secret_shares_by_owner_expiry" {
  project     = var.project_id
  database    = google_firestore_database.default.name
  collection  = "secret_shares"
  query_scope = "COLLECTION"

  fields {
    field_path = "ownerUid"
    order      = "ASCENDING"
  }
  fields {
    field_path = "expiresAt"
    order      = "ASCENDING"
  }

  timeouts {
    create = "30m"
    delete = "30m"
  }

  lifecycle {
    ignore_changes = [fields]
  }

  depends_on = [google_firestore_database.default]
}

# TTL policy on the share expiry timestamp (firestore.rules enforces the same
# deadline on reads). An empty ttl_config block declares the policy on the
# field — the provider computes `state` once the backend activates it, and
# Google's TTL cleaner then purges docs past `expiresAt` automatically. Rules
# refuse expired reads even before the cleaner runs.
resource "google_firestore_field" "secret_shares_expires_at_ttl" {
  provider   = google-beta
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "secret_shares"
  field      = "expiresAt"

  ttl_config {}

  depends_on = [google_firestore_database.default]
}
