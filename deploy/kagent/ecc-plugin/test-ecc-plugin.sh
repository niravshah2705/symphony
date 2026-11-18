#!/usr/bin/env bash
# Test command for the ECC plugin agent on the local kind cluster.
#
# Answers one question: is the ECC plugin bundle actually mounted into the agent's
# sandbox, and can the agent be driven from the CLI? It checks four layers, cheapest
# first, and stops with a verdict that names the layer that failed:
#
#   1  control plane   the four CRs exist and the Agent reports Accepted/ResolvedRefs/
#                      Compatible/Ready; the digest in ecc-agent.yaml matches the live
#                      AgentTemplate (catches "rebuilt the image, forgot to re-apply")
#   2  artifact        the digest-pinned OCI ref resolves against the kind registry
#   3  mount           atelet's own Run call for the current revision reports the
#                      skill-0 volume, its in-sandbox mountPath, and err=null
#   4  live turn       a session is created and invoked through the kagent CLI, and the
#                      reply must quote a skill file read from that mountPath
#
# Layers 1-3 need no working model endpoint, so they still tell you whether the plugin
# plumbing is intact while the LLM credentials are broken. Layer 4 is the only part
# that proves the agent can *use* the skills.
#
# Usage:
#   bash deploy/kagent/ecc-plugin/test-ecc-plugin.sh              # all four layers
#   bash deploy/kagent/ecc-plugin/test-ecc-plugin.sh --quick      # layers 1-3 only
#   bash deploy/kagent/ecc-plugin/test-ecc-plugin.sh --apply      # apply the YAML first
# Env: KCONTEXT (kind-kind), NS (kagent), AGENT (ecc-agent),
#      LIVE_TIMEOUT (5m), TEST_TASK (override the prompt sent in layer 4).
#
# Exit codes: 0 all layers passed, 1 a plugin/control-plane layer failed,
#             2 plugin layers passed but the live turn failed (model path, not plugin).
set -uo pipefail

KCONTEXT="${KCONTEXT:-kind-kind}"
NS="${NS:-kagent}"
AGENT="${AGENT:-ecc-agent}"
TEMPLATE_NAME="${TEMPLATE_NAME:-ecc-template}"
HARNESS="${HARNESS:-ecc-codex}"
MODELCONFIG="${MODELCONFIG:-ecc-gemini-model}"
PUSH_REF_HOST="${PUSH_REF_HOST:-localhost:5001/ecc-plugin}"
ATE_NS="${ATE_NS:-ate-system}"
LIVE_TIMEOUT="${LIVE_TIMEOUT:-5m}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The builder stamps a gitignored local copy, so that is the file whose digest is
# compared against the live AgentTemplate; the committed ecc-agent.yaml holds the
# ghcr ref CI publishes and would always read as drift inside a kind cluster.
MANIFEST="${MANIFEST:-${SCRIPT_DIR}/build/ecc-agent.local.yaml}"
[ -f "${MANIFEST}" ] || MANIFEST="${SCRIPT_DIR}/ecc-agent.yaml"

QUICK=false
APPLY=false
for a in "$@"; do
  case "$a" in
    --quick) QUICK=true ;;
    --apply) APPLY=true ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'unknown flag: %s\n' "$a" >&2; exit 64 ;;
  esac
done

PASS=0; FAIL_LAYER=""
hr()   { printf '\n\033[1m── %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL_LAYER="${FAIL_LAYER:-$1}"; }
note() { printf '        %s\n' "$*"; }
kctl() { kubectl --context "${KCONTEXT}" -n "${NS}" "$@"; }

# ------------------------------------------------------------------ 0. preflight
hr "preflight"
command -v kubectl >/dev/null || { bad "kubectl not on PATH"; exit 1; }
command -v docker  >/dev/null || { bad "docker not on PATH"; exit 1; }
kubectl config get-contexts "${KCONTEXT}" >/dev/null 2>&1 || { bad "no kube context ${KCONTEXT}"; exit 1; }
ok "context ${KCONTEXT}"
[ -f "${MANIFEST}" ] || { bad "missing ${MANIFEST}"; exit 1; }

if [ "${APPLY}" = true ]; then
  kctl apply -f "${MANIFEST}" >/dev/null 2>&1 || kubectl --context "${KCONTEXT}" apply -f "${MANIFEST}"
  ok "applied ${MANIFEST##*/}"
  # the golden rebuild is what layer 3 inspects, so give it a chance to land
  for _ in $(seq 1 30); do
    [ "$(kctl get agent "${AGENT}" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = "True" ] && break
    sleep 5
  done
fi

LIVE_OCI="$(kctl get agenttemplate "${TEMPLATE_NAME}" -o jsonpath='{.spec.plugins[0].source.oci}' 2>/dev/null)"
FILE_OCI="$(grep -m1 -E '^[[:space:]]*oci:[[:space:]]+[0-9]' "${MANIFEST}" | sed -E 's/^[[:space:]]*oci:[[:space:]]+//')"
REVISION="$(kctl get agent "${AGENT}" -o jsonpath='{.status.desiredRevision}' 2>/dev/null)"

# ---------------------------------------------------------------- 1. control plane
hr "1. control plane"
for r in "modelconfig/${MODELCONFIG}" "harness/${HARNESS}" "agenttemplate/${TEMPLATE_NAME}" "agent/${AGENT}"; do
  if kctl get "${r}" >/dev/null 2>&1; then ok "${r} exists"; else bad "${r} not found in ${NS}"; fi
done

if [ -z "${REVISION}" ]; then
  bad "agent ${AGENT} has no status.desiredRevision"
else
  ok "desiredRevision ${REVISION:0:12}"
fi

for c in Accepted ResolvedRefs Compatible Ready; do
  st="$(kctl get agent "${AGENT}" -o "jsonpath={.status.conditions[?(@.type==\"${c}\")].status}" 2>/dev/null)"
  msg="$(kctl get agent "${AGENT}" -o "jsonpath={.status.conditions[?(@.type==\"${c}\")].message}" 2>/dev/null)"
  if [ "${st}" = "True" ]; then ok "condition ${c}=True"; else bad "condition ${c}=${st:-absent}: ${msg}"; fi
done

if [ -z "${LIVE_OCI}" ]; then
  bad "no spec.plugins[0].source.oci on ${TEMPLATE_NAME}"
elif [ -z "${FILE_OCI}" ]; then
  bad "no kind-registry oci: in ${MANIFEST##*/} (the committed manifest holds the ghcr ref, which this cluster cannot pull)"
  note "run bash ${SCRIPT_DIR}/build-ecc-plugin-image.sh, or point MANIFEST= at the stamped build/ecc-agent.local.yaml"
elif [ "${LIVE_OCI}" = "${FILE_OCI}" ]; then
  ok "plugin source matches the manifest: ${LIVE_OCI}"
else
  bad "drift: live AgentTemplate=${LIVE_OCI} but ${MANIFEST##*/}=${FILE_OCI}"
  note "rebuilt the image without re-applying? bash build-ecc-plugin-image.sh && kubectl apply -f ${MANIFEST}"
fi

# ------------------------------------------------------------------- 2. artifact
hr "2. OCI artifact in the kind registry"
DIGEST="${LIVE_OCI##*@}"
case "${DIGEST}" in
  sha256:*) ok "digest-pinned reference ${DIGEST:0:19}…" ;;
  *) bad "reference is not digest-pinned: ${LIVE_OCI:-<none>} (kagent rejects bare tags)"; DIGEST="" ;;
esac
if [ -n "${DIGEST}" ]; then
  # Checked from the host through the registry's published port; layer 3 checks the
  # in-cluster path separately, because atelet forces https on anything that is not
  # an RFC1918 IP, which is why the spec carries an IP and not kind-registry:5000.
  # --insecure is required: the kind registry serves plain http and docker defaults to
  # https, so without it this check fails on an image that is plainly present.
  if docker manifest inspect --insecure "${PUSH_REF_HOST}@${DIGEST}" >/dev/null 2>&1; then
    ok "manifest resolves at ${PUSH_REF_HOST}@${DIGEST:0:19}…"
  else
    bad "registry has no manifest for ${DIGEST:0:19}… (image GC'd or pushed elsewhere?)"
    note "rebuild with: bash ${SCRIPT_DIR}/build-ecc-plugin-image.sh"
  fi
fi

# ---------------------------------------------------------------------- 3. mount
hr "3. plugin volume mounted into the sandbox"
# atelet logs the full actor spec for every Run, including the volume list it was
# handed and the mountPath the harness sees. This is the only layer that proves the
# OCI bundle was materialised rather than merely accepted by the API.
ATELET_POD="$(kubectl --context "${KCONTEXT}" -n "${ATE_NS}" get pods \
  --field-selector=status.phase=Running -o name 2>/dev/null | grep atelet | head -1 | sed 's|^pod/||')"
if [ -z "${ATELET_POD}" ]; then
  bad "no atelet pod found in ${ATE_NS}"
elif [ -z "${REVISION}" ]; then
  bad "cannot look up the actor without a revision"
else
  ACTOR_TMPL="${AGENT}-${REVISION:0:12}"
  note "actor template ${ACTOR_TMPL}"
  LOG="$(kubectl --context "${KCONTEXT}" -n "${ATE_NS}" logs "${ATELET_POD}" --since=6h 2>/dev/null \
    | grep -F "\"actor_template_name\":\"${ACTOR_TMPL}\"" | grep -F '/atelet.Atelet/Run' | tail -1)"
  if [ -z "${LOG}" ]; then
    bad "no atelet Run record for ${ACTOR_TMPL} in the last 6h"
    note "the golden snapshot was built earlier than the log window, or the revision never ran"
  else
    printf '%s' "${LOG}" | python3 -c '
import json,sys
d=json.loads(sys.stdin.read())
spec=d["req"]["spec"]
vols={v["name"]:v.get("image",{}).get("reference","") for v in spec.get("volumes",[])}
mounts=[m for m in spec["containers"][0].get("volume_mounts",[]) if m["name"].startswith("skill")]
print("ERR\t" + str(d["err"])[:400] if d["err"] else "RUNOK")
for m in mounts:
    print("MOUNT\t" + m["name"] + "\t" + m["mount_path"] + "\t" + vols.get(m["name"],""))
if not mounts: print("NOMOUNT")
' 2>/dev/null > "${TMPDIR:-/tmp}/ecc-mount.txt"
    if grep -q '^ERR\t' "${TMPDIR:-/tmp}/ecc-mount.txt"; then
      bad "atelet Run failed: $(sed -n 's/^ERR\t//p' "${TMPDIR:-/tmp}/ecc-mount.txt" | cut -c1-160)"
      note "known trap: a DNS-named registry ref is fetched over https and rejected"
    elif grep -q '^NOMOUNT' "${TMPDIR:-/tmp}/ecc-mount.txt"; then
      bad "actor ran with no skill-* volume: the plugin source did not reach the sandbox"
    else
      while IFS=$'\t' read -r _ name path ref; do
        ok "${name} mounted at ${path}"
        note "image ${ref}"
        MOUNT_PATH="${path}"
      done < <(grep '^MOUNT' "${TMPDIR:-/tmp}/ecc-mount.txt")
      if [ -n "${DIGEST}" ] && ! grep -qF "${DIGEST}" "${TMPDIR:-/tmp}/ecc-mount.txt"; then
        bad "mounted volume does not carry the expected digest"
      fi
    fi
  fi
fi

# ------------------------------------------------------------------ 4. live turn
if [ "${QUICK}" = true ]; then
  hr "4. live turn (skipped by --quick)"
else
  hr "4. live turn through the kagent CLI"
  command -v kagent >/dev/null || { bad "kagent CLI not on PATH"; }
  SESSION_JSON="$(kagent agent session create --agent "${AGENT}" -n "${NS}" -o json 2>&1)"
  SESSION_ID="$(printf '%s' "${SESSION_JSON}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["session"]["id"])' 2>/dev/null)"
  if [ -z "${SESSION_ID}" ]; then
    bad "could not create a session: $(printf '%s' "${SESSION_JSON}" | head -c 200)"
  else
    ok "session ${SESSION_ID}"
    PREP="$(printf '%s' "${SESSION_JSON}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["session"].get("preparedRevision",""))' 2>/dev/null)"
    if [ -n "${REVISION}" ] && [ "${PREP}" != "${REVISION}" ]; then
      bad "session prepared ${PREP:0:12}, expected ${REVISION:0:12} (agent not converged yet)"
    else
      ok "session prepared revision ${PREP:0:12}"
    fi

    TASK="${TEST_TASK:-Use your shell to list the directories under ${MOUNT_PATH:-/run/kagent/artifacts}/ skills/ , then print the exact title line from the tdd-workflow SKILL.md. Report the skill names you found; do not invent any.}"
    note "task: $(printf '%s' "${TASK}" | cut -c1-120)…"
    REPLY="$(kagent agent invoke --session "${SESSION_ID}" -n "${NS}" --timeout "${LIVE_TIMEOUT}" \
      -t "${TASK}" 2>&1)"
    if printf '%s' "${REPLY}" | grep -qiE 'tdd-workflow'; then
      ok "agent read tdd-workflow from the mount"
    else
      # Distinguish a dead model endpoint from a dead plugin: by this point layers 1-3
      # have already proven the mount, so a failure here is almost never the plugin.
      # The CLI only reports its own deadline; the reason is on the proxy that served it.
      MODEL_ERR="$(kubectl --context "${KCONTEXT}" -n "${LITELLM_NS:-litellm}" logs \
        "deploy/${LITELLM_DEPLOY:-litellm}" --since=5m 2>/dev/null \
        | grep -E 'APIConnectionError|AuthenticationError|API key|expired|401|No fallback' \
        | tail -1)"
      [ -n "${MODEL_ERR}" ] || MODEL_ERR="$(printf '%s' "${REPLY}" | grep -iE '401|403|expired|invalid api key|unauthor|no route|upstream|Connection refused|deadline|timeout|error' | head -1)"
      if [ -n "${MODEL_ERR}" ]; then
        printf '  \033[33mMODEL PATH\033[0m live turn failed on the endpoint, not the plugin:\n'
        note "${MODEL_ERR}"
        note "the turn reached the proxy and failed there, so routing and the mount are intact"
        note "check: kubectl -n ${LITELLM_NS:-litellm} get deploy ${LITELLM_DEPLOY:-litellm} -o jsonpath='{.spec.template.spec.containers[0].env}'"
        note "and that the OpenRouter key in secret litellm-secrets is still valid (expired answers 401)"
        FAIL_LAYER="${FAIL_LAYER:-live turn / model endpoint}"
      else
        bad "reply did not mention tdd-workflow"
        note "$(printf '%s' "${REPLY}" | tail -c 300)"
      fi
    fi
    kagent agent session delete "${SESSION_ID}" -n "${NS}" >/dev/null 2>&1 || true
  fi
fi

# ---------------------------------------------------------------------- verdict
hr "verdict"
if [ -z "${FAIL_LAYER}" ]; then
  if [ "${QUICK}" = true ]; then
    printf '\033[32mPlugin is published and mounted in the sandbox; live turn not exercised (--quick).\033[0m (%s checks passed)\n' "${PASS}"
  else
    printf '\033[32mECC plugin is mounted and the live turn used it.\033[0m (%s checks passed)\n' "${PASS}"
  fi
  exit 0
fi
case "${FAIL_LAYER}" in
  *"model endpoint"*)
    printf '\033[33mPlugin layers passed; the live turn failed: %s\033[0m\n' "${FAIL_LAYER}"
    printf 'The bundle mounts and the agent converges. Fix the model route, then re-run with --quick omitted.\n'
    exit 2 ;;
  *)
    printf '\033[31mFailed at: %s\033[0m\n' "${FAIL_LAYER}"
    printf 'Fix that layer before trusting the mount. Rebuild+re-apply with:\n'
    printf '  bash %s/build-ecc-plugin-image.sh && kubectl --context %s apply -f %s\n' "${SCRIPT_DIR}" "${KCONTEXT}" "${MANIFEST}"
    exit 1 ;;
esac
