#!/usr/bin/env bash
# Fallback bridge: poll LiteLLM /spend/logs/v2 and ingest ai.usage events into
# FlexPrice. Run from cron / a k8s CronJob every N minutes. No proxy-side file
# required. At-least-once: overlapping pulls are absorbed by event_id dedup in
# FlexPrice, so the cursor is only advanced after a fully successful run.
#
# Required env:
#   LITELLM_API_URL, LITELLM_MASTER_KEY
#   FLEXPRICE_API_URL, FLEXPRICE_API_KEY [, FLEXPRICE_ENVIRONMENT_ID]
# Optional:
#   OVERLAP_MINUTES (default 10), CURSOR_FILE (default ./litellm-cursor),
#   BILLABLE_TAGS (default "planning,skill,mcp"), BATCH_SIZE (default 500)
set -euo pipefail

: "${LITELLM_API_URL:?}"; : "${LITELLM_MASTER_KEY:?}"
: "${FLEXPRICE_API_URL:?}"; : "${FLEXPRICE_API_KEY:?}"
OVERLAP_MINUTES="${OVERLAP_MINUTES:-10}"
CURSOR_FILE="${CURSOR_FILE:-./litellm-cursor}"
BILLABLE_TAGS="${BILLABLE_TAGS:-planning,skill,mcp}"
BATCH_SIZE="${BATCH_SIZE:-500}"

now="$(date -u "+%Y-%m-%d %H:%M:%S")"
fallback_start="$(date -u -v-"${OVERLAP_MINUTES}"M "+%Y-%m-%d %H:%M:%S" 2>/dev/null \
        || date -u -d "${OVERLAP_MINUTES} minutes ago" "+%Y-%m-%d %H:%M:%S")"
start="$(cat "$CURSOR_FILE" 2>/dev/null || true)"
start="${start:-$fallback_start}"

logs="$(mktemp)"
trap 'rm -f "$logs"' EXIT

page=1
while :; do
    resp="$(curl -sf -G "$LITELLM_API_URL/spend/logs/v2" \
        -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
        --data-urlencode "start_date=$start" \
        --data-urlencode "end_date=$now" \
        --data-urlencode "page_size=500" \
        --data-urlencode "page=$page")" || { echo "spend/logs page $page failed" >&2; exit 1; }
    rows="$(jq -c '.data[]?' <<<"$resp")"
    [ -n "$rows" ] && printf '%s\n' "$rows" >> "$logs"
    [ "$(jq '.data | length' <<<"$resp")" -ge 500 ] || break
    page=$((page + 1))
done
[ -s "$logs" ] || { printf '%s' "$now" > "$CURSOR_FILE"; echo "no logs in window $start -> $now"; exit 0; }

# Map spend-log rows -> ai.usage events with flattened tag_<name> properties,
# identical in shape to the callback bridge.
events="$(jq -sc --arg tags "$BILLABLE_TAGS" '
    ($tags | split(",") | map(select(. != ""))) as $tlist
    | map(
        (((.metadata // {}) | (.tags // [])) + (.request_tags // [])
         | map(select(. as $x | $tlist | index($x) != null)) | unique) as $tagsArr
        | {
            event_name: "ai.usage",
            event_id: (.request_id // .call_id),
            timestamp: (.date // .startTime),
            source: "litellm",
            external_customer_id: ("litellm-org:" + (((.metadata // {}).user_api_key_org_id // .organization_id // "unknown") | tostring)),
            properties: (
                {
                    provider:        ((.provider // .custom_llm_provider // "") | tostring),
                    model:           ((.model // "") | tostring),
                    operation:       "chat",
                    input_tokens:    ((.prompt_tokens // 0) | tostring),
                    output_tokens:   ((.completion_tokens // 0) | tostring),
                    total_tokens:    (((.prompt_tokens // 0) + (.completion_tokens // 0)) | tostring),
                    reported_cost:   ((.spend // 0) | tostring),
                    request_id:      ((.request_id // "") | tostring),
                    organisation_id: (((.metadata // {}).user_api_key_org_id // .organization_id // "") | tostring),
                    raw_team:        (((.metadata // {}).user_api_key_team_id // .team_id // "") | tostring),
                    raw_user:        (((.metadata // {}).user_api_key_user_id // .user // "") | tostring),
                    fidelity:        "per_request",
                    tagged:          (if ($tagsArr | length) > 0 then "true" else "false" end)
                }
                + reduce $tlist[] as $tg ({};
                    . + {("tag_" + $tg): (if ($tagsArr | index($tg)) != null then $tg else "" end)})
            )
          })' "$logs")"

total="$(jq 'length' <<<"$events")"
i=0
while [ "$i" -lt "$total" ]; do
    batch="$(jq -c --argjson i "$i" --argjson n "$BATCH_SIZE" '{events: .[$i : $i + $n]}' <<<"$events")"
    hdr=(-H "Content-Type: application/json" -H "x-api-key: ${FLEXPRICE_API_KEY}")
    [ -n "${FLEXPRICE_ENVIRONMENT_ID:-}" ] && hdr+=(-H "X-Environment-ID: ${FLEXPRICE_ENVIRONMENT_ID}")
    if ! curl -sf -X POST "${FLEXPRICE_API_URL}/v1/events/bulk" "${hdr[@]}" -d "$batch" >/dev/null; then
        echo "bulk ingest failed at offset $i; cursor NOT advanced — next run retries (event_id dedup absorbs it)" >&2
        exit 1
    fi
    i=$((i + BATCH_SIZE))
done

printf '%s' "$now" > "$CURSOR_FILE"
echo "ingested $total events (window $start -> $now)"
