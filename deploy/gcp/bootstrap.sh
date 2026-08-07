#!/usr/bin/env bash
# =============================================================================
# One-time project bootstrap for a NEW ai-fleet customer / GCP project.
# Idempotent — safe to re-run.
# =============================================================================
# Sets up everything the CD pipeline (.github/workflows/deploy.yml) and Terraform
# need but cannot manage themselves (the bootstrap layer): enabled APIs, the
# Terraform state bucket, the keyless deployer SA + roles, Workload Identity
# Federation, the Pub/Sub service agent, seeded Secret Manager values, and the
# GitHub repo secrets/variables. It also imports the seeded secrets into TF state
# so the very first `git push` deploys cleanly (no chicken-and-egg on secret
# versions).
#
# After this, only TWO things remain manual (both console-only):
#   1. Link a BILLING account to the project.
#   2. Firebase console -> Authentication -> enable the Google sign-in provider
#      (creates the Google OAuth client; there is no API/Terraform to create it).
# Then: push to main (first run: Actions -> Deploy to GCP -> Run workflow with
# deploy_all=true so all images build), and CD does the rest.
#
# Usage:
#   PROJECT_ID=my-proj REPO=owner/repo LINEAR_API_KEY=lin_... \
#     ./deploy/gcp/bootstrap.sh
#
# Optional env: REGION (asia-south1), SPA_BUCKET (<project>-aifleet-spa),
#   TF_STATE_BUCKET (<project>-tfstate), FIRESTORE_LOCATION (nam5),
#   SPA_ORIGIN (https://<project>.web.app), FIREBASE_ALLOWED_DOMAIN,
#   GITHUB_TOKEN, LANGSMITH_API_KEY, STREAM_TOKEN_SECRET (auto-generated if unset).
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
: "${REPO:?set REPO (the GitHub owner/repo the CD workflow lives in)}"

REGION="${REGION:-asia-south1}"
SPA_BUCKET="${SPA_BUCKET:-${PROJECT_ID}-aifleet-spa}"
TF_STATE_BUCKET="${TF_STATE_BUCKET:-${PROJECT_ID}-tfstate}"
TF_STATE_PREFIX="${TF_STATE_PREFIX:-ai-fleet/gcp}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-nam5}"
SPA_ORIGIN="${SPA_ORIGIN:-https://${PROJECT_ID}.web.app}"
DEPLOYER="gh-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
TF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/terraform" && pwd)"

log() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

PROJNUM="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
[ -n "$PROJNUM" ] || { echo "Cannot read project $PROJECT_ID — does it exist and are you authenticated?"; exit 1; }

# --- 1. Enable APIs ----------------------------------------------------------
log "Enabling APIs"
gcloud services enable --project "$PROJECT_ID" \
  serviceusage.googleapis.com cloudresourcemanager.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  run.googleapis.com artifactregistry.googleapis.com pubsub.googleapis.com \
  cloudscheduler.googleapis.com firestore.googleapis.com \
  secretmanager.googleapis.com cloudbuild.googleapis.com storage.googleapis.com \
  firebase.googleapis.com firebasehosting.googleapis.com identitytoolkit.googleapis.com

# --- 2. Terraform state bucket ----------------------------------------------
log "Terraform state bucket gs://${TF_STATE_BUCKET}"
gcloud storage buckets describe "gs://${TF_STATE_BUCKET}" >/dev/null 2>&1 \
  || gcloud storage buckets create "gs://${TF_STATE_BUCKET}" --project "$PROJECT_ID" \
       --location "$REGION" --uniform-bucket-level-access
gcloud storage buckets update "gs://${TF_STATE_BUCKET}" --versioning >/dev/null 2>&1 || true

# --- 3. Deployer service account + roles ------------------------------------
log "Deployer SA ${DEPLOYER}"
gcloud iam service-accounts describe "$DEPLOYER" --project "$PROJECT_ID" >/dev/null 2>&1 \
  || gcloud iam service-accounts create gh-deployer --project "$PROJECT_ID" \
       --display-name "GitHub Actions deployer"
for role in \
  roles/run.admin roles/cloudscheduler.admin roles/pubsub.admin \
  roles/artifactregistry.admin roles/datastore.owner roles/secretmanager.admin \
  roles/storage.admin roles/iam.serviceAccountAdmin roles/iam.serviceAccountUser \
  roles/resourcemanager.projectIamAdmin roles/serviceusage.serviceUsageAdmin \
  roles/firebase.admin roles/firebasehosting.admin roles/identityplatform.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOYER}" --role="$role" --condition=None >/dev/null
done
echo "  granted 15 roles"

# --- 4. Workload Identity Federation (bind the repo to the deployer SA) ------
log "Workload Identity Federation for ${REPO}"
gcloud iam workload-identity-pools describe github \
  --project "$PROJECT_ID" --location global >/dev/null 2>&1 \
  || gcloud iam workload-identity-pools create github \
       --project "$PROJECT_ID" --location global --display-name "GitHub"
gcloud iam workload-identity-pools providers describe github-oidc \
  --project "$PROJECT_ID" --location global --workload-identity-pool github >/dev/null 2>&1 \
  || gcloud iam workload-identity-pools providers create-oidc github-oidc \
       --project "$PROJECT_ID" --location global --workload-identity-pool github \
       --display-name "GitHub OIDC" \
       --issuer-uri "https://token.actions.githubusercontent.com" \
       --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
       --attribute-condition "assertion.repository=='${REPO}'"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" --project "$PROJECT_ID" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJNUM}/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}" >/dev/null
WIF_PROVIDER="projects/${PROJNUM}/locations/global/workloadIdentityPools/github/providers/github-oidc"

# --- 5. Pub/Sub service agent (mints OIDC push tokens; must exist for IAM) ---
log "Pub/Sub service agent"
gcloud beta services identity create --service=pubsub.googleapis.com --project "$PROJECT_ID" >/dev/null 2>&1 \
  && echo "  ready" || echo "  (already exists or beta component missing — safe to ignore)"

# --- 6. Seed Secret Manager values ------------------------------------------
# Containers + versions created here (out of band) so the first CD apply finds
# populated secrets and Cloud Run boots. Step 8 imports the containers into TF
# state so Terraform adopts (not re-creates) them.
log "Secret Manager values"
ensure_secret() { gcloud secrets describe "$1" --project "$PROJECT_ID" >/dev/null 2>&1 \
  || gcloud secrets create "$1" --project "$PROJECT_ID" --replication-policy=automatic >/dev/null; }
has_version() { gcloud secrets versions list "$1" --project "$PROJECT_ID" --format='value(name)' 2>/dev/null | grep -q .; }
seed() { ensure_secret "$1"; if has_version "$1"; then echo "  $1: has a version (unchanged)";
  else printf '%s' "$2" | gcloud secrets versions add "$1" --project "$PROJECT_ID" --data-file=- >/dev/null; echo "  $1: seeded"; fi; }

STREAM_TOKEN_SECRET="${STREAM_TOKEN_SECRET:-$(openssl rand -base64 32 2>/dev/null | tr -d '\n' || head -c 32 /dev/urandom | base64 | tr -d '\n')}"
seed stream-token-secret "$STREAM_TOKEN_SECRET"
ORG_JWT_SECRET="${ORG_JWT_SECRET:-$(openssl rand -base64 32 2>/dev/null | tr -d '\n' || head -c 32 /dev/urandom | base64 | tr -d '\n')}"
seed org-jwt-secret "$ORG_JWT_SECRET"
if [ -n "${LINEAR_API_KEY:-}" ]; then seed linear-api-key "$LINEAR_API_KEY"
else ensure_secret linear-api-key; echo "  linear-api-key: created EMPTY — add a version before deploy (services won't start without it)"; fi
ensure_secret github-token;     [ -n "${GITHUB_TOKEN:-}" ]      && seed github-token     "$GITHUB_TOKEN"      || true
ensure_secret langsmith-api-key;[ -n "${LANGSMITH_API_KEY:-}" ] && seed langsmith-api-key "$LANGSMITH_API_KEY" || true

# --- 7. GitHub repo secrets + variables -------------------------------------
if command -v gh >/dev/null 2>&1; then
  log "GitHub repo secrets + variables (${REPO})"
  gh secret   set GCP_WIF_PROVIDER    --repo "$REPO" --body "$WIF_PROVIDER"
  gh secret   set GCP_DEPLOYER_SA     --repo "$REPO" --body "$DEPLOYER"
  gh variable set GCP_PROJECT_ID      --repo "$REPO" --body "$PROJECT_ID"
  gh variable set GCP_REGION          --repo "$REPO" --body "$REGION"
  gh variable set SPA_BUCKET          --repo "$REPO" --body "$SPA_BUCKET"
  gh variable set TF_STATE_BUCKET     --repo "$REPO" --body "$TF_STATE_BUCKET"
  gh variable set FIRESTORE_LOCATION  --repo "$REPO" --body "$FIRESTORE_LOCATION"
  gh variable set SPA_ORIGIN          --repo "$REPO" --body "$SPA_ORIGIN"
  [ -n "${FIREBASE_ALLOWED_DOMAIN:-}" ] && gh variable set FIREBASE_ALLOWED_DOMAIN --repo "$REPO" --body "$FIREBASE_ALLOWED_DOMAIN" || true
  echo "  set (FIREBASE_API_KEY is NOT needed — Terraform derives it from the web app)"
else
  log "gh CLI not found — set these repo secrets/variables manually"
  echo "  secret GCP_WIF_PROVIDER = $WIF_PROVIDER"
  echo "  secret GCP_DEPLOYER_SA  = $DEPLOYER"
  echo "  vars: GCP_PROJECT_ID=$PROJECT_ID GCP_REGION=$REGION SPA_BUCKET=$SPA_BUCKET"
  echo "        TF_STATE_BUCKET=$TF_STATE_BUCKET FIRESTORE_LOCATION=$FIRESTORE_LOCATION SPA_ORIGIN=$SPA_ORIGIN"
fi

# --- 8. Import seeded secrets into TF state (so first `git push` applies clean)
if command -v terraform >/dev/null 2>&1; then
  log "Importing secret containers into Terraform state"
  terraform -chdir="$TF_DIR" init -input=false -reconfigure \
    -backend-config="bucket=${TF_STATE_BUCKET}" -backend-config="prefix=${TF_STATE_PREFIX}" >/dev/null
  tfimport() { # <address> <id>
    if terraform -chdir="$TF_DIR" state list 2>/dev/null | grep -qxF "$1"; then echo "  $1: already in state";
    else terraform -chdir="$TF_DIR" import -input=false \
      -var="project_id=${PROJECT_ID}" -var="region=${REGION}" -var="spa_bucket_name=${SPA_BUCKET}" \
      "$1" "$2" >/dev/null && echo "  $1: imported"; fi; }
  tfimport 'google_secret_manager_secret.stream_token_secret' "projects/${PROJECT_ID}/secrets/stream-token-secret"
  tfimport 'google_secret_manager_secret.org_jwt_secret'      "projects/${PROJECT_ID}/secrets/org-jwt-secret"
  tfimport 'google_secret_manager_secret.linear_api_key'      "projects/${PROJECT_ID}/secrets/linear-api-key"
  tfimport 'google_secret_manager_secret.extra["github-token"]'     "projects/${PROJECT_ID}/secrets/github-token"
  tfimport 'google_secret_manager_secret.extra["langsmith-api-key"]' "projects/${PROJECT_ID}/secrets/langsmith-api-key"
else
  log "terraform not found — skipping secret import"
  echo "  Run the first deploy with ./deploy/gcp/deploy.sh instead of git push"
  echo "  (it stages secret creation), then use git push for subsequent deploys."
fi

# --- Done -------------------------------------------------------------------
cat <<EOF

────────────────────────────────────────────────────────────────────────────
Bootstrap complete for ${PROJECT_ID} (${REGION}).

TWO manual steps remain (console only):
  1. Link a BILLING account:
     https://console.cloud.google.com/billing/linkedaccount?project=${PROJECT_ID}
  2. Firebase -> Authentication -> Sign-in method -> enable Google:
     https://console.firebase.google.com/project/${PROJECT_ID}/authentication/providers
     (Terraform manages the web app, Hosting and authorized domains; only the
      Google OAuth client must be created via this console toggle.)

Then deploy: push to main. For the FIRST run, trigger it with all images built:
  gh workflow run deploy.yml -f deploy_all=true --repo ${REPO}
────────────────────────────────────────────────────────────────────────────
EOF
