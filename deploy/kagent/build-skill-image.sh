#!/usr/bin/env bash
# Build and publish the standalone-skill artifact for one row of deploy/kagent/skills.csv.
#
# The sibling of build-plugin-image.sh for packs that are ONE skill rather than a
# plugin bundle. It differs in three places, and only three: the manifest it
# reads (skills.csv, not plugins.csv), the composer it calls
# (compose-skill-bundle.sh, which authors no plugin.json and takes no allowlist),
# and the field it stamps (spec.skills[].source.oci, not spec.plugins[].source.oci).
# The registry two-name problem is identical, so it is spelled out again here
# rather than linked:
#   PUSH_REF_HOST     localhost:5001       host -> kind-registry published port
#   PULL_REF_CLUSTER  <registry-ip>:5000   the kind-network address the Substrate
#                                 worker resolves. atelet pulls with
#                                 go-containerregistry, whose Scheme() uses plain
#                                 http only for RFC1918, localhost:port,
#                                 *.localhost and loopback.
#
# Like the plugin builder, this stamps build/<skill>-<cli>.local.yaml and never
# the committed manifest: the committed file carries the ghcr digest CI writes
# back.
#
# Usage:  bash deploy/kagent/build-skill-image.sh <skill>
# Env:    SKILL_COMMIT=<sha>  override the CSV pin for an experiment
#         PUSH_IT=false       build without pushing (and without stamping)
#         CLIS="codex claude" which committed manifests to stamp locally
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

SKILL="${1:?usage: build-skill-image.sh <skill>}"

log() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# -------------------------------------------- 1-2. the CSV row + the skill inputs
# Sourced, not duplicated: build-skill-images.yml resolves the same row through
# the same helper.
# shellcheck disable=SC1091
. deploy/kagent/skill-inputs.sh
SKILL_DIR="$(cd "$(dirname "${CSV_DOCKERFILE}")" && pwd)"

CLIS="${CLIS:-codex claude}"
BUILD_DIR="${SKILL_DIR}/build"
PUSH_REF_HOST="${PUSH_REF_HOST:-localhost:5001/${IMAGE_NAME}}"
PUSH_IT="${PUSH_IT:-true}"
KCONTEXT="${KCONTEXT:-kind-kind}"

# ------------------------------------- 3. fetch the pin and compose the artifact
BUNDLE_DIR="$(bash deploy/kagent/compose-skill-bundle.sh "${BUILD_DIR}")"

# ----------------------------------------------------------- 4. build + push
log "building ${PUSH_REF_HOST}:${SKILL_VERSION}"
NODE_PLATFORM="${NODE_PLATFORM:-$(kubectl --context "${KCONTEXT}" get nodes \
  -o jsonpath='{.items[0].status.nodeInfo.architecture}' | sed 's|^|linux/|')}"
docker build -q --platform "${NODE_PLATFORM}" \
  -f "${CSV_DOCKERFILE}" \
  -t "${PUSH_REF_HOST}:${SKILL_VERSION}" \
  "${BUILD_DIR}" >/dev/null

[ "${PUSH_IT}" = "true" ] || { log "PUSH_IT=false; stopping after build"; exit 0; }

log "pushing to the kind registry"
# No :latest here. A plugin's current=true row owns a moving tag that CI
# publishes alongside; a skill artifact is labelled by its pin, so "latest" would
# be a second name for bytes the manifest never names.
docker push -q "${PUSH_REF_HOST}:${SKILL_VERSION}" >/dev/null

DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "${PUSH_REF_HOST}:${SKILL_VERSION}" | sed 's|.*@||')"
[ -n "${DIGEST}" ] || die "could not read the repo digest from docker inspect"

KIND_REGISTRY_CONTAINER="${KIND_REGISTRY_CONTAINER:-kind-registry}"
REGISTRY_IP="$(docker inspect -f \
  '{{range $net, $cfg := .NetworkSettings.Networks}}{{if eq $net "kind"}}{{if $cfg.IPAddress}}{{$cfg.IPAddress}}{{end}}{{end}}{{end}}' \
  "${KIND_REGISTRY_CONTAINER}" 2>/dev/null || true)"
if [ -z "${REGISTRY_IP}" ]; then
  REGISTRY_IP="$(docker exec kind-control-plane getent hosts "${KIND_REGISTRY_CONTAINER}" \
    2>/dev/null | awk '{print $1; exit}')"
fi
[ -n "${REGISTRY_IP}" ] || die "could not find an IP for ${KIND_REGISTRY_CONTAINER} on the kind network"
PULL_REF_CLUSTER="${PULL_REF_CLUSTER:-${REGISTRY_IP}:5000/${IMAGE_NAME}}"
OCI_REF="${PULL_REF_CLUSTER}@${DIGEST}"
printf '%s\n' "${OCI_REF}" > "${BUILD_DIR}/skill-oci-ref.txt"
log "oci ref for spec.skills[].source.oci: ${OCI_REF}"

# --------------------------------------------- 5. prove the worker can reach it
log "checking the manifest resolves in-cluster from ${REGISTRY_IP}:5000"
PROBE_POD="${SKILL}-probe-$$"
CODE="$(kubectl --context "${KCONTEXT}" run "${PROBE_POD}" --rm -i --restart=Never \
  --image=curlimages/curl:latest --image-pull-policy=IfNotPresent --command -- sh -c \
  "curl -sS -m 20 -o /dev/null -w 'PROBE=%{http_code}' http://${REGISTRY_IP}:5000/v2/${IMAGE_NAME}/manifests/${DIGEST}" \
  2>/dev/null | grep -oE 'PROBE=[0-9]{3}' | cut -d= -f2)"
[ -n "${CODE}" ] || CODE=000
if [ "${CODE}" != "200" ]; then
  die "in-cluster pull probe returned HTTP ${CODE}. Check the container is on the 'kind' network: docker inspect ${KIND_REGISTRY_CONTAINER} --format '{{range \$n, \$c := .NetworkSettings.Networks}}{{\$n}}={{\$c.IPAddress}} {{end}}'"
fi
log "in-cluster manifest check: 200 OK"

# ----------------------------------- 6. stamp LOCAL copies, never the committed file
for cli in ${CLIS}; do
  committed="${SKILL_DIR}/${SKILL}-${cli}.yaml"
  [ -f "${committed}" ] || { log "no committed manifest ${committed}; skipping ${cli}"; continue; }
  local_copy="${BUILD_DIR}/${SKILL}-${cli}.local.yaml"
  cp "${committed}" "${local_copy}"
  sed -i.bak -E "s|^([[:space:]]*)oci:[[:space:]]+.*$|\1oci: ${OCI_REF}|" "${local_copy}"
  rm -f "${local_copy}.bak"
  log "stamped ${local_copy}"
done

log "done. Apply a local build with:"
log "  kubectl --context ${KCONTEXT} apply -f ${BUILD_DIR}/${SKILL}-codex.local.yaml"
