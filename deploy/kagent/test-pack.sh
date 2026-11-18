#!/usr/bin/env bash
# Test command for any kagent pack (plugin bundle or standalone skill) on the local
# kind cluster. The ECC-specific test-ecc-plugin.sh is what this generalizes.
#
# Answers one question: did the pack's artifact actually mount into the agent's
# sandbox, and can the agent be driven from the CLI? Four layers, cheapest first,
# and the verdict names the layer that failed:
#
#   1  control plane   the four CRs exist and the Agent reports Accepted/ResolvedRefs/
#                      Compatible/Ready; the digest in the manifest matches the live
#                      AgentTemplate (catches "rebuilt the image, forgot to re-apply")
#   2  artifact        the digest-pinned OCI ref resolves against the kind registry
#   3  mount           atelet's own Run call for the current revision reports the
#                      skill volume, its in-sandbox mountPath, and err=null
#   4  live turn       a session is created and invoked through the kagent CLI, and the
#                      reply must name a skill from that mount
#
# Layers 1-3 need no working model endpoint, so they still say whether the mount
# plumbing is intact while the LLM credentials are broken. Layer 4 is the only part
# that proves the agent can use the skills.
#
# Everything the checks need — resource names, which spec field carries the source,
# which skill to ask about — comes out of the catalogs, so a pack that is in the
# catalog is testable without writing another script.
#
# Usage:
#   bash deploy/kagent/test-pack.sh <id> [cli]           # all four layers
#   bash deploy/kagent/test-pack.sh <id> [cli] --quick    # layers 1-3 only
#   bash deploy/kagent/test-pack.sh <id> [cli] --apply    # apply the manifest first
# Examples:
#   bash deploy/kagent/test-pack.sh security-audit codex --apply --quick
#   bash deploy/kagent/test-pack.sh code-review-graph claude
# Env: KCONTEXT (kind-kind), NS (kagent), ATE_NS (ate-system), LIVE_TIMEOUT (5m),
#      TEST_TASK (override the prompt sent in layer 4).
#
# Exit codes: 0 all layers passed, 1 a pack/control-plane layer failed,
#             2 pack layers passed but the live turn failed (model path, not pack).
set -uo pipefail

ID="${1:?usage: test-pack.sh <plugin-or-skill-id> [cli] [--quick] [--apply]}"
shift
CLI="${1:-}"
case "${CLI}" in
  --* | "") ;;
  *) shift ;;
esac
CLI="${CLI:-codex}"

KCONTEXT="${KCONTEXT:-kind-kind}"
NS="${NS:-kagent}"
ATE_NS="${ATE_NS:-ate-system}"
LITELLM_NS="${LITELLM_NS:-litellm}"
LITELLM_DEPLOY="${LITELLM_DEPLOY:-litellm}"
LIVE_TIMEOUT="${LIVE_TIMEOUT:-5m}"

QUICK=false
APPLY=false
for a in "$@"; do
  case "$a" in
    --quick) QUICK=true ;;
    --apply) APPLY=true ;;
    -h|--help) sed -n '2,38p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'unknown flag: %s\n' "$a" >&2; exit 64 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

PASS=0; FAIL_LAYER=""; MOUNT_PATH=""
hr()   { printf '\n\033[1m── %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL_LAYER="${FAIL_LAYER:-$1}"; }
note() { printf '        %s\n' "$*"; }
kctl() { kubectl --context "${KCONTEXT}" -n "${NS}" "$@"; }

# ------------------------------------------------- 0. what the catalogs say to test
# Emitted by node, values constrained to identifier-ish characters so the eval
# below cannot execute anything the catalogs did not already state as a name.
SPEC="$(REPO_ROOT="${REPO_ROOT}" ID="${ID}" CLI="${CLI}" node -e '
const path = require("node:path");
const root = process.env.REPO_ROOT;
const reg = (n) => require(path.join(root, "packages/shared-core/src/agent/registry", n));
const { CATALOG, enabledSkills, findPlugin } = reg("plugin-catalog");
const { SKILLS, findSkill } = reg("skill-catalog");
const id = process.env.ID, cli = process.env.CLI;
const plugin = findPlugin(id, CATALOG);
const record = plugin || findSkill(id, SKILLS);
if (!record) { console.error(`no catalog record named ${id}`); process.exit(1); }
const entry = (record.harnesses || {})[cli];
if (!entry) { console.error(`catalog ${id} has no ${cli} row`); process.exit(1); }
// An unsupported row is not a broken mount: the runtime image does not exist yet.
// Saying so here stops the first check from reading as "agent not found".
if (entry.status === "unsupported") {
  console.error(`${id}/${cli} is unsupported: blocked on ${entry.blockedOn || "a runtime image the catalog does not name"}`);
  process.exit(1);
}
const bundle = plugin ? record.bundle : record.artifact;
const manifests = bundle.manifests || {};
const out = {
  KIND: plugin ? "plugin" : "skill",
  MANIFEST: manifests[cli] || "",
  LABEL: record.label,
  AGENT: `${id}-${cli}-agent`,
  TEMPLATE: `${id}-${cli}-template`,
  HARNESS: `${id}-${cli}`,
  MODELCONFIG: `${id}-${cli}-model`,
  // A standalone skill mounts through spec.skills[].source; a bundle through
  // spec.plugins[].source. Asking the wrong path reads empty and looks like a
  // missing plugin.
  SOURCE: plugin ? ".spec.plugins[0].source.oci" : ".spec.skills[0].source.oci",
  // The skill the live turn asks about: an enabled one, never a bundled-but-
  // disabled one the agent legitimately cannot see.
  SKILL: plugin ? (enabledSkills(record)[0] || "") : id,
  REGISTRY_IMAGE: (bundle.image || "").split("/").pop(),
};
for (const [k, v] of Object.entries(out)) {
  if (!/^[A-Za-z0-9._/@:+-]*$/.test(v)) { console.error(`${k} has an unexpected character: ${v}`); process.exit(1); }
  process.stdout.write(`${k}=${v}\n`);
}
' 2>&1)" || { printf 'ERROR: %s\n' "$SPEC" >&2; exit 1; }
# shellcheck disable=SC2046,SC2086
eval "$(printf '%s\n' "${SPEC}" | sed -E "s/^([A-Z_]+)=(.*)$/\1='\2'/")"

MANIFEST_ABS="${REPO_ROOT}/${MANIFEST}"
PUSH_REF_HOST="${PUSH_REF_HOST:-localhost:5001/${REGISTRY_IMAGE}}"

# ------------------------------------------------------------------ 0. preflight
hr "preflight"
command -v kubectl >/dev/null || { bad "kubectl not on PATH"; exit 1; }
command -v docker  >/dev/null || { bad "docker not on PATH"; exit 1; }
kubectl config get-contexts "${KCONTEXT}" >/dev/null 2>&1 || { bad "no kube context ${KCONTEXT}"; exit 1; }
ok "context ${KCONTEXT}, ${KIND} ${LABEL} on ${CLI}"
if [ -z "${MANIFEST}" ]; then
  bad "the catalog names no ${CLI} manifest for ${ID}"
  note "add bundle.manifests.${CLI} (or artifact.manifests.${CLI}) to the catalog record"
  exit 1
fi
[ -f "${MANIFEST_ABS}" ] || { bad "missing ${MANIFEST}"; exit 1; }
if [ "${APPLY}" = true ]; then
  kctl apply -f "${MANIFEST_ABS}" >/dev/null 2>&1 || kubectl --context "${KCONTEXT}" apply -f "${MANIFEST_ABS}"
  ok "applied ${MANIFEST##*/}"
  # The golden rebuild is what layer 3 inspects, so give it a chance to land.
  for _ in $(seq 1 30); do
    [ "$(kctl get agent "${AGENT}" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = "True" ] && break
    sleep 5
  done
fi

LIVE_OCI="$(kctl get agenttemplate "${TEMPLATE}" -o jsonpath="{${SOURCE}}" 2>/dev/null)"
FILE_OCI="$(grep -m1 -E '^[[:space:]]*oci:[[:space:]]' "${MANIFEST_ABS}" | sed -E 's/^[[:space:]]*oci:[[:space:]]+//; s/^'\''//; s/'\''$//')"
REVISION="$(kctl get agent "${AGENT}" -o jsonpath='{.status.desiredRevision}' 2>/dev/null)"

# ---------------------------------------------------------------- 1. control plane
hr "1. control plane"
for r in "modelconfig/${MODELCONFIG}" "harness/${HARNESS}" "agenttemplate/${TEMPLATE}" "agent/${AGENT}"; do
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
  bad "no ${SOURCE} on ${TEMPLATE}"
elif [ -z "${FILE_OCI}" ]; then
  bad "no oci: line in ${MANIFEST##*/}"
elif [ "${LIVE_OCI}" = "${FILE_OCI}" ]; then
  ok "artifact source matches the manifest: ${LIVE_OCI}"
else
  bad "drift: live AgentTemplate=${LIVE_OCI} but ${MANIFEST##*/}=${FILE_OCI}"
  note "rebuilt the image without re-applying? run the builder for ${ID}, then apply ${MANIFEST}"
fi

# ------------------------------------------------------------------- 2. artifact
hr "2. OCI artifact in the kind registry"
DIGEST="${LIVE_OCI##*@}"
case "${DIGEST}" in
  sha256:*) ok "digest-pinned reference ${DIGEST:0:19}…" ;;
  *) bad "reference is not digest-pinned: ${LIVE_OCI:-<none>} (kagent rejects bare tags)"; DIGEST="" ;;
esac
if [ -n "${DIGEST}" ]; then
  if [ "${DIGEST#sha256:}" = "0000000000000000000000000000000000000000000000000000000000000000" ]; then
    bad "the manifest still carries the unstamped placeholder digest"
    note "publish it: bash deploy/kagent/build-${KIND}-image.sh ${ID}"
    DIGEST=""
  else
    # Checked from the host through the registry's published port; layer 3 checks
    # the in-cluster path separately, because atelet forces https on anything that
    # is not an RFC1918 IP — which is why the spec carries an IP and not
    # kind-registry:5000. --insecure is required: the kind registry serves plain
    # http and docker defaults to https, so without it this check fails on an
    # image that is plainly present.
    if docker manifest inspect --insecure "${PUSH_REF_HOST}@${DIGEST}" >/dev/null 2>&1; then
      ok "manifest resolves at ${PUSH_REF_HOST}@${DIGEST:0:19}…"
    else
      bad "registry has no manifest for ${DIGEST:0:19}… (image GC'd or pushed elsewhere?)"
      note "rebuild with: bash deploy/kagent/build-${KIND}-image.sh ${ID}"
    fi
  fi
fi

# ---------------------------------------------------------------------- 3. mount
hr "3. ${KIND} volume mounted into the sandbox"
# atelet logs the full actor spec for every Run, including the volume list it was
# handed and the mountPath the harness sees. This is the only layer that proves the
# OCI artifact was materialised rather than merely accepted by the API.
ATELET_POD="$(kubectl --context "${KCONTEXT}" -n "${ATE_NS}" get pods \
  --field-selector=status.phase=Running -o name 2>/dev/null | grep atelet | head -1 | sed 's|^pod/||')"
if [ -z "${ATELET_POD}" ]; then
  bad "no atelet pod found in ${ATE_NS}"
elif [ -z "${REVISION}" ]; then
  bad "cannot look up the actor without a revision"
else
  ACTOR_TMPL="${AGENT}-${REVISION:0:12}"
  note "actor template ${ACTOR_TMPL}"
  MOUNT_OUT="${TMPDIR:-/tmp}/${ID}-${CLI}-mount.txt"
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
' 2>/dev/null > "${MOUNT_OUT}"
    if grep -q '^ERR\t' "${MOUNT_OUT}"; then
      bad "atelet Run failed: $(sed -n 's/^ERR\t//p' "${MOUNT_OUT}" | cut -c1-160)"
      note "known trap: a DNS-named registry ref is fetched over https and rejected"
    elif grep -q '^NOMOUNT' "${MOUNT_OUT}"; then
      bad "actor ran with no skill-* volume: the ${KIND} source did not reach the sandbox"
    else
      while IFS=$'\t' read -r _ name path ref; do
        ok "${name} mounted at ${path}"
        note "image ${ref}"
        MOUNT_PATH="${path}"
      done < <(grep '^MOUNT' "${MOUNT_OUT}")
      if [ -n "${DIGEST}" ] && ! grep -qF "${DIGEST}" "${MOUNT_OUT}"; then
        bad "mounted volume does not carry the expected digest"
      fi
    fi
  fi
  rm -f "${MOUNT_OUT}"
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

    TASK="${TEST_TASK:-Use your shell to list the directories under ${MOUNT_PATH:-/run/kagent/artifacts}/ skills/ , then print the exact title line from the ${SKILL} SKILL.md. Report the skill names you found; do not invent any.}"
    note "task: $(printf '%s' "${TASK}" | cut -c1-120)…"
    REPLY="$(kagent agent invoke --session "${SESSION_ID}" -n "${NS}" --timeout "${LIVE_TIMEOUT}" \
      -t "${TASK}" 2>&1)"
    if printf '%s' "${REPLY}" | grep -qiF "${SKILL}"; then
      ok "agent read ${SKILL} from the mount"
    else
      # Distinguish a dead model endpoint from a dead mount: by this point layers 1-3
      # have already proven the mount, so a failure here is almost never the pack.
      # The CLI only reports its own deadline; the reason is on the proxy that served it.
      MODEL_ERR="$(kubectl --context "${KCONTEXT}" -n "${LITELLM_NS}" logs \
        "deploy/${LITELLM_DEPLOY}" --since=5m 2>/dev/null \
        | grep -E 'APIConnectionError|AuthenticationError|API key|expired|401|No fallback' \
        | tail -1)"
      [ -n "${MODEL_ERR}" ] || MODEL_ERR="$(printf '%s' "${REPLY}" | grep -iE '401|403|expired|invalid api key|unauthor|no route|upstream|Connection refused|deadline|timeout|error' | head -1)"
      if [ -n "${MODEL_ERR}" ]; then
        printf '  \033[33mMODEL PATH\033[0m live turn failed on the endpoint, not the pack:\n'
        note "${MODEL_ERR}"
        note "the turn reached the proxy and failed there, so routing and the mount are intact"
        note "check: kubectl -n ${LITELLM_NS} get deploy ${LITELLM_DEPLOY} -o jsonpath='{.spec.template.spec.containers[0].env}'"
        note "and that the model key in secret litellm-secrets is still valid (expired answers 401)"
        FAIL_LAYER="${FAIL_LAYER:-live turn / model endpoint}"
      else
        bad "reply did not mention ${SKILL}"
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
    printf '\033[32m%s is published and mounted in the sandbox; live turn not exercised (--quick).\033[0m (%s checks passed)\n' "${LABEL}" "${PASS}"
  else
    printf '\033[32m%s is mounted and the live turn used it.\033[0m (%s checks passed)\n' "${LABEL}" "${PASS}"
  fi
  exit 0
fi
case "${FAIL_LAYER}" in
  *"model endpoint"*)
    printf '\033[33mPack layers passed; the live turn failed: %s\033[0m\n' "${FAIL_LAYER}"
    printf 'The artifact mounts and the agent converges. Fix the model route, then re-run with --quick omitted.\n'
    exit 2 ;;
  *)
    printf '\033[31mFailed at: %s\033[0m\n' "${FAIL_LAYER}"
    printf 'Fix that layer before trusting the mount. Rebuild + re-apply with:\n'
    printf '  bash deploy/kagent/build-%s-image.sh %s && kubectl --context %s apply -f %s\n' \
      "${KIND}" "${ID}" "${KCONTEXT}" "${MANIFEST}"
    exit 1 ;;
esac
