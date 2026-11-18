#!/usr/bin/env bash
# Compose an Agent Plugins 1.0.0 bundle for one plugin row, into a build context.
#
# Shared by build-ecc-plugin-image.sh (local kind registry), the per-pack
# build-plugin-image.sh wrappers, and .github/workflows/build-plugin-images.yml
# (ghcr publish) so the bundle a developer tests is byte-identical to the one
# CI publishes.
#
# The output dir receives:
#   <out>/<plugin>-<commit>/   the upstream checkout (cached; kept for repeat runs)
#   <out>/bundle/              plugin.json at the root + skills/ (+ mcp.json) — the
#                              docker build context for Dockerfile.<plugin>-plugin
#
# Upstream packs are not shaped alike, so the shape comes in as inputs rather
# than being assumed: ECC, agent-skills, superpowers and code-review-graph ship
# skills/*/SKILL.md; graphify ships one graphify/skill.md; spec-kit ships no
# skills at all. The last two are supplied as a reviewed overlay committed
# beside the pack's bundle.env, so this script never rewrites a prompt file.
#
# Usage:  compose-bundle.sh <out-dir>
# Env:    PLUGIN_REPO       upstream git URL                 (required)
#         PLUGIN_COMMIT     full 40-hex pin                  [required]
#         PLUGIN_VERSION    must equal the upstream version, kagent-style
#         PLUGIN_NAME       name written into plugin.json    [required]
#         PLUGIN_VERSION_SOURCE  repo-relative file the version is read from
#                              (VERSION | *.json | pyproject.toml); default VERSION
#         PLUGIN_SKILLS_SRC      upstream dir of skill subdirectories; default skills
#         PLUGIN_SKILLS_LIST     file of skill dir names to ship, one per line;
#                              absent means every upstream skill directory
#         PLUGIN_OVERLAY_DIR     dir of <skill>/SKILL.md trees to add or override
#         PLUGIN_MCP_FILE        bundle-relative mcp.json to emit at the root
#         PLUGIN_EXCLUDES        space-separated names/paths to drop from the
#                              copied skills (a pack's own test fixtures and
#                              sample apps travel with its skills/ tree)
#         PLUGIN_DESCRIPTION     text for the plugin.json description
#         MAX_ENTRIES / MAX_BYTES  kagent bundle limits
#
# ECC_REPO / ECC_COMMIT / ECC_VERSION are accepted as aliases for the ECC pack,
# so PR #307's script and docs keep working while the CSV drives the rest.
set -euo pipefail

PLUGIN_REPO="${PLUGIN_REPO:-${ECC_REPO-}}"
PLUGIN_COMMIT="${PLUGIN_COMMIT:-${ECC_COMMIT-}}"
PLUGIN_VERSION="${PLUGIN_VERSION:-${ECC_VERSION-}}"
PLUGIN_NAME="${PLUGIN_NAME:?PLUGIN_NAME is required}"
PLUGIN_VERSION_SOURCE="${PLUGIN_VERSION_SOURCE:-VERSION}"
PLUGIN_SKILLS_SRC="${PLUGIN_SKILLS_SRC:-skills}"
PLUGIN_SKILLS_LIST="${PLUGIN_SKILLS_LIST:-}"
PLUGIN_OVERLAY_DIR="${PLUGIN_OVERLAY_DIR:-}"
PLUGIN_MCP_FILE="${PLUGIN_MCP_FILE:-}"
PLUGIN_EXCLUDES="${PLUGIN_EXCLUDES:-}"
PLUGIN_DESCRIPTION="${PLUGIN_DESCRIPTION:-${PLUGIN_NAME} skills, packaged for kagent}"
MAX_ENTRIES="${MAX_ENTRIES:-10000}"
MAX_BYTES="${MAX_BYTES:-104857600}"

OUT_DIR="${1:?usage: compose-bundle.sh <out-dir>}"
SRC_DIR="${OUT_DIR}/${PLUGIN_NAME}-${PLUGIN_COMMIT}"
BUNDLE_DIR="${OUT_DIR}/bundle"

# stdout is reserved for the one-line bundle path; everything narrated goes to stderr.
log() { printf '\033[1;36m==> %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ 0. inputs
[ -n "$PLUGIN_REPO" ] || die "PLUGIN_REPO is required"
[ -n "$PLUGIN_COMMIT" ] || die "PLUGIN_COMMIT is required"
[ -n "$PLUGIN_VERSION" ] || die "PLUGIN_VERSION is required"
case "${PLUGIN_COMMIT}" in
  "" | *[!0-9a-f]*) die "PLUGIN_COMMIT must be exactly 40 lowercase hex, got '${PLUGIN_COMMIT}'" ;;
esac
[ "${#PLUGIN_COMMIT}" -eq 40 ] || die "PLUGIN_COMMIT must be exactly 40 lowercase hex, got '${PLUGIN_COMMIT}'"

# The name kagent reads out of plugin.json has to satisfy the Agent Plugins
# 1.0.0 rule, and a bundle named wrongly fails at resolve time with a message
# that does not point back here.
case "$PLUGIN_NAME" in
  *[!a-z0-9.-]* | -* | *- | .* | *. | *--* | *..*)
    die "PLUGIN_NAME '${PLUGIN_NAME}' is not an Agent Plugins 1.0.0 name: lowercase letters, digits, dots and hyphens, no leading or trailing dot or hyphen, no -- or .." ;;
esac
[ "${#PLUGIN_NAME}" -le 64 ] || die "PLUGIN_NAME '${PLUGIN_NAME}' exceeds 64 characters"

case "$PLUGIN_VERSION_SOURCE" in
  /* | *..*) die "PLUGIN_VERSION_SOURCE must be a repo-relative path, got '${PLUGIN_VERSION_SOURCE}'" ;;
esac
case "$PLUGIN_VERSION_SOURCE" in
  *.json | *.toml | VERSION) ;;
  *) die "PLUGIN_VERSION_SOURCE '${PLUGIN_VERSION_SOURCE}' must be VERSION, a *.json manifest or a *.toml" ;;
esac

# ------------------------------------------------------------------ 1. fetch the pin
if [ ! -d "${SRC_DIR}/.git" ]; then
  log "fetching ${PLUGIN_REPO##*:///} @ ${PLUGIN_COMMIT:0:12}"
  rm -rf "${SRC_DIR:?}"
  mkdir -p "${SRC_DIR}"
  git -C "${SRC_DIR}" init -q
  git -C "${SRC_DIR}" remote add origin "${PLUGIN_REPO}"
  # --depth 1 by SHA keeps the checkout byte-identical to the pinned commit.
  git -C "${SRC_DIR}" fetch -q --depth 1 origin "${PLUGIN_COMMIT}"
  git -C "${SRC_DIR}" checkout -q FETCH_HEAD
fi

ACTUAL_SHA="$(git -C "${SRC_DIR}" rev-parse HEAD)"
[ "${ACTUAL_SHA}" = "${PLUGIN_COMMIT}" ] || die "checked out ${ACTUAL_SHA}, wanted ${PLUGIN_COMMIT}"
[ -f "${SRC_DIR}/${PLUGIN_VERSION_SOURCE}" ] \
  || die "no ${PLUGIN_VERSION_SOURCE} at the pinned commit (bad pin, or the pack moved its version file)"

# The version we advertise must be the version upstream shipped at this commit;
# a CSV row that drifted from its pin publishes an image labelled with bytes it
# does not contain. Read it the way verify-plugin-images.sh reads it, so the two
# never disagree about what a pack calls its own version.
case "$PLUGIN_VERSION_SOURCE" in
  *.json)
    UPSTREAM_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      "${SRC_DIR}/${PLUGIN_VERSION_SOURCE}" | head -n 1)" ;;
  *.toml)
    UPSTREAM_VERSION="$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
      "${SRC_DIR}/${PLUGIN_VERSION_SOURCE}" | head -n 1)" ;;
  *) UPSTREAM_VERSION="$(tr -d '[:space:]' < "${SRC_DIR}/${PLUGIN_VERSION_SOURCE}")" ;;
esac
[ -n "$UPSTREAM_VERSION" ] || die "no version readable from ${PLUGIN_VERSION_SOURCE} at the pinned commit"
[ "${UPSTREAM_VERSION}" = "${PLUGIN_VERSION}" ] \
  || die "upstream ${PLUGIN_VERSION_SOURCE} is ${UPSTREAM_VERSION}, manifest row says ${PLUGIN_VERSION}"
log "pinned commit verified: ${ACTUAL_SHA:0:12}  (${PLUGIN_VERSION_SOURCE} ${UPSTREAM_VERSION})"

# ------------------------------------------- 2. materialize the plugin bundle
# Agent Plugins 1.0.0 wants plugin.json at the bundle ROOT. These packs ship
# their manifests under .codex-plugin/ and .claude-plugin/; kagent treats the
# latter as Claude-format and fails the agent on any other harness, so we emit
# a root manifest ourselves and copy only the skills tree.
log "composing bundle"
rm -rf "${BUNDLE_DIR:?}"
mkdir -p "${BUNDLE_DIR}/skills"
cat > "${BUNDLE_DIR}/plugin.json" <<EOF
{
  "\$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "${PLUGIN_NAME}",
  "version": "${PLUGIN_VERSION}",
  "description": "${PLUGIN_DESCRIPTION}",
  "skills": "./skills/"
}
EOF

# A reviewed overlay goes first: it is the only source for packs that ship no
# skills/ tree, and it is how we replace an upstream skill we will not run as-is.
if [ -n "$PLUGIN_OVERLAY_DIR" ]; then
  [ -d "$PLUGIN_OVERLAY_DIR" ] || die "PLUGIN_OVERLAY_DIR '${PLUGIN_OVERLAY_DIR}' is not a directory"
  for dir in "${PLUGIN_OVERLAY_DIR}"/*/; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    [ -f "${dir}SKILL.md" ] || die "overlay skill '${name}' has no SKILL.md"
    cp -R "${dir%/}" "${BUNDLE_DIR}/skills/${name}"
  done
fi

# Only the skills named in the allowlist travel into the bundle. ECC ships 327
# of them; shipping the curated set is what keeps the bundle under kagent's
# entry and byte caps, and it keeps the bundle equal to the list the manifest
# enables — a skill that is mounted but never enabled is dead weight in a
# read-only mount, and one that is enabled but not mounted is a silent no-op.
WANTED=()
if [ -n "$PLUGIN_SKILLS_LIST" ]; then
  [ -f "$PLUGIN_SKILLS_LIST" ] || die "PLUGIN_SKILLS_LIST '${PLUGIN_SKILLS_LIST}' is not a file"
  while IFS= read -r line; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [ -n "$line" ] && WANTED+=("$line")
  done < "$PLUGIN_SKILLS_LIST"
  [ "${#WANTED[@]}" -gt 0 ] || die "PLUGIN_SKILLS_LIST '${PLUGIN_SKILLS_LIST}' has no entries"
else
  [ -d "${SRC_DIR}/${PLUGIN_SKILLS_SRC}" ] || die "no ${PLUGIN_SKILLS_SRC}/ directory at the pinned commit and no skills list"
  for dir in "${SRC_DIR}/${PLUGIN_SKILLS_SRC}"/*/; do
    [ -d "$dir" ] || continue
    WANTED+=("$(basename "$dir")")
  done
fi

for name in ${WANTED[@]+"${WANTED[@]}"}; do
  case "$name" in
    *[!a-z0-9._-]* | "" | . | .. | *--* | *..*) die "skill name '${name}' is not a safe directory name" ;;
  esac
  if [ ! -e "${BUNDLE_DIR}/skills/${name}" ]; then
    [ -d "${SRC_DIR}/${PLUGIN_SKILLS_SRC}/${name}" ] \
      || die "skill '${name}' is listed but ${PLUGIN_SKILLS_SRC}/${name} does not exist at ${ACTUAL_SHA:0:12}"
    cp -R "${SRC_DIR}/${PLUGIN_SKILLS_SRC}/${name}" "${BUNDLE_DIR}/skills/${name}"
  fi
done

# Drop what the agent will never read. A pack ships its fixtures beside its
# skills, and a read-only mount of them costs pull time for nothing — but a
# SKILL.md is never excludable, because that is the file that makes a skill
# mountable at all.
# read -a splits without pathname-expanding the patterns against the caller's
# working directory, which an unquoted `for pat in $VAR` would do. The
# ${arr[@]+...} guard is what macOS' bash 3.2 needs: an empty array there is an
# unbound variable under set -u, not zero iterations.
EXCLUDES=()
read -r -a EXCLUDES <<<"${PLUGIN_EXCLUDES}"
for pat in ${EXCLUDES[@]+"${EXCLUDES[@]}"}; do
  case "$pat" in
    SKILL.md | */SKILL.md) die "PLUGIN_EXCLUDES may not name SKILL.md" ;;
    *) ;;
  esac
  while IFS= read -r -d '' hit; do
    rm -rf "$hit"
  done < <(find "${BUNDLE_DIR}/skills" \
      \( -name "$pat" -o -path "*/${pat%/}" \) -print0 2>/dev/null || true)
done

# An allowlist entry that resolves to nothing upstream would otherwise surface
# as a skill the agent cannot find.
MISSING_SKILLS=""
for name in ${WANTED[@]+"${WANTED[@]}"}; do
  [ -f "${BUNDLE_DIR}/skills/${name}/SKILL.md" ] || MISSING_SKILLS="${MISSING_SKILLS}${MISSING_SKILLS:+ }${name}"
done
[ -z "$MISSING_SKILLS" ] || die "skills listed but not shipped with a SKILL.md: ${MISSING_SKILLS}"

# Two packs are primarily MCP servers, and their mcp.json is the part that is
# worth mounting. It is emitted at the bundle root, where the kagent engine
# reads it — no other harness does, which is why the manifest's engine matters.
if [ -n "$PLUGIN_MCP_FILE" ]; then
  [ -f "$PLUGIN_MCP_FILE" ] || die "PLUGIN_MCP_FILE '${PLUGIN_MCP_FILE}' is not a file"
  grep -q '"mcpServers"' "$PLUGIN_MCP_FILE" || die "PLUGIN_MCP_FILE '${PLUGIN_MCP_FILE}' has no mcpServers object"
  cp "$PLUGIN_MCP_FILE" "${BUNDLE_DIR}/mcp.json"
fi

ENTRY_COUNT="$(find "${BUNDLE_DIR}" | wc -l | tr -d ' ')"
BUNDLE_BYTES="$(du -sk "${BUNDLE_DIR}" | cut -f1)"
BUNDLE_BYTES=$(( BUNDLE_BYTES * 1024 ))
SKILL_COUNT="$(find "${BUNDLE_DIR}/skills" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')"
log "bundle: ${SKILL_COUNT} skills, ${ENTRY_COUNT} entries, $(( BUNDLE_BYTES / 1048576 )) MB"

# A skill is only mountable if its directory holds a SKILL.md; kagent reads the
# front matter of each one and offers it to the model as a tool.
EMPTY="$(find "${BUNDLE_DIR}/skills" -mindepth 1 -maxdepth 1 -type d \
  ! -exec test -f '{}/SKILL.md' \; -print | sed "s|${BUNDLE_DIR}/skills/||")"
[ -z "${EMPTY}" ] || die "skill directories without SKILL.md: ${EMPTY}"

# Attaching a plugin does not enable its skills, so an empty selection would
# publish an image whose mount the agent cannot see.
[ "${SKILL_COUNT}" -gt 0 ] || die "bundle carries no skills"

[ "${ENTRY_COUNT}" -le "${MAX_ENTRIES}" ] \
  || die "bundle has ${ENTRY_COUNT} entries; kagent rejects plugins over ${MAX_ENTRIES}"
[ "${BUNDLE_BYTES}" -le "${MAX_BYTES}" ] \
  || die "bundle is ${BUNDLE_BYTES} bytes; kagent rejects plugins over ${MAX_BYTES}"

printf '%s\n' "${BUNDLE_DIR}"
