#!/usr/bin/env bash
# T-06: ensure the seeded Flexprice plan has an INR usage price so INR/MONTHLY
# subscriptions validate ("No prices match the subscription criteria" otherwise).
# Idempotent: skips if a published INR price already exists on the plan.
set -euo pipefail
CTX=${KCTX:-kind-flexprice-local}
PLAN_ID=${PLAN_ID:-plan_01M7T6D75Z1STVQ8JXMY5SP3Z0}
METER_ID=${METER_ID:-meter_01M7T5PH095CNDN4751F9566G7}   # LLM Passthrough Cost (reported_cost SUM)
AMOUNT=${AMOUNT:-83}                                      # USD x 1.10 margin at ~INR 83/USD

FP_KEY=$(kubectl --context "$CTX" -n litellm get deploy litellm -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="FLEXPRICE_API_KEY")].value}')
FP_ENV=$(kubectl --context "$CTX" -n litellm get deploy litellm -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="FLEXPRICE_ENVIRONMENT_ID")].value}')
API=http://api.flexprice.local
H=(-H "x-api-key: $FP_KEY" -H "X-Environment-ID: $FP_ENV" -H 'content-type: application/json')
R=(--resolve api.flexprice.local:80:127.0.0.1)

existing=$(curl -sS "${R[@]}" "$API/v1/prices/$PLAN_ID" "${H[@]}" 2>/dev/null || true)
if curl -sS "${R[@]}" "$API/v1/plans/$PLAN_ID" "${H[@]}" | grep -q '"currency":"inr"'; then
  echo "INR price already present on $PLAN_ID — nothing to do"; exit 0
fi

curl -sS "${R[@]}" -X POST "$API/v1/prices" "${H[@]}" -d "{
  \"display_name\": \"LLM Passthrough Cost (INR)\",
  \"type\": \"USAGE\",
  \"entity_type\": \"PLAN\",
  \"entity_id\": \"$PLAN_ID\",
  \"currency\": \"INR\",
  \"amount\": \"$AMOUNT\",
  \"billing_period\": \"MONTHLY\",
  \"billing_period_count\": 1,
  \"billing_model\": \"FLAT_FEE\",
  \"billing_cadence\": \"RECURRING\",
  \"invoice_cadence\": \"ARREAR\",
  \"meter_id\": \"$METER_ID\",
  \"transform_quantity\": {\"divide_by\": 1},
  \"start_date\": \"2026-10-31T00:00:00.000Z\"
}" | jq -c '{id, currency, amount, status}'
echo "INR price created on $PLAN_ID"
