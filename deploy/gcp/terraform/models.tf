# -----------------------------------------------------------------------------
# Model weights registry (GCS bucket + gcsfuse mount) — Ollama/vLLM inference demo.
# -----------------------------------------------------------------------------
# Model weights (Ollama pulls + HuggingFace checkpoints) are published as
# VERSIONED bundles to this bucket by .github/workflows/publish-models.yml
# (objects laid out as `ollama/<version>/...` and `vllm/<version>/<model>/...`
# per deploy/models/manifest.json). The inference-ollama / inference-vllm Cloud
# Run services (inference.tf) mount it read-only via a gen2 GCS volume at
# /models and PIN a version per engine (see inference.tf), so multiple
# versions coexist and an older pinned deployment keeps working while a new
# version is published. Mirrors skills.tf's registry pattern.
#
# THIS IS A STANDALONE DEMO — this bucket/mount is consumed only by
# inference-ollama/inference-vllm (inference.tf). It is NOT wired into the
# egress proxy or any agent runtime; see inference.tf's header comment.
#
# Terraform CREATES and OWNS this bucket — it is NOT assumed to pre-exist. The
# name defaults to a stable derived value (local.models_bucket_name =
# "<project_id>-aifleet-models"; override with var.models_bucket_name). The
# whole feature is toggled by var.models_enabled: false → no bucket, no mount,
# and inference.tf's services fail their enablement precondition if turned on
# without it.

resource "google_storage_bucket" "models" {
  count    = var.models_enabled ? 1 : 0
  project  = var.project_id
  name     = local.models_bucket_name
  location = var.region
  labels   = merge(local.common_labels, { component = "models" })

  # Uniform bucket-level access — no per-object ACLs (infra checklist).
  uniform_bucket_level_access = true

  # Internal registry (read by the inference service accounts, written by the
  # CI publisher). Enforce no-public-access at the bucket level so an
  # accidental allUsers/allAuthenticatedUsers grant can never expose weights.
  public_access_prevention = "enforced"

  force_destroy = var.models_bucket_force_destroy

  # Object versioning keeps a prior generation if an object is ever overwritten
  # in place — the primary "coexist" story is separate `<engine>/<version>/`
  # prefixes (see below), so a pinned bundle is never mutated by a later publish.
  versioning {
    enabled = true
  }

  # Model weights are GB-sized (unlike KB-sized skill bundles), so every
  # published version left around forever is real, ongoing storage cost. Age
  # out noncurrent object generations after 30 days — the CURRENT object in
  # each `<engine>/<version>/` prefix is unaffected; only stale versions
  # created by object versioning above are pruned. Bump var.models_bucket_ttl_days
  # or disable by setting it to 0.
  dynamic "lifecycle_rule" {
    for_each = var.models_bucket_ttl_days > 0 ? [1] : []
    content {
      condition {
        days_since_noncurrent_time = var.models_bucket_ttl_days
      }
      action {
        type = "Delete"
      }
    }
  }

  depends_on = [google_project_service.services]
}

# --- Read-only access for the inference service accounts ----------------------

resource "google_storage_bucket_iam_member" "inference_ollama_models_read" {
  count  = var.models_enabled && var.inference_ollama_enabled ? 1 : 0
  bucket = google_storage_bucket.models[0].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.inference_ollama[0].email}"
}

resource "google_storage_bucket_iam_member" "inference_vllm_models_read" {
  count  = var.models_enabled && var.inference_vllm_enabled ? 1 : 0
  bucket = google_storage_bucket.models[0].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.inference_vllm[0].email}"
}

# --- Optional publisher (CI) --------------------------------------------------
# The publish-models workflow authenticates as the WIF deployer SA and needs
# write access to push new versioned bundles. That SA is a repo-level secret
# (GCP_DEPLOYER_SA), not a Terraform-managed resource, so grant it here ONLY
# when its member string is provided. objectAdmin (not admin) — write objects,
# never change bucket IAM/config.
resource "google_storage_bucket_iam_member" "models_publisher" {
  count  = var.models_enabled && var.models_publisher_member != "" ? 1 : 0
  bucket = google_storage_bucket.models[0].name
  role   = "roles/storage.objectAdmin"
  member = var.models_publisher_member
}
