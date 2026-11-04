# -----------------------------------------------------------------------------
# Laya checkpoint registry (GCS bucket + read-only gcsfuse mount).
# -----------------------------------------------------------------------------
# The pip `laya[serve]` inference image (deploy/gcp/Dockerfile.laya-inference)
# serves fully OFFLINE: it never downloads weights at runtime. The Hugging Face
# hub cache for the served checkpoints (convaiinnovations/laya,
# laya-multilingual, laya-typed-decisions) is pre-downloaded by
# .github/workflows/publish-laya-models.yml into VERSIONED prefixes of this
# bucket (`<version>/models--convaiinnovations--laya/...`, symlink-dereferenced
# so gcsfuse serves plain files) plus a `laya-models-manifest.json`.
# The laya-inference Cloud Run service mounts it read-only at /models and pins
# a version via HF_HUB_CACHE=/models/<laya_model_version> (see laya_inference.tf),
# so publishing a new version never disturbs an older pinned deployment —
# versions coexist and rollout is a separate `terraform apply` that bumps the
# pin. Same story as the skills registry (skills.tf).
#
# Terraform CREATES and OWNS this bucket — it is NOT assumed to pre-exist. The
# name defaults to a stable derived value (local.laya_models_bucket_name =
# "<project_id>-aifleet-laya-models"; override with var.laya_models_bucket_name).
# var.laya_models_enabled=false removes the bucket AND the mount; the service
# then fails closed on the first model load (there is no vendored fallback for
# laya[serve]) — only flip it off when the laya service is not deployed.

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
