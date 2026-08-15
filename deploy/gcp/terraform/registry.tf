# -----------------------------------------------------------------------------
# Harness-native artifact registry (GCS bucket).
# -----------------------------------------------------------------------------
# The weekly "sync harness registry" GitHub Action (.github/workflows/
# sync-harness-registry.yml) reads packages/shared-core/src/agent/registry/
# sources.json, resolves ECC to one immutable commit, builds every supported
# harness with its native installer, and publishes a VERSIONED v2 bundle:
#   gs://<bucket>/<version>/harnesses/<id>/rootfs.tar.gz  ready-to-copy root
#   gs://<bucket>/<version>/harnesses/<id>/artifact.json  verified descriptor
#   gs://<bucket>/<version>/inert/...                       non-ECC resources
#   gs://<bucket>/<version>/registry.json                  index (published last)
#
# This mirrors the skills registry (skills.tf): Terraform CREATES and OWNS the
# bucket. Unlike the skills bucket, the name is a FIXED value from
# var.registry_bucket_name (default "aifleet-registry", NOT derived from
# project_id) — GCS names are globally unique, so override it if taken. The
# whole feature is gated by var.registry_enabled. The planner/coder SAs get
# read-only access so runtime provisioning can select the descriptor for its
# harness; publishing is done by the CI deployer SA.

resource "google_storage_bucket" "registry" {
  count    = var.registry_enabled ? 1 : 0
  project  = var.project_id
  name     = var.registry_bucket_name
  location = var.region
  labels   = merge(local.common_labels, { component = "registry" })

  # Uniform bucket-level access — no per-object ACLs (infra checklist).
  uniform_bucket_level_access = true

  # Internal registry (read by planner/coder SAs, written by the CI deployer).
  # Enforce no-public-access so an accidental allUsers grant can never expose the
  # bundles (they may embed third-party plugin payloads).
  public_access_prevention = "enforced"

  force_destroy = var.registry_bucket_force_destroy

  # Object versioning keeps a prior generation if an object is overwritten in
  # place; the primary "coexist" story is separate `<version>/` prefixes.
  versioning {
    enabled = true
  }

  depends_on = [google_project_service.services]
}

# --- Read-only access for the planner + coder service accounts ----------------
# coder-sa is shared by coder-control AND the coder-worker Job.
resource "google_storage_bucket_iam_member" "planner_registry_read" {
  count  = var.registry_enabled ? 1 : 0
  bucket = google_storage_bucket.registry[0].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.planner.email}"
}

resource "google_storage_bucket_iam_member" "coder_registry_read" {
  count  = var.registry_enabled ? 1 : 0
  bucket = google_storage_bucket.registry[0].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.coder.email}"
}

# --- Optional publisher (CI) --------------------------------------------------
# The sync-harness-registry workflow authenticates as the WIF deployer SA and
# needs write access to push new versioned bundles. That SA is a repo-level
# secret (GCP_DEPLOYER_SA), not Terraform-managed, so grant it here ONLY when its
# member string is provided. objectAdmin (not admin) — write objects, never
# change bucket IAM/config.
resource "google_storage_bucket_iam_member" "registry_publisher" {
  count  = var.registry_enabled && var.registry_publisher_member != "" ? 1 : 0
  bucket = google_storage_bucket.registry[0].name
  role   = "roles/storage.objectAdmin"
  member = var.registry_publisher_member
}
