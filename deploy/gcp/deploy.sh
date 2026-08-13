#!/usr/bin/env bash
#
# AI Fleet — one-shot GCP deploy (no-cost design).
#
# Orchestrates the full deploy from an operator machine: enables APIs, creates
# the Terraform state bucket, stages Secret Manager versions, builds + pushes the
# shared images, publishes the SPA to GCS, and applies Terraform. Idempotent —
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
#   ./deploy/gcp/deploy.sh
#
# The Firebase Web API key is read from the managed web app by Terraform — no
# FIREBASE_API_KEY input is needed.
#
# Optional env: REGION (asia-south1), AR_REPO (ai-fleet), TF_STATE_PREFIX
#   (ai-fleet/gcp), IMAGE_TAG (git short SHA), FIRESTORE_LOCATION (nam5),
#   SPA_ORIGIN (https://storage.googleapis.com), FIREBASE_ALLOWED_DOMAIN (empty =
#   any verified user), STREAM_TOKEN_SECRET (auto-generated if unset),
#   GITHUB_TOKEN, LANGSMITH_API_KEY, SKIP_BUILD=1 (reuse existing images).
#   Email delivery: EMAIL_SMTP_HOST, EMAIL_SMTP_PORT, EMAIL_SMTP_SECURE,
#   EMAIL_SMTP_REQUIRE_TLS, EMAIL_SMTP_USER, EMAIL_SMTP_PASSWORD, EMAIL_FROM,
#   EMAIL_PUBLIC_APP_URL. Its default is the GCS SPA entry point published here;
#   empty SMTP host/from values deploy the email service in not-ready state.
#   Grafana Cloud monitoring: GRAFANA_MONITORING_ENABLED (false),
#   GRAFANA_METRICS_REMOTE_WRITE_URL, GRAFANA_METRICS_USERNAME (numeric instance
#   ID), GRAFANA_LOKI_PUSH_URL, GRAFANA_LOKI_USERNAME, GRAFANA_CLOUD_TOKEN
#   (optional initial seed), and GRAFANA_CLOUD_TOKEN_VERSION (optional pin).
set -euo pipefail

# --- Inputs -----------------------------------------------------------------
: "${PROJECT_ID:?set PROJECT_ID}"
: "${SPA_BUCKET:?set SPA_BUCKET (a globally-unique GCS bucket name)}"
: "${TF_STATE_BUCKET:?set TF_STATE_BUCKET (GCS bucket for Terraform remote state)}"

REGION="${REGION:-asia-south1}"
AR_REPO="${AR_REPO:-ai-fleet}"
TF_STATE_PREFIX="${TF_STATE_PREFIX:-ai-fleet/gcp}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-nam5}"
SPA_ORIGIN="${SPA_ORIGIN:-https://storage.googleapis.com}"
FIREBASE_ALLOWED_DOMAIN="${FIREBASE_ALLOWED_DOMAIN:-}"
GOOGLE_ONE_TAP_CLIENT_ID="${GOOGLE_ONE_TAP_CLIENT_ID:-}"  # public OAuth Web client id for Google One Tap (optional)
AUTH_ADMIN_EMAILS="${AUTH_ADMIN_EMAILS:-}"
AUTH_DEFAULT_ROLE="${AUTH_DEFAULT_ROLE:-viewer}"
EMAIL_SMTP_HOST="${EMAIL_SMTP_HOST:-}"
EMAIL_SMTP_PORT="${EMAIL_SMTP_PORT:-587}"
EMAIL_SMTP_SECURE="${EMAIL_SMTP_SECURE:-false}"
EMAIL_SMTP_REQUIRE_TLS="${EMAIL_SMTP_REQUIRE_TLS:-true}"
EMAIL_SMTP_USER="${EMAIL_SMTP_USER:-}"
EMAIL_SMTP_PASSWORD="${EMAIL_SMTP_PASSWORD:-}"
EMAIL_FROM="${EMAIL_FROM:-}"
EMAIL_PUBLIC_APP_URL="${EMAIL_PUBLIC_APP_URL:-https://storage.googleapis.com/${SPA_BUCKET}/index.html}"
PIPELINE_ORCHESTRATOR_ENABLED="${PIPELINE_ORCHESTRATOR_ENABLED:-false}"
PIPELINE_DEPLOYMENT_ENABLED="${PIPELINE_DEPLOYMENT_ENABLED:-false}"
EGRESS_PROXY_ENABLED="${EGRESS_PROXY_ENABLED:-$PIPELINE_ORCHESTRATOR_ENABLED}"
SETTINGS_OPERATOR_INVOKER="${SETTINGS_OPERATOR_INVOKER:-}"
INTERNAL_API_TOKEN="${INTERNAL_API_TOKEN:-}"
GRAFANA_MONITORING_ENABLED="${GRAFANA_MONITORING_ENABLED:-false}"
GRAFANA_METRICS_REMOTE_WRITE_URL="${GRAFANA_METRICS_REMOTE_WRITE_URL:-https://prometheus-prod-43-prod-ap-south-1.grafana.net/api/prom/push}"
GRAFANA_METRICS_USERNAME="${GRAFANA_METRICS_USERNAME:-}"
GRAFANA_LOKI_PUSH_URL="${GRAFANA_LOKI_PUSH_URL:-}"
GRAFANA_LOKI_USERNAME="${GRAFANA_LOKI_USERNAME:-}"
GRAFANA_CLOUD_TOKEN_VERSION="${GRAFANA_CLOUD_TOKEN_VERSION:-}"
# Do not leave the raw token exported to gcloud, Docker, Terraform, or service
# builds. Keep a shell-local copy only until it is piped to Secret Manager.
GRAFANA_CLOUD_TOKEN_VALUE="${GRAFANA_CLOUD_TOKEN:-}"
unset GRAFANA_CLOUD_TOKEN
export -n GRAFANA_CLOUD_TOKEN_VALUE 2>/dev/null || true

case "$GRAFANA_MONITORING_ENABLED" in
  true|false) ;;
  *) echo "ERROR: GRAFANA_MONITORING_ENABLED must be true or false." >&2; exit 1 ;;
esac
if [ -n "$GRAFANA_CLOUD_TOKEN_VERSION" ] && [[ ! "$GRAFANA_CLOUD_TOKEN_VERSION" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: GRAFANA_CLOUD_TOKEN_VERSION must be an exact positive numeric version, never 'latest'." >&2
  exit 1
fi
if [ "$GRAFANA_MONITORING_ENABLED" = "true" ]; then
  [[ "$GRAFANA_METRICS_REMOTE_WRITE_URL" == https://*/api/prom/push ]] || {
    echo "ERROR: GRAFANA_METRICS_REMOTE_WRITE_URL must be an HTTPS /api/prom/push endpoint." >&2; exit 1;
  }
  [[ "$GRAFANA_METRICS_USERNAME" =~ ^[0-9]+$ ]] || {
    echo "ERROR: GRAFANA_METRICS_USERNAME must be the numeric Grafana Cloud metrics instance ID." >&2; exit 1;
  }
  [[ "$GRAFANA_LOKI_PUSH_URL" == https://*/loki/api/v1/push ]] || {
    echo "ERROR: GRAFANA_LOKI_PUSH_URL must be an HTTPS /loki/api/v1/push endpoint." >&2; exit 1;
  }
  [ -n "$GRAFANA_LOKI_USERNAME" ] || {
    echo "ERROR: GRAFANA_LOKI_USERNAME is required when monitoring is enabled." >&2; exit 1;
  }
fi

if [ "$PIPELINE_ORCHESTRATOR_ENABLED" = "true" ] && [ "$EGRESS_PROXY_ENABLED" != "true" ]; then
  echo "ERROR: the durable pipeline requires EGRESS_PROXY_ENABLED=true." >&2
  exit 1
fi
if [ "$EGRESS_PROXY_ENABLED" = "true" ] && [ -z "$INTERNAL_API_TOKEN" ]; then
  echo "ERROR: egress proxy mode requires INTERNAL_API_TOKEN (used only for settings S2S auth)." >&2
  exit 1
fi
# Keep the shared internal token out of the Terraform command line/process list.
export TF_VAR_internal_api_token="$INTERNAL_API_TOKEN"

if { [ -n "$EMAIL_SMTP_USER" ] && [ -z "$EMAIL_SMTP_PASSWORD" ]; } || \
   { [ -z "$EMAIL_SMTP_USER" ] && [ -n "$EMAIL_SMTP_PASSWORD" ]; }; then
  echo "ERROR: EMAIL_SMTP_USER and EMAIL_SMTP_PASSWORD must both be set (or both omitted)." >&2
  exit 1
fi

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
  -var="firebase_allowed_domain=${FIREBASE_ALLOWED_DOMAIN}"
  -var="google_one_tap_client_id=${GOOGLE_ONE_TAP_CLIENT_ID}"
  -var="auth_admin_emails=${AUTH_ADMIN_EMAILS}"
  -var="auth_default_role=${AUTH_DEFAULT_ROLE}"
  -var="email_smtp_host=${EMAIL_SMTP_HOST}"
  -var="email_smtp_port=${EMAIL_SMTP_PORT}"
  -var="email_smtp_secure=${EMAIL_SMTP_SECURE}"
  -var="email_smtp_require_tls=${EMAIL_SMTP_REQUIRE_TLS}"
  -var="email_from=${EMAIL_FROM}"
  -var="email_public_app_url=${EMAIL_PUBLIC_APP_URL}"
  -var="pipeline_orchestrator_enabled=${PIPELINE_ORCHESTRATOR_ENABLED}"
  -var="pipeline_deployment_enabled=${PIPELINE_DEPLOYMENT_ENABLED}"
  -var="egress_proxy_enabled=${EGRESS_PROXY_ENABLED}"
  -var="settings_operator_invoker=${SETTINGS_OPERATOR_INVOKER}"
  -var="alloy_image_tag=${IMAGE_TAG}"
  -var="grafana_monitoring_enabled=${GRAFANA_MONITORING_ENABLED}"
  -var="grafana_metrics_remote_write_url=${GRAFANA_METRICS_REMOTE_WRITE_URL}"
  -var="grafana_metrics_username=${GRAFANA_METRICS_USERNAME}"
  -var="grafana_loki_push_url=${GRAFANA_LOKI_PUSH_URL}"
  -var="grafana_loki_username=${GRAFANA_LOKI_USERNAME}"
)

# --- 1. Enable APIs ---------------------------------------------------------
log "Enabling required APIs"
gcloud services enable \
  run.googleapis.com artifactregistry.googleapis.com pubsub.googleapis.com \
  cloudscheduler.googleapis.com firestore.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
  storage.googleapis.com logging.googleapis.com monitoring.googleapis.com

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
  -target=google_secret_manager_secret.org_jwt_secret \
  -target=google_secret_manager_secret.email_smtp_user \
  -target=google_secret_manager_secret.email_smtp_password \
  -target=google_secret_manager_secret.grafana_cloud_access_token \
  -target=google_secret_manager_secret.extra \
  -target=google_storage_bucket.spa \
  -target=google_storage_bucket_iam_member.spa_public_read

# --- 5. Secret versions (idempotent — only seed when a secret has none) ------
log "Staging Secret Manager versions"
has_version() { gcloud secrets versions list "$1" --project "$PROJECT_ID" \
  --filter='state=ENABLED' --format='value(name)' 2>/dev/null | grep -q .; }
seed_secret() { # id, value
  if has_version "$1"; then echo "  $1: already has a version (unchanged)";
  else printf '%s' "$2" | gcloud secrets versions add "$1" --project "$PROJECT_ID" --data-file=- >/dev/null; echo "  $1: seeded"; fi
}

# stream-token-secret: never printed; generated once if absent (do NOT rotate on redeploy).
STREAM_TOKEN_SECRET="${STREAM_TOKEN_SECRET:-$(openssl rand -base64 32 2>/dev/null | tr -d '\n' || head -c 32 /dev/urandom | base64 | tr -d '\n')}"
seed_secret stream-token-secret "$STREAM_TOKEN_SECRET"
# org-jwt-secret is Terraform-managed (random_password + secret version); no seed here.
[ -n "${LINEAR_API_KEY:-}" ]    && seed_secret linear-api-key   "$LINEAR_API_KEY"    || echo "  linear-api-key: LINEAR_API_KEY not provided"
[ -n "${GITHUB_TOKEN:-}" ]      && seed_secret github-token     "$GITHUB_TOKEN"      || true
[ -n "${LANGSMITH_API_KEY:-}" ] && seed_secret langsmith-api-key "$LANGSMITH_API_KEY" || true
if [ -n "$EMAIL_SMTP_USER" ]; then seed_secret email-smtp-user "$EMAIL_SMTP_USER"; fi
if [ -n "$EMAIL_SMTP_PASSWORD" ]; then seed_secret email-smtp-password "$EMAIL_SMTP_PASSWORD"; fi
if [ -n "$GRAFANA_CLOUD_TOKEN_VALUE" ]; then
  seed_secret grafana-cloud-access-token "$GRAFANA_CLOUD_TOKEN_VALUE"
fi
unset GRAFANA_CLOUD_TOKEN_VALUE

enabled_version() {
  gcloud secrets versions list "$1" --project "$PROJECT_ID" \
    --filter='state=ENABLED' --limit=1 --format='value(name)'
}
EMAIL_SMTP_USER_VERSION="$(enabled_version email-smtp-user)"
EMAIL_SMTP_PASSWORD_VERSION="$(enabled_version email-smtp-password)"
EMAIL_SMTP_AUTH_ENABLED=false
EMAIL_SMTP_USER_READY=false
EMAIL_SMTP_PASSWORD_READY=false
[ -n "$EMAIL_SMTP_USER_VERSION" ] && EMAIL_SMTP_USER_READY=true
[ -n "$EMAIL_SMTP_PASSWORD_VERSION" ] && EMAIL_SMTP_PASSWORD_READY=true
if [ "$EMAIL_SMTP_USER_READY" != "$EMAIL_SMTP_PASSWORD_READY" ]; then
  echo "ERROR: email-smtp-user and email-smtp-password must both have an enabled version (or neither may)." >&2
  exit 1
fi
[ "$EMAIL_SMTP_USER_READY" = true ] && EMAIL_SMTP_AUTH_ENABLED=true
TFVARS+=( -var="email_smtp_auth_enabled=${EMAIL_SMTP_AUTH_ENABLED}" )

# Pin the exact enabled version while passing only Secret Manager metadata to
# Terraform. The secret value is never accessed after the optional local seed.
if [ "$GRAFANA_MONITORING_ENABLED" = "true" ]; then
  if [ -n "$GRAFANA_CLOUD_TOKEN_VERSION" ]; then
    GRAFANA_TOKEN_STATE="$(gcloud secrets versions describe "$GRAFANA_CLOUD_TOKEN_VERSION" \
      --secret=grafana-cloud-access-token --project "$PROJECT_ID" \
      --format='value(state)' 2>/dev/null || true)"
    [ "$GRAFANA_TOKEN_STATE" = "ENABLED" ] || {
      echo "ERROR: requested Grafana token version does not exist or is not enabled." >&2; exit 1;
    }
  else
    GRAFANA_TOKEN_NAME="$(gcloud secrets versions list grafana-cloud-access-token \
      --project "$PROJECT_ID" --filter='state=ENABLED' --sort-by='~createTime' \
      --limit=1 --format='value(name)' 2>/dev/null || true)"
    GRAFANA_CLOUD_TOKEN_VERSION="${GRAFANA_TOKEN_NAME##*/}"
  fi
  [[ "$GRAFANA_CLOUD_TOKEN_VERSION" =~ ^[0-9]+$ ]] || {
    echo "ERROR: monitoring is enabled, but grafana-cloud-access-token has no enabled version." >&2
    echo "Deploy once disabled, add the token version, then enable monitoring." >&2
    exit 1
  }
fi
TFVARS+=( -var="grafana_cloud_token_version=${GRAFANA_CLOUD_TOKEN_VERSION}" )

# linear-api-key is mounted as REQUIRED env — the revisions won't start without it.
has_version linear-api-key || { echo "ERROR: secret 'linear-api-key' has no version. Re-run with LINEAR_API_KEY=... set."; exit 1; }

# --- 6. Build + push images -------------------------------------------------
if [ "${SKIP_BUILD:-}" = "1" ]; then
  log "SKIP_BUILD=1 — reusing images already pushed at tag ${IMAGE_TAG}"
  if [ "$GRAFANA_MONITORING_ENABLED" = "true" ]; then
    gcloud artifacts docker images describe "${IMAGE_BASE}/grafana-alloy:${IMAGE_TAG}" >/dev/null 2>&1 || {
      echo "ERROR: SKIP_BUILD=1 but the grafana-alloy:${IMAGE_TAG} image does not exist." >&2; exit 1;
    }
  fi
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
  build_push_context() { # service, dockerfile, context
    docker build -f "$2" -t "${IMAGE_BASE}/$1:${IMAGE_TAG}" "$3"
    docker push "${IMAGE_BASE}/$1:${IMAGE_TAG}"
  }
  build_push gateway       Dockerfile.gateway
  build_push planner       Dockerfile.planner
  build_push coder-control Dockerfile.coder   # dual-role image; also runs the worker Job
  build_push pipeline-orchestrator Dockerfile.orchestrator
  build_push pipeline-tester       Dockerfile.tester
  build_push pipeline-deployer     Dockerfile.deployer
  if [ "$EGRESS_PROXY_ENABLED" = "true" ]; then build_push proxy Dockerfile.proxy; fi
  build_push email-service Dockerfile.email
  build_push provisioner Dockerfile.provisioner
  build_push grafana-alloy Dockerfile.alloy
  build_push_context org-service services/org/Dockerfile services/org
  # Settings copies the shared-core harness catalog, so it builds at repo root.
  build_push_context settings-service services/settings/Dockerfile .
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
  Monitoring  : ${GRAFANA_MONITORING_ENABLED}

  Next, in the Firebase console:
    - enable the Google sign-in provider (Authentication → Sign-in method), and
    - add the SPA origin (${SPA_ORIGIN}) and the gateway URL (${GATEWAY_URL})
      to Authentication → Settings → Authorized domains.
EOF
