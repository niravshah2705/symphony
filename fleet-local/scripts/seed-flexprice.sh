#!/usr/bin/env bash
# Idempotent Flexprice seed: 7 ai.usage meters + actor-compute meter + plan + usage prices
# (backdated; USD + one INR passthrough for the BFF's INR subscriptions) + tenant
# spend-alert toggle + FLEXPRICE_PLAN_ID publish to fleet-bff-config. Configuration only.
set -euo pipefail
cd "$(dirname "$0")/.."

FP_BASE=${FP_BASE:-http://api.flexprice.local}
# Fresh-cluster shape: the litellm chart injects these via environmentSecrets
# (secret litellm-fleet-secrets), NOT as Deployment env literals — reading only
# the env produced empty auth and every curl answered HTML into jq
# ("Invalid numeric literal"). Env-literal fallback kept for the old layout.
fp_from_secret() { kubectl -n litellm get secret litellm-fleet-secrets -o jsonpath="{.data.$1}" 2>/dev/null | base64 -d; }
fp_from_deploy_env() { kubectl -n litellm get deploy litellm -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name==\"$1\")].value}" 2>/dev/null; }
FP_KEY=${FP_KEY:-$(fp_from_secret FLEXPRICE_API_KEY || true)}
[ -n "$FP_KEY" ] || FP_KEY=$(fp_from_deploy_env FLEXPRICE_API_KEY || true)
FP_ENV=${FP_ENV:-$(fp_from_secret FLEXPRICE_ENVIRONMENT_ID || true)}
[ -n "$FP_ENV" ] || FP_ENV=$(fp_from_deploy_env FLEXPRICE_ENVIRONMENT_ID || true)
[ -n "$FP_KEY" ] || { echo "no FLEXPRICE_API_KEY (litellm-fleet-secrets / deploy env both empty) — run setup steps 2+3 first" >&2; exit 1; }
PRICE_START=${PRICE_START:-2026-01-01T00:00:00Z}

curlf() { curl -sS --resolve api.flexprice.local:80:127.0.0.1 \
  -H "x-api-key: $FP_KEY" -H "X-Environment-ID: $FP_ENV" -H 'Content-Type: application/json' "$@"; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curlf -G "$FP_BASE/v1/meters" --data-urlencode 'limit=200' \
  | jq -r '(.meters // .items // [])[] | [.id, .name] | @tsv' > "$tmp/meters.tsv"
cp "$tmp/meters.tsv" "$tmp/metermap.tsv"
meter_id() { awk -F'\t' -v n="$1" '$2==n{print $1; exit}' "$tmp/metermap.tsv"; }
while read -r m; do
  name=$(jq -r '.name' <<<"$m")
  id=$(meter_id "$name")
  if [ -z "$id" ]; then
    id=$(curlf -X POST "$FP_BASE/v1/meters" -d "$m" | jq -r '.id')
    echo "created meter $name -> $id"
    printf '%s\t%s\n' "$id" "$name" >> "$tmp/metermap.tsv"
  else
    echo "exists  meter $name -> $id"
  fi
done < <(jq -c '.[]' deploy/flexprice/meters.json)

ACTOR_NAME=actor-compute
id=$(awk -F'\t' -v n="$ACTOR_NAME" '$2==n{print $1; exit}' "$tmp/meters.tsv")
if [ -z "$id" ]; then
  id=$(curlf -X POST "$FP_BASE/v1/meters" -d '{
    "name":"actor-compute","event_name":"fleet.actor_compute",
    "aggregation":{"type":"SUM","field":"duration_seconds"},
    "reset_usage":"BILLING_PERIOD"}' | jq -r '.id')
  echo "created meter $ACTOR_NAME -> $id"
else
  echo "exists  meter $ACTOR_NAME -> $id"
fi

PLAN_NAME=$(jq -r '.plan.name' deploy/flexprice/prices-plan.json)
curlf -G "$FP_BASE/v1/plans" --data-urlencode 'limit=200' \
  | jq -r '(.plans // .items // [])[] | [.id, .name] | @tsv' > "$tmp/plans.tsv"
PLAN_ID=$(awk -F'\t' -v n="$PLAN_NAME" '$2==n{print $1; exit}' "$tmp/plans.tsv")
if [ -z "$PLAN_ID" ]; then
  PLAN_ID=$(curlf -X POST "$FP_BASE/v1/plans" -d "$(jq '.plan' deploy/flexprice/prices-plan.json)" | jq -r '.id')
  echo "created plan $PLAN_NAME -> $PLAN_ID"
else
  echo "exists  plan $PLAN_NAME -> $PLAN_ID"
fi

curlf -G "$FP_BASE/v1/prices" --data-urlencode 'limit=200' \
  --data-urlencode "entity_type=PLAN" --data-urlencode "entity_id=$PLAN_ID" \
  | jq -r '(.prices // .items // [])[] | [.id, .display_name] | @tsv' > "$tmp/prices.tsv"
i=0
while read -r p; do
  meter_name=$(jq -r ".[$i].name" deploy/flexprice/meters.json)
  display=$(jq -r '.display_name' <<<"$p")
  pid=$(awk -F'\t' -v n="$display" '$2==n{print $1; exit}' "$tmp/prices.tsv")
  if [ -z "$pid" ]; then
    body=$(jq --arg plan "$PLAN_ID" --arg meter "$(meter_id "$meter_name")" --arg start "$PRICE_START" \
      '.entity_id=$plan | .meter_id=$meter | .start_date=$start' <<<"$p")
    pid=$(curlf -X POST "$FP_BASE/v1/prices" -d "$body" | jq -r '.id')
    echo "created price $display -> $pid"
  else
    echo "exists  price $display -> $pid"
  fi
  i=$((i+1))
done < <(jq -c '.prices[]' deploy/flexprice/prices-plan.json)

# INR passthrough price (the old cluster's t06-fix, now part of the seed):
# the BFF creates the wallet, top-up and subscription in INR, and Flexprice
# rejects a subscription whose plan has no INR/MONTHLY price
# ("No prices match the subscription criteria"). USD prices above stay for
# reporting. Amount = USD passthrough x ~1.10 margin at ~INR 83/USD.
INR_NAME="LLM Passthrough Cost (INR)"
inr_pid=$(awk -F'\t' -v n="$INR_NAME" '$2==n{print $1; exit}' "$tmp/prices.tsv")
if [ -z "$inr_pid" ]; then
  PASSTHROUGH_MID=$(meter_id 'LLM Passthrough Cost (untagged)')
  [ -n "$PASSTHROUGH_MID" ] || { echo "meter 'LLM Passthrough Cost (untagged)' not found — cannot price INR passthrough" >&2; exit 1; }
  inr_pid=$(curlf -X POST "$FP_BASE/v1/prices" -d "{
    \"display_name\":\"$INR_NAME\",
    \"type\":\"USAGE\",
    \"entity_type\":\"PLAN\",
    \"entity_id\":\"$PLAN_ID\",
    \"currency\":\"INR\",
    \"amount\":\"${FP_INR_AMOUNT:-83}\",
    \"billing_period\":\"MONTHLY\",
    \"billing_period_count\":1,
    \"billing_model\":\"FLAT_FEE\",
    \"billing_cadence\":\"RECURRING\",
    \"invoice_cadence\":\"ARREAR\",
    \"meter_id\":\"$PASSTHROUGH_MID\",
    \"transform_quantity\":{\"divide_by\":1},
    \"start_date\":\"$PRICE_START\"
  }" | jq -r '.id')
  [ "$inr_pid" != "null" ] && [ -n "$inr_pid" ] || { echo "FAILED to create price $INR_NAME" >&2; exit 1; }
  echo "created price $INR_NAME -> $inr_pid"
else
  echo "exists  price $INR_NAME -> $inr_pid"
fi

curlf -X PUT "$FP_BASE/v1/settings/subscription_alert_config" \
  -d '{"value":{"alert_enabled":true}}' > "$tmp/alerts.json"
echo "alert toggle: $(jq -c '.' "$tmp/alerts.json" | head -c 200)"

# The FLEXPRICE_PLAN_ID literal in deploy/bff/configmap.yaml is a placeholder:
# every fresh Flexprice database mints a new plan ID, and the wizard step 2c
# (subscription) 404s on the stale value. Publish the seeded ID into the live
# ConfigMap and bounce the BFF (it reads config at boot only).
CUR=$(kubectl -n fleet-system get cm fleet-bff-config -o jsonpath='{.data.FLEXPRICE_PLAN_ID}' 2>/dev/null || true)
if [ "$CUR" != "$PLAN_ID" ]; then
  kubectl -n fleet-system patch cm fleet-bff-config \
    -p "{\"data\":{\"FLEXPRICE_PLAN_ID\":\"$PLAN_ID\"}}" >/dev/null
  if kubectl -n fleet-system get deploy fleet-bff >/dev/null 2>&1; then
    kubectl -n fleet-system rollout restart deploy/fleet-bff >/dev/null
    kubectl -n fleet-system rollout status deploy/fleet-bff --timeout=3m >/dev/null
    echo "fleet-bff FLEXPRICE_PLAN_ID -> $PLAN_ID (was ${CUR:-<unset>}; BFF restarted)"
  else
    echo "fleet-bff-config FLEXPRICE_PLAN_ID -> $PLAN_ID (no deploy yet; 50-bff-spa will pick it up)"
  fi
else
  echo "fleet-bff-config FLEXPRICE_PLAN_ID already $PLAN_ID"
fi
echo "SEED OK plan=$PLAN_ID"