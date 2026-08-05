#!/usr/bin/env bash
#
# AI Fleet — one-shot GCP deploy (no-cost design).
#
# Orchestrates the full deploy from an operator machine: enables APIs, creates
# the Terraform state bucket, stages Secret Manager versions, builds + pushes the
# three images, publishes the SPA to GCS, and applies Terraform. Idempotent —
# safe to re-run. (For CI, prefer cloudbuild.yaml; this is its local sibling.)
#
# The apply is STAGED to fix an ordering constraint: the SPA bucket and the
# Secret Manager secrets must exist BEFORE the SPA is uploaded and BEFORE the
# Cloud Run revisions (which mount secrets) are created.
#
# Usage:
#   PROJECT_ID=my-proj \
#   SPA_BUCKET=my-proj-aifleet-spa \        # globally-unique
#   TF_STATE_BUCKET=my-proj-tfstate \       # created if missing
#   LINEAR_API_KEY=lin_... \                # required secret (else services won't start)
#   FIREBASE_API_KEY=AIza... \              # public Firebase Web API key (NOT a secret)
#   ./deploy/gcp/deploy.sh
#
# Optional env: REGION (us-central1), AR_REPO (ai-fleet), TF_STATE_PREFIX
#   (ai-fleet/gcp), IMAGE_TAG (git short SHA), FIRESTORE_LOCATION (nam5),
#   SPA_ORIGIN (https://storage.googleapis.com), FIREBASE_ALLOWED_DOMAIN (empty =
#   any verified user), STREAM_TOKEN_SECRET (auto-generated if unset),
#   GITHUB_TOKEN, LANGSMITH_API_KEY, SKIP_BUILD=1 (reuse existing images).
set -euo pipefail

# --- Inputs -----------------------------------------------------------------
: "${PROJECT_ID:?set PROJECT_ID}"
: "${SPA_BUCKET:?set SPA_BUCKET (a globally-unique GCS bucket name)}"
: "${TF_STATE_BUCKET:?set TF_STATE_BUCKET (GCS bucket for Terraform remote state)}"

REGION="${REGION:-us-central1}"
AR_REPO="${AR_REPO:-ai-fleet}"
TF_STATE_PREFIX="${TF_STATE_PREFIX:-ai-fleet/gcp}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-nam5}"
SPA_ORIGIN="${SPA_ORIGIN:-https://storage.googleapis.com}"
# Firebase web config is PUBLIC (exposed to the browser via /api/auth/config) — plain
# vars, never Secret Manager. FIREBASE_PROJECT_ID defaults to PROJECT_ID in Terraform.
FIREBASE_API_KEY="${FIREBASE_API_KEY:-}"
FIREBASE_ALLOWED_DOMAIN="${FIREBASE_ALLOWED_DOMAIN:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TF_DIR="$SCRIPT_DIR/terraform"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo latest)}"
AR_HOST="${REGION}-docker.pkg.dev"
IMAGE_BASE="${AR_HOST}/${PROJECT_ID}/${AR_REPO}"

log() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }

# Restore the committed SPA config placeholder so the working tree stays clean.
cleanup() { git -C "$REPO_ROOT" checkout -- public/config.js 2>/dev/null || true; }
trap cleanup EXIT

# --- Preflight --------------------------------------------------------------
log "Preflight"
for cmd in gcloud terraform gsutil; do
  command -v "$cmd" >/dev/null || { echo "missing required tool: $cmd"; exit 1; }
done
if [ "${SKIP_BUILD:-}" != "1" ]; then
  command -v docker >/dev/null || { echo "missing docker (or set SKIP_BUILD=1 to reuse pushed images)"; exit 1; }
fi
gcloud config set project "$PROJECT_ID" >/dev/null
gcloud auth print-access-token >/dev/null 2>&1 || { echo "run 'gcloud auth login' first"; exit 1; }

# Terraform vars reused across every apply.
TFVARS=(
  -var="project_id=${PROJECT_ID}"
  -var="region=${REGION}"
  -var="artifact_repo=${AR_REPO}"
  -var="spa_bucket_name=${SPA_BUCKET}"
  -var="firestore_location=${FIRESTORE_LOCATION}"
  -var="image_tag=${IMAGE_TAG}"
  -var="spa_origin=${SPA_ORIGIN}"
  -var="firebase_api_key=${FIREBASE_API_KEY}"
  -var="firebase_allowed_domain=${FIREBASE_ALLOWED_DOMAIN}"
)

# --- 1. Enable APIs ---------------------------------------------------------
log "Enabling required APIs"
gcloud services enable \
  run.googleapis.com artifactregistry.googleapis.com pubsub.googleapis.com \
  cloudscheduler.googleapis.com firestore.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
  storage.googleapis.com

# --- 2. Terraform state bucket (idempotent) ---------------------------------
log "Ensuring Terraform state bucket gs://${TF_STATE_BUCKET}"
if ! gsutil ls -b "gs://${TF_STATE_BUCKET}" >/dev/null 2>&1; then
  gsutil mb -p "$PROJECT_ID" -l "$REGION" -b on "gs://${TF_STATE_BUCKET}"
  gsutil versioning set on "gs://${TF_STATE_BUCKET}"
fi

# --- 3. Terraform init ------------------------------------------------------
log "terraform init"
terraform -chdir="$TF_DIR" init -input=false -reconfigure \
  -backend-config="bucket=${TF_STATE_BUCKET}" \
  -backend-config="prefix=${TF_STATE_PREFIX}"

# --- 4. Bootstrap apply: APIs + Artifact Registry + secrets + SPA bucket -----
# These must exist before we push images, add secret versions, or upload the SPA.
log "Bootstrap apply (registry, secrets, SPA bucket)"
terraform -chdir="$TF_DIR" apply -input=false -auto-approve "${TFVARS[@]}" \
  -target=google_project_service.services \
  -target=google_artifact_registry_repository.docker \
  -target=google_secret_manager_secret.stream_token_secret \
  -target=google_secret_manager_secret.linear_api_key \
  -target=google_secret_manager_secret.extra \
  -target=google_storage_bucket.spa \
  -target=google_storage_bucket_iam_member.spa_public_read

# --- 5. Secret versions (idempotent — only seed when a secret has none) ------
log "Staging Secret Manager versions"
has_version() { gcloud secrets versions list "$1" --project "$PROJECT_ID" --format='value(name)' 2>/dev/null | grep -q .; }
seed_secret() { # id, value
  if has_version "$1"; then echo "  $1: already has a version (unchanged)";
  else printf '%s' "$2" | gcloud secrets versions add "$1" --project "$PROJECT_ID" --data-file=- >/dev/null; echo "  $1: seeded"; fi
}

# stream-token-secret: never printed; generated once if absent (do NOT rotate on redeploy).
STREAM_TOKEN_SECRET="${STREAM_TOKEN_SECRET:-$(openssl rand -base64 32 2>/dev/null | tr -d '\n' || head -c 32 /dev/urandom | base64 | tr -d '\n')}"
seed_secret stream-token-secret "$STREAM_TOKEN_SECRET"
[ -n "${LINEAR_API_KEY:-}" ]    && seed_secret linear-api-key   "$LINEAR_API_KEY"    || echo "  linear-api-key: LINEAR_API_KEY not provided"
[ -n "${GITHUB_TOKEN:-}" ]      && seed_secret github-token     "$GITHUB_TOKEN"      || true
[ -n "${LANGSMITH_API_KEY:-}" ] && seed_secret langsmith-api-key "$LANGSMITH_API_KEY" || true

# linear-api-key is mounted as REQUIRED env — the revisions won't start without it.
has_version linear-api-key || { echo "ERROR: secret 'linear-api-key' has no version. Re-run with LINEAR_API_KEY=... set."; exit 1; }

# --- 6. Build + push images -------------------------------------------------
if [ "${SKIP_BUILD:-}" = "1" ]; then
  log "SKIP_BUILD=1 — reusing images already pushed at tag ${IMAGE_TAG}"
else
  log "Building + pushing images (tag ${IMAGE_TAG})"
  gcloud auth configure-docker "$AR_HOST" -q
  cd "$REPO_ROOT"
  # The Firebase Web SDK ships as committed static assets under public/vendor/firebase/
  # and is published to GCS by the gsutil rsync in step 7 — nothing to stage here.
  build_push() { # service, dockerfile
    docker build -f "deploy/gcp/$2" -t "${IMAGE_BASE}/$1:${IMAGE_TAG}" .
    docker push "${IMAGE_BASE}/$1:${IMAGE_TAG}"
  }
  build_push gateway       Dockerfile.gateway
  build_push planner       Dockerfile.planner
  build_push coder-control Dockerfile.coder   # dual-role image; also runs the worker Job
fi

# --- 7. Publish the SPA to GCS ----------------------------------------------
log "Publishing SPA to gs://${SPA_BUCKET}"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
GATEWAY_URL="https://gateway-${PROJECT_NUMBER}.${REGION}.run.app"
printf "window.__API_BASE__='%s';\n" "$GATEWAY_URL" > "$REPO_ROOT/public/config.js"
gsutil -m rsync -r -d "$REPO_ROOT/public" "gs://${SPA_BUCKET}"
gsutil -m setmeta -h "Content-Type:text/javascript" "gs://${SPA_BUCKET}/**/*.mjs" >/dev/null 2>&1 || true

# --- 8. Full apply ----------------------------------------------------------
log "Full apply (Cloud Run services + job, Pub/Sub, Scheduler, Firestore, IAM)"
terraform -chdir="$TF_DIR" apply -input=false -auto-approve "${TFVARS[@]}" \
  -var="api_base_url=${GATEWAY_URL}"

# --- 9. Report --------------------------------------------------------------
log "Done"
terraform -chdir="$TF_DIR" output || true
cat <<EOF

  Gateway API : ${GATEWAY_URL}
  SPA         : https://storage.googleapis.com/${SPA_BUCKET}/index.html

  Next, in the Firebase console:
    - enable the Google sign-in provider (Authentication → Sign-in method), and
    - add the SPA origin (${SPA_ORIGIN}) and the gateway URL (${GATEWAY_URL})
      to Authentication → Settings → Authorized domains.
EOF
