# -----------------------------------------------------------------------------
# Service accounts + least-privilege IAM.
# -----------------------------------------------------------------------------
# One SA per trust role. NO wildcard roles, NO allUsers on internal services.
# Grants are scoped to the specific topic / secret / service resource wherever
# the API supports it (infrastructure-misconfig checklist).

# --- Service accounts ---------------------------------------------------------

resource "google_service_account" "gateway" {
  project      = var.project_id
  account_id   = "gateway-sa"
  display_name = "AI Fleet gateway (public API)"
}

resource "google_service_account" "planner" {
  project      = var.project_id
  account_id   = "planner-sa"
  display_name = "AI Fleet planner (internal)"
}

# Used by BOTH coder-control (service) and coder-worker (job).
resource "google_service_account" "coder" {
  project      = var.project_id
  account_id   = "coder-sa"
  display_name = "AI Fleet coder control + worker"
}

# Identity Pub/Sub push subscriptions and Cloud Scheduler jobs sign their OIDC
# tokens as. It may ONLY invoke the two internal services.
resource "google_service_account" "pubsub_push" {
  project      = var.project_id
  account_id   = "pubsub-push-sa"
  display_name = "AI Fleet Pub/Sub push + Scheduler invoker"
}

# --- Firestore (Datastore) access — project-scoped role, data-plane only ------

resource "google_project_iam_member" "gateway_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.gateway.email}"
}

resource "google_project_iam_member" "planner_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.planner.email}"
}

resource "google_project_iam_member" "coder_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.coder.email}"
}

# --- Pub/Sub publish — gateway only, scoped to the two request topics ---------

resource "google_pubsub_topic_iam_member" "gateway_publish_planner" {
  project = var.project_id
  topic   = google_pubsub_topic.planner.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.gateway.email}"
}

resource "google_pubsub_topic_iam_member" "gateway_publish_coder" {
  project = var.project_id
  topic   = google_pubsub_topic.coder.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.gateway.email}"
}

# --- Secret Manager accessor — scoped per secret ------------------------------

# The stream-token proxy sidecar shares gateway-sa at the Cloud Run service
# boundary, so the accessor remains scoped to this single secret.
resource "google_secret_manager_secret_iam_member" "gateway_stream_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.stream_token_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.gateway.email}"
}

# --- Cloud Run invoke rights --------------------------------------------------
# planner + coder-control are INTERNAL and IAM-gated. Their ONLY invokers are:
#   - gateway-sa   (the gateway reverse-proxies read endpoints to them)
#   - pubsub-push-sa (Pub/Sub push + Cloud Scheduler ticks)
# There is intentionally NO allUsers binding on these services.

resource "google_cloud_run_v2_service_iam_member" "gateway_invokes_planner" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.planner.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.gateway.email}"
}

resource "google_cloud_run_v2_service_iam_member" "gateway_invokes_coder" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.coder_control.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.gateway.email}"
}

resource "google_cloud_run_v2_service_iam_member" "push_invokes_planner" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.planner.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_push.email}"
}

resource "google_cloud_run_v2_service_iam_member" "push_invokes_coder" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.coder_control.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_push.email}"
}

# gateway is PUBLIC: allUsers may invoke it. This is intentional — the gateway
# is guarded at the application layer by Firebase auth (AUTH_MODE=firebase) and is
# the only browser-facing origin. (Internal services get no such binding.)
resource "google_cloud_run_v2_service_iam_member" "gateway_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.gateway.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- coder-control launches the coder-worker Job ------------------------------
# Scoped to the specific job resource (not project-wide). Running a job also
# needs actAs on the job's runtime SA — coder-sa acts as itself.
resource "google_cloud_run_v2_job_iam_member" "coder_runs_worker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.coder_worker.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.coder.email}"
}

resource "google_service_account_iam_member" "coder_actas_self" {
  service_account_id = google_service_account.coder.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.coder.email}"
}

# --- Pub/Sub service agent: mint OIDC push tokens as pubsub-push-sa ------------
# Required for push subscriptions with an oidc_token whose service_account_email
# is pubsub-push-sa.
resource "google_service_account_iam_member" "pubsub_agent_token_creator" {
  service_account_id = google_service_account.pubsub_push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.pubsub_agent

  depends_on = [google_project_service.services]
}
