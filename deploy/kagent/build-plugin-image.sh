#!/usr/bin/env bash
# Build and publish the plugin bundle for one row of deploy/kagent/plugins.csv.
#
# This is the CSV-driven generalization of ecc-plugin/build-ecc-plugin-image.sh
# (PR #307): the pin comes from the manifest, the bundle shape comes from the
# pack's own bundle.env, and the bytes come from compose-bundle.sh — the same
# script .github/workflows/build-plugin-images.yml runs, so a local bundle and a
# published one cannot differ.
#
# Two names point at one local registry, and the difference is not cosmetic:
#   PUSH_REF_HOST     localhost:5001       host -> kind-registry published port
#   PULL_REF_CLUSTER  <registry-ip>:5000   the address on the kind network that
#                                 the Substrate worker resolves. atelet pulls
#                                 with go-containerregistry, whose Scheme() uses
#                                 plain http only for RFC1918, localhost:port,
#                                 *.localhost and loopback — everything else is
#                                 forced to https against an http registry.
#
# What this script stamps is build/<plugin>-<cli>.local.yaml, never the
# committed manifest: the committed <plugin>-codex.yaml / <plugin>-claude.yaml
# carry the ghcr digest that CI writes back, and a local kind digest flipping
# that file on every developer build would make the manifest unreviewable.
#
# Usage:  bash deploy/kagent/build-plugin-image.sh <plugin>
# Env:    PLUGIN_COMMIT=<sha>  override the CSV pin for an experiment
#         PUSH_IT=false        build without pushing (and without stamping)
#         CLIS="codex claude"  which committed manifests to stamp locally
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

PLUGIN="${1:?usage: build-plugin-image.sh <plugin>}"

log() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ------------------------------------------------- 1-2. the CSV row + pack inputs
# Sourced, not duplicated: CI composes the same bundle through the same helper, so
# an input that one side resolves and the other forgets cannot exist.
# shellcheck disable=SC1091
. deploy/kagent/pack-inputs.sh

CLIS="${CLIS:-codex claude}"
BUILD_DIR="${PACK_DIR}/build"
IMAGE_NAME="${IMAGE_NAME:-${PLUGIN}-plugin}"
PUSH_REF_HOST="${PUSH_REF_HOST:-localhost:5001/${IMAGE_NAME}}"
PUSH_IT="${PUSH_IT:-true}"
KCONTEXT="${KCONTEXT:-kind-kind}"

# ------------------------------------- 3. fetch the pin and compose the bundle
BUNDLE_DIR="$(bash deploy/kagent/ecc-plugin/compose-bundle.sh "${BUILD_DIR}")"

# ----------------------------------------------------------- 4. build + push
log "building ${PUSH_REF_HOST}:${PLUGIN_VERSION}"
# The bundle is architecture-free, but the worker matches the platform it pulls
# against the node's, so pin it to the kind node rather than the build host.
NODE_PLATFORM="${NODE_PLATFORM:-$(kubectl --context "${KCONTEXT}" get nodes \
  -o jsonpath='{.items[0].status.nodeInfo.architecture}' | sed 's|^|linux/|')}"
docker build -q --platform "${NODE_PLATFORM}" \
  -f "${CSV_DOCKERFILE}" \
  -t "${PUSH_REF_HOST}:${PLUGIN_VERSION}" \
  -t "${PUSH_REF_HOST}:latest" \
  "${BUILD_DIR}" >/dev/null

[ "${PUSH_IT}" = "true" ] || { log "PUSH_IT=false; stopping after build"; exit 0; }

log "pushing to the kind registry"
docker push -q "${PUSH_REF_HOST}:${PLUGIN_VERSION}" >/dev/null
docker push -q "${PUSH_REF_HOST}:latest" >/dev/null

# RepoDigests is what the registry stores, so the digest is read back rather
# than recomputed — the YAML has to name the bytes the worker will pull.
DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "${PUSH_REF_HOST}:${PLUGIN_VERSION}" | sed 's|.*@||')"
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
printf '%s\n' "${OCI_REF}" > "${BUILD_DIR}/plugin-oci-ref.txt"
log "oci ref for spec.plugins[].source.oci: ${OCI_REF}"

# --------------------------------------------- 5. prove the worker can reach it
log "checking the manifest resolves in-cluster from ${REGISTRY_IP}:5000"
PROBE_POD="${PLUGIN}-probe-$$"
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
  committed="${PACK_DIR}/${PLUGIN}-${cli}.yaml"
  [ -f "${committed}" ] || { log "no committed manifest ${committed}; skipping ${cli}"; continue; }
  local_copy="${BUILD_DIR}/${PLUGIN}-${cli}.local.yaml"
  cp "${committed}" "${local_copy}"
  sed -i.bak -E "s|^([[:space:]]*)oci:[[:space:]]+.*$|\1oci: ${OCI_REF}|" "${local_copy}"
  rm -f "${local_copy}.bak"
  log "stamped ${local_copy}"
done

log "done. Apply a local build with:"
log "  kubectl --context ${KCONTEXT} apply -f ${BUILD_DIR}/${PLUGIN}-codex.local.yaml"
