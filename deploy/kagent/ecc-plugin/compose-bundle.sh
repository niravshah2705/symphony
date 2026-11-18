#!/usr/bin/env bash
# Compose an Agent Plugins 1.0.0 bundle for one plugin row, into a build context.
#
# Shared by build-ecc-plugin-image.sh (local kind registry) and
# .github/workflows/build-plugin-images.yml (ghcr publish) so the bundle a
# developer tests is byte-identical to the one CI publishes.
#
# The output dir receives:
#   <out>/ECC-<commit>/   the upstream checkout (cached; kept for repeat runs)
#   <out>/bundle/         plugin.json at the root + skills/ — the docker build
#                         context for Dockerfile.ecc-plugin
#
# Usage:  compose-bundle.sh <out-dir>
# Env:    ECC_REPO     upstream git URL                    (required upstream)
#         ECC_COMMIT   full 40-hex pin                     [required]
#         ECC_VERSION  must equal the upstream VERSION file, kagent-style
#         PLUGIN_NAME  name written into plugin.json       (default ecc)
#         MAX_ENTRIES / MAX_BYTES  kagent bundle limits
set -euo pipefail

ECC_REPO="${ECC_REPO:-https://github.com/affaan-m/ECC.git}"
ECC_COMMIT="${ECC_COMMIT:?ECC_COMMIT (full 40-hex pin) is required}"
ECC_VERSION="${ECC_VERSION:?ECC_VERSION is required}"
PLUGIN_NAME="${PLUGIN_NAME:-ecc}"
MAX_ENTRIES="${MAX_ENTRIES:-10000}"
MAX_BYTES="${MAX_BYTES:-104857600}"

OUT_DIR="${1:?usage: compose-bundle.sh <out-dir>}"
SRC_DIR="${OUT_DIR}/ECC-${ECC_COMMIT}"
BUNDLE_DIR="${OUT_DIR}/bundle"

# stdout is reserved for the one-line bundle path; everything narrated goes to stderr.
log() { printf '\033[1;36m==> %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

case "${ECC_COMMIT}" in
  "" | *[!0-9a-f]*) die "ECC_COMMIT must be exactly 40 lowercase hex, got '${ECC_COMMIT}'" ;;
esac
[ "${#ECC_COMMIT}" -eq 40 ] || die "ECC_COMMIT must be exactly 40 lowercase hex, got '${ECC_COMMIT}'"

# ------------------------------------------------------------------ 1. fetch the pin
if [ ! -d "${SRC_DIR}/skills" ]; then
  log "fetching ${ECC_REPO##*:///} @ ${ECC_COMMIT:0:12}"
  rm -rf "${SRC_DIR:?}"
  mkdir -p "${SRC_DIR}"
  git -C "${SRC_DIR}" init -q
  git -C "${SRC_DIR}" remote add origin "${ECC_REPO}"
  # --depth 1 by SHA keeps the checkout byte-identical to the pinned commit.
  git -C "${SRC_DIR}" fetch -q --depth 1 origin "${ECC_COMMIT}"
  git -C "${SRC_DIR}" checkout -q FETCH_HEAD
fi

ACTUAL_SHA="$(git -C "${SRC_DIR}" rev-parse HEAD)"
[ "${ACTUAL_SHA}" = "${ECC_COMMIT}" ] || die "checked out ${ACTUAL_SHA}, wanted ${ECC_COMMIT}"
[ -f "${SRC_DIR}/VERSION" ] || die "no VERSION file at the pinned commit"
[ -d "${SRC_DIR}/skills" ] || die "no skills/ directory at the pinned commit"

# The version we advertise must be the version upstream shipped at this commit;
# a CSV row that drifted from its pin publishes an image labelled with bytes it
# does not contain.
UPSTREAM_VERSION="$(tr -d '[:space:]' < "${SRC_DIR}/VERSION")"
[ "${UPSTREAM_VERSION}" = "${ECC_VERSION}" ] \
  || die "upstream VERSION is ${UPSTREAM_VERSION}, manifest row says ${ECC_VERSION}"
log "pinned commit verified: ${ACTUAL_SHA:0:12}  (VERSION ${UPSTREAM_VERSION})"

# ------------------------------------------- 2. materialize the plugin bundle
# Agent Plugins 1.0.0 wants plugin.json at the bundle ROOT. ECC ships its manifests
# under .codex-plugin/ and .claude-plugin/; kagent treats the latter as Claude-format
# and fails the agent on any other harness, so we emit a root manifest ourselves.
log "composing bundle"
rm -rf "${BUNDLE_DIR:?}"
mkdir -p "${BUNDLE_DIR}"
cat > "${BUNDLE_DIR}/plugin.json" <<EOF
{
  "\$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "${PLUGIN_NAME}",
  "version": "${ECC_VERSION}",
  "description": "ECC skills, packaged for kagent from github.com/affaan-m/ECC@${ACTUAL_SHA}",
  "skills": "./skills/"
}
EOF
# Only skills travel into the bundle: hooks, commands and per-harness adapters are
# owned by the harness that ships them, not by Substrate's read-only mount.
cp -R "${SRC_DIR}/skills" "${BUNDLE_DIR}/skills"

ENTRY_COUNT="$(find "${BUNDLE_DIR}" | wc -l | tr -d ' ')"
BUNDLE_BYTES="$(du -sk "${BUNDLE_DIR}" | cut -f1)"
BUNDLE_BYTES=$(( BUNDLE_BYTES * 1024 ))
SKILL_COUNT="$(find "${BUNDLE_DIR}/skills" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')"
log "bundle: ${SKILL_COUNT} skills, ${ENTRY_COUNT} entries, $(( BUNDLE_BYTES / 1048576 )) MB"

# A skill is only mountable if its directory holds a SKILL.md; kagent reads the
# front matter of each one and offers it to the model as a tool.
MISSING="$(find "${BUNDLE_DIR}/skills" -mindepth 1 -maxdepth 1 -type d \
  ! -exec test -f '{}/SKILL.md' \; -print | sed "s|${BUNDLE_DIR}/skills/||")"
[ -n "${MISSING}" ] && die "skill directories without SKILL.md: ${MISSING}"

[ "${ENTRY_COUNT}" -le "${MAX_ENTRIES}" ] \
  || die "bundle has ${ENTRY_COUNT} entries; kagent rejects plugins over ${MAX_ENTRIES}"
[ "${BUNDLE_BYTES}" -le "${MAX_BYTES}" ] \
  || die "bundle is ${BUNDLE_BYTES} bytes; kagent rejects plugins over ${MAX_BYTES}"

printf '%s\n' "${BUNDLE_DIR}"
