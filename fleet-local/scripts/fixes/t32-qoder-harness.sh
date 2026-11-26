#!/usr/bin/env bash
# T-32: add the Qoder BYO agent to EXISTING tenant releases (the three orgs that
# were onboarded before the qoder catalog row existed), without the browser
# wizard. Mirrors apps/control-plane/src/onboarding/tenant-values.ts; that file
# stays canonical for NEW orgs.
#
# MERGE, not mirror. t26 rebuilt the whole values document from FLEET_MODELS,
# which prunes anything a release carries that the code does not render (org-test
# has a harness "custom-claude" from t28's probe). Here the current user-supplied
# values are read back with `helm get values -o json` and only the four qoder
# objects are appended/replaced, so every other release value survives verbatim.
#
# Per org/project row in fleet_control:
#   1) tenant Secret gains QODER_API_KEY, copied from its own `key` (never re-minted)
#   2) helm template pre-flight of the merged values (a _helpers.tpl rejection must
#      be loud and happen BEFORE anything mutates)
#   3) helm upgrade --install with the merged values
#   4) report the new Agent + Harness conditions — report only: an experimental
#      agent must never make this run fail for a tenant whose other agents are fine
# No /team/update or /key/update: litellmModelList already carries openrouter/*,
# which covers the new model id.
# No credential is printed: the key moves from the Secret to a patch payload in-shell.
set -euo pipefail
CTX=${KCTX:-kind-flexprice-local}
k() { kubectl --context "$CTX" "$@"; }
BFF=( -n fleet-system )
BFF_TARGET=deploy/fleet-bff

PGPW=$(k -n flexprice get secret flexprice-postgresql -o jsonpath='{.data.password}' | base64 -d)
fp() { k -n flexprice exec -i flexprice-postgresql-0 -- env PGPASSWORD="$PGPW" \
  psql -U flexprice -d fleet_control -tAc "$1"; }

cm() { k -n fleet-system get cm fleet-bff-config -o jsonpath="{.data.$1}" | tr -d '\n\r'; }
CATALOG=$(cm FLEET_MODELS)
CHART=$(cm TENANT_CHART_PATH)
IMG=${QODER_RUNTIME_IMAGE:-$(cm QODER_RUNTIME_IMAGE)}
CMD=${QODER_ADAPTER_COMMAND:-$(cm QODER_ADAPTER_COMMAND)}
KEYENV=${QODER_API_KEY_ENV:-$(cm QODER_API_KEY_ENV)}
[ -n "$CATALOG" ] || { echo "FLEET_MODELS missing from fleet-bff-config — apply deploy/bff/configmap.yaml first" >&2; exit 1; }
[ -n "$KEYENV" ] || KEYENV=QODER_API_KEY
# The CRD pattern is ^[^[:space:]@]+@sha256:[a-f0-9]{64}$; :latest is not a value
# that can ever be applied, so refuse here instead of at helm apply time.
case "$IMG" in
  *@sha256:*) ;;
  "") echo "QODER_RUNTIME_IMAGE is empty — set it in cm/fleet-bff-config to the qoder-runtime digest that contains the ADK-boot fix (config.Load); nothing to do." >&2; exit 1 ;;
  *) echo "QODER_RUNTIME_IMAGE $IMG is not digest-pinned — the Harness CRD rejects tags" >&2; exit 1 ;;
esac

ENTRY=$(jq -c '[ .[] | select(.runtime=="qoder") ][0]' <<<"$CATALOG")
[ "$ENTRY" != "null" ] || { echo "no runtime:\"qoder\" entry in FLEET_MODELS — add the qoder catalog row first" >&2; exit 1; }

rows=$(fp "select o.slug||'|'||o.id||'|'||p.id||'|'||p.slug||'|'||coalesce(p.agent_namespace,'') from orgs o join projects p on p.org_id=o.id;")
[ -n "$rows" ] || { echo "no org/project rows — nothing to do"; exit 0; }

# ORG_FILTER=<slug> restricts the run to one tenant (canary: ORG_FILTER=test).
ORG_FILTER=${ORG_FILTER:-}
while IFS='|' read -r slug orgId projId projSlug projNs; do
  [ -n "$slug" ] || continue
  if [ -n "$ORG_FILTER" ] && [ "$slug" != "$ORG_FILTER" ]; then echo "skip org $slug (ORG_FILTER=$ORG_FILTER)"; continue; fi
  ns=${projNs:-org-$slug}
  secret="litellm-$slug-$projSlug"
  echo "== org $slug ($ns) =="

  # 1) one Secret, two names for the same virtual key. A project whose key is
  #    missing gets no qoder objects: a ModelConfig pointing at an absent key
  #    produces an agent that fails at the first turn, not at apply.
  keyb64=$(k -n "$ns" get secret "$secret" -o jsonpath='{.data.key}' 2>/dev/null | tr -d '\n')
  if [ -z "$keyb64" ]; then
    echo "  SKIP: secret $ns/$secret has no .data.key — run onboarding (key step) first"
    continue
  fi
  if [ -z "$(k -n "$ns" get secret "$secret" -o jsonpath="{.data.$KEYENV}" 2>/dev/null | tr -d '\n')" ]; then
    k -n "$ns" patch secret "$secret" --type merge -p "{\"data\":{\"$KEYENV\":\"$keyb64\"}}" >/dev/null
    echo "  secret $secret: $KEYENV added (copied from .data.key)"
  else
    echo "  secret $secret: $KEYENV already present"
  fi

  # 2) the four objects tenant-values.ts renders for a runtime:"qoder" entry.
  patch=$(jq -n --argjson entry "$ENTRY" --arg orgId "$orgId" --arg projId "$projId" \
    --arg secret "$secret" --arg keyenv "$KEYENV" --arg image "$IMG" --arg cmd "$CMD" '{
    name: $entry.id,
    model: { name: $entry.id, provider: "OpenAI", model: $entry.model, apiFormat: "chatCompletions",
             stream: true,
             defaultHeaders: { "x-fleet-org-id": $orgId, "x-fleet-project-id": $projId },
             apiKeySecret: $secret, apiKeySecretKey: $keyenv },
    template: { name: ($entry.id + "-coding"), modelConfig: $entry.id,
                description: ("Fleet coding workflow (" + $entry.label + ")"),
                systemPrompt: "You are a concise coding agent. Plan, then act.\n", mcp: ["webfetch"] },
    agent: { name: ($entry.id + "-worker"), template: ($entry.id + "-coding"), harness: $entry.id },
    harness: { name: $entry.id, type: "byo", image: $image, command: [$cmd], env: [
      { name: "OTEL_PROPAGATORS", value: "tracecontext,baggage" },
      { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://opentelemetry-collector.otel-system.svc:4317" },
      { name: "OTEL_RESOURCE_ATTRIBUTES", value: ("fleet.org_id=" + $orgId) },
      { name: "QODER_SDK_CUSTOM_BASE_URL_BYOK", value: "1" } ] }
  }')
  cur=$(k "${BFF[@]}" exec -i "$BFF_TARGET" -- helm get values "$slug-kagent-tenant" -n "$ns" -o json </dev/null)
  merged=$(jq -c --argjson p "$patch" '
    def put($kind; $want): ((.[$kind] // []) | map(select(.name != $want.name))) + [$want];
    .models    = put("models";    $p.model)
    | .templates = put("templates"; $p.template)
    | .agents    = put("agents";    $p.agent)
    | .harnesses = put("harnesses"; $p.harness)' <<<"$cur")
  k "${BFF[@]}" exec -i "$BFF_TARGET" -- sh -c "cat > /tmp/t32-values.json" <<<"$merged"
  k "${BFF[@]}" exec -i "$BFF_TARGET" -- helm template "$slug-kagent-tenant" "$CHART" -n "$ns" \
    -f /tmp/t32-values.json >/dev/null </dev/null
  echo "  pre-flight render OK"

  # 3) upgrade
  k "${BFF[@]}" exec -i "$BFF_TARGET" -- helm upgrade --install "$slug-kagent-tenant" "$CHART" -n "$ns" \
    -f /tmp/t32-values.json >/dev/null </dev/null
  echo "  helm release $slug-kagent-tenant upgraded (qoder objects merged in)"

  # 4) report, never fail: onboarding does not wait on an experimental agent and
  #    neither does this run — a tenant whose qoder agent is stuck must still keep
  #    the five agents that work.
  qname=$(jq -r '.name' <<<"$ENTRY")
  conds() { k -n "$ns" get "$1" -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.reason}{"\n"}{end}' 2>/dev/null | tr '\n' ' '; }
  echo "  harness $slug-harness-$qname: $(conds "harness/$slug-harness-$qname")"
  echo "  agent   $slug-agent-$qname-worker: $(conds "agents.api.kagent.dev/$slug-agent-$qname-worker")"
done <<<"$rows"
echo "T32 DONE — qoder harness/model/template/agent merged into every selected tenant"
echo "  follow-up: kubectl -n <ns> get agents.api.kagent.dev | grep qoder"
