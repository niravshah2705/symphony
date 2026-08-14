#!/usr/bin/env bash
# Publish the vendored deep-agent skills as a versioned GCS bundle.
#
# gsutil rsync mirrors only the selected version prefix; other version prefixes
# are never touched. A top-level manifest is refreshed as a convenience pointer
# after the selected version has been mirrored.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CALLER_CWD="$(pwd)"
DEFAULT_ENV_FILE="$REPO_ROOT/deploy/gcp/.env"
SKILLS_REL="packages/shared-core/src/agent/skills"
SKILLS_DIR="$REPO_ROOT/$SKILLS_REL"

usage() {
  cat <<'EOF'
Usage: scripts/publish-skills.sh [options]

Options:
  --version VERSION  Assert the version prefix (must match the manifest version)
  --bucket BUCKET    GCS bucket override
  --project PROJECT  GCP project used to derive <project>-aifleet-skills
  --env-file PATH    Load configuration from PATH instead of deploy/gcp/.env
  --dry-run          Validate and print the publish plan without uploading
  -h, --help         Show this help

Environment:
  SKILLS_BUCKET (or SKILLS_BUCKET_OVERRIDE) overrides the bucket.
  GCP_PROJECT_ID (or PROJECT_ID) supplies the project used for the default bucket.
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

# Locate the env file before parsing the remaining flags. Parsing again after
# sourcing guarantees that explicit CLI values win over file/environment values.
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

# These publishers never need the deployment's control-plane secret. Remove an
# ambient/exported copy as well as avoiding automatic export from the env file.
unset INTERNAL_API_TOKEN TF_VAR_internal_api_token

CLI_VERSION=""
CLI_VERSION_SET=false
CLI_BUCKET=""
CLI_PROJECT=""
DRY_RUN=false
i=0
while [ "$i" -lt "${#ORIGINAL_ARGS[@]}" ]; do
  arg="${ORIGINAL_ARGS[$i]}"
  case "$arg" in
    --version)
      i=$((i + 1))
      [ "$i" -lt "${#ORIGINAL_ARGS[@]}" ] || die "--version requires a value"
      CLI_VERSION="${ORIGINAL_ARGS[$i]}"
      CLI_VERSION_SET=true
      ;;
    --bucket)
      i=$((i + 1))
      [ "$i" -lt "${#ORIGINAL_ARGS[@]}" ] || die "--bucket requires a value"
      CLI_BUCKET="${ORIGINAL_ARGS[$i]}"
      ;;
    --project)
      i=$((i + 1))
      [ "$i" -lt "${#ORIGINAL_ARGS[@]}" ] || die "--project requires a value"
      CLI_PROJECT="${ORIGINAL_ARGS[$i]}"
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

for cmd in node; do
  command -v "$cmd" >/dev/null 2>&1 || die "missing required tool: $cmd"
done
NODE_VERSION="$(node --version)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
case "$NODE_MAJOR" in
  ""|*[!0-9]*) die "could not parse Node.js version: $NODE_VERSION" ;;
esac
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 22 or newer is required (found $NODE_VERSION)"

MANIFEST="$SKILLS_DIR/skills-manifest.json"
[ -f "$MANIFEST" ] || die "missing skills manifest: $MANIFEST"

manifest_version() {
  local manifest_file="${1:-$MANIFEST}"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const value = JSON.parse(fs.readFileSync(file, "utf8")).version;
    if (typeof value !== "string") {
      process.stderr.write(`Manifest version must be a string: ${file}\n`);
      process.exit(1);
    }
    process.stdout.write(value);
  ' "$manifest_file"
}

MANIFEST_VERSION="$(manifest_version)"
if [ "$CLI_VERSION_SET" = true ]; then
  VERSION="$CLI_VERSION"
else
  VERSION="$MANIFEST_VERSION"
fi
case "$VERSION" in
  ""|"."|".."|*/*|*[!A-Za-z0-9._-]*)
    die "refusing invalid skills version: '$VERSION'"
    ;;
esac
if [ "$VERSION" != "$MANIFEST_VERSION" ]; then
  die "requested skills version '$VERSION' does not match manifest version '$MANIFEST_VERSION'"
fi

BUCKET="$CLI_BUCKET"
[ -n "$BUCKET" ] || BUCKET="${SKILLS_BUCKET:-${SKILLS_BUCKET_OVERRIDE:-}}"
PROJECT="$CLI_PROJECT"
[ -n "$PROJECT" ] || PROJECT="${GCP_PROJECT_ID:-${PROJECT_ID:-}}"
if [ -z "$BUCKET" ]; then
  [ -n "$PROJECT" ] || die "set GCP_PROJECT_ID (or PROJECT_ID), SKILLS_BUCKET, or --bucket"
  BUCKET="${PROJECT}-aifleet-skills"
fi

DEST="gs://${BUCKET}/${VERSION}"
printf 'Skills version: %s\n' "$VERSION"
printf 'Target bucket: gs://%s\n' "$BUCKET"

if [ "$DRY_RUN" = true ]; then
  printf 'Dry run: would stage tracked HEAD content from %s and mirror it -> %s\n' "$SKILLS_REL" "$DEST"
  printf 'Dry run: would refresh %s/skills-manifest.json and gs://%s/skills-manifest.json\n' "$DEST" "$BUCKET"
  exit 0
fi

for cmd in git gcloud gsutil find mktemp tar head sed wc; do
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

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aifleet-skills-publish.XXXXXX")"
LOCK_OBJECT="gs://${BUCKET}/.locks/skills-publish.lock"
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

# Never upload from the live checkout: ignored files are intentionally absent
# from git status and could otherwise ride along in a directory-level rsync.
# Archiving HEAD also makes every uploaded byte traceable to the clean commit.
ARCHIVE="$TEMP_DIR/skills.tar"
printf 'Source commit: %s\n' "$HEAD_SHA"
git -C "$REPO_ROOT" archive --format=tar --output="$ARCHIVE" "$HEAD_SHA" -- "$SKILLS_REL"
tar -xf "$ARCHIVE" -C "$TEMP_DIR"
STAGED_SKILLS="$TEMP_DIR/$SKILLS_REL"
STAGED_MANIFEST="$STAGED_SKILLS/skills-manifest.json"
[ -f "$STAGED_MANIFEST" ] || die "tracked HEAD archive is missing skills-manifest.json"
STAGED_MANIFEST_VERSION="$(manifest_version "$STAGED_MANIFEST")"
if [ "$VERSION" != "$STAGED_MANIFEST_VERSION" ]; then
  die "requested skills version '$VERSION' does not match committed manifest version '$STAGED_MANIFEST_VERSION'"
fi
SYMLINKS="$(find "$STAGED_SKILLS" -type l -print)"
if [ -n "$SYMLINKS" ]; then
  printf 'ERROR: refusing symlinks in the tracked skills archive:\n%s\n' "$SYMLINKS" >&2
  exit 1
fi

# This GCS create-if-absent lock serializes local operators with manual Actions
# runs, including the shared top-level manifest pointer. A stale lock must be
# inspected and removed manually only after confirming no publisher is active.
LOCK_FILE="$TEMP_DIR/publish-lock.txt"
printf 'kind=skills\nversion=%s\ncommit=%s\n' "$VERSION" "$HEAD_SHA" > "$LOCK_FILE"
if ! gsutil -h 'x-goog-if-generation-match:0' cp "$LOCK_FILE" "$LOCK_OBJECT" >/dev/null 2>&1; then
  if gsutil stat "$LOCK_OBJECT" >/dev/null 2>&1; then
    die "another skills publisher holds $LOCK_OBJECT (inspect it before removing a stale lock)"
  fi
  die "unable to acquire $LOCK_OBJECT; verify bucket access and connectivity"
fi
LOCK_HELD=true
LOCK_GENERATION="$(gsutil stat "$LOCK_OBJECT" 2>/dev/null \
  | sed -n 's/^[[:space:]]*Generation:[[:space:]]*//p' | head -1)"
case "$LOCK_GENERATION" in
  ''|*[!0-9]*) die "acquired $LOCK_OBJECT but could not resolve its generation; lock retained for inspection" ;;
esac

printf 'Publishing tracked HEAD skills %s -> %s\n' "$STAGED_SKILLS" "$DEST"
gsutil -m rsync -r -d "$STAGED_SKILLS" "$DEST"
gsutil cp "$STAGED_MANIFEST" "$DEST/skills-manifest.json"
gsutil cp "$STAGED_MANIFEST" "gs://${BUCKET}/skills-manifest.json"

LISTING="$TEMP_DIR/listing.txt"
gsutil ls -r "$DEST" > "$LISTING"
printf 'Published objects: %s\n' "$(wc -l < "$LISTING")"
head -50 "$LISTING"
