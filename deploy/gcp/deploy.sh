#!/usr/bin/env bash
#
# Selective operator-driven GCP deployment. This is the canonical implementation
# used both locally and by the manual GitHub Actions wrapper.
#
# Usage:
#   ./deploy/gcp/deploy.sh                    # deploy newest-commit changes only
#   ./deploy/gcp/deploy.sh --since <git-ref>  # deploy changes since a chosen ref
#   ./deploy/gcp/deploy.sh --all              # rebuild/deploy the whole stack
#   ./deploy/gcp/deploy.sh --plan             # print the plan; make no cloud calls
#
# Configuration is loaded from deploy/gcp/.env when it exists. Pass
# --env-file <path> to select another trusted shell-assignment file. Existing
# environment variables and GitHub's manual wrapper are also supported.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEFAULT_ENV_FILE="$SCRIPT_DIR/.env"
ENV_FILE="$DEFAULT_ENV_FILE"
ENV_FILE_EXPLICIT=false

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --all              Build every image, deploy the SPA, and apply Terraform.
  --since <git-ref>  Compare the ref's merge-base with HEAD (default: HEAD^).
  --plan             Print the resolved JSON plan and exit before cloud access.
  --env-file <path>  Load configuration from a trusted shell env file.
  -h, --help         Show this help.

The HEAD^ default covers only the newest commit. After more than one commit has
accumulated, pass the last successfully deployed ref to --since or use --all.
EOF
}

# Locate the env file before normal argument parsing so file values can provide
# defaults. The file is operator-owned and may contain quoted shell assignments.
expect_env_file=false
for scan_arg in "$@"; do
  if [ "$expect_env_file" = true ]; then
    ENV_FILE="$scan_arg"
    ENV_FILE_EXPLICIT=true
    expect_env_file=false
  elif [ "$scan_arg" = "--env-file" ]; then
    expect_env_file=true
  fi
done
if [ "$expect_env_file" = true ]; then
  echo "deploy: --env-file requires a path" >&2
  exit 2
fi

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090 -- the operator explicitly selects this local file.
  . "$ENV_FILE"
elif [ "$ENV_FILE_EXPLICIT" = true ]; then
  echo "deploy: env file not found: $ENV_FILE" >&2
  exit 2
fi

# Keep the control-plane secret out of planning, Docker/npm builds, Firebase,
# gcloud lookups, and Terraform init/output. The non-exported value is exposed
# only to the Terraform apply process below.
DEPLOY_INTERNAL_API_TOKEN="${INTERNAL_API_TOKEN:-${TF_VAR_internal_api_token:-}}"
unset INTERNAL_API_TOKEN TF_VAR_internal_api_token

FORCE_ALL="${DEPLOY_ALL:-false}"
CHANGED_SINCE="${CHANGED_SINCE:-HEAD^}"
PLAN_ONLY=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --all) FORCE_ALL=true ;;
    --since)
      [ "$#" -ge 2 ] || { echo "deploy: --since requires a git ref" >&2; exit 2; }
      CHANGED_SINCE="$2"
      shift
      ;;
    --plan) PLAN_ONLY=true ;;
    --env-file)
      [ "$#" -ge 2 ] || { echo "deploy: --env-file requires a path" >&2; exit 2; }
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "deploy: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

case "$FORCE_ALL" in true|false) ;; *) echo "deploy: DEPLOY_ALL must be true or false" >&2; exit 2 ;; esac

command -v node >/dev/null 2>&1 || { echo "deploy: missing required tool: node" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "deploy: missing required tool: jq" >&2; exit 1; }
node -e 'const major=Number(process.versions.node.split(".")[0]); if (major < 22) { console.error(`deploy: Node 22+ required (found ${process.version})`); process.exit(1); }'

DEPLOY_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if [[ ! "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "deploy: HEAD did not resolve to a full immutable commit SHA" >&2
  exit 1
fi

PIPELINE_ORCHESTRATOR_ENABLED="${PIPELINE_ORCHESTRATOR_ENABLED:-false}"
case "$PIPELINE_ORCHESTRATOR_ENABLED" in true|false) ;; *) echo "deploy: PIPELINE_ORCHESTRATOR_ENABLED must be true or false" >&2; exit 2 ;; esac

plan_args=(--sha "$DEPLOY_SHA" --pipeline-enabled "$PIPELINE_ORCHESTRATOR_ENABLED")
if [ "$FORCE_ALL" = true ]; then
  plan_args+=(--all)
else
  if [ "$CHANGED_SINCE" = "HEAD^" ]; then
    echo "deploy: HEAD^ selects only the newest commit; use --since <last-deployed-ref> after a deployment gap" >&2
  fi
  case "$CHANGED_SINCE" in
    ''|-*|*[!A-Za-z0-9._/~^:-]*)
      echo "deploy: refusing unsafe --since ref: $CHANGED_SINCE" >&2
      exit 2
      ;;
  esac
  CHANGED_SINCE_SHA="$(git -C "$REPO_ROOT" rev-parse --verify "${CHANGED_SINCE}^{commit}" 2>/dev/null)" \
    || { echo "deploy: unable to resolve --since ref: $CHANGED_SINCE" >&2; exit 2; }
  if [[ ! "$CHANGED_SINCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    echo "deploy: --since did not resolve to a full commit SHA" >&2
    exit 2
  fi
  plan_args+=(--since "$CHANGED_SINCE_SHA")
fi
DEPLOY_PLAN="$(node "$SCRIPT_DIR/deploy-plan.js" "${plan_args[@]}")"

printf 'Deployment plan for %s\n' "$DEPLOY_SHA"
printf '%s\n' "$DEPLOY_PLAN" | jq .
if [ "$PLAN_ONLY" = true ]; then
  exit 0
fi

SERVICE_COUNT="$(printf '%s' "$DEPLOY_PLAN" | jq '.services | length')"
DEPLOY_SPA="$(printf '%s' "$DEPLOY_PLAN" | jq -r '.spa')"
RUN_TERRAFORM="$(printf '%s' "$DEPLOY_PLAN" | jq -r '.terraform')"
if [ "$SERVICE_COUNT" -eq 0 ] && [ "$DEPLOY_SPA" = false ] && [ "$RUN_TERRAFORM" = false ]; then
  echo "No deployable changes detected. Use --all to force a full deployment."
  exit 0
fi

DIRTY="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)"
if [ -n "$DIRTY" ]; then
  echo "deploy: refusing to publish from a dirty worktree:" >&2
  printf '%s\n' "$DIRTY" >&2
  exit 1
fi

# Canonical names mirror GitHub repository variables. The former local script's
# PROJECT_ID/REGION names remain accepted for compatibility.
GCP_PROJECT_ID="${GCP_PROJECT_ID:-${PROJECT_ID:-}}"
GCP_REGION="${GCP_REGION:-${REGION:-asia-south1}}"
AR_REPO="${AR_REPO:-ai-fleet}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"
TF_DIR="${TF_DIR:-deploy/gcp/terraform}"
TF_STATE_PREFIX="${TF_STATE_PREFIX:-ai-fleet/gcp}"
TF_STATE_BUCKET="${TF_STATE_BUCKET:-}"
SPA_BUCKET="${SPA_BUCKET:-}"
GATEWAY_SERVICE_NAME="${GATEWAY_SERVICE_NAME:-gateway}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-nam5}"
SPA_ORIGIN="${SPA_ORIGIN:-https://${GCP_PROJECT_ID}.web.app}"
FIREBASE_ALLOWED_DOMAIN="${FIREBASE_ALLOWED_DOMAIN:-}"
AUTH_ADMIN_EMAILS="${AUTH_ADMIN_EMAILS:-}"
AUTH_DEFAULT_ROLE="${AUTH_DEFAULT_ROLE:-viewer}"
GOOGLE_ONE_TAP_CLIENT_ID="${GOOGLE_ONE_TAP_CLIENT_ID:-}"
SKILLS_BUCKET="${SKILLS_BUCKET:-}"
SKILLS_VERSION="${SKILLS_VERSION:-v1}"
REGISTRY_BUCKET="${REGISTRY_BUCKET:-aifleet-registry}"
SPA_OBFUSCATION_STRENGTH="${SPA_OBFUSCATION_STRENGTH:-light}"
PROVISIONING_ENABLED="${PROVISIONING_ENABLED:-false}"
PIPELINE_DEPLOYMENT_ENABLED="${PIPELINE_DEPLOYMENT_ENABLED:-false}"
SETTINGS_OPERATOR_INVOKER="${SETTINGS_OPERATOR_INVOKER:-}"
EMAIL_SMTP_HOST="${EMAIL_SMTP_HOST:-}"
EMAIL_SMTP_PORT="${EMAIL_SMTP_PORT:-587}"
EMAIL_SMTP_SECURE="${EMAIL_SMTP_SECURE:-false}"
EMAIL_SMTP_REQUIRE_TLS="${EMAIL_SMTP_REQUIRE_TLS:-true}"
EMAIL_SMTP_AUTH_ENABLED="${EMAIL_SMTP_AUTH_ENABLED:-false}"
EMAIL_FROM="${EMAIL_FROM:-}"
EMAIL_PUBLIC_APP_URL="${EMAIL_PUBLIC_APP_URL:-https://${GCP_PROJECT_ID}.web.app}"

validate_bool() {
  case "$2" in true|false) ;; *) echo "deploy: $1 must be true or false" >&2; exit 2 ;; esac
}
validate_bool PROVISIONING_ENABLED "$PROVISIONING_ENABLED"
validate_bool PIPELINE_DEPLOYMENT_ENABLED "$PIPELINE_DEPLOYMENT_ENABLED"
validate_bool EMAIL_SMTP_SECURE "$EMAIL_SMTP_SECURE"
validate_bool EMAIL_SMTP_REQUIRE_TLS "$EMAIL_SMTP_REQUIRE_TLS"
validate_bool EMAIL_SMTP_AUTH_ENABLED "$EMAIL_SMTP_AUTH_ENABLED"

[ -n "$GCP_PROJECT_ID" ] || { echo "deploy: set GCP_PROJECT_ID (or PROJECT_ID)" >&2; exit 1; }
[ -n "$TF_STATE_BUCKET" ] || { echo "deploy: set TF_STATE_BUCKET for the cross-machine deployment lock" >&2; exit 1; }
if [ "$RUN_TERRAFORM" = true ]; then
  [ -n "$SPA_BUCKET" ] || { echo "deploy: set SPA_BUCKET" >&2; exit 1; }
  [ -n "$DEPLOY_INTERNAL_API_TOKEN" ] || { echo "deploy: set INTERNAL_API_TOKEN for the mandatory egress proxy" >&2; exit 1; }
fi

for command_name in gcloud gsutil head jq sed; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "deploy: missing required tool: $command_name" >&2; exit 1; }
done
command -v tar >/dev/null 2>&1 || { echo "deploy: missing required tool: tar" >&2; exit 1; }
if [ "$SERVICE_COUNT" -gt 0 ]; then
  command -v docker >/dev/null 2>&1 || { echo "deploy: missing required tool: docker" >&2; exit 1; }
fi
if [ "$DEPLOY_SPA" = true ]; then
  command -v npm >/dev/null 2>&1 || { echo "deploy: missing required tool: npm" >&2; exit 1; }
  command -v npx >/dev/null 2>&1 || { echo "deploy: missing required tool: npx" >&2; exit 1; }
fi
if [ "$RUN_TERRAFORM" = true ]; then
  command -v terraform >/dev/null 2>&1 || { echo "deploy: missing required tool: terraform" >&2; exit 1; }
fi
gcloud auth print-access-token >/dev/null 2>&1 || { echo "deploy: authenticate first with gcloud auth login/application-default login" >&2; exit 1; }
if [ "$RUN_TERRAFORM" = true ]; then
  gcloud auth application-default print-access-token >/dev/null 2>&1 \
    || { echo "deploy: Terraform requires Application Default Credentials; run gcloud auth application-default login" >&2; exit 1; }
fi

case "$TF_DIR" in
  "$REPO_ROOT"/*) TF_DIR_RELATIVE="${TF_DIR#"$REPO_ROOT"/}" ;;
  /*)
    echo "deploy: TF_DIR must be inside the committed repository" >&2
    exit 2
    ;;
  *) TF_DIR_RELATIVE="$TF_DIR" ;;
esac
case "$TF_DIR_RELATIVE" in
  ''|..|../*|*/..|*/../*)
    echo "deploy: refusing unsafe TF_DIR: $TF_DIR" >&2
    exit 2
    ;;
esac
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ai-fleet-deploy.XXXXXX")"
LOCK_KEY="$(printf '%s' "$GCP_PROJECT_ID" | tr -c 'A-Za-z0-9._-' '_')"
LOCK_DIR="${TMPDIR:-/tmp}/ai-fleet-gcp-deploy-${LOCK_KEY}.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  rm -rf "$TEMP_ROOT"
  echo "deploy: another local deployment appears active ($LOCK_DIR)" >&2
  exit 1
fi
printf '%s\n' "$$" > "$LOCK_DIR/pid"
REMOTE_LOCK_OBJECT="gs://${TF_STATE_BUCKET}/.locks/gcp-deploy-${LOCK_KEY}.lock"
REMOTE_LOCK_HELD=false
REMOTE_LOCK_GENERATION=""
cleanup() {
  local exit_status=$?
  trap - EXIT HUP INT TERM
  if [ "$REMOTE_LOCK_HELD" = true ]; then
    REMOTE_LOCK_HELD=false
    if [ -z "$REMOTE_LOCK_GENERATION" ]; then
      printf 'deploy: retained remote lock with unknown generation: %s\n' "$REMOTE_LOCK_OBJECT" >&2
      [ "$exit_status" -ne 0 ] || exit_status=1
    elif ! gsutil -h "x-goog-if-generation-match:${REMOTE_LOCK_GENERATION}" \
      rm "$REMOTE_LOCK_OBJECT" >/dev/null 2>&1; then
      printf 'deploy: failed to conditionally release remote lock generation %s: %s\n' \
        "$REMOTE_LOCK_GENERATION" "$REMOTE_LOCK_OBJECT" >&2
      [ "$exit_status" -ne 0 ] || exit_status=1
    fi
  fi
  rm -rf "$TEMP_ROOT"
  rm -rf "$LOCK_DIR"
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

log() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }

# Terraform locks state writes, but it does not serialize Firebase Hosting or
# the ordering of separate applies. This generation-fenced object covers the
# complete mutating run across operator machines and the manual wrapper.
REMOTE_LOCK_FILE="$TEMP_ROOT/deploy-lock.txt"
printf 'kind=deploy\nproject=%s\ncommit=%s\n' "$GCP_PROJECT_ID" "$DEPLOY_SHA" > "$REMOTE_LOCK_FILE"
if ! gsutil -h 'x-goog-if-generation-match:0' cp \
  "$REMOTE_LOCK_FILE" "$REMOTE_LOCK_OBJECT" >/dev/null 2>&1; then
  if gsutil stat "$REMOTE_LOCK_OBJECT" >/dev/null 2>&1; then
    echo "deploy: another deployment holds $REMOTE_LOCK_OBJECT (inspect it before removing a stale lock)" >&2
  else
    echo "deploy: unable to acquire $REMOTE_LOCK_OBJECT; verify bucket access and connectivity" >&2
  fi
  exit 1
fi
REMOTE_LOCK_HELD=true
REMOTE_LOCK_GENERATION="$(gsutil stat "$REMOTE_LOCK_OBJECT" 2>/dev/null \
  | sed -n 's/^[[:space:]]*Generation:[[:space:]]*//p' | head -1)"
case "$REMOTE_LOCK_GENERATION" in
  ''|*[!0-9]*)
    echo "deploy: acquired $REMOTE_LOCK_OBJECT but could not resolve its generation; lock retained" >&2
    exit 1
    ;;
esac

# Build and deploy only the immutable commit identified above. Besides making
# local and GitHub executions equivalent, this keeps ignored local credentials
# and service-level .env files out of Docker, npm, Firebase, and Terraform.
SOURCE_ROOT="$TEMP_ROOT/source"
mkdir -p "$SOURCE_ROOT"
git -C "$REPO_ROOT" archive --format=tar "$DEPLOY_SHA" | tar -xf - -C "$SOURCE_ROOT"
TF_DIR="$SOURCE_ROOT/$TF_DIR_RELATIVE"
[ -d "$TF_DIR" ] || { echo "deploy: Terraform directory is absent from commit: $TF_DIR_RELATIVE" >&2; exit 1; }

if [ "$SERVICE_COUNT" -gt 0 ]; then
  log "Checking Artifact Registry and configuring Docker"
  if ! gcloud artifacts repositories describe "$AR_REPO" \
    --project "$GCP_PROJECT_ID" --location "$GCP_REGION" >/dev/null 2>&1; then
    echo "deploy: Artifact Registry $AR_REPO is missing; run deploy/gcp/bootstrap.sh first" >&2
    exit 1
  fi
  gcloud auth configure-docker "${GCP_REGION}-docker.pkg.dev" -q

  while IFS=$'\t' read -r service_id image_name dockerfile context; do
    image="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${AR_REPO}/${image_name}:${DEPLOY_SHA}"
    log "Building ${service_id}"
    docker build --platform "$DOCKER_PLATFORM" \
      -f "$SOURCE_ROOT/$dockerfile" -t "$image" "$SOURCE_ROOT/$context"
    docker push "$image"
    echo "Pushed $image"
  done < <(printf '%s' "$DEPLOY_PLAN" | jq -r '.services[] | [.id, .image, .dockerfile, .context] | @tsv')
fi

PROJECT_NUMBER=""
GATEWAY_URL=""
if [ "$DEPLOY_SPA" = true ] || [ "$RUN_TERRAFORM" = true ]; then
  PROJECT_NUMBER="$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')"
  [ -n "$PROJECT_NUMBER" ] || { echo "deploy: unable to resolve GCP project number" >&2; exit 1; }
  GATEWAY_URL="https://${GATEWAY_SERVICE_NAME}-${PROJECT_NUMBER}.${GCP_REGION}.run.app"
fi

if [ "$DEPLOY_SPA" = true ]; then
  log "Staging and deploying the obfuscated SPA"
  (
    cd "$SOURCE_ROOT"
    npm ci --no-audit --no-fund --ignore-scripts
    node scripts/obfuscate-spa.js \
      --src public --out "$TEMP_ROOT/spa-public" --strength "$SPA_OBFUSCATION_STRENGTH"
  )
  printf '%s\n' \
    "window.__API_BASE__='$GATEWAY_URL';" \
    "(()=>{const link=document.createElement('link');link.rel='preconnect';link.href=window.__API_BASE__;link.crossOrigin='anonymous';document.head.appendChild(link);})();" \
    > "$TEMP_ROOT/spa-public/config.js"
  jq --arg public "$TEMP_ROOT/spa-public" '.hosting.public = $public' \
    "$SOURCE_ROOT/firebase.json" > "$TEMP_ROOT/firebase.json"
  (
    cd "$SOURCE_ROOT"
    npx --yes firebase-tools@13 deploy --only hosting \
      --project "$GCP_PROJECT_ID" --config "$TEMP_ROOT/firebase.json" --non-interactive
  )
fi

if [ "$RUN_TERRAFORM" = true ]; then
  log "Resolving immutable image tags"
  DEPLOY_SERVICES_JSON="$(printf '%s' "$DEPLOY_PLAN" | jq -c '.services')"
  export DEPLOY_SERVICES_JSON DEPLOY_SHA GCP_PROJECT_ID GCP_REGION GATEWAY_SERVICE_NAME
  export PIPELINE_ORCHESTRATOR_ENABLED PROVISIONING_ENABLED
  # shellcheck source=deploy-lib.sh
  . "$SCRIPT_DIR/deploy-lib.sh"
  write_all_tags > "$TEMP_ROOT/image-tags"
  cat "$TEMP_ROOT/image-tags"

  tag_value() {
    sed -n "s/^$1=//p" "$TEMP_ROOT/image-tags"
  }

  log "Terraform init"
  terraform -chdir="$TF_DIR" init -input=false \
    -backend-config="bucket=${TF_STATE_BUCKET}" \
    -backend-config="prefix=${TF_STATE_PREFIX}"

  apply_args=(
    -var="project_id=${GCP_PROJECT_ID}"
    -var="region=${GCP_REGION}"
    -var="artifact_repo=${AR_REPO}"
    -var="spa_bucket_name=${SPA_BUCKET}"
    -var="firestore_location=${FIRESTORE_LOCATION}"
    -var="gateway_service_name=${GATEWAY_SERVICE_NAME}"
    -var="spa_origin=${SPA_ORIGIN}"
    -var="api_base_url=${GATEWAY_URL}"
    -var="firebase_allowed_domain=${FIREBASE_ALLOWED_DOMAIN}"
    -var="auth_admin_emails=${AUTH_ADMIN_EMAILS}"
    -var="auth_default_role=${AUTH_DEFAULT_ROLE}"
    -var="google_one_tap_client_id=${GOOGLE_ONE_TAP_CLIENT_ID}"
    -var="skills_bucket_name=${SKILLS_BUCKET}"
    -var="skills_version=${SKILLS_VERSION}"
    -var="registry_bucket_name=${REGISTRY_BUCKET}"
    -var="egress_proxy_enabled=true"
    -var="provisioning_enabled=${PROVISIONING_ENABLED}"
    -var="pipeline_orchestrator_enabled=${PIPELINE_ORCHESTRATOR_ENABLED}"
    -var="pipeline_deployment_enabled=${PIPELINE_DEPLOYMENT_ENABLED}"
    -var="settings_operator_invoker=${SETTINGS_OPERATOR_INVOKER}"
    -var="email_smtp_host=${EMAIL_SMTP_HOST}"
    -var="email_smtp_port=${EMAIL_SMTP_PORT}"
    -var="email_smtp_secure=${EMAIL_SMTP_SECURE}"
    -var="email_smtp_require_tls=${EMAIL_SMTP_REQUIRE_TLS}"
    -var="email_smtp_auth_enabled=${EMAIL_SMTP_AUTH_ENABLED}"
    -var="email_from=${EMAIL_FROM}"
    -var="email_public_app_url=${EMAIL_PUBLIC_APP_URL}"
    -var="gateway_image_tag=$(tag_value gateway)"
    -var="planner_image_tag=$(tag_value planner)"
    -var="coder_image_tag=$(tag_value coder)"
    -var="orchestrator_image_tag=$(tag_value orchestrator)"
    -var="tester_image_tag=$(tag_value tester)"
    -var="deployer_image_tag=$(tag_value deployer)"
    -var="provisioner_image_tag=$(tag_value provisioner)"
    -var="proxy_image_tag=$(tag_value proxy)"
    -var="org_image_tag=$(tag_value org)"
    -var="settings_image_tag=$(tag_value settings)"
    -var="email_image_tag=$(tag_value email)"
  )

  log "Terraform apply"
  TF_VAR_internal_api_token="$DEPLOY_INTERNAL_API_TOKEN" \
    terraform -chdir="$TF_DIR" apply -input=false -auto-approve "${apply_args[@]}"
  terraform -chdir="$TF_DIR" output
fi

log "Deployment complete"
[ -n "$GATEWAY_URL" ] && echo "Gateway: $GATEWAY_URL"
