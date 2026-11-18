#!/usr/bin/env bash
# Packages the ECC plugin row of deploy/kagent/plugins.csv as an Agent Plugins
# 1.0.0 bundle and publishes it as a digest-pinned OCI image into the local kind
# registry, then stamps the digest into gitignored build/*.local.yaml copies.
#
# kagent only accepts immutable plugin sources, and a bare tag is rejected, so the
# digest is the product of this build. Two names point at the same repository:
#   PUSH_REF_HOST    localhost:5001        host -> kind-registry published port
#   PULL_REF_CLUSTER <registry-ip>:5000    the address on the kind network, which is
#                                          what the Substrate worker resolves. See the
#                                          Scheme() note below the defaults.
#
# The fetch + bundle composition lives in compose-bundle.sh, shared with
# .github/workflows/build-plugin-images.yml so CI publishes the same bytes.
#
# Usage:  bash deploy/kagent/ecc-plugin/build-ecc-plugin-image.sh
# Env:    ECC_COMMIT=<sha> override the CSV pin; PUSH_IT=false to build without pushing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${SCRIPT_DIR}/../plugins.csv"

log() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# The ecc row of the manifest is the single source of truth for the pin; env
# vars still override for experiments against an unpinned commit.
if [ -f "${MANIFEST}" ]; then
  read -r CSV_REPO CSV_COMMIT CSV_VERSION <<EOF
$(awk -F',' 'NR==1{for(i=1;i<=NF;i++)h[$i]=i;next} $1=="ecc"{print $h["repo"],$h["commit"],$h["version"];exit}' "${MANIFEST}")
EOF
  [ -n "${CSV_COMMIT:-}" ] || die "no ecc row in ${MANIFEST}"
else
  die "manifest not found: ${MANIFEST}"
fi

ECC_REPO="${ECC_REPO:-${CSV_REPO}}"
ECC_COMMIT="${ECC_COMMIT:-${CSV_COMMIT}}"
ECC_VERSION="${ECC_VERSION:-${CSV_VERSION}}"
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

# ------------------------------------------- 1-2. fetch the pin + compose the bundle
BUNDLE_DIR="$(bash "${SCRIPT_DIR}/compose-bundle.sh" "${BUILD_DIR}")"

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

# ---------------------------------------------------------- 6. stamp LOCAL copies
# The committed YAML carries the ghcr digest that CI writes back; a kind digest
# flipped into it on every developer build would make the manifest unreviewable.
# build/ is gitignored, so the stamped files are what `kubectl apply` runs and
# nothing here shows up in a diff.
log "stamping the local manifests"
STAMPED=0
for committed in "${SCRIPT_DIR}"/ecc-*.yaml; do
  [ -f "${committed}" ] || continue
  name="$(basename "${committed}" .yaml)"
  local_copy="${BUILD_DIR}/${name}.local.yaml"
  cp "${committed}" "${local_copy}"
  if grep -qE '^[[:space:]]*oci:[[:space:]]' "${local_copy}"; then
    sed -i.bak -E "s|^([[:space:]]*)oci:[[:space:]]+.*$|\1oci: ${OCI_REF}|" "${local_copy}"
    rm -f "${local_copy}.bak"
  else
    log "no oci: line in ${name}.yaml; set spec.plugins[].source.oci to ${OCI_REF}"
  fi
  log "wrote ${local_copy}"
  STAMPED=$((STAMPED + 1))
done
[ "${STAMPED}" -gt 0 ] || die "no ecc-*.yaml manifests found in ${SCRIPT_DIR}"

log "done. Apply a local build with:"
log "  kubectl --context ${KCONTEXT} apply -f ${BUILD_DIR}/ecc-codex.local.yaml"
