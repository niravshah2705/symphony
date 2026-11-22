#!/usr/bin/env bash
# T-26 (P6): upgrade EXISTING tenant releases to the per-model catalog
# (one ModelConfig/AgentTemplate/Agent per FLEET_MODELS entry) without walking the browser
# wizard again. Mirrors apps/control-plane/src/onboarding/steps/workflow.ts
# values exactly (that file stays canonical for NEW orgs).
#
# What it does per org/project row in fleet_control:
#   1) LiteLLM /team/update + /key/update  -> models = catalog + openrouter/*
#      (the existing secret key was minted pre-P6 with just mock-gpt+claude)
#   2) helm upgrade <slug>-kagent-tenant with the catalog values (helm prunes
#      the legacy single agent <slug>-agent-worker and renders worker-<id>)
#   3) wait for every Agent Ready (substrate golden build per new agent)
#   4) projects.agent_name -> <slug>-agent-<defaultId>-worker (chat default)
# No credential is printed; the master key is read from the BFF pod env in-pod.
set -euo pipefail
CTX=${KCTX:-kind-flexprice-local}
k() { kubectl --context "$CTX" "$@"; }
BFF=( -n fleet-system )
BFF_TARGET=deploy/fleet-bff

PGPW=$(k -n flexprice get secret flexprice-postgresql -o jsonpath='{.data.password}' | base64 -d)
fp() { k -n flexprice exec -i flexprice-postgresql-0 -- env PGPASSWORD="$PGPW" \
  psql -U flexprice -d fleet_control -tAc "$1"; }

CATALOG=$(k -n fleet-system get cm fleet-bff-config -o jsonpath='{.data.FLEET_MODELS}' | tr -d '\n\r')
[ -n "$CATALOG" ] || { echo "FLEET_MODELS missing from fleet-bff-config — apply deploy/bff/configmap.yaml first" >&2; exit 1; }
CHART=$(k -n fleet-system get cm fleet-bff-config -o jsonpath='{.data.TENANT_CHART_PATH}')
LITELLM_URL=${LITELLM_URL:-http://litellm.litellm.svc.cluster.local:4000}

MODELS=$(jq -c '[ .[] | {name:.id, provider:"OpenAI", model:.model, apiFormat:"chatCompletions", stream:true} ]' <<<"$CATALOG")
TMPLS=$(jq -c '[ .[] | {name:(.id+"-coding"), modelConfig:.id, description:("Fleet coding workflow ("+.label+")"), systemPrompt:"You are a concise coding agent. Plan, then act.\n"} ]' <<<"$CATALOG")
AGENTS=$(jq -c '[ .[] | {name:(.id+"-worker"), template:(.id+"-coding"), harness:"app"} ]' <<<"$CATALOG")
DEF=$(jq -r 'map(select(.default))[0].id // .[0].id' <<<"$CATALOG")
LMODELS=$(jq -c '[ .[].model, "openrouter/*" ] | unique' <<<"$CATALOG")

rows=$(fp "select o.slug||'|'||o.id||'|'||p.id||'|'||p.slug||'|'||coalesce(p.agent_namespace,'') from orgs o join projects p on p.org_id=o.id;")
[ -n "$rows" ] || { echo "no org/project rows — nothing to do"; exit 0; }

# ORG_FILTER=<slug> restricts the run to one tenant (verify org-test first).
ORG_FILTER=${ORG_FILTER:-}
while IFS='|' read -r slug orgId projId projSlug projNs; do
  [ -n "$slug" ] || continue
  if [ -n "$ORG_FILTER" ] && [ "$slug" != "$ORG_FILTER" ]; then echo "skip org $slug (ORG_FILTER=$ORG_FILTER)"; continue; fi
  ns=${projNs:-org-$slug}
  secret="litellm-$slug-$projSlug"
  echo "== org $slug ($ns) =="

  # 1) LiteLLM team + key model lists (in-pod: keys travel only via stdin/env,
  #    never argv/logs). /key/list on this build exposes only token hashes, so
  #    the tenant key is addressed by its plaintext value from the org Secret.
  k -n "$ns" get secret "$secret" -o jsonpath='{.data.key}' | base64 -d | tr -d "\n" | \
  k "${BFF[@]}" exec -i "$BFF_TARGET" -- node -e '
    const [base, modelsJson, teamId] = process.argv.slice(1);
    const models = JSON.parse(modelsJson);
    const token = require("fs").readFileSync(0, "utf8").trim();
    const H = { "Authorization": "Bearer " + process.env.LITELLM_MASTER_KEY, "Content-Type": "application/json" };
    const post = async (p, body) => {
      const r = await fetch(base + p, { method: "POST", headers: H, body: JSON.stringify(body) });
      const t = await r.text();
      if (!r.ok) throw new Error(p + " -> " + r.status + ": " + t.slice(0, 200));
      return JSON.parse(t);
    };
    (async () => {
      await post("/team/update", { team_id: teamId, models });
      console.log("team models updated");
      if (token) { await post("/key/update", { key: token, models }); console.log("key models updated"); }
      else console.log("WARN: empty tenant key secret (key models not touched)");
    })().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
  ' "$LITELLM_URL" "$LMODELS" "$projId"

  # 2) helm upgrade with the catalog values (mirror of workflowStep).
  vals=$(jq -n --argjson models "$MODELS" --argjson tmpls "$TMPLS" --argjson agents "$AGENTS" \
    --arg ns "$ns" --arg id "$slug" --arg snapRoot "s3://ate-snapshots/$slug" \
    --arg secret "$secret" --arg url "$LITELLM_URL" --arg orgId "$orgId" --arg projId "$projId" '{
    namespace: $ns,
    tenant: { id: $id, snapshotRoot: $snapRoot },
    workerPool: { name: $ns },
    litellm: { baseUrl: ($url + "/v1"), apiKeySecret: $secret, apiKeySecretKey: "key" },
    models: ($models | map(. + { defaultHeaders: { "x-fleet-org-id": $orgId, "x-fleet-project-id": $projId } })),
    harnesses: [{ name: "app", type: "kagent", env: [
      { name: "OTEL_PROPAGATORS", value: "tracecontext,baggage" },
      { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://opentelemetry-collector.otel-system.svc:4317" },
      { name: "OTEL_RESOURCE_ATTRIBUTES", value: ("fleet.org_id=" + $orgId) } ] }],
    templates: $tmpls,
    agents: $agents,
    commonLabels: { "fleet.local/org-id": $orgId, "fleet.local/project-id": $projId }
  }')
  k "${BFF[@]}" exec -i "$BFF_TARGET" -- sh -c "cat > /tmp/t26-values.json" <<<"$vals"
  k "${BFF[@]}" exec -i "$BFF_TARGET" -- helm upgrade --install "$slug-kagent-tenant" "$CHART" -n "$ns" -f /tmp/t26-values.json >/dev/null </dev/null
  echo "helm release $slug-kagent-tenant upgraded"

  # 3) every per-model Agent Ready (the first nemotron golden build pulls a snapshot).
  for m in $(jq -r '.[].id' <<<"$CATALOG"); do
    k -n "$ns" wait --for=condition=Ready "agents.api.kagent.dev/$slug-agent-$m-worker" --timeout=600s
  done

  # 4) chat default follows the catalog default model.
  fp "update projects set agent_name='$slug-agent-$DEF-worker' where id='$projId';" >/dev/null </dev/null
  echo "projects.agent_name -> $slug-agent-$DEF-worker"
done <<<"$rows"
echo "T26 OK — per-model agents live; pick the model in the chat dropdown"
