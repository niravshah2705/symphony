#!/usr/bin/env bash
# Compose a standalone-skill artifact for one row of deploy/kagent/skills.csv.
#
# The sibling of ecc-plugin/compose-bundle.sh for packs that are ONE skill and
# ship no plugin manifest: there is no plugin.json to author and no allowlist to
# filter, because the artifact is a single SKILL.md tree that the AgentTemplate
# mounts through `spec.skills[].source.oci` plus `path:`.
#
# The output dir receives:
#   <out>/<skill>-<commit>/   the upstream checkout (cached; kept for repeat runs)
#   <out>/bundle/             skills/<skill>/... — the docker build context for
#                             Dockerfile.<skill>-skill
#
# Usage:  compose-skill-bundle.sh <out-dir>
# Env:    SKILL_REPO      upstream git URL                      [required]
#         SKILL_COMMIT    full 40-hex pin                       [required]
#         SKILL_NAME      directory name under skills/          [required]
#         SKILL_PATH      repo-relative source dir to copy      [required]
#         SKILL_VERSION   the artifact label; for an unversioned
#                       upstream it must equal the first 12 chars of
#                       SKILL_COMMIT, because nothing else identifies it
#         SKILL_EXCLUDES  space-separated names/paths to drop from the copy
#         MAX_ENTRIES / MAX_BYTES  kagent artifact limits
set -euo pipefail

SKILL_REPO="${SKILL_REPO:?SKILL_REPO is required}"
SKILL_COMMIT="${SKILL_COMMIT:?SKILL_COMMIT (full 40-hex pin) is required}"
SKILL_NAME="${SKILL_NAME:?SKILL_NAME is required}"
SKILL_PATH="${SKILL_PATH:?SKILL_PATH is required}"
SKILL_VERSION="${SKILL_VERSION:-}"
SKILL_EXCLUDES="${SKILL_EXCLUDES:-}"
MAX_ENTRIES="${MAX_ENTRIES:-10000}"
MAX_BYTES="${MAX_BYTES:-104857600}"

OUT_DIR="${1:?usage: compose-skill-bundle.sh <out-dir>}"
SRC_DIR="${OUT_DIR}/${SKILL_NAME}-${SKILL_COMMIT}"
BUNDLE_DIR="${OUT_DIR}/bundle"

log() { printf '\033[1;36m==> %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

case "${SKILL_COMMIT}" in
  "" | *[!0-9a-f]*) die "SKILL_COMMIT must be exactly 40 lowercase hex, got '${SKILL_COMMIT}'" ;;
esac
[ "${#SKILL_COMMIT}" -eq 40 ] || die "SKILL_COMMIT must be exactly 40 lowercase hex, got '${SKILL_COMMIT}'"
case "${SKILL_NAME}" in
  *[!a-z0-9.-]* | -* | *- | .* | *. | *--* | *..*)
    die "SKILL_NAME '${SKILL_NAME}' is not a valid skill directory name" ;;
esac
[ "${SKILL_PATH}" != "${SKILL_NAME}" ] || die "SKILL_PATH must be the upstream directory, not just its name"
case "${SKILL_PATH}" in
  /* | *..*) die "SKILL_PATH must be repo-relative and contain no ..: ${SKILL_PATH}" ;;
esac
# The mount point is where kagent reads the skill name out of the directory, so
# a bundle that renames the tree silently changes the tool the model sees.
[ "$(basename "${SKILL_PATH}")" = "${SKILL_NAME}" ] \
  || die "SKILL_PATH ends in $(basename "${SKILL_PATH}") but SKILL_NAME is ${SKILL_NAME}; the mounted directory name IS the skill name"
if [ -n "${SKILL_VERSION}" ]; then
  [ "${#SKILL_VERSION}" -le 64 ] || die "SKILL_VERSION '${SKILL_VERSION}' exceeds 64 characters"
  case "${SKILL_VERSION}" in
    *[!0-9a-zA-Z._+-]*) die "SKILL_VERSION '${SKILL_VERSION}' is not a safe image tag" ;;
  esac
fi

# ------------------------------------------------------------------ 1. fetch the pin
if [ ! -d "${SRC_DIR}/.git" ]; then
  log "fetching ${SKILL_REPO##*:///} @ ${SKILL_COMMIT:0:12}"
  rm -rf "${SRC_DIR:?}"
  mkdir -p "${SRC_DIR}"
  git -C "${SRC_DIR}" init -q
  git -C "${SRC_DIR}" remote add origin "${SKILL_REPO}"
  git -C "${SRC_DIR}" fetch -q --depth 1 origin "${SKILL_COMMIT}"
  git -C "${SRC_DIR}" checkout -q FETCH_HEAD
fi

ACTUAL_SHA="$(git -C "${SRC_DIR}" rev-parse HEAD)"
[ "${ACTUAL_SHA}" = "${SKILL_COMMIT}" ] || die "checked out ${ACTUAL_SHA}, wanted ${SKILL_COMMIT}"
[ -d "${SRC_DIR}/${SKILL_PATH}" ] || die "no ${SKILL_PATH}/ at ${ACTUAL_SHA:0:12}"
[ -f "${SRC_DIR}/${SKILL_PATH}/SKILL.md" ] || die "${SKILL_PATH} has no SKILL.md at ${ACTUAL_SHA:0:12}; kagent reads its front matter to offer the skill"

# --------------------------------------------- 2. prove the identity we claim
# An unversioned upstream has no string to compare against, so the artifact's
# label is the pin. Reading the version out of the front matter instead would
# let a re-pin publish the same tag with different bytes.
if [ -f "${SRC_DIR}/VERSION" ]; then
  UPSTREAM_VERSION="$(tr -d '[:space:]' < "${SRC_DIR}/VERSION")"
elif [ -f "${SRC_DIR}/package.json" ]; then
  UPSTREAM_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${SRC_DIR}/package.json" | head -n 1)"
elif [ -f "${SRC_DIR}/pyproject.toml" ]; then
  UPSTREAM_VERSION="$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "${SRC_DIR}/pyproject.toml" | head -n 1)"
else
  UPSTREAM_VERSION=""
fi
if [ -z "${UPSTREAM_VERSION}" ]; then
  [ "${SKILL_VERSION}" = "${SKILL_COMMIT:0:12}" ] \
    || die "upstream states no version, so the artifact label must be the pin ${SKILL_COMMIT:0:12}, not '${SKILL_VERSION}'"
  log "pinned commit verified: ${ACTUAL_SHA:0:12}  (unversioned upstream: label is the pin)"
else
  [ -z "${SKILL_VERSION}" ] || [ "${SKILL_VERSION}" = "${UPSTREAM_VERSION}" ] \
    || die "upstream version is ${UPSTREAM_VERSION}, skills.csv row says ${SKILL_VERSION}"
  log "pinned commit verified: ${ACTUAL_SHA:0:12}  (upstream version ${UPSTREAM_VERSION})"
fi

# The name in the front matter is what the runtime advertises; a directory and a
# front-matter name that disagree produce a skill the model cannot call.
FM_NAME="$(sed -n 's/^name:[[:space:]]*\([A-Za-z0-9._-]*\).*/\1/p' "${SRC_DIR}/${SKILL_PATH}/SKILL.md" | head -n 1)"
[ -z "${FM_NAME}" ] || [ "${FM_NAME}" = "${SKILL_NAME}" ] \
  || die "SKILL.md front matter names '${FM_NAME}' but the mounted directory is '${SKILL_NAME}'"
[ -n "${FM_NAME}" ] || die "SKILL.md has no name: front matter, so kagent cannot advertise it"

# ------------------------------------------- 3. materialize the artifact
log "composing skill artifact"
rm -rf "${BUNDLE_DIR:?}"
mkdir -p "${BUNDLE_DIR}/skills"
cp -R "${SRC_DIR}/${SKILL_PATH}" "${BUNDLE_DIR}/skills/${SKILL_NAME}"

# read -a splits without pathname-expanding: an unquoted `for pat in $VAR` would
# glob *.test.cjs against the caller's working directory instead of the bundle,
# and the ${arr[@]+...} guard is what macOS' bash 3.2 needs to iterate an empty
# array under set -u.
EXCLUDES=()
read -r -a EXCLUDES <<<"${SKILL_EXCLUDES}"
for pat in ${EXCLUDES[@]+"${EXCLUDES[@]}"}; do
  case "${pat}" in
    SKILL.md | */SKILL.md) die "SKILL_EXCLUDES may not drop SKILL.md" ;;
    *) ;;
  esac
  while IFS= read -r -d '' hit; do
    rm -rf "${hit}"
  done < <(find "${BUNDLE_DIR}/skills" \( -name "${pat}" -o -path "*/${pat%/}" \) -print0 2>/dev/null || true)
done

ENTRY_COUNT="$(find "${BUNDLE_DIR}" | wc -l | tr -d ' ')"
BUNDLE_BYTES="$(du -sk "${BUNDLE_DIR}" | cut -f1)"
BUNDLE_BYTES=$(( BUNDLE_BYTES * 1024 ))
FILE_COUNT="$(find "${BUNDLE_DIR}/skills/${SKILL_NAME}" -type f | wc -l | tr -d ' ')"
log "artifact: ${FILE_COUNT} files, ${ENTRY_COUNT} entries, $(( BUNDLE_BYTES / 1024 )) KB"

[ "${ENTRY_COUNT}" -le "${MAX_ENTRIES}" ] \
  || die "artifact has ${ENTRY_COUNT} entries; kagent rejects mounts over ${MAX_ENTRIES}"
[ "${BUNDLE_BYTES}" -le "${MAX_BYTES}" ] \
  || die "artifact is ${BUNDLE_BYTES} bytes; kagent rejects mounts over ${MAX_BYTES}"

# The digest the CSV records is of these bytes, so a local compose and a CI
# compose of the same pin have to agree; the SKILL.md name plus the sorted file
# list is the cheapest thing that changes when the skill changes.
CONTENT_SHA="$(cd "${BUNDLE_DIR}" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
printf '%s\n' "${CONTENT_SHA}" > "${OUT_DIR}/content-sha256.txt"
log "content sha256: ${CONTENT_SHA}"

printf '%s\n' "${BUNDLE_DIR}"
