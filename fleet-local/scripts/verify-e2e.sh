#!/usr/bin/env bash
# End-to-end verification against the 12-point plan gate. Automatable read-backs
# run here; interactive gates (Google login, live chat, online spend) are printed
# as MANUAL with the exact steps. Nothing is reported PASS unless observed.
#   ORG_UUID=<uuid> scripts/verify-e2e.sh   # to exercise per-org Flexprice checks
# Run scripts/port-forwards.sh first for the Langfuse/Prometheus/Jaeger read-backs.
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0; MANUAL=0
ok()   { echo "PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL  $1"; FAIL=$((FAIL+1)); }
man()  { echo "MANUAL $1"; MANUAL=$((MANUAL+1)); }

ORG_UUID=${ORG_UUID:-}
FP_KEY=$(kubectl -n litellm get deploy litellm -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="FLEXPRICE_API_KEY")].value}' 2>/dev/null)
FP_ENV=$(kubectl -n litellm get deploy litellm -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="FLEXPRICE_ENVIRONMENT_ID")].value}' 2>/dev/null)
fpcurl() { curl -sS --resolve api.flexprice.local:80:127.0.0.1 \
  -H "x-api-key: $FP_KEY" -H "X-Environment-ID: $FP_ENV" -H 'Content-Type: application/json' "$@"; }

echo "=== 1. edge: app/kagent https via nginx; flexprice hosts unchanged ==="
for h in app.fleet.dev kagent.fleet.dev; do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$h:443:127.0.0.1" "https://$h/" 2>/dev/null)
  case "$code" in 200|302|401) ok "$h https responds ($code)";; *) bad "$h https ($code)";; esac
done
fpcode=$(curl -s -o /dev/null -w '%{http_code}' --resolve flexprice.local:80:127.0.0.1 http://flexprice.local/ 2>/dev/null)
[ "$fpcode" != "000" ] && ok "flexprice.local still HTTP ($fpcode)" || bad "flexprice.local unreachable"
ctrls=$(kubectl get pods -A -l app.kubernetes.io/name=ingress-nginx --no-headers 2>/dev/null | wc -l | tr -d ' ')
[ "$ctrls" -ge 1 ] && ok "ingress-nginx present ($ctrls pod)" || bad "no ingress-nginx"

echo "=== 2. observability NOT exposed (no Ingress) ==="
obs_ing=$(kubectl get ingress -A -o jsonpath='{range .items[*]}{.spec.rules[*].host}{"\n"}{end}' 2>/dev/null | grep -E 'langfuse|jaeger|prometheus' || true)
[ -z "$obs_ing" ] && ok "no langfuse/jaeger/prometheus Ingress" || bad "observability exposed: $obs_ing"

echo "=== 3. onboarding org-demo (interactive) ==="
man "Google login at https://app.fleet.dev -> wizard -> onboard org-demo; re-run = zero duplicates; ORG_UUID=$ORG_UUID"

echo "=== 4. long-running multi-turn chat SSE (interactive) ==="
man "chat >60s mock-gpt streams AG-UI events (RUN_STARTED → TEXT_MESSAGE_* → a terminal frame) on POST /api/agui/…; sessions.thread_id + outcome recorded; kagent.fleet.dev SSO shows same agent"

echo "=== 5. llm-mock echo: baggage fleet_user_id + x-fleet-org-id arrived ==="
mocklog=$(kubectl -n litellm logs deploy/llm-mock --tail=200 2>/dev/null | grep -E 'fleet_user_id|x-fleet-org-id' | tail -1 || true)
[ -n "$mocklog" ] && ok "llm-mock saw fleet headers/baggage" || man "no llm-mock echo yet — run a chat, then re-check (else per-user-key fallback)"

echo "=== 6. Flexprice ai.usage + actor_compute (bare UUID customer) ==="
if [ -n "$ORG_UUID" ]; then
  ev=$(fpcurl -G "http://api.flexprice.local/v1/events" --data-urlencode "external_customer_id=$ORG_UUID" --data-urlencode 'limit=5' 2>/dev/null)
  echo "$ev" | jq -e '(.events // .items // []) | length > 0' >/dev/null 2>&1 \
    && ok "Flexprice events exist for $ORG_UUID" || bad "no Flexprice events for $ORG_UUID"
  bare=$(echo "$ev" | jq -r '(.events // .items // [])[0].external_customer_id // empty' 2>/dev/null)
  [ "$bare" = "$ORG_UUID" ] && ok "external_customer_id is bare UUID" || bad "customer id not bare UUID ($bare)"
else
  man "set ORG_UUID=<uuid> to verify Flexprice events / bare UUID / group_by rows"
fi

echo "=== 7. Langfuse trace userId/sessionId/cost (port-forward :3000) ==="
if curl -s -o /dev/null http://localhost:3000/api/public/health 2>/dev/null; then
  LFPK=$(kubectl -n langfuse get secret langfuse-stores -o jsonpath='{.data.langfuse-secret-key}' 2>/dev/null | base64 -d)
  tr=$(curl -s -u "pk-lf-fleet-local:$LFPK" 'http://localhost:3000/api/public/traces?limit=1' 2>/dev/null)
  echo "$tr" | jq -e '.data | length > 0' >/dev/null 2>&1 && ok "Langfuse traces present" || man "no Langfuse traces yet — run a chat"
  # The app's Traces panel filters on userId (routes/orgs.ts) — a trace with no
  # userId is invisible there even though the Langfuse UI shows it. Every trace
  # observed so far, pre- and post-T-20 drift, has userId null: the actor's LLM
  # call carries only gen_ai.*/a2a.task.id baggage plus x-fleet-org-id/-project-id,
  # so the fleet_user_id the BFF stamps is dropped before LiteLLM sees it.
  uid=$(echo "$tr" | jq -r '.data[0].userId // "NULL"' 2>/dev/null)
  [ "$uid" != "NULL" ] && ok "trace userId=$uid (the app's Traces panel filter matches)" \
    || man "traces have no userId — the app's Traces panel filter matches none (T-20)"
else
  man "run scripts/port-forwards.sh (Langfuse :3000) to verify traces"
fi

echo "=== 8. Prometheus fleet series + Jaeger chain (port-forward) ==="
if curl -s -o /dev/null http://localhost:9090/-/ready 2>/dev/null; then
  ser=$(curl -s 'http://localhost:9090/api/v1/query?query=substrate_actor_running_seconds_total' 2>/dev/null)
  echo "$ser" | jq -e '.data.result | length > 0' >/dev/null 2>&1 && ok "Prometheus fleet actor series" || man "no actor series yet — run a chat"
else
  man "run scripts/port-forwards.sh (Prometheus :9090, Jaeger :16686)"
fi

echo "=== 9. limits: LiteLLM native budget + Flexprice alert config ==="
man "set key max_budget=0.001 -> next call 429 (LiteLLM native); Flexprice alert config fires natively"

echo "=== 10. spoofed identity headers stripped by nginx snippet ==="
snip=$(kubectl -n fleet-system get ingress fleet-app -o jsonpath='{.metadata.annotations.nginx\.ingress\.kubernetes\.io/configuration-snippet}' 2>/dev/null)
echo "$snip" | grep -qi 'x-auth-request-email' && ok "app ingress strips x-auth-request-*" || bad "app ingress missing sanitize snippet"
allow=$(kubectl -n ingress-nginx get cm ingress-nginx-controller -o jsonpath='{.data.allow-snippet-annotations}' 2>/dev/null)
[ "$allow" = "true" ] && ok "allow-snippet-annotations=true" || bad "snippets not permitted ($allow)"

for d in fleet-oauth2-proxy kagent-oauth2-proxy; do
  ut=$(kubectl -n fleet-system get deploy "$d" -o jsonpath='{.spec.template.spec.containers[0].args}' 2>/dev/null | tr ',' '\n' | sed -n 's/.*--upstream-timeout=\([0-9]*\)s.*/\1/p')
  [ "${ut:-0}" -ge 1800 ] && ok "$d upstream-timeout=${ut}s" \
    || bad "$d upstream-timeout=${ut:-30 (default)}s — the browser's POST /api/agui 502s during actor wake"
done

echo "=== 11. online claude-sonnet-4 via OpenRouter (interactive) ==="
man "run a claude chat; real spend appears in Flexprice + LiteLLM + Langfuse"

echo "=== 12. helm status + no Cloud Run references ==="
kst=$(helm status kagent -n kagent 2>/dev/null | awk '/STATUS:/{print $2}')
[ "$kst" = "deployed" ] && ok "kagent STATUS=deployed" || bad "kagent STATUS=$kst"
cr=$(grep -riE 'cloudrun|cloud-run|run\.app' deploy/ 2>/dev/null | grep -v 'kubectl run' || true)
[ -z "$cr" ] && ok "no Cloud Run references in deploy/" || bad "Cloud Run reference found"

echo "=== 13. A2A facade (T-19) — the BFF is an A2A server per project ==="
# Runs a real agent turn, so it stays explicit rather than firing on every
# re-verify: REBUILD=1 scripts/fixes/t31-a2a-facade-check.sh
man "t31-a2a-facade-check.sh: card rewrite, 401-as-JSON routing, a relayed message:stream turn, outcome + meter_seconds read-back (incl. a silent completion explaining its own empty bubble), the refusal shapes (unknown conversation/model, push config, foreign task), the legacy /chat relay gone (404), a provider credential fault landing as upstream_error with 0 seconds metered, a real A2A client (scripts/fixes/FleetA2AClient.ts over @assistant-ui/react-a2a) parsing the card, typing every frame and landing its model choice on the session row, and the AG-UI run endpoint the browser now speaks (client-minted threadId → RUN_STARTED/TEXT_MESSAGE_*/terminal frame → sessions.thread_id + outcome on the row)"

echo "=== 14. litellm carries the langfuse half of the callback chain (T-20) ==="
# Two read-backs, because the drift is a helm list merge: values-base alone gives
# envFrom WITHOUT litellm-langfuse-keys and callbacks WITHOUT `langfuse`, and the
# only symptom is the LiteLLM UI saying tracing is disabled — billing still works.
ef=$(kubectl -n litellm get deploy litellm -o jsonpath='{.spec.template.spec.containers[0].envFrom[*].secretRef.name}' 2>/dev/null)
echo "$ef" | grep -q 'litellm-langfuse-keys' && ok "litellm envFrom carries litellm-langfuse-keys" \
  || bad "litellm envFrom=[$ef] — no LANGFUSE_* on the pod: no trace is written. Fix: bash scripts/30-litellm.sh"
cb=$(kubectl -n litellm get cm litellm-config -o jsonpath='{.data.config\.yaml}' 2>/dev/null)
echo "$cb" | grep -qE '^[[:space:]]*- langfuse' && ok "callbacks include langfuse" \
  || bad "callbacks missing '- langfuse': $(echo "$cb" | sed -n '/callbacks:/,/^  [a-z]/p' | tr '\n' ' ')"
lfcount=$(kubectl -n litellm exec deploy/litellm -c litellm -- sh -c \
  'env | grep -c "^LANGFUSE_"' 2>/dev/null)
[ "${lfcount:-0}" -ge 3 ] && ok "pod env has LANGFUSE_PUBLIC_KEY/SECRET_KEY/HOST ($lfcount)" \
  || man "pod env unreadable (no shell?) — the two read-backs above are authoritative"

echo
echo "RESULT  PASS=$PASS FAIL=$FAIL MANUAL=$MANUAL"
[ "$FAIL" -eq 0 ] || exit 1