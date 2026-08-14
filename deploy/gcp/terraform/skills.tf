# -----------------------------------------------------------------------------
# Versioned agent-skills registry (GCS bucket + gcsfuse mount).
# -----------------------------------------------------------------------------
# The deep-agent skills (packages/shared-core/src/agent/skills/<skill>/SKILL.md) are
# published as VERSIONED bundles by `npm run skills:publish` (locally or through
# the manual GitHub wrapper)
# (objects laid out as `<version>/<skill>/SKILL.md` plus a `skills-manifest.json`).
# The planner + coder Cloud Run services mount it read-only via a gen2 GCS volume
# at /skills and PIN a version with SKILLS_VERSION (see cloud_run.tf), so the
# runtime reads /skills/<version>/<skill>/SKILL.md. Multiple versions coexist, so
# an older pinned deployment keeps working while a new version is published.
#
# Terraform CREATES and OWNS this bucket — it is NOT assumed to pre-exist. The
# name defaults to a stable derived value (local.skills_bucket_name =
# "<project_id>-aifleet-skills"; override with var.skills_bucket_name). The whole
# feature is toggled by var.skills_enabled: false → no bucket, no mount, no
# SKILLS_ROOT env, so local/dev and a project with it off fall back to the
# vendored skills baked into the image (packages/shared/src/config.js
# resolveSkillsSrc default).

resource "google_storage_bucket" "skills" {
  count    = var.skills_enabled ? 1 : 0
  project  = var.project_id
  name     = local.skills_bucket_name
  location = var.region
  labels   = merge(local.common_labels, { component = "skills" })

  # Uniform bucket-level access — no per-object ACLs (infra checklist).
  uniform_bucket_level_access = true

  # This registry is internal (read by planner/coder SAs, written by a publisher
  # identity). Enforce no-public-access at the bucket level so an accidental
  # allUsers/allAuthenticatedUsers grant can never expose the skill bundles.
  public_access_prevention = "enforced"

  force_destroy = var.skills_bucket_force_destroy

  # Object versioning keeps a prior generation if an object is ever overwritten
  # in place — a safety net; the primary "coexist" story is separate `<version>/`
  # prefixes, so a pinned bundle is never mutated by publishing a newer version.
  versioning {
    enabled = true
  }

  depends_on = [google_project_service.services]
}

# --- Read-only access for the planner + coder service accounts ----------------
# coder-sa is shared by coder-control AND the coder-worker Job, so this single
# grant covers the worker that actually installs the skills.
resource "google_storage_bucket_iam_member" "planner_skills_read" {
  count  = var.skills_enabled ? 1 : 0
  bucket = google_storage_bucket.skills[0].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.planner.email}"
}

resource "google_storage_bucket_iam_member" "coder_skills_read" {
  count  = var.skills_enabled ? 1 : 0
  bucket = google_storage_bucket.skills[0].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.coder.email}"
}

# --- Optional publisher -------------------------------------------------------
# Local publishing uses ambient gcloud credentials; the manual wrapper uses the
# WIF deployer SA. Grant a dedicated publisher here ONLY when its member string
# is provided. objectAdmin (not admin) — write objects, never change bucket IAM.
resource "google_storage_bucket_iam_member" "skills_publisher" {
  count  = var.skills_enabled && var.skills_publisher_member != "" ? 1 : 0
  bucket = google_storage_bucket.skills[0].name
  role   = "roles/storage.objectAdmin"
  member = var.skills_publisher_member
}
