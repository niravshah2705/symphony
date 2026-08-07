# =============================================================================
# AI Fleet — GCP "no-cost" deployment (Terraform)
# =============================================================================
# Scale-to-zero Cloud Run services + a Cloud Run Job, Pub/Sub, Cloud Scheduler,
# Firestore, Secret Manager, Artifact Registry, and a public GCS bucket for the
# SPA. Everything idles at $0 (min instances = 0; you pay only while requests /
# jobs run and for a little Firestore/GCS storage).
#
# REQUIRED APIs — enabled by apis.tf (google_project_service), but the Terraform
# principal must itself be able to enable them:
#   run.googleapis.com            artifactregistry.googleapis.com
#   pubsub.googleapis.com         cloudscheduler.googleapis.com
#   firestore.googleapis.com      secretmanager.googleapis.com
#   cloudbuild.googleapis.com     iam.googleapis.com
#   iamcredentials.googleapis.com storage.googleapis.com
#
# SECURITY POSTURE (tribal-knowledge infra / ingress / oauth-oidc checklists):
#   - Least-privilege, per-resource IAM. No wildcard roles, no allUsers on the
#     internal services.
#   - planner + coder-control use INTERNAL-only ingress; only the gateway is
#     public (and it is guarded by app-level Firebase auth — AUTH_MODE=firebase).
#   - Every Pub/Sub push and every Cloud Scheduler call carries an OIDC token.
#   - Secrets live in Secret Manager and are injected as secret env, never baked
#     into images or hardcoded here.
#   - Container images are non-root and pinned by digest (see the Dockerfiles).
# =============================================================================

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
  }

  # Remote state — NEVER use the local backend for infra with secrets/IAM
  # (infrastructure-misconfig checklist rule 10). This is a PARTIAL config: pass
  # the bucket + prefix at init time so nothing sensitive is committed, e.g.
  #   terraform init \
  #     -backend-config="bucket=<YOUR_TF_STATE_BUCKET>" \
  #     -backend-config="prefix=ai-fleet/gcp"
  # Restrict that bucket to the CI/CD + operator identities only.
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region

  # Firebase / Identity Platform APIs require a quota (billing) project on the
  # request; without this they 403 under both ADC and WIF. Harmless for the other
  # APIs (attributes quota to this same project).
  user_project_override = true
  billing_project       = var.project_id
}

provider "google-beta" {
  project = var.project_id
  region  = var.region

  user_project_override = true
  billing_project       = var.project_id
}
