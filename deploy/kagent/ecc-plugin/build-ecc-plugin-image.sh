#!/usr/bin/env bash
# Packages github.com/affaan-m/ECC as an Agent Plugins 1.0.0 bundle and publishes it
# as a digest-pinned OCI image into the local kind registry, then stamps the digest
# into ecc-agent.yaml.
#
# kagent only accepts immutable plugin sources, and a bare tag is rejected, so the
# digest is the product of this build. Two names point at the same repository:
#   PUSH_REF_HOST    localhost:5001        host -> kind-registry published port
#   PULL_REF_CLUSTER <registry-ip>:5000    the address on the kind network, which is
#                                          what the Substrate worker resolves. See the
#                                          Scheme() note below the defaults.
#
# Usage:  bash deploy/kagent/ecc-plugin/build-ecc-plugin-image.sh
# Env:    ECC_COMMIT=<sha> override the pin; PUSH_IT=false to build without pushing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ECC_REPO="${ECC_REPO:-https://github.com/affaan-m/ECC.git}"
ECC_COMMIT="${ECC_COMMIT:-3f14a103a8694e51c1df9a806217a6d0b5f7a6f7}"
ECC_VERSION="${ECC_VERSION:-2.2.3}"
PLUGIN_NAME="${PLUGIN_NAME:-ecc}"

IMAGE_NAME="${IMAGE_NAME:-ecc-plugin}"
PUSH_REF_HOST="${PUSH_REF_HOST:-localhost:5001/${IMAGE_NAME}}"

# The ref the worker pulls with must be an IP, not the DNS name. atelet fetches plugin
# images with go-containerregistry, whose Scheme() picks plain http only for RFC1918
# addresses, localhost:port, *.localhost and loopback -- everything else is forced to
# https, and this registry serves http. "kind-registry:5000" therefore fails with
# "server gave HTTP response to HTTPS client" while "172.20.0.3:5000" succeeds, even
# though both reach the same process. Discover the address on the kind network so a
# recreated registry container gets re-stamped rather than silently breaking pulls.
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
PUSH_IT="${PUSH_IT:-true}"
KCONTEXT="${KCONTEXT:-kind-kind}"

BUILD_DIR="${SCRIPT_DIR}/build"
SRC_DIR="${BUILD_DIR}/ECC-${ECC_COMMIT}"
BUNDLE_DIR="${BUILD_DIR}/bundle"

# kagent rejects a plugin above these limits (measured after fetch, before mount).
MAX_ENTRIES="${MAX_ENTRIES:-10000}"
MAX_BYTES="${MAX_BYTES:-104857600}"

log() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. fetch the pin
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
log "pinned commit verified: ${ACTUAL_SHA:0:12}  (VERSION $(cat "${SRC_DIR}/VERSION"))"

# ------------------------------------------------- 2. materialize the plugin bundle
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

# ------------------------------------------------------------ 3. build the OCI image
log "building ${PUSH_REF_HOST}:${ECC_VERSION}"
# The bundle is architecture-free, but the worker matches the platform it pulls
# against the node's, so pin it to the kind node rather than the build host default.
NODE_PLATFORM="${NODE_PLATFORM:-$(kubectl --context "${KCONTEXT}" get nodes \
  -o jsonpath='{.items[0].status.nodeInfo.architecture}' | sed 's|^|linux/|')}"
docker build -q --platform "${NODE_PLATFORM}" \
  -f "${SCRIPT_DIR}/Dockerfile.ecc-plugin" \
  -t "${PUSH_REF_HOST}:${ECC_VERSION}" \
  -t "${PUSH_REF_HOST}:latest" \
  "${BUILD_DIR}" >/dev/null

[ "${PUSH_IT}" = "true" ] || { log "PUSH_IT=false; stopping after build"; exit 0; }

# ------------------------------------------------------------------- 4. push + digest
log "pushing to the kind registry"
docker push -q "${PUSH_REF_HOST}:${ECC_VERSION}" >/dev/null
docker push -q "${PUSH_REF_HOST}:latest" >/dev/null

# RepoDigests is what the registry actually stores, so the digest is read back rather
# than recomputed -- the YAML has to name the bytes the worker will pull.
DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "${PUSH_REF_HOST}:${ECC_VERSION}" | sed 's|.*@||')"
[ -n "${DIGEST}" ] || die "could not read the repo digest from docker inspect"
OCI_REF="${PULL_REF_CLUSTER}@${DIGEST}"
printf '%s\n' "${OCI_REF}" > "${BUILD_DIR}/plugin-oci-ref.txt"
log "oci ref for spec.plugins[].source.oci: ${OCI_REF}"

# ------------------------------------------------- 5. prove the worker can reach it
# One-shot pod in the cluster: same network path the Substrate worker takes.
log "checking the manifest resolves in-cluster from ${REGISTRY_IP}:5000"
# Marker-framed, not tr -dc: kubectl attach can interleave its own stdout ("pod
# ... deleted", "stty: Inappropriate ioctl"), and a name collision with a leftover
# pod makes kubectl run fail with the code never printed at all.
PROBE_POD="ecc-probe-$$"
CODE="$(kubectl --context "${KCONTEXT}" run "${PROBE_POD}" --rm -i --restart=Never \
  --image=curlimages/curl:latest --image-pull-policy=IfNotPresent --command -- sh -c \
  "curl -sS -m 20 -o /dev/null -w 'ECCPROBE=%{http_code}' http://${REGISTRY_IP}:5000/v2/${IMAGE_NAME}/manifests/${DIGEST}" \
  2>/dev/null | grep -oE 'ECCPROBE=[0-9]{3}' | cut -d= -f2)"
[ -n "${CODE}" ] || CODE=000
if [ "${CODE}" != "200" ]; then
  die "in-cluster pull probe returned HTTP ${CODE}. Check the container is on the 'kind' network: docker inspect ${KIND_REGISTRY_CONTAINER} --format '{{range \$n, \$c := .NetworkSettings.Networks}}{{\$n}}={{\$c.IPAddress}} {{end}}'"
fi
log "in-cluster manifest check: 200 OK"

# ---------------------------------------------------------- 6. stamp the YAML
MANIFEST="${SCRIPT_DIR}/ecc-agent.yaml"
if grep -qE '^[[:space:]]*oci:[[:space:]]' "${MANIFEST}"; then
  sed -i.bak -E "s|^([[:space:]]*)oci:[[:space:]]+.*$|\1oci: ${OCI_REF}|" "${MANIFEST}"
  rm -f "${MANIFEST}.bak"
  log "wrote the digest into ${MANIFEST}"
else
  log "no oci: line in ${MANIFEST}; set spec.plugins[].source.oci to ${OCI_REF}"
fi

log "done. Apply with: kubectl --context ${KCONTEXT} apply -f ${MANIFEST}"
