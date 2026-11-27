#!/usr/bin/env bash
# T-32: add the Qoder BYO agent to EXISTING tenant releases (the three orgs that
# were onboarded before the qoder catalog row existed), without the browser
# wizard. Mirrors apps/control-plane/src/onboarding/tenant-values.ts; that file
# stays canonical for NEW orgs.
#
# MERGE, not mirror. t26 rebuilt the whole values document from FLEET_MODELS,
# which prunes anything a release carries that the code does not render (all three
# releases carry a harness "custom-claude"). Here the current user-supplied
# values are read back with `helm get values -o json` and only the qoder objects
# are appended/replaced, so every other release value survives verbatim.
#
# Qoder dials Qoder, not LiteLLM, so this run writes five objects per tenant:
# ModelConfig (with baseUrl), Harness (byo), AgentTemplate, Agent (with
# egressPolicyRefs), and the EgressPolicy that substitutes the tenant's Qoder job
# token into the Authorization header at the gateway on each call.
#
# Per org/project row in fleet_control:
#   1) the tenant Secret must carry $PATKEY (default QODER_PAT) = that org's long-lived
#      Qoder personal access token. It is NOT the LiteLLM virtual key and is never
#      copied from it. Set QODER_TOKEN=<pat> to seed a project that lacks it; otherwise
#      the project is skipped, because an EgressPolicy whose secretRef points at an
#      absent key yields an agent that fails at the first turn, not at apply. A
#      $TOKENKEY holding a copy of .data.key — what the pre-direct-access runs left
#      behind — is cleared first, so no third-party origin can be handed the platform
#      billing credential.
#   1b) the control plane mints the derived 24h job token: it exchanges the PAT outside
#      the Actor and writes the result into $TOKENKEY (default QODER_API_KEY) in the
#      same Secret, which is what the policy substitutes. Minting here — before the
#      pre-flight — means the first apply already carries a live credential instead of
#      waiting up to QODER_TOKEN_INTERVAL_SECONDS for the rotation loop.
#   2) helm template pre-flight of the merged values (a _helpers.tpl rejection must
#      be loud and happen BEFORE anything mutates)
#   3) helm upgrade --install with the merged values
#   4) report the new Harness + Agent + EgressPolicy conditions — report only: an
#      experimental agent must never make this run fail for a tenant that is fine
# No /team/update or /key/update: those are LiteLLM's team/key model lists, and this
# agent never touches LiteLLM.
# No credential is printed or passed in argv: the token moves Secret -> stdin.
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
# The long-lived PAT the operator seeds, the derived job token the gateway injects,
# and the refresh token the mint loop writes beside it.
PATKEY=${QODER_PAT_SECRET_KEY:-$(cm QODER_PAT_SECRET_KEY)}
TOKENKEY=${QODER_API_KEY_ENV:-$(cm QODER_API_KEY_ENV)}
PATKEY=${PATKEY:-QODER_PAT}
TOKENKEY=${TOKENKEY:-QODER_API_KEY}
# The ModelConfig origin (what kagent routes the turn at) and the two egress lists:
# exact origins that carry a bearer token get the substitution, wildcards are granted
# plain because the model host's Authorization is a value the CLI signs locally.
MODELBASE=${QODER_MODEL_BASE_URL:-$(cm QODER_MODEL_BASE_URL)}
MODELBASE=${MODELBASE:-https://api.qoder.sh}
BEARERS=${QODER_BEARER_ORIGINS:-$(cm QODER_BEARER_ORIGINS)}
BEARERS=${BEARERS:-https://openapi.qoder.sh,https://center.qoder.sh}
GRANTS=${QODER_GRANT_ORIGINS:-$(cm QODER_GRANT_ORIGINS)}
GRANTS=${GRANTS:-https://*.qoder.sh,https://*.qoder.com}
split() { jq -cn --arg s "$1" '$s | split(",") | map(gsub("^\\s+|\\s+$";"")) | map(select(. != ""))'; }
BEARER_JSON=$(split "$BEARERS")
GRANT_JSON=$(split "$GRANTS")
[ -n "$CATALOG" ] || { echo "FLEET_MODELS missing from fleet-bff-config — apply deploy/bff/configmap.yaml first" >&2; exit 1; }
[ "$(jq -r 'length' <<<"$BEARER_JSON")" -gt 0 ] || { echo "QODER_BEARER_ORIGINS parsed to nothing" >&2; exit 1; }
[ "$(jq -r 'length' <<<"$GRANT_JSON")" -gt 0 ] || { echo "QODER_GRANT_ORIGINS parsed to nothing" >&2; exit 1; }
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

  # 1) the Qoder PAT, under $PATKEY in the tenant Secret. The LiteLLM virtual key in
  #    .data.key authenticates against LiteLLM, which this agent no longer dials, so it
  #    is never copied into either Qoder key: a run that leaves that value in place
  #    produces an agent that boots and is refused on the first turn.
  have=$(k -n "$ns" get secret "$secret" -o jsonpath="{.data.$PATKEY}" 2>/dev/null | tr -d '\n')
  if [ -n "${QODER_TOKEN:-}" ]; then
    printf '{"data":{"%s":"%s"}}' "$PATKEY" "$(printf '%s' "$QODER_TOKEN" | base64 | tr -d '\n')" \
      | k -n "$ns" patch secret "$secret" --type merge --patch-file=/dev/stdin >/dev/null
    echo "  secret $secret: $PATKEY seeded from QODER_TOKEN"
  elif [ -z "$have" ]; then
    echo "  SKIP: secret $ns/$secret has no .$PATKEY and QODER_TOKEN is unset — set QODER_TOKEN=<the org's Qoder PAT> (or patch the Secret) and re-run"
    continue
  else
    echo "  secret $secret: $PATKEY already present"
  fi

  # The pre-direct-access runs wrote $TOKENKEY as a copy of .data.key (the tenant's
  # LiteLLM virtual key). The _helpers.tpl guard cannot see that — it checks the key
  # NAME, and a third-party origin handed a value that happens to be the billing
  # credential is exactly the failure it is meant to prevent — so clear it here. The
  # mint below rewrites $TOKENKEY with a real jt-*, and a tenant with no PAT is left
  # alone rather than silently un-keyed.
  pat=$(k -n "$ns" get secret "$secret" -o jsonpath="{.data.$PATKEY}" 2>/dev/null | tr -d '\n')
  stale=$(k -n "$ns" get secret "$secret" -o json | jq -r --arg tk "$TOKENKEY" \
    'select(.data[$tk] != null and .data[$tk] == .data.key) | "yes"' 2>/dev/null)
  if [ "$stale" = "yes" ]; then
    if [ -n "$pat" ]; then
      k -n "$ns" patch secret "$secret" --type=json \
        -p="[{\"op\":\"remove\",\"path\":\"/data/${TOKENKEY}\"}]" >/dev/null
      echo "  secret $secret: cleared $TOKENKEY (it held a copy of .data.key, the LiteLLM virtual key) — the mint replaces it"
    else
      echo "  WARN: secret $ns/$secret .$TOKENKEY is a copy of .data.key and there is no $PATKEY to mint from — the EgressPolicy would send the platform billing credential to Qoder. Seed QODER_TOKEN=<pat> and re-run, or remove the key by hand."
    fi
  fi

  # 1b) mint the derived job token so the policy's secretRef is live at first apply.
  #     The BFF runs the exchange (it holds the cluster and DB access this needs) and
  #     prints only the action, never a token. QODER_TOKEN=<pat> above is what makes
  #     this succeed on a fresh tenant; without a PAT the mint is a no-op skip.
  mint=$(k "${BFF[@]}" exec -i "$BFF_TARGET" -- node --input-type=module -e \
    "const m = await import('/app/apps/control-plane/dist/credentials/qoderTokens.js');
     const r = await m.mintQoderToken({ namespace: process.argv[1], secretName: process.argv[2], orgId: process.argv[3] });
     console.log(r.action + (r.reason ? ':' + r.reason : ''));" "$ns" "$secret" "$orgId" 2>&1 </dev/null | tail -1)
  case "$mint" in
    exchanged|refreshed|fresh) echo "  mint: $mint ($TOKENKEY is a live jt-* in the Secret)" ;;
    *) echo "  WARN: mint reported \"$mint\" — the rotation loop will retry; the first turn may be refused" ;;
  esac

  # 2) the five objects tenant-values.ts renders for a runtime:"qoder" entry.
  patch=$(jq -n --argjson entry "$ENTRY" --argjson bearers "$BEARER_JSON" --argjson grants "$GRANT_JSON" \
    --arg orgId "$orgId" --arg projId "$projId" \
    --arg secret "$secret" --arg keyenv "$TOKENKEY" --arg image "$IMG" --arg cmd "$CMD" \
    --arg base "$MODELBASE" '{
    name: $entry.id,
    model: { name: $entry.id, provider: "OpenAI", model: $entry.model, apiFormat: "chatCompletions",
             stream: true,
             defaultHeaders: { "x-fleet-org-id": $orgId, "x-fleet-project-id": $projId },
             baseUrl: $base, apiKeySecret: $secret, apiKeySecretKey: $keyenv },
    template: { name: ($entry.id + "-coding"), modelConfig: $entry.id,
                description: ("Fleet coding workflow (" + $entry.label + ")"),
                systemPrompt: "You are a concise coding agent. Plan, then act.\n", mcp: ["webfetch"] },
    agent: { name: ($entry.id + "-worker"), template: ($entry.id + "-coding"), harness: $entry.id,
             egress: [$entry.id] },
    harness: { name: $entry.id, type: "byo", image: $image, command: [$cmd], env: [
      { name: "OTEL_PROPAGATORS", value: "tracecontext,baggage" },
      { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://opentelemetry-collector.otel-system.svc:4317" },
      { name: "OTEL_RESOURCE_ATTRIBUTES", value: ("fleet.org_id=" + $orgId) },
      # The CLI logs in from this envelope and sends its token as the Bearer value; the
      # EgressPolicy replaces the header at the gateway, so the live credential never
      # enters the Actor. It is a placeholder, not a key: _helpers.tpl rejects a real
      # jt-/jrt-/pt- value here, because spec.env has no valueFrom and the Harness env
      # is frozen into the ActorTemplate snapshot.
      { name: "QODER_JOB_TOKEN", value: "{\"token\":\"kagent-egress-placeholder\",\"expireTime\":4102444800}" } ] },
    # kagent substitutes a credential only on an EXACT origin, and a host whose
    # Authorization is signature-derived must NOT be rewritten — so authentication
    # lands on $bearers and $grants stay plain grants.
    egress: { name: $entry.id, destinations: (
      ( $bearers | unique | map({ origin: ., authentication: { header: "authorization", prefix: "Bearer ",
                                     secretRef: { name: $secret, key: $keyenv } } }) )
      + ( $grants | map(select(. as $o | ($bearers | index($o)) == null)) | map({ origin: . }) ) ) }
  }')
  cur=$(k "${BFF[@]}" exec -i "$BFF_TARGET" -- helm get values "$slug-kagent-tenant" -n "$ns" -o json </dev/null)
  merged=$(jq -c --argjson p "$patch" '
    def put($kind; $want): ((.[$kind] // []) | map(select(.name != $want.name))) + [$want];
    .models    = put("models";    $p.model)
    | .templates = put("templates"; $p.template)
    | .agents    = put("agents";    $p.agent)
    | .harnesses = put("harnesses"; $p.harness)
    | .egress    = put("egress";    $p.egress)' <<<"$cur")
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
  qname=$(jq -r '.id' <<<"$ENTRY")
  conds() { k -n "$ns" get "$1" -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.reason}{"\n"}{end}' 2>/dev/null | tr '\n' ' '; }
  echo "  harness $slug-harness-$qname: $(conds "harness/$slug-harness-$qname")"
  echo "  egress  $slug-egress-$qname: $(conds "egresspolicies.api.kagent.dev/$slug-egress-$qname")"
  echo "  agent   $slug-agent-$qname-worker: $(conds "agents.api.kagent.dev/$slug-agent-$qname-worker")"
done <<<"$rows"
echo "T32 DONE — qoder harness/model/template/agent/egress merged into every selected tenant"
echo "  follow-up: kubectl -n <ns> get agents.api.kagent.dev,egresspolicies.api.kagent.dev | grep qoder"
