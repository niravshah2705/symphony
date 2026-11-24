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
  display_name = "Software Factory gateway (public API)"
}

resource "google_service_account" "stream_token_broker" {
  project      = var.project_id
  account_id   = "stream-token-broker-sa"
  display_name = "Software Factory stream-token broker (private signer)"
}

# planner-sa / coder-sa are retired with their services: the orchestrator SA
# (pipeline.tf) is the single agent-workload identity now.

# Identity Pub/Sub push subscriptions and Cloud Scheduler jobs sign their OIDC
# tokens as. It may ONLY invoke the internal services.
resource "google_service_account" "pubsub_push" {
  project      = var.project_id
  account_id   = "pubsub-push-sa"
  display_name = "Software Factory Pub/Sub push + Scheduler invoker"
}

# --- Firestore (Datastore) access — project-scoped role, data-plane only ------

resource "google_project_iam_member" "gateway_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.gateway.email}"
}

# (the orchestrator/deployer datastore grants live in pipeline.tf)

# --- Pub/Sub publish — gateway only, scoped to the request topic --------------

resource "google_pubsub_topic_iam_member" "gateway_publish_planner" {
  project = var.project_id
  topic   = google_pubsub_topic.planner.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.gateway.email}"
}

# --- Secret Manager accessor — scoped per secret ------------------------------

# Preserve the existing gateway binding in state during phase 1. Existing
# tenant services are outside this Terraform state and can still run the old
# stream-token sidecar until they are explicitly reconciled. Phase 2 sets the
# migration gate false, which removes this exact binding without touching the
# broker's independent grant below.
moved {
  from = google_secret_manager_secret_iam_member.gateway_stream_token
  to   = google_secret_manager_secret_iam_member.gateway_stream_token_legacy[0]
}

resource "google_secret_manager_secret_iam_member" "gateway_stream_token_legacy" {
  count = var.stream_token_legacy_gateway_secret_access ? 1 : 0

  project   = var.project_id
  secret_id = google_secret_manager_secret.stream_token_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.gateway.email}"
}

resource "google_secret_manager_secret_iam_member" "stream_token_broker" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.stream_token_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.stream_token_broker.email}"
}

# --- Cloud Run invoke rights --------------------------------------------------
# The agent workloads are INTERNAL and IAM-gated. Their invokers are only:
#   - gateway-sa   (the gateway reverse-proxies to the orchestrator surface)
#   - pubsub-push-sa (Pub/Sub push + Cloud Scheduler ticks)
#   - substrate_actor_member, and only when an operator names it (see below)
# There is intentionally NO allUsers binding on these services. The orchestrator
# invoke bindings (gateway_invokes_orchestrator,
# push_invokes_pipeline, pipeline_proxy_invokes_settings) live in pipeline.tf
# next to the services they gate.

# The substrate actor's own dispatch path: an actor calls
# POST /internal/plan/run on the orchestrator with its workload identity, and Cloud Run
# answers 403 before the route's JWT verification ever runs unless this binding
# exists. Naming an invoker is therefore part of OPENING the endpoint, not an
# optional extra — which is why substrate.tf gates the SUBSTRATE_ACTOR_MODE env on
# the same variable. `allUsers` / `allAuthenticatedUsers` are not accepted here:
# the endpoint takes a prompt on behalf of an organization.
moved {
  from = google_cloud_run_v2_service_iam_member.substrate_actor_invokes_planner
  to   = google_cloud_run_v2_service_iam_member.substrate_actor_invokes_orchestrator
}

resource "google_cloud_run_v2_service_iam_member" "substrate_actor_invokes_orchestrator" {
  count    = trimspace(var.substrate_actor_member) != "" ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.orchestrator.name
  role     = "roles/run.invoker"
  member   = var.substrate_actor_member

  lifecycle {
    precondition {
      condition = (
        can(regex("^serviceAccount:[^@ ]+@[^ ]+\\.iam\\.gserviceaccount\\.com$", var.substrate_actor_member))
        || can(regex("^principal://iam\\.googleapis\\.com/[^ ]+$", var.substrate_actor_member))
      )
      error_message = "substrate_actor_member must be a serviceAccount:<email> or a principal://<workload-identity-pool>/ns/<namespace>/sa/<name> — not allUsers, and not allAuthenticatedUsers."
    }
  }
}

# The public gateway can exercise only the broker's narrow mint/verify API. In
# the completed migration state it cannot retrieve the HMAC key because
# gateway-sa has no Secret Manager grant. The temporary legacy binding above is
# retained only while unreconciled tenant revisions still need their sidecars.
resource "google_cloud_run_v2_service_iam_member" "gateway_invokes_stream_token_broker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.stream_token_broker.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.gateway.email}"
}

# --- gateway is PUBLIC -----------------------------------------------------------------
# The gateway is the only browser-facing origin, so its invoker below is the one
# unauthenticated member binding in this root. That is intentional — it is
# guarded at the application layer by Firebase auth (AUTH_MODE=firebase), and
# internal services get no such binding.
# ---------------------------------------------------------------------------------------
resource "google_cloud_run_v2_service_iam_member" "gateway_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.gateway.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# (the retired coder-control/coder-worker Job act-as + run.developer grants are
# gone: the substrate worker pool, not Cloud Run Jobs, runs model-generated code,
# and it holds no GCP identity of its own beyond the actor workload identity.)

# --- Pub/Sub service agent: mint OIDC push tokens as pubsub-push-sa ------------
# Required for push subscriptions with an oidc_token whose service_account_email
# is pubsub-push-sa.
resource "google_service_account_iam_member" "pubsub_agent_token_creator" {
  service_account_id = google_service_account.pubsub_push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.pubsub_agent

  depends_on = [google_project_service.services]
}
