#!/usr/bin/env bash

set -euo pipefail

# Capture the manual wrapper's contents:write token as a non-exported shell
# variable, then remove it before npm/npx or tested code can run. It is
# reintroduced only for the GitHub CLI calls that validate and publish.
RELEASE_GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
# GH_REPO can override repository inference even after changing directory. The
# release target below is derived from this checkout's origin and passed to every
# GitHub operation explicitly, so an ambient override must never participate.
unset GH_TOKEN GITHUB_TOKEN GH_REPO

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)

usage() {
  cat <<'EOF'
Usage: scripts/release-cli.sh --version <semver> [--dry-run]

Build and optionally publish an adlc CLI release from the committed HEAD.
Artifacts are written to dist/adlc-v<version>/.

Options:
  --version <semver>  Release version, for example 1.2.0
  --dry-run           Build and verify artifacts without creating a GitHub release
  -h, --help          Show this help
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

resolve_release_repository() {
  local remote_url remainder authority repository_path owner repository

  remote_url=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null) \
    || die "unable to resolve the GitHub repository: origin has no URL"
  remote_url=${remote_url%/}

  case "$remote_url" in
    https://*|http://*|ssh://*|git://*)
      remainder=${remote_url#*://}
      authority=${remainder%%/*}
      [ "$authority" != "$remainder" ] \
        || die "origin URL does not identify a GitHub repository"
      RELEASE_GITHUB_HOST=${authority##*@}
      repository_path=${remainder#*/}
      ;;
    *@*:*|[A-Za-z0-9._-]*:*)
      authority=${remote_url%%:*}
      RELEASE_GITHUB_HOST=${authority##*@}
      repository_path=${remote_url#*:}
      ;;
    *)
      die "unsupported origin URL (expected HTTP(S), SSH, or Git transport)"
      ;;
  esac

  repository_path=${repository_path#/}
  repository_path=${repository_path%/}
  repository_path=${repository_path%.git}
  case "$repository_path" in
    */*) ;;
    *) die "origin URL does not identify an owner/repository" ;;
  esac
  owner=${repository_path%%/*}
  repository=${repository_path#*/}

  case "$RELEASE_GITHUB_HOST" in
    ''|*[!A-Za-z0-9._:-]*) die "origin URL has an invalid GitHub host" ;;
  esac
  case "$owner" in
    ''|*[!A-Za-z0-9_.-]*) die "origin URL has an invalid GitHub owner" ;;
  esac
  case "$repository" in
    ''|*/*|*[!A-Za-z0-9_.-]*) die "origin URL has an invalid GitHub repository" ;;
  esac

  RELEASE_GITHUB_REPOSITORY="$owner/$repository"
  RELEASE_GITHUB_TARGET="$RELEASE_GITHUB_HOST/$RELEASE_GITHUB_REPOSITORY"
}

run_gh() {
  if [ -n "$RELEASE_GH_TOKEN" ]; then
    GH_TOKEN="$RELEASE_GH_TOKEN" command gh "$@"
  else
    command gh "$@"
  fi
}

validate_remote_tag() {
  local remote_refs existing_sha

  remote_refs=$(run_gh api --hostname "$RELEASE_GITHUB_HOST" \
    "repos/${RELEASE_GITHUB_REPOSITORY}/git/matching-refs/tags/${TAG}" \
    --jq '.[].ref') \
    || die "unable to inspect remote tag $TAG in $RELEASE_GITHUB_TARGET"

  if printf '%s\n' "$remote_refs" | grep -Fxq "refs/tags/$TAG"; then
    existing_sha=$(run_gh api --hostname "$RELEASE_GITHUB_HOST" \
      "repos/${RELEASE_GITHUB_REPOSITORY}/commits/${TAG}" --jq '.sha') \
      || die "unable to resolve existing remote tag $TAG in $RELEASE_GITHUB_TARGET"
    case "$existing_sha" in
      ''|*[!0-9a-f]*) die "existing remote tag $TAG did not resolve to a full commit SHA" ;;
    esac
    [ "${#existing_sha}" -eq 40 ] \
      || die "existing remote tag $TAG did not resolve to a full commit SHA"
    [ "$existing_sha" = "$HEAD_SHA" ] \
      || die "existing remote tag $TAG points to $existing_sha, not release commit $HEAD_SHA"
    printf 'Verified existing remote tag %s at %s.\n' "$TAG" "$HEAD_SHA"
  fi
}

validate_semver() {
  local version core prerelease identifier old_ifs
  version=$1

  if ! printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'; then
    return 1
  fi

  core=${version%%+*}
  case "$core" in
    *-*) prerelease=${core#*-} ;;
    *) return 0 ;;
  esac

  old_ifs=$IFS
  IFS=.
  # SemVer forbids leading zeroes only for numeric pre-release identifiers.
  for identifier in $prerelease; do
    case "$identifier" in
      0|'') ;;
      0*[!0-9]*) ;;
      0*) IFS=$old_ifs; return 1 ;;
    esac
  done
  IFS=$old_ifs
  return 0
}

preflight_node() {
  local node_version node_major

  require_command node
  node_version=$(node --version)
  node_version=${node_version#v}
  node_major=${node_version%%.*}

  case "$node_major" in
    ''|*[!0-9]*) die "could not determine the Node.js version" ;;
  esac

  if [ "$node_major" -lt 22 ]; then
    die "Node.js 22 or newer is required (found v$node_version)"
  fi
}

write_checksums() {
  local bundle_name tarball_name
  bundle_name=$1
  tarball_name=$2

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$bundle_name" "$tarball_name"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$bundle_name" "$tarball_name"
  else
    die "sha256sum or shasum is required to create SHA256SUMS"
  fi
}

VERSION=''
DRY_RUN=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version requires a value"
      [ -z "$VERSION" ] || die "--version may only be specified once"
      VERSION=$2
      shift 2
      ;;
    --version=*)
      [ -z "$VERSION" ] || die "--version may only be specified once"
      VERSION=${1#--version=}
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1 (run with --help for usage)"
      ;;
  esac
done

[ -n "$VERSION" ] || die "--version is required"
require_command grep
validate_semver "$VERSION" || die "invalid semver '$VERSION' (expected a version such as 1.2.0)"
TAG=adlc-v$VERSION

require_command git
require_command tar

GIT_ROOT=$(git -C "$REPO_ROOT" rev-parse --show-toplevel 2>/dev/null) || die "not inside a Git repository"
GIT_ROOT=$(CDPATH= cd -- "$GIT_ROOT" && pwd -P)
[ "$GIT_ROOT" = "$REPO_ROOT" ] || die "script must run from its repository root"
cd "$REPO_ROOT"

HEAD_SHA=$(git -C "$REPO_ROOT" rev-parse --verify 'HEAD^{commit}') || die "HEAD is not a commit"
case "$HEAD_SHA" in
  ''|*[!0-9a-f]*) die "expected a full 40-character HEAD SHA, got '$HEAD_SHA'" ;;
esac
[ "${#HEAD_SHA}" -eq 40 ] || die "expected a full 40-character HEAD SHA, got '$HEAD_SHA'"

WORKTREE_STATUS=$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)
[ -z "$WORKTREE_STATUS" ] || die "the Git worktree must be clean and fully committed before releasing"

preflight_node
require_command npm
require_command npx
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  die "sha256sum or shasum is required to create SHA256SUMS"
fi
if [ "$DRY_RUN" = false ]; then
  require_command gh
  resolve_release_repository
fi

TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/adlc-release.XXXXXX")
trap 'rm -rf -- "$TEMP_ROOT"' EXIT
STAGE_DIR=$TEMP_ROOT/source
BUILD_DIR=$TEMP_ROOT/artifacts
mkdir -p "$STAGE_DIR" "$BUILD_DIR"

printf '==> Staging committed source at %s\n' "$HEAD_SHA"
git -C "$REPO_ROOT" archive "$HEAD_SHA" | tar -x -C "$STAGE_DIR"

printf '==> Installing dependencies from package-lock.json\n'
(
  cd "$STAGE_DIR"
  npm ci
)

printf '==> Running adlc CLI unit tests\n'
(
  cd "$STAGE_DIR"
  node --test "packages/cli/src/**/*.test.js"
)

printf '==> Stamping adlc CLI v%s in the staging tree\n' "$VERSION"
(
  cd "$STAGE_DIR"
  npm version "$VERSION" --no-git-tag-version --allow-same-version -w @ai-fleet/cli
)

printf '==> Packing npm tarball\n'
(
  cd "$STAGE_DIR"
  npm pack -w @ai-fleet/cli --pack-destination "$BUILD_DIR"
)

TARBALL_PATH=''
for candidate in "$BUILD_DIR"/*.tgz; do
  [ -f "$candidate" ] || continue
  [ -z "$TARBALL_PATH" ] || die "npm pack produced more than one tarball"
  TARBALL_PATH=$candidate
done
[ -n "$TARBALL_PATH" ] || die "npm pack did not produce a tarball"
TARBALL_NAME=${TARBALL_PATH##*/}

printf '==> Building standalone bundle with esbuild 0.24.2\n'
(
  cd "$STAGE_DIR"
  npx --yes esbuild@0.24.2 packages/cli/bin/adlc.js \
    --bundle --platform=node --target=node22 --format=cjs \
    --outfile="$BUILD_DIR/adlc.js"
)
chmod +x "$BUILD_DIR/adlc.js"

printf '==> Smoke-testing standalone bundle\n'
node "$BUILD_DIR/adlc.js" --help >/dev/null

printf '==> Writing portable SHA-256 checksums\n'
(
  cd "$BUILD_DIR"
  write_checksums adlc.js "$TARBALL_NAME" > SHA256SUMS
)

RELEASE_DIR=$REPO_ROOT/dist/adlc-v$VERSION
mkdir -p "$RELEASE_DIR"
cp "$BUILD_DIR/adlc.js" "$TARBALL_PATH" "$BUILD_DIR/SHA256SUMS" "$RELEASE_DIR/"

printf '\nArtifacts:\n'
printf '  %s/adlc.js\n' "$RELEASE_DIR"
printf '  %s/%s\n' "$RELEASE_DIR" "$TARBALL_NAME"
printf '  %s/SHA256SUMS\n' "$RELEASE_DIR"
cat "$RELEASE_DIR/SHA256SUMS"

if [ "$DRY_RUN" = true ]; then
  printf '\nDry run complete; GitHub release %s was not created.\n' "$TAG"
  exit 0
fi

printf '\n==> Validating GitHub release target %s\n' "$RELEASE_GITHUB_TARGET"
validate_remote_tag

printf '\n==> Publishing GitHub release %s at %s\n' "$TAG" "$HEAD_SHA"
release_args=(
  release create "$TAG"
  --repo "$RELEASE_GITHUB_TARGET"
  --title "adlc CLI v$VERSION"
  --generate-notes
  --target "$HEAD_SHA"
  "$RELEASE_DIR/adlc.js"
  "$RELEASE_DIR/$TARBALL_NAME"
  "$RELEASE_DIR/SHA256SUMS"
)
run_gh "${release_args[@]}"

printf 'Published GitHub release %s.\n' "$TAG"
