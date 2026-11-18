#!/usr/bin/env bash
# Points the local LiteLLM proxy at Sarvam so the ECC agent has a model route that
# does not depend on OpenRouter credit.
#
# Sequence matters: a dead key written into the router config produces a 500 at the
# agent and hides whether the shape was ever right. So this script mounts the
# credential, proves it authenticates AND has credit with one tiny upstream call, and
# only then adds the alias. The final probe is /v1/responses, not /v1/chat/completions,
# because the codex Harness is contracted to the responses wire format -- a route that
# only answers chat.completions upstream still has to be reachable that way through the
# proxy, which converts the request.
#
# No credential is ever passed on a command line: both probes exec into the proxy pod
# and read os.environ there, so nothing sensitive lands in shell history or logs.
#
# Usage:
#   bash deploy/kagent/ecc-plugin/patch-litellm-sarvam.sh              # check + patch + probe
#   APPLY=false bash deploy/kagent/ecc-plugin/patch-litellm-sarvam.sh  # only verify the key works
#   PROBE=false ... # patch without spending a call
#   MODEL=deepseekv4.1-flash-1017 API_BASE=https://api.sarvam.ai/v2 ...  # open-weight route, 1M ctx
# Env:   ALIAS, MODEL, API_BASE, MAX_TOKENS, TEMPERATURE, CONTEXT_INPUT, CONTEXT_OUTPUT,
#        SECRET_NS, SECRET, SECRET_KEY, RESTART=true, PROBE=true, APPLY=true, KCONTEXT
set -euo pipefail

NAMESPACE="${NAMESPACE:-litellm}"
CONFIGMAP="${CONFIGMAP:-litellm-config}"
DEPLOYMENT="${DEPLOYMENT:-litellm}"
SECRET_NS="${SECRET_NS:-litellm}"
SECRET="${SECRET:-litellm-secrets}"
SECRET_KEY="${SECRET_KEY:-SARVAM_KEY}"

MODEL="${MODEL:-sarvam-105b}"
ALIAS="${ALIAS:-${MODEL}}"
API_BASE="${API_BASE:-https://api.sarvam.ai/v1}"
MAX_TOKENS="${MAX_TOKENS:-16384}"
TEMPERATURE="${TEMPERATURE:-0.2}"
# Sarvam's own numbers: 128K context on sarvam-105b. max_tokens is not generous here by
# default -- with thinking on (the default) reasoning tokens are billed against it, so a
# small cap returns finish_reason=length with empty content.
CONTEXT_INPUT="${CONTEXT_INPUT:-131072}"
CONTEXT_OUTPUT="${CONTEXT_OUTPUT:-16384}"
APPLY="${APPLY:-true}"
PROBE="${PROBE:-true}"
RESTART="${RESTART:-true}"
KCONTEXT="${KCONTEXT:-kind-kind}"

log() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
kctl() { kubectl --context "${KCONTEXT}" "$@"; }

# ------------------------------------------------- 1. mount the credential into the proxy
log "checking ${SECRET}/${SECRET_KEY} is on ${NAMESPACE}/deploy/${DEPLOYMENT}"
if kctl get deploy "${DEPLOYMENT}" -n "${NAMESPACE}" \
     -o jsonpath='{.spec.template.spec.containers[0].env[*].name}' | tr ' ' '\n' \
     | grep -qx "${SECRET_KEY}"; then
  log "${SECRET_KEY} already mounted"
else
  kctl get secret "${SECRET}" -n "${SECRET_NS}" >/dev/null 2>&1 \
    || die "secret ${SECRET} has no ${SECRET_KEY} in ${SECRET_NS}; nothing to mount"
  kctl patch deploy "${DEPLOYMENT}" -n "${NAMESPACE}" --type=strategic -p \
    "{\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"name\":\"${DEPLOYMENT}\",\"env\":[{\"name\":\"${SECRET_KEY}\",\"valueFrom\":{\"secretKeyRef\":{\"name\":\"${SECRET}\",\"key\":\"${SECRET_KEY}\"}}}]}]}}}}" >/dev/null
  log "mounted ${SECRET_KEY} from secret/${SECRET}"
  kctl rollout status deploy/"${DEPLOYMENT}" -n "${NAMESPACE}" --timeout=240s \
    || die "rollout did not finish; the key is set but the running pod cannot see it yet"
fi

# ------------------------------------------- 2. prove the key authenticates and has credit
# Direct to the provider, from inside the proxy pod. A 403 means the key is wrong or
# unpaid (Sarvam answers auth failures with 403, not 401); a 402/insufficient-credits
# message is the same blocker OpenRouter's negative balance was.
log "verifying the key against ${API_BASE}/chat/completions (model ${MODEL}) -- this spends one tiny call"
# Only the non-secret model id and URL are interpolated into the snippet; the key is
# read from the pod's own environment, so it never appears in the command or in logs.
AUTH_OUT="$(kctl exec -n "${NAMESPACE}" deploy/"${DEPLOYMENT}" -- python3 -c "
import json, os, re, urllib.request, urllib.error
# .strip() matters: the stored secret carries a trailing newline, which urllib rejects
# as an invalid header value before the request is ever sent.
key = os.environ['${SECRET_KEY}'].strip()
def scrub(s):
    return re.sub(re.escape(key), '********', str(s))[:300]
body = json.dumps({'model': '${MODEL}', 'max_tokens': 8, 'reasoning_effort': 'none',
                   'messages': [{'role': 'user', 'content': 'Reply with the single word: ready'}]}).encode()
req = urllib.request.Request('${API_BASE}/chat/completions', data=body, method='POST', headers={
    'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
try:
    with urllib.request.urlopen(req, timeout=90) as r:
        d = json.load(r)
    print('OK ' + (d['choices'][0]['message']['content'] or '').strip()[:40] + ' ' + json.dumps(d.get('usage', {})))
except urllib.error.HTTPError as e:
    print('FAIL http%s %s' % (e.code, scrub(e.read().decode())))
except Exception as e:
    print('FAIL %s: %s' % (type(e).__name__, scrub(e)))
" 2>/dev/null | tail -1)"
case "${AUTH_OUT}" in
  OK\ *) log "key is live: ${AUTH_OUT#OK }" ;;
  *) die "Sarvam refused the key: ${AUTH_OUT:-no output from the probe}. Fix the credential before touching the router config -- APPLY was not run." ;;
esac

if [ "${APPLY}" != "true" ]; then
  log "APPLY=${APPLY}; credential verified, router config untouched"
  exit 0
fi

# ------------------------------------------------------------------ 3. add the alias
CONFIG="$(kctl get cm "${CONFIGMAP}" -n "${NAMESPACE}" -o jsonpath='{.data.config\.yaml}')"
if printf '%s' "${CONFIG}" | grep -q "model_name: ${ALIAS}\$"; then
  log "alias ${ALIAS} already present; nothing to patch"
else
  # model_list is the last top-level key in this file, so an appended entry parses as a
  # new item. If that ever stops being true this needs a real YAML merge.
  # openai/ is the OpenAI-compatible provider in LiteLLM: it sends Authorization: Bearer,
  # which Sarvam accepts alongside its native api-subscription-key header, and it appends
  # /chat/completions to api_base.
  printf '%s\n%s' "${CONFIG}" "
- model_name: ${ALIAS}
  litellm_params:
    api_key: os.environ/${SECRET_KEY}
    api_base: ${API_BASE}
    model: openai/${MODEL}
    max_tokens: ${MAX_TOKENS}
    temperature: ${TEMPERATURE}
    stream: true
  model_info:
    max_input_tokens: ${CONTEXT_INPUT}
    max_output_tokens: ${CONTEXT_OUTPUT}" > /tmp/litellm-config-sarvam.yaml
  log "adding ${ALIAS} -> ${API_BASE} model ${MODEL} (ctx ${CONTEXT_INPUT}/${CONTEXT_OUTPUT}, max_tokens ${MAX_TOKENS})"
  kctl create cm "${CONFIGMAP}" -n "${NAMESPACE}" --from-file=config.yaml=/tmp/litellm-config-sarvam.yaml \
    --dry-run=client -o yaml | kctl apply -f -
  rm -f /tmp/litellm-config-sarvam.yaml
fi

# ----------------------------------------------------------------------- 4. restart
if [ "${RESTART}" = "true" ]; then
  log "restarting ${DEPLOYMENT} (config is mounted via subPath and does not hot-reload)"
  kctl rollout restart deploy/"${DEPLOYMENT}" -n "${NAMESPACE}"
  kctl rollout status deploy/"${DEPLOYMENT}" -n "${NAMESPACE}" --timeout=240s || true
fi

# ------------------------------------------------------------------------ 5. probe
if [ "${PROBE}" != "true" ]; then
  log "PROBE=${PROBE}; skipping the round-trip"
  exit 0
fi
log "probing /v1/responses for ${ALIAS} through the proxy -- the codex harness' actual call"
RESP_OUT="$(kctl exec -n "${NAMESPACE}" deploy/"${DEPLOYMENT}" -- python3 -c "
import json, os, urllib.request, urllib.error
key = (os.environ.get('LITELLM_MASTER_KEY') or os.environ.get('PROXY_MASTER_KEY') or '').strip()
body = json.dumps({'model': '${ALIAS}', 'max_output_tokens': 16, 'stream': False,
                   'input': [{'role': 'user', 'content': [{'type': 'input_text',
                              'text': 'Reply with the single word: ready'}]}]}).encode()
req = urllib.request.Request('http://127.0.0.1:4000/v1/responses', data=body, method='POST',
                             headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.load(r)
    txt = ''.join(c.get('text', '') for o in d.get('output', []) for c in o.get('content', []) if isinstance(c, dict))
    print('OK ' + (txt or json.dumps(d)[:160]).strip()[:80])
except urllib.error.HTTPError as e:
    print('FAIL http%s %s' % (e.code, e.read().decode()[:400]))
except Exception as e:
    print('FAIL %s: %s' % (type(e).__name__, str(e)[:300]))
" 2>/dev/null | tail -1)"
case "${RESP_OUT}" in
  OK\ *) log "the route answers the responses API: ${RESP_OUT#OK }" ;;
  *) die "proxy did not serve /v1/responses for ${ALIAS}: ${RESP_OUT:-no output}. If this reports the Responses API is unsupported for this provider, the codex harness cannot use this route -- it is contracted to apiFormat: responses and accepts no other openAI setting." ;;
esac
log "ready: point the ModelConfig at model: ${ALIAS}"
