# -----------------------------------------------------------------------------
# GCS bucket for chat attachments (services/planner/src/routes/agent-attachments.js).
# -----------------------------------------------------------------------------
# Holds user-uploaded files (pdf/docx/txt/jpg/png) scoped per
# organizations/{orgId}/projects/{projectId}/conversations/{conversationId}/...
# — tenant content, unlike the SPA/skills buckets, so this one is NEVER public
# and its CORS allowlist is the real app origin, not "*".
#
# Only planner mints signed upload URLs and reads objects back for extraction
# (packages/shared-core/src/attachments/gcs.js) — no other service gets a grant.

resource "google_storage_bucket" "attachments" {
  project  = var.project_id
  name     = local.attachments_bucket_name
  location = var.region
  labels   = merge(local.common_labels, { component = "attachments" })

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced" # tenant file content — never public, unlike gcs_spa.tf's SPA bucket
  force_destroy               = var.attachments_bucket_force_destroy

  cors {
    origin          = [var.spa_origin] # the real app origin — not "*", this bucket holds tenant content
    method          = ["PUT", "GET"]
    response_header = ["*"]
    max_age_seconds = 3600
  }

  depends_on = [google_project_service.services]
}

resource "google_storage_bucket_iam_member" "planner_attachments_readwrite" {
  bucket = google_storage_bucket.attachments.name
  role   = "roles/storage.objectAdmin" # planner both mints upload URLs and reads objects back for extraction
  member = "serviceAccount:${google_service_account.planner.email}"
}

# Signed-URL generation on Cloud Run (no keyfile, ADC only) goes through the IAM
# Credentials API's signBlob, which requires the signing SA to hold
# serviceAccountTokenCreator ON ITSELF — mirrors the coder_actas_self pattern in
# iam.tf. Without this, gcs.js's getSignedUrl() throws at runtime in Cloud Run
# even though it works locally with a keyfile/emulator — a real risk to verify
# in an actual deploy, not just locally.
resource "google_service_account_iam_member" "planner_signblob_self" {
  service_account_id = google_service_account.planner.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.planner.email}"
}
