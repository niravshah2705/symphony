#!/usr/bin/env bash
# Sourced helper: turn one skills.csv row plus the skill's bundle.env into the
# exact environment deploy/kagent/compose-skill-bundle.sh expects.
#
# The standalone-skill sibling of pack-inputs.sh, and the same reason: the local
# kind builder and .github/workflows/build-skill-images.yml must resolve the row
# identically, or CI publishes an artifact from a different directory inside the
# pin than the one a developer tested.
#
# Usage:
#   SKILL=<row> . deploy/kagent/skill-inputs.sh     # REPO_ROOT must be set
# Sets/exports: SKILL_REPO, SKILL_COMMIT, SKILL_VERSION, SKILL_NAME, SKILL_PATH,
#   SKILL_EXCLUDES, IMAGE_NAME, and the row fields CSV_*.
set -euo pipefail

[ "${BASH_SOURCE[0]}" != "$0" ] || { echo "skill-inputs.sh is sourced, not executed" >&2; exit 2; }
: "${REPO_ROOT:?REPO_ROOT must be set before sourcing skill-inputs.sh}"
: "${SKILL:?SKILL must be set before sourcing skill-inputs.sh}"

CSV="${CSV:-${REPO_ROOT}/deploy/kagent/skills.csv}"
[ -f "${CSV}" ] || { echo "ERROR: no manifest at ${CSV}" >&2; return 1; }

read -r CSV_REPO CSV_COMMIT CSV_VERSION CSV_VERSION_SOURCE CSV_SKILL_PATH CSV_IMAGE CSV_DOCKERFILE CSV_CURRENT <<EOF
$(awk -F',' -v s="$SKILL" 'NR==1{for(i=1;i<=NF;i++)h[$i]=i;next} $1==s && $h["current"]=="true"{print $h["repo"],$h["commit"],$h["version"],$h["version_source"],$h["skill_path"],$h["image"],$h["dockerfile"],$h["current"];exit}' "${CSV}")
EOF
[ -n "${CSV_COMMIT:-}" ] || { echo "ERROR: no current=true row for ${SKILL} in ${CSV}" >&2; return 1; }
[ -f "${CSV_DOCKERFILE}" ] || { echo "ERROR: ${CSV_DOCKERFILE} (from the CSV row) is not a file" >&2; return 1; }

SKILL_DIR="${SKILL_DIR:-$(cd "$(dirname "${CSV_DOCKERFILE}")" && pwd)}"
[ -f "${SKILL_DIR}/bundle.env" ] || { echo "ERROR: no ${SKILL_DIR}/bundle.env" >&2; return 1; }
# shellcheck disable=SC1090
. "${SKILL_DIR}/bundle.env"
: "${SKILL_NAME:?bundle.env must set SKILL_NAME}"
[ "${SKILL_NAME}" = "${SKILL}" ] \
  || { echo "ERROR: ${SKILL_DIR}/bundle.env says ${SKILL_NAME}, the CSV row says ${SKILL}" >&2; return 1; }
[ "${SKILL_PATH:-}" = "${CSV_SKILL_PATH}" ] \
  || { echo "ERROR: bundle.env SKILL_PATH ${SKILL_PATH:-} != skills.csv skill_path ${CSV_SKILL_PATH}" >&2; return 1; }

# version_source "none" is the whole reason this is a separate track: there is no
# upstream string to compare against, so the version column is derived from the
# pin, and the two have to agree here rather than at pull time.
case "${CSV_VERSION_SOURCE}" in
  none)
    [ "${CSV_VERSION}" = "${CSV_COMMIT:0:12}" ] \
      || { echo "ERROR: ${SKILL}: version_source is none, so skills.csv version must be the pin prefix ${CSV_COMMIT:0:12}, not ${CSV_VERSION}" >&2; return 1; } ;;
  VERSION | *.json | *.toml) ;;
  *) echo "ERROR: ${SKILL}: version_source '${CSV_VERSION_SOURCE}' must be none, VERSION, a *.json manifest or a *.toml" >&2; return 1 ;;
esac

export SKILL_REPO="${SKILL_REPO:-${CSV_REPO}}"
export SKILL_COMMIT="${SKILL_COMMIT:-${CSV_COMMIT}}"
export SKILL_VERSION="${SKILL_VERSION:-${CSV_VERSION}}"
export SKILL_NAME SKILL_PATH
export SKILL_EXCLUDES="${SKILL_EXCLUDES:-}"
export IMAGE_NAME="${IMAGE_NAME:-${SKILL}-skill}"
export CSV_IMAGE="${CSV_IMAGE}" CSV_DOCKERFILE="${CSV_DOCKERFILE}" CSV_CURRENT="${CSV_CURRENT}"
