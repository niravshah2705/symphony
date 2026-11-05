# -----------------------------------------------------------------------------
# Laya checkpoint registry (GCS bucket — publish/backup target).
# -----------------------------------------------------------------------------
# The pip `laya[serve]` inference image (deploy/gcp/Dockerfile.laya-inference)
# serves fully OFFLINE and now BAKES the weights into the image itself:
# gcsfuse streaming made each CPU checkpoint build ~3.5min and preloading
# blocks the port bind, so the service never passed its startup probe
# (revisions 00015-00018). The service no longer mounts this bucket.
#
# This bucket REMAINS managed here as the versioned publish target of
# .github/workflows/publish-laya-models.yml (`<version>/models--…` prefixes +
# laya-models-manifest.json) — an out-of-image record of exactly which
# checkpoint revisions ship per bundle, useful for audit and as a fallback if
# the mount path is ever reintroduced. Same layout as the skills registry
# (skills.tf), minus the runtime mount.
#
# Terraform CREATES and OWNS this bucket — it is NOT assumed to pre-exist. The
# name defaults to a stable derived value (local.laya_models_bucket_name =
# "<project_id>-aifleet-laya-models"; override with var.laya_models_bucket_name).
# var.laya_models_enabled=false removes the bucket (destroying a non-empty
# bucket needs laya_models_bucket_force_destroy=true); the service does NOT
# depend on it at runtime any more.

resource "google_storage_bucket" "laya_models" {
  count    = var.laya_models_enabled ? 1 : 0
  project  = var.project_id
  name     = local.laya_models_bucket_name
  location = var.region
  labels   = merge(local.common_labels, { component = "laya-models" })

  # Uniform bucket-level access — no per-object ACLs (infra checklist).
  uniform_bucket_level_access = true

  # Internal registry: read by the laya-inference SA, written by the CI
  # deployer. Enforce no-public-access so an accidental allUsers grant can
  # never expose model weights.
  public_access_prevention = "enforced"

  force_destroy = var.laya_models_bucket_force_destroy

  # Object versioning is a safety net against in-place overwrites; the primary
  # "coexist" story is separate `<version>/` prefixes.
  versioning {
    enabled = true
  }

  depends_on = [google_project_service.services]
}

# --- Read-only access for the laya inference service account ------------------
# Required for the gen2 GCS volume mount AND for object reads through it.
resource "google_storage_bucket_iam_member" "laya_models_read" {
  count  = var.laya_models_enabled ? 1 : 0
  bucket = google_storage_bucket.laya_models[0].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.laya_inference.email}"
}

# --- Optional publisher (CI) --------------------------------------------------
# The publish-laya-models workflow authenticates as the WIF deployer SA and
# needs write access to push new versioned bundles. That SA is a repo-level
# secret (GCP_DEPLOYER_SA), not a Terraform-managed resource, so grant it here
# ONLY when its member string is provided. objectAdmin (not admin) — write
# objects, never change bucket IAM/config.
resource "google_storage_bucket_iam_member" "laya_models_publisher" {
  count  = var.laya_models_enabled && var.laya_models_publisher_member != "" ? 1 : 0
  bucket = google_storage_bucket.laya_models[0].name
  role   = "roles/storage.objectAdmin"
  member = var.laya_models_publisher_member
}
