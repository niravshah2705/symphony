#!/usr/bin/env bash
# Adds an explicit `gemini-3.6-flash` alias to the in-cluster LiteLLM proxy and puts the
# model context parameters on it.
#
# Why here: the agent runs on the codex Harness, whose contract accepts only
# openAI.baseUrl and openAI.apiFormat on a ModelConfig -- temperature, max_tokens and the
# rest are rejected at the Compatible check. LiteLLM params are the one place those knobs
# take effect for this agent, and the proxy already holds OPENROUTER_API_KEY.
#
# Idempotent: appends nothing if the alias is already configured. The config is mounted
# with subPath, so a ConfigMap edit only lands after the rollout this script triggers.
#
# Usage: bash deploy/kagent/ecc-plugin/patch-litellm-gemini.sh
# Env:   MODEL=<openrouter id>  MAX_TOKENS=<n>  TEMPERATURE=<x>  PROBE=false to skip the
#        live round-trip.
set -euo pipefail

NAMESPACE="${NAMESPACE:-litellm}"
CONFIGMAP="${CONFIGMAP:-litellm-config}"
DEPLOYMENT="${DEPLOYMENT:-litellm}"
ALIAS="${ALIAS:-gemini-3.6-flash}"
UPSTREAM="${UPSTREAM:-openrouter/google/gemini-3.6-flash}"
MAX_TOKENS="${MAX_TOKENS:-16384}"
TEMPERATURE="${TEMPERATURE:-0.2}"
TOP_P="${TOP_P:-0.95}"
CONTEXT_INPUT="${CONTEXT_INPUT:-1048576}"    # gemini-3.6-flash context window on OpenRouter
CONTEXT_OUTPUT="${CONTEXT_OUTPUT:-65536}"
PROBE="${PROBE:-true}"
KCONTEXT="${KCONTEXT:-kind-kind}"
KEY_SECRET_NS="${KEY_SECRET_NS:-kagent}"
KEY_SECRET="${KEY_SECRET:-litellm-secrets}"
KEY_SECRET_KEY="${KEY_SECRET_KEY:-LITELLM_MASTER_KEY}"

log() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
kctl() { kubectl --context "${KCONTEXT}" "$@"; }

log "reading ${CONFIGMAP}/config.yaml from ${NAMESPACE}"
CONFIG="$(kctl get cm "${CONFIGMAP}" -n "${NAMESPACE}" -o jsonpath='{.data.config\.yaml}')" \
  || die "no ${CONFIGMAP} in ${NAMESPACE}"

if printf '%s' "${CONFIG}" | grep -q "model_name: ${ALIAS}\$"; then
  log "alias ${ALIAS} already present; nothing to patch"
else
  # model_list is the last top-level key in this file, so an appended item is a new entry.
  # If that ever stops being true, this block has to move to a real YAML merge.
  printf '%s\n%s' "${CONFIG}" "
- model_name: ${ALIAS}
  litellm_params:
    api_key: os.environ/OPENROUTER_API_KEY
    model: ${UPSTREAM}
    max_tokens: ${MAX_TOKENS}
    temperature: ${TEMPERATURE}
    top_p: ${TOP_P}
    stream: true
  model_info:
    max_input_tokens: ${CONTEXT_INPUT}
    max_output_tokens: ${CONTEXT_OUTPUT}" > /tmp/litellm-config.new.yaml

  log "applying ${ALIAS} with max_tokens=${MAX_TOKENS} temperature=${TEMPERATURE} top_p=${TOP_P} ctx=${CONTEXT_INPUT}/${CONTEXT_OUTPUT}"
  kctl create cm "${CONFIGMAP}" -n "${NAMESPACE}" \
    --from-file=config.yaml=/tmp/litellm-config.new.yaml \
    --dry-run=client -o yaml | kctl apply -f -
  rm -f /tmp/litellm-config.new.yaml

  log "restarting ${DEPLOYMENT} (subPath mounts do not hot-reload)"
  kctl rollout restart deploy/"${DEPLOYMENT}" -n "${NAMESPACE}"
  kctl rollout status deploy/"${DEPLOYMENT}" -n "${NAMESPACE}" --timeout=180s
fi

if [ "${PROBE}" != "true" ]; then
  log "PROBE=${PROBE}; skipping the live call"
  exit 0
fi

MASTER_KEY="$(kctl get secret "${KEY_SECRET}" -n "${KEY_SECRET_NS}" \
  -o jsonpath="{.data.${KEY_SECRET_KEY}}" | base64 -d)"
[ -n "${MASTER_KEY}" ] || die "could not read ${KEY_SECRET}/${KEY_SECRET_KEY}"

SVC="$(kctl get svc "${DEPLOYMENT}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.clusterIP}')"
[ -n "${SVC}" ] || die "no clusterIP for svc/${DEPLOYMENT} in ${NAMESPACE}"

log "probing ${ALIAS} through the proxy (this spends one small OpenRouter call)"
# One-shot pod: nothing on the host can reach the ClusterIP directly.
RESULT="$(kctl run litellm-probe --rm -i --restart=Never \
  --image=curlimages/curl:latest --image-pull-policy=IfNotPresent -- \
  -sS -m 90 -X POST "http://${SVC}:4000/v1/chat/completions" \
  -H "Authorization: Bearer ${MASTER_KEY}" \
  -H 'content-type: application/json' \
  -d "{\"model\":\"${ALIAS}\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: ready\"}]}" \
  2>/dev/null)"

printf '%s\n' "${RESULT}" | grep -q '"content"' \
  || die "proxy did not answer for ${ALIAS}: ${RESULT}"
log "alias ${ALIAS} -> ${UPSTREAM} answered: $(printf '%s' "${RESULT}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["choices"][0]["message"]["content"][:60] or "(empty)")')"
log "ready: point the ModelConfig at model: ${ALIAS}"
