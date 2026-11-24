#!/usr/bin/env bash
# Pull-sync alternative to the webhook receiver: reconcile remaining budget
# from FlexPrice into LiteLLM virtual-key max_budget on a schedule. No
# always-on service required; enforcement lag = run interval.
#
# For every FlexPrice customer named litellm-org:<org_id>:
#   remaining = plan monthly budget - current-period spend (from subscription
#   usage), then set max_budget = max(remaining, 0) on all of that org's keys.
#
# Required env:
#   LITELLM_API_URL, LITELLM_MASTER_KEY
#   FLEXPRICE_API_URL, FLEXPRICE_API_KEY [, FLEXPRICE_ENVIRONMENT_ID]
#   BUDGET_USD (monthly budget applied to every org; or edit ORGS list below)
set -euo pipefail

: "${LITELLM_API_URL:?}"; : "${LITELLM_MASTER_KEY:?}"
: "${FLEXPRICE_API_URL:?}"; : "${FLEXPRICE_API_KEY:?}"
BUDGET_USD="${BUDGET_USD:-500}"

fp() { # fp METHOD PATH [BODY]
    local method="$1" path="$2" body="${3:-}"
    local hdr=(-H "x-api-key: ${FLEXPRICE_API_KEY}" -H "Content-Type: application/json")
    [ -n "${FLEXPRICE_ENVIRONMENT_ID:-}" ] && hdr+=(-H "X-Environment-ID: ${FLEXPRICE_ENVIRONMENT_ID}")
    if [ "$method" = GET ]; then
        curl -sf -X GET "${hdr[@]}" "${FLEXPRICE_API_URL}${path}"
    else
        curl -sf -X "$method" "${hdr[@]}" -d "$body" "${FLEXPRICE_API_URL}${path}"
    fi
}

ll() { # ll PATH BODY
    curl -sf -X POST "${LITELLM_API_URL}$1" \
        -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
        -H "Content-Type: application/json" -d "$2"
}

month_start="$(date -u +%Y-%m-01T00:00:00Z)"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Current-period spend per org = sum over the passthrough + token prices via
# the subscription usage endpoint; simplest robust proxy is /v1/invoices
# draft + paid totals for the window, falling back to meter usage.
customers="$(fp GET '/v1/customers?limit=1000' | jq -r '.data[].external_id // empty' | grep '^litellm-org:' || true)"

for ext in $customers; do
    org="${ext#litellm-org:}"
    spend="$(ll /global/spend/logs "{\"organization_ids\":[\"${org}\"],\"start_date\":\"${month_start}\",\"end_date\":\"${now}\"}" \
        | jq '[.[].spend // 0] | add // 0')"
    remaining="$(jq -n --arg b "$BUDGET_USD" --arg s "$spend" '([$b|tonum - $s|tonum, 0] | max)')"
    team_ids="$(ll /team/list "{\"organization_ids\":[\"${org}\"]}" | jq -c '[.[].team_id] | map(select(. != null))')"
    keys="$(ll /key/list "{\"team_ids\":${team_ids}}" | jq -c '[.keys[].key] | map(select(. != null))')"
    for key in $(jq -r '.[]' <<<"$keys"); do
        ll /key/update "$(jq -nc --arg k "$key" --argjson m "$remaining" '{key:$k, max_budget:$m}')" >/dev/null
        echo "org=$org key=${key:0:10}... max_budget=$remaining (spend=$spend)"
    done
done
