#!/usr/bin/env bash
# T-05/T-06/T-07: run the full Flexprice customer+wallet+subscription sequence for one
# org against the live API, exactly as the BFF onboarding step does. Use to validate
# config or manually complete the step. Idempotent (find-or-create everywhere).
# Usage: t07-flexprice-org.sh <ORG_UUID> <ORG_NAME> [PLAN_ID]
set -euo pipefail
CTX=${KCTX:-kind-flexprice-local}
ORG=${1:?usage: $0 <org-uuid> <org-name> [plan-id]}
NAME=${2:?org name required}
PLAN=${3:-plan_01M7T6D75Z1STVQ8JXMY5SP3Z0}

FP_KEY=$(kubectl --context "$CTX" -n litellm get deploy litellm -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="FLEXPRICE_API_KEY")].value}')
FP_ENV=$(kubectl --context "$CTX" -n litellm get deploy litellm -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="FLEXPRICE_ENVIRONMENT_ID")].value}')
API=http://api.flexprice.local
H=(-H "x-api-key: $FP_KEY" -H "X-Environment-ID: $FP_ENV" -H 'content-type: application/json')
R=(--resolve api.flexprice.local:80:127.0.0.1)

echo "== 1. customer (external_id = bare org uuid) =="
CUST=$(curl -sS "${R[@]}" "$API/v1/customers?external_id=$ORG&limit=1" "${H[@]}" | jq -r '(.items // .customers // .data // [])[0].id // empty')
if [ -z "$CUST" ]; then
  CUST=$(curl -sS "${R[@]}" -X POST "$API/v1/customers" "${H[@]}" -d "{\"external_id\":\"$ORG\",\"name\":\"$NAME\"}" | jq -r .id)
fi
echo "customer=$CUST"

echo "== 2. INR prepaid wallet =="
WALLET=$(curl -sS "${R[@]}" "$API/v1/wallets?customer_id=$CUST&limit=10" "${H[@]}" | jq -r '(.items // .wallets // .data // [])[] | select((.currency|ascii_downcase)=="inr" and .wallet_status=="active") | .id' | head -1)
if [ -z "$WALLET" ]; then
  WALLET=$(curl -sS "${R[@]}" -X POST "$API/v1/wallets" "${H[@]}" -d "{\"customer_id\":\"$CUST\",\"currency\":\"INR\",\"wallet_type\":\"PRE_PAID\",\"conversion_rate\":1}" | jq -r .id)
fi
echo "wallet=$WALLET"

echo "== 3. top-up (PURCHASED_CREDIT_DIRECT, fixed idempotency key) =="
TOPUP=$(curl -sS "${R[@]}" -X POST "$API/v1/wallets/$WALLET/top-up" "${H[@]}" -d "{\"amount\":50,\"currency\":\"INR\",\"transaction_reason\":\"PURCHASED_CREDIT_DIRECT\",\"idempotency_key\":\"$ORG:flexprice:topup\"}")
echo "$TOPUP" | jq -c '{invoice_id, status} // .' 2>/dev/null || echo "$TOPUP"
INVOICE=$(echo "$TOPUP" | jq -r '.invoice_id // empty')
[ -n "$INVOICE" ] && curl -sS "${R[@]}" -X PUT "$API/v1/invoices/$INVOICE/payment" "${H[@]}" -d '{"payment_status":"SUCCEEDED"}' | jq -c '{id, payment_status}' || true

echo "== 4. subscription (currency must match plan prices; billing_period=MONTHLY) =="
SUBS=$(curl -sS "${R[@]}" "$API/v1/subscriptions?customer_id=$CUST&limit=5" "${H[@]}" | jq -r '(.items // .subscriptions // .data // [])[0].id // empty')
if [ -z "$SUBS" ]; then
  SUBS=$(curl -sS "${R[@]}" -X POST "$API/v1/subscriptions" "${H[@]}" -d "{\"customer_id\":\"$CUST\",\"plan_id\":\"$PLAN\",\"currency\":\"INR\",\"billing_period\":\"MONTHLY\"}" | tee /dev/stderr | jq -r .id)
fi
echo "subscription=$SUBS"
echo "DONE: org=$ORG customer=$CUST wallet=$WALLET subs=$SUBS"
