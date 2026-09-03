# -----------------------------------------------------------------------------
# Agent memory store (claude-mem, harness-agnostic) — GCS bucket + gcsfuse mount.
# -----------------------------------------------------------------------------
# The MemoryMiddleware (packages/shared/src/agent/memory-middleware.js) captures
# + AI-compresses each finished agent run and injects durable memory into future
# ones. Persistence is this bucket, mounted READ-WRITE via gcsfuse at MEMORY_ROOT
# (/memory) on the planner + coder services (see cloud_run.tf), version-pinned by
# MEMORY_VERSION. On-disk layout is write-once-per-memory files, tenant-isolated
# by an org digest, so a single shared bucket keeps tenants separate by path:
#   /memory/<version>/<orgKey>/<scope>/<stamp>__<id>.md   frontmatter + text
#   /memory/<version>/<orgKey>/<scope>/<stamp>__<id>.f32  768×float32 embedding
#
# UNLIKE the read-only skills/registry buckets, the agents WRITE here at runtime,
# so the planner/coder SAs get objectAdmin (not objectViewer) and the volume is
# mounted read_only = false. There is NO CI publisher — nothing pushes bundles.
#
# Terraform CREATES and OWNS the bucket. The name defaults to a derived
# "<project_id>-aifleet-memory" (override with var.memory_bucket_name). The whole
# feature is gated by var.memory_enabled; the gcsfuse MOUNT is a SEPARATE toggle
# (var.memory_mount_enabled, default OFF) because the gen2 fuse mount is fragile
# (same startup-probe caveat as the skills mount). Mount off → MEMORY_ROOT is
# unset and the middleware falls back to the Firestore/file memories store
# (packages/shared/src/agent/memory-store/index.js), or stays dormant if the
# per-org `memoryEnabled` opt-in is off (it is off by default).

resource "google_storage_bucket" "memory" {
  count    = var.memory_enabled ? 1 : 0
  project  = var.project_id
  name     = local.memory_bucket_name
  location = var.region
  labels   = merge(local.common_labels, { component = "memory" })

  # Uniform bucket-level access — no per-object ACLs (infra checklist).
  uniform_bucket_level_access = true

  # Holds compressed agent memories (may reference internal decisions). Enforce
  # no-public-access so an accidental allUsers grant can never expose them.
  public_access_prevention = "enforced"

  force_destroy = var.memory_bucket_force_destroy

  # Object versioning keeps a prior generation if a memory object were ever
  # overwritten in place; writes are write-once so this is only a safety net.
  versioning {
    enabled = true
  }

  depends_on = [google_project_service.services]
}

# --- Read/WRITE access for the planner + coder service accounts ---------------
# coder-sa is shared by coder-control AND the coder-worker Job, so this single
# grant covers the worker that actually persists memories. objectAdmin (not
# admin) — read/write objects, never change bucket IAM/config.
resource "google_storage_bucket_iam_member" "planner_memory_write" {
  count  = var.memory_enabled ? 1 : 0
  bucket = google_storage_bucket.memory[0].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.planner.email}"
}

resource "google_storage_bucket_iam_member" "coder_memory_write" {
  count  = var.memory_enabled ? 1 : 0
  bucket = google_storage_bucket.memory[0].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.coder.email}"
}
