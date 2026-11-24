#!/usr/bin/env bash
# End-to-end FlexPrice org lifecycle setup (customer -> wallet -> coupon top-up ->
# usage events -> bill -> balance). Safe to re-run: every step finds-or-creates,
# and usage events use deterministic event_ids (ClickHouse dedup absorbs repeats).
#
# Required env:
#   FLEXPRICE_API_KEY   private key (x-api-key)
# Optional env (defaults shown):
#   FLEXPRICE_API_URL         http://api.flexprice.local
#   FLEXPRICE_ENVIRONMENT_ID  00000000-0000-0000-0000-000000000000 (Sandbox)
#   CURL_RESOLVE              extra curl flag mapping api.flexprice.local to 127.0.0.1
#   ORG_ID / ORG_NAME         org_scripted / "Org Scripted"
#   CREDITS_TO_TOPUP          200
#   COUPON_CODE / COUPON_OFF  org50 / 50 (fixed USD, cadence once)
#   TOPUP_IDEM                org-<ORG_ID>-topup-<CREDITS> (change to force a fresh top-up)
#   METER_IDS                 "<meter_id>=<property>" list to report after ingest;
#                             defaults to the docs/integrations/litellm.md local-kind meters
set -euo pipefail

: "${FLEXPRICE_API_KEY:?}"
API="${FLEXPRICE_API_URL:-http://api.flexprice.local}"
ENV_ID="${FLEXPRICE_ENVIRONMENT_ID:-00000000-0000-0000-0000-000000000000}"
RESOLVE=()
[ "${CURL_RESOLVE:-1}" = "1" ] && RESOLVE=(--resolve "api.flexprice.local:80:127.0.0.1")
ORG="${ORG_ID:-org_scripted}"
ORG_NAME="${ORG_NAME:-Org Scripted}"
CREDITS="${CREDITS_TO_TOPUP:-200}"
CODE="${COUPON_CODE:-org50}"
OFF="${COUPON_OFF:-50}"
IDEM="${TOPUP_IDEM:-org-$ORG-topup-$CREDITS}"
EXT_ID="litellm-org:$ORG"

fp() { # fp METHOD PATH [JSON]
    local method="$1" path="$2" body="${3:-}"
    local args=(-s -X "$method" "$API$path" "${RESOLVE[@]}"
        -H "Content-Type: application/json"
        -H "x-api-key: $FLEXPRICE_API_KEY"
        -H "X-Environment-ID: $ENV_ID")
    [ -n "$body" ] && args+=(-d "$body")
    curl "${args[@]}"
}
step() { printf '\n==> %s\n' "$1"; }

step "1. customer $EXT_ID (find or create)"
CUST_JSON="$(fp POST /v1/customers "{\"external_id\":\"$EXT_ID\",\"name\":\"$ORG_NAME\",\"currency\":\"USD\"}")"
CUST_ID="$(jq -r '.id // .customer_id // empty' <<<"$CUST_JSON")"
if [ -z "$CUST_ID" ]; then
    CUST_ID="$(fp GET "/v1/customers?limit=100" | jq -r --arg e "$EXT_ID" '.items[]? | select(.external_id==$e) | .id')"
fi
[ -n "$CUST_ID" ] || { echo "customer not created/found: $CUST_JSON" >&2; exit 1; }
echo "customer_id=$CUST_ID"

step "2. USD prepaid wallet (find or create, 1 USD = 1 credit)"
find_usd_wallet() { fp GET "/v1/customers/$CUST_ID/wallets" | jq -r '[.[]? | select(.currency=="usd" and (.wallet_status=="active" // true))][0].id // empty'; }
WALLET_ID="$(find_usd_wallet)"
if [ -z "$WALLET_ID" ]; then
    fp POST /v1/wallets "{\"customer_id\":\"$CUST_ID\",\"name\":\"$ORG credits\",\"currency\":\"USD\",\"wallet_type\":\"PRE_PAID\",\"conversion_rate\":1}" >/dev/null || true
    WALLET_ID="$(find_usd_wallet)"
fi
[ -n "$WALLET_ID" ] || { echo "wallet not found/created" >&2; exit 1; }
echo "wallet_id=$WALLET_ID"

step "3. coupon $CODE — \$OFF fixed/once (find or create)"
if ! fp GET "/v1/coupons/code/$CODE" | jq -e '.id' >/dev/null 2>&1; then
    fp POST /v1/coupons "{\"name\":\"$CODE\",\"coupon_code\":\"$CODE\",\"type\":\"fixed\",\"cadence\":\"once\",\"amount_off\":$OFF,\"currency\":\"USD\",\"max_redemptions\":1}" >/dev/null
fi
COUPON_ID="$(fp GET "/v1/coupons/code/$CODE" | jq -r '.id')"
echo "coupon_id=$COUPON_ID"

step "4. top-up $CREDITS credits with $CODE (idempotency_key=$IDEM)"
find_topup_invoice() { fp GET "/v1/invoices?customer_id=$CUST_ID&limit=100" | jq -r --arg k "$1" '[.items[]? | select(.idempotency_key==$k)][0].id // empty'; }
topup_call() { # topup_call KEY [COUPON_JSON]
    fp POST "/v1/wallets/$WALLET_ID/top-up" "{\"wallet_id\":\"$WALLET_ID\",\"credits_to_add\":$CREDITS,\"transaction_reason\":\"PURCHASED_CREDIT_INVOICED\",\"payment_status\":\"PENDING\",\"idempotency_key\":\"$1\"${2:+,\"coupons\":$2}}"
}
TOPUP="$(topup_call "$IDEM" "[{\"coupon_code\":\"$CODE\"}]")"
INVOICE_ID="$(jq -r '.invoice_id // empty' <<<"$TOPUP")"
if [ -z "$INVOICE_ID" ]; then
    MSG="$(jq -r '.message // ""' <<<"$TOPUP")"
    case "$MSG" in
        *"maximum redemptions"*)
            echo "coupon spent on a previous run ($MSG); retrying without coupon"
            TOPUP="$(topup_call "${IDEM}-nc" "")"
            INVOICE_ID="$(jq -r '.invoice_id // empty' <<<"$TOPUP")";;
    esac
    [ -n "$INVOICE_ID" ] || INVOICE_ID="$(find_topup_invoice "$IDEM")"
    [ -n "$INVOICE_ID" ] || INVOICE_ID="$(find_topup_invoice "${IDEM}-nc")"
fi
if [ -z "$INVOICE_ID" ]; then
    echo "top-up failed: $(jq -c '{code, message}' <<<"$TOPUP")" >&2; exit 1
fi
INV="$(fp GET "/v1/invoices/$INVOICE_ID")"
jq -r '"invoice \(.id): subtotal \(.subtotal) - discount \(.total_discount) = due \(.amount_due)"' <<<"$INV"

step "5. settle invoice (offline payment)"
if [ "$(jq -r .payment_status <<<"$INV")" = "PENDING" ]; then
    fp PUT "/v1/invoices/$INVOICE_ID/payment" '{"payment_status":"SUCCEEDED"}' >/dev/null
fi
fp GET "/v1/wallets/$WALLET_ID/balance/real-time" | jq -r '"balance after top-up: " + .credit_balance'

step "6. push sample ai.usage events (deterministic ids -> rerun-safe via dedup)"
fp POST /v1/events/bulk "{\"events\":[
 {\"event_name\":\"ai.usage\",\"event_id\":\"usage-$ORG-1\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"source\":\"litellm\",\"external_customer_id\":\"$EXT_ID\",\"properties\":{\"provider\":\"openrouter\",\"model\":\"anthropic/claude-sonnet-4\",\"operation\":\"chat\",\"input_tokens\":\"2400\",\"output_tokens\":\"600\",\"total_tokens\":\"3000\",\"reported_cost\":\"0.031\",\"request_id\":\"usage-$ORG-1\",\"organisation_id\":\"$ORG\",\"raw_team\":\"team_core\",\"raw_user\":\"u_1\",\"fidelity\":\"per_request\",\"tagged\":\"false\",\"tag_planning\":\"\",\"tag_skill\":\"\",\"tag_mcp\":\"\"}},
 {\"event_name\":\"ai.usage\",\"event_id\":\"usage-$ORG-2\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"source\":\"litellm\",\"external_customer_id\":\"$EXT_ID\",\"properties\":{\"provider\":\"openrouter\",\"model\":\"anthropic/claude-sonnet-4\",\"operation\":\"chat\",\"input_tokens\":\"5200\",\"output_tokens\":\"900\",\"total_tokens\":\"6100\",\"reported_cost\":\"0.058\",\"request_id\":\"usage-$ORG-2\",\"organisation_id\":\"$ORG\",\"raw_team\":\"team_planning\",\"raw_user\":\"u_1\",\"fidelity\":\"per_request\",\"tagged\":\"true\",\"tag_planning\":\"planning\",\"tag_skill\":\"\",\"tag_mcp\":\"\"}},
 {\"event_name\":\"ai.usage\",\"event_id\":\"usage-$ORG-3\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"source\":\"litellm\",\"external_customer_id\":\"$EXT_ID\",\"properties\":{\"provider\":\"openrouter\",\"model\":\"anthropic/claude-sonnet-4\",\"operation\":\"chat\",\"input_tokens\":\"800\",\"output_tokens\":\"250\",\"total_tokens\":\"1050\",\"reported_cost\":\"0.009\",\"request_id\":\"usage-$ORG-3\",\"organisation_id\":\"$ORG\",\"raw_team\":\"team_core\",\"raw_user\":\"u_1\",\"fidelity\":\"per_request\",\"tagged\":\"true\",\"tag_planning\":\"\",\"tag_skill\":\"skill\",\"tag_mcp\":\"\"}}]}" >/dev/null
echo "3 events accepted (deduped on re-run)"

step "7. meter usage check (~1 min consumer lag; raw path sums all events —"
echo "    meter tag filters are applied by the rollup/billing path, not here)"
METERS="${METER_IDS:-meter_01M7T5PGYK3GF6T3SM72PZ4HYZ=input_tokens meter_01M7T5PH12QF0KAKXH1QJ562Q6=input_tokens meter_01M7T5PH290N9E6KF72SN0127N=total_tokens}"
# meter filters decide what a meter counts; the raw endpoint shows the event-side numbers
FROM="$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)"
TO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
for mp in $METERS; do
    id="${mp%%=*}"
    v="$(fp POST /v1/events/usage/meter "{\"meter_id\":\"$id\",\"external_customer_id\":\"$EXT_ID\",\"start_time\":\"$FROM\",\"end_time\":\"$TO\"}" | jq -r '.value // 0')"
    echo "$id  value=$v"
done

step "done. wallet=$WALLET_ID customer=$CUST_ID invoice=$INVOICE_ID coupon=$COUPON_ID"
echo "usage invoices bill at period end (or immediately via subscription cancel with"
echo "cancellation_type=immediate + cancel_immediately_invoice_policy=generate_invoice);"
echo "the finalize workflow debits the wallet — see docs/integrations/litellm.md §11."
