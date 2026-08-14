#!/usr/bin/env bash
# Build, audit, and publish the versioned dual-format harness registry.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CALLER_CWD="$(pwd)"
DEFAULT_ENV_FILE="$REPO_ROOT/deploy/gcp/.env"
DEFAULT_SOURCES_REL="packages/shared-core/src/agent/registry/sources.json"
BUILDER_REL="scripts/build-harness-registry.js"
DEFAULT_SOURCES="$REPO_ROOT/$DEFAULT_SOURCES_REL"
BUILDER="$REPO_ROOT/$BUILDER_REL"

usage() {
  cat <<'EOF'
Usage: scripts/sync-harness-registry.sh [options]

Options:
  --bucket BUCKET    GCS bucket override (default: aifleet-registry)
  --sources PATH     Source manifest (default: the repo-pinned sources.json)
  --env-file PATH    Load configuration from PATH instead of deploy/gcp/.env
  --dry-run          Build and scan the bundle without uploading it
  -h, --help         Show this help

Environment:
  REGISTRY_BUCKET (or REGISTRY_BUCKET_OVERRIDE) overrides the bucket.
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

resolve_from_caller() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$CALLER_CWD" "$1" ;;
  esac
}

# Resolve the env file first; parse all options again after sourcing so command
# line values have unambiguous precedence over file/environment configuration.
ORIGINAL_ARGS=("$@")
ENV_FILE_ARG=""
i=0
while [ "$i" -lt "${#ORIGINAL_ARGS[@]}" ]; do
  if [ "${ORIGINAL_ARGS[$i]}" = "--env-file" ]; then
    i=$((i + 1))
    [ "$i" -lt "${#ORIGINAL_ARGS[@]}" ] || die "--env-file requires a path"
    ENV_FILE_ARG="${ORIGINAL_ARGS[$i]}"
  fi
  i=$((i + 1))
done

ENV_FILE=""
if [ -n "$ENV_FILE_ARG" ]; then
  ENV_FILE="$(resolve_from_caller "$ENV_FILE_ARG")"
  [ -f "$ENV_FILE" ] || die "env file does not exist: $ENV_FILE"
elif [ -f "$DEFAULT_ENV_FILE" ]; then
  ENV_FILE="$DEFAULT_ENV_FILE"
fi
if [ -n "$ENV_FILE" ]; then
  # shellcheck disable=SC1090 -- operator-selected local configuration file.
  . "$ENV_FILE"
  set -euo pipefail
fi


# Registry construction and upload do not need the deployment's internal API
# token. Never let an ambient or env-file copy reach Node, git, or gsutil.
unset INTERNAL_API_TOKEN TF_VAR_internal_api_token

CLI_BUCKET=""
CLI_SOURCES=""
DRY_RUN=false
i=0
while [ "$i" -lt "${#ORIGINAL_ARGS[@]}" ]; do
  arg="${ORIGINAL_ARGS[$i]}"
  case "$arg" in
    --bucket)
      i=$((i + 1))
      [ "$i" -lt "${#ORIGINAL_ARGS[@]}" ] || die "--bucket requires a value"
      CLI_BUCKET="${ORIGINAL_ARGS[$i]}"
      ;;
    --sources)
      i=$((i + 1))
      [ "$i" -lt "${#ORIGINAL_ARGS[@]}" ] || die "--sources requires a path"
      CLI_SOURCES="${ORIGINAL_ARGS[$i]}"
      ;;
    --env-file)
      i=$((i + 1))
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $arg"
      ;;
  esac
  i=$((i + 1))
done

for cmd in node git find mktemp tar; do
  command -v "$cmd" >/dev/null 2>&1 || die "missing required tool: $cmd"
done
NODE_VERSION="$(node --version)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
case "$NODE_MAJOR" in
  ""|*[!0-9]*) die "could not parse Node.js version: $NODE_VERSION" ;;
esac
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 22 or newer is required (found $NODE_VERSION)"
[ -f "$BUILDER" ] || die "missing registry builder: $BUILDER"

SOURCES="$DEFAULT_SOURCES"
if [ "$DRY_RUN" = true ]; then
  if [ -n "$CLI_SOURCES" ]; then
    SOURCES="$(resolve_from_caller "$CLI_SOURCES")"
  elif [ -n "${REGISTRY_SOURCES:-}" ]; then
    SOURCES="${REGISTRY_SOURCES}"
  fi
elif [ -n "$CLI_SOURCES" ] || [ -n "${REGISTRY_SOURCES:-}" ]; then
  die "--sources and REGISTRY_SOURCES are supported only with --dry-run; publishing uses committed HEAD sources.json"
fi

manifest_version() {
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const value = JSON.parse(fs.readFileSync(file, "utf8")).version;
    if (typeof value !== "string") {
      process.stderr.write(`Manifest version must be a string: ${file}\n`);
      process.exit(1);
    }
    process.stdout.write(value);
  ' "$SOURCES"
}

HEAD_SHA=""
if [ "$DRY_RUN" != true ]; then
  for cmd in gcloud gsutil head sed wc; do
    command -v "$cmd" >/dev/null 2>&1 || die "missing required tool: $cmd"
  done
  HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" \
    || die "repository has no committed HEAD"
  case "$HEAD_SHA" in
    ''|*[!0-9a-f]*) die "expected a full 40-character HEAD SHA, got '$HEAD_SHA'" ;;
  esac
  [ "${#HEAD_SHA}" -eq 40 ] || die "expected a full 40-character HEAD SHA, got '$HEAD_SHA'"
  STATUS="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)"
  if [ -n "$STATUS" ]; then
    printf 'ERROR: publishing requires a clean committed worktree:\n%s\n' "$STATUS" >&2
    exit 1
  fi
  gcloud auth print-access-token >/dev/null 2>&1 \
    || die "gcloud has no active credentials; run 'gcloud auth login' first"
fi

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aifleet-registry-publish.XXXXXX")"
LOCK_OBJECT=""
LOCK_HELD=false
LOCK_GENERATION=""
cleanup() {
  local exit_status=$?
  trap - EXIT HUP INT TERM
  if [ "$LOCK_HELD" = true ]; then
    LOCK_HELD=false
    if [ -z "$LOCK_GENERATION" ]; then
      printf 'ERROR: retained remote publish lock with unknown generation: %s\n' "$LOCK_OBJECT" >&2
      [ "$exit_status" -ne 0 ] || exit_status=1
    elif ! gsutil -h "x-goog-if-generation-match:${LOCK_GENERATION}" rm "$LOCK_OBJECT" >/dev/null 2>&1; then
      printf 'ERROR: failed to conditionally release remote publish lock generation %s: %s\n' \
        "$LOCK_GENERATION" "$LOCK_OBJECT" >&2
      [ "$exit_status" -ne 0 ] || exit_status=1
    fi
  fi
  rm -rf "$TEMP_DIR"
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

if [ "$DRY_RUN" != true ]; then
  # Publish from one immutable repository snapshot so the manifest, builder,
  # registry normalizers, and vendored skills all match the reported commit.
  STAGED_SOURCE="$TEMP_DIR/source"
  mkdir -p "$STAGED_SOURCE"
  git -C "$REPO_ROOT" archive --format=tar "$HEAD_SHA" | tar -xf - -C "$STAGED_SOURCE"
  SOURCES="$STAGED_SOURCE/$DEFAULT_SOURCES_REL"
  BUILDER="$STAGED_SOURCE/$BUILDER_REL"
  printf 'Source commit: %s\n' "$HEAD_SHA"
fi

[ -f "$SOURCES" ] || die "missing registry sources manifest: $SOURCES"
[ -f "$BUILDER" ] || die "missing registry builder: $BUILDER"

VERSION="$(manifest_version)"
case "$VERSION" in
  ""|"."|".."|*/*|*[!A-Za-z0-9._-]*)
    die "refusing invalid registry version: '$VERSION'"
    ;;
esac

BUCKET="$CLI_BUCKET"
[ -n "$BUCKET" ] || BUCKET="${REGISTRY_BUCKET:-${REGISTRY_BUCKET_OVERRIDE:-aifleet-registry}}"
[ -n "$BUCKET" ] || die "registry bucket must not be empty"
LOCK_OBJECT="gs://${BUCKET}/.locks/registry-publish.lock"

BUNDLE="$TEMP_DIR/registry"
WORK="$TEMP_DIR/clones"
export GIT_TERMINAL_PROMPT=0

printf 'Registry version: %s\n' "$VERSION"
printf 'Target bucket: gs://%s\n' "$BUCKET"
printf 'Validating pinned source plan...\n'
node "$BUILDER" --sources "$SOURCES" --dry-run
printf 'Building registry in a fresh temporary directory...\n'
node "$BUILDER" --sources "$SOURCES" --out "$BUNDLE" --work "$WORK"

SRC="$BUNDLE/$VERSION"
[ -d "$SRC" ] || die "built bundle is missing version directory: $SRC"
[ -f "$BUNDLE/registry-manifest.json" ] || die "built bundle is missing registry-manifest.json"

# Defense in depth over both original and normalized payloads. This intentionally
# checks filenames rather than prose, where words such as "token" are legitimate.
LEAKED="$(find "$BUNDLE" -type f \( \
  -name 'auth.json' -o -name 'credentials.json' -o -name '.netrc' -o \
  -name '.npmrc' -o -name '.pypirc' -o -name '.env' -o -name '.env.*' -o \
  -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o \
  -name '*.keystore' -o -name '*.jks' -o -name 'id_rsa*' -o \
  -name 'id_dsa*' -o -name 'id_ecdsa*' -o -name 'id_ed25519*' -o \
  -name '.mcp.json' -o -name 'mcp.json' \
\) -print)"
if [ -n "$LEAKED" ]; then
  printf 'ERROR: secret-like files leaked into the bundle:\n%s\n' "$LEAKED" >&2
  exit 1
fi

MCP_ROOT="$SRC/generic/mcp" node - <<'NODE'
const fs = require('fs');
const path = require('path');

const root = process.env.MCP_ROOT;
if (!fs.existsSync(root)) process.exit(0);

function forbiddenPath(value, at) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    const here = at ? `${at}.${key}` : key;
    if (key === 'env' || key === 'headers') return here;
    const nested = forbiddenPath(child, here);
    if (nested) return nested;
  }
  return null;
}

function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(file);
      continue;
    }
    if (!entry.isFile() || path.extname(entry.name) !== '.json') continue;
    const descriptor = JSON.parse(fs.readFileSync(file, 'utf8'));
    const forbidden = forbiddenPath(descriptor, '');
    if (forbidden) {
      throw new Error(`MCP descriptor retained ${forbidden}: ${file}`);
    }
  }
}

scan(root);
process.stdout.write('MCP descriptors clean.\n');
NODE
printf 'Secret-leak guard passed.\n'

DEST="gs://${BUCKET}/${VERSION}"
if [ "$DRY_RUN" = true ]; then
  printf 'Dry run: built and scanned %s\n' "$SRC"
  printf 'Dry run: would mirror %s -> %s and refresh gs://%s/registry-manifest.json\n' "$SRC" "$DEST" "$BUCKET"
  exit 0
fi

# Serialize the version mirror and shared manifest pointer across operator
# machines and the manual GitHub wrapper using an atomic GCS object create.
LOCK_FILE="$TEMP_DIR/publish-lock.txt"
printf 'kind=registry\nversion=%s\ncommit=%s\n' "$VERSION" "$HEAD_SHA" > "$LOCK_FILE"
if ! gsutil -h 'x-goog-if-generation-match:0' cp "$LOCK_FILE" "$LOCK_OBJECT" >/dev/null 2>&1; then
  if gsutil stat "$LOCK_OBJECT" >/dev/null 2>&1; then
    die "another registry publisher holds $LOCK_OBJECT (inspect it before removing a stale lock)"
  fi
  die "unable to acquire $LOCK_OBJECT; verify bucket access and connectivity"
fi
LOCK_HELD=true
LOCK_GENERATION="$(gsutil stat "$LOCK_OBJECT" 2>/dev/null \
  | sed -n 's/^[[:space:]]*Generation:[[:space:]]*//p' | head -1)"
case "$LOCK_GENERATION" in
  ''|*[!0-9]*) die "acquired $LOCK_OBJECT but could not resolve its generation; lock retained for inspection" ;;
esac

printf 'Publishing %s -> %s\n' "$SRC" "$DEST"
gsutil -m rsync -r -d "$SRC" "$DEST"
gsutil cp "$BUNDLE/registry-manifest.json" "gs://${BUCKET}/registry-manifest.json"

LISTING="$TEMP_DIR/listing.txt"
gsutil ls -r "$DEST" > "$LISTING"
printf 'Published objects: %s\n' "$(wc -l < "$LISTING")"
head -50 "$LISTING"
