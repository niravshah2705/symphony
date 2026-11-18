#!/usr/bin/env bash
# Sourced helper: turn one plugins.csv row plus the pack's bundle.env into the
# exact environment deploy/kagent/ecc-plugin/compose-bundle.sh expects.
#
# Both consumers of the composer go through here —
# deploy/kagent/build-plugin-image.sh (local kind registry) and
# .github/workflows/build-plugin-images.yml (ghcr publish). The reason is a
# specific failure mode: bundle.env names the skills allowlist, the overlay
# directory and the mcp.json repo-relative, and a CI that forgot to resolve one
# of them would publish a bundle missing those skills without any error, because
# compose-bundle.sh treats an unset allowlist as "ship every upstream skill".
#
# Usage:
#   PLUGIN=<row> . deploy/kagent/pack-inputs.sh      # REPO_ROOT must be set
# Sets/exports: PLUGIN_REPO, PLUGIN_COMMIT, PLUGIN_VERSION, PLUGIN_NAME,
#   PLUGIN_VERSION_SOURCE, PLUGIN_SKILLS_SRC, PLUGIN_SKILLS_LIST,
#   PLUGIN_OVERLAY_DIR, PLUGIN_MCP_FILE, PLUGIN_EXCLUDES, PLUGIN_DESCRIPTION,
#   and the row fields CSV_* (commit, version, image, dockerfile, current).
set -euo pipefail

[ "${BASH_SOURCE[0]}" != "$0" ] || { echo "pack-inputs.sh is sourced, not executed" >&2; exit 2; }
: "${REPO_ROOT:?REPO_ROOT must be set before sourcing pack-inputs.sh}"
: "${PLUGIN:?PLUGIN must be set before sourcing pack-inputs.sh}"

CSV="${CSV:-${REPO_ROOT}/deploy/kagent/plugins.csv}"
[ -f "${CSV}" ] || { echo "ERROR: no manifest at ${CSV}" >&2; return 1; }

read -r CSV_REPO CSV_COMMIT CSV_VERSION CSV_VERSION_SOURCE CSV_IMAGE CSV_DOCKERFILE CSV_CURRENT <<EOF
$(awk -F',' -v p="$PLUGIN" 'NR==1{for(i=1;i<=NF;i++)h[$i]=i;next} $1==p && $h["current"]=="true"{print $h["repo"],$h["commit"],$h["version"],$h["version_source"],$h["image"],$h["dockerfile"],$h["current"];exit}' "${CSV}")
EOF
[ -n "${CSV_COMMIT:-}" ] || { echo "ERROR: no current=true row for ${PLUGIN} in ${CSV}" >&2; return 1; }
[ -f "${CSV_DOCKERFILE}" ] || { echo "ERROR: ${CSV_DOCKERFILE} (from the CSV row) is not a file" >&2; return 1; }

# The row already names the Dockerfile, so the pack directory is its dirname
# rather than a second naming rule to get wrong — ECC's folder is ecc-plugin/
# because PR #307 predates the other packs.
PACK_DIR="${PACK_DIR:-$(cd "$(dirname "${CSV_DOCKERFILE}")" && pwd)}"
[ -f "${PACK_DIR}/bundle.env" ] || { echo "ERROR: no ${PACK_DIR}/bundle.env" >&2; return 1; }

# shellcheck disable=SC1090
. "${PACK_DIR}/bundle.env"
: "${PLUGIN_NAME:?bundle.env must set PLUGIN_NAME}"
[ "${PLUGIN_NAME}" = "${PLUGIN}" ] \
  || { echo "ERROR: ${PACK_DIR}/bundle.env says ${PLUGIN_NAME}, the CSV row says ${PLUGIN}" >&2; return 1; }

# An empty input stays empty rather than defaulting to a path: a bundle.env that
# names no overlay is the normal case for the packs that ship their own skills
# tree, and a defaulted-but-missing path is a confusing failure.
resolve() {
  case "${1-}" in
    "") printf '' ;;
    /*) printf '%s\n' "$1" ;;
    *) printf '%s\n' "${REPO_ROOT}/$1" ;;
  esac
}

export PLUGIN_REPO="${PLUGIN_REPO:-${CSV_REPO}}"
export PLUGIN_COMMIT="${PLUGIN_COMMIT:-${CSV_COMMIT}}"
export PLUGIN_VERSION="${PLUGIN_VERSION:-${CSV_VERSION}}"
export PLUGIN_NAME
# The CSV column is the default, not a hard-coded VERSION: a pack whose version
# lives in pyproject.toml composes to a bundle labelled 0.0.0-or-wrong otherwise,
# and compose-bundle.sh dies on the mismatch only at fetch time.
export PLUGIN_VERSION_SOURCE="${PLUGIN_VERSION_SOURCE:-${CSV_VERSION_SOURCE:-VERSION}}"
export PLUGIN_SKILLS_SRC="${PLUGIN_SKILLS_SRC:-skills}"
export PLUGIN_DESCRIPTION
export PLUGIN_EXCLUDES="${PLUGIN_EXCLUDES:-}"
export PLUGIN_SKILLS_LIST="$(resolve "${PLUGIN_SKILLS_LIST-}")"
export PLUGIN_OVERLAY_DIR="$(resolve "${PLUGIN_OVERLAY_DIR-}")"
export PLUGIN_MCP_FILE="$(resolve "${PLUGIN_MCP_FILE-}")"
[ -z "${PLUGIN_SKILLS_LIST}" ] || [ -f "${PLUGIN_SKILLS_LIST}" ] \
  || { echo "ERROR: skills list ${PLUGIN_SKILLS_LIST} is not a file" >&2; return 1; }
[ -z "${PLUGIN_OVERLAY_DIR}" ] || [ -d "${PLUGIN_OVERLAY_DIR}" ] \
  || { echo "ERROR: overlay dir ${PLUGIN_OVERLAY_DIR} is not a directory" >&2; return 1; }
[ -z "${PLUGIN_MCP_FILE}" ] || [ -f "${PLUGIN_MCP_FILE}" ] \
  || { echo "ERROR: mcp file ${PLUGIN_MCP_FILE} is not a file" >&2; return 1; }
export CSV_IMAGE="${CSV_IMAGE}" CSV_DOCKERFILE="${CSV_DOCKERFILE}" CSV_CURRENT="${CSV_CURRENT}"
