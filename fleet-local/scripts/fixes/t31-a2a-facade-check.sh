#!/usr/bin/env bash
# T-31: prove the BFF's A2A facade (see docs/TROUBLESHOOTING.md T-19) against the
# live cluster, rather than assuming the local unit tests describe the wire.
#
# Read-only by default: it port-forwards, mints its own session cookie and calls
# the facade. Pass REBUILD=1 to rebuild + roll the BFF image first.
#
# What it proves, in order:
#   1) routing beats the SPA fallback (an unauthenticated card call answers 401
#      in the A2A error shape, as JSON — never index.html)
#   2) the agent card is rewritten to the facade and leaks no in-cluster URL
#   3) a real message:stream turn relays controller frames and BINDS a contextId
#   4) the session row records WHAT the turn was and how long it actually ran
#   5) the refusal paths are honest: unknown conversation, unknown model, push
#      notifications, and a task belonging to someone else
#   6) the legacy /chat relay is gone (PR 3 deleted it — the browser now speaks
#      AG-UI, and one browser wire per app is the point)
#   7) a turn the PLATFORM could not run (dead credential or retired model id) is
#      classified upstream_error and is NOT metered (FAULT_MODEL names it; empty
#      skips)
#   8) a real A2A client (scripts/fixes/FleetA2AClient.ts over
#      @assistant-ui/react-a2a) parses the card, types the frames, and lands its
#      model choice on the row
#   9) the AG-UI run endpoint that replaced /chat accepts the client-minted
#      thread handle, streams RUN_STARTED / TEXT_MESSAGE_* / a terminal frame, and
#      records thread_id + outcome on the session row
set -uo pipefail
CTX=${KCTX:-kind-flexprice-local}
k() { kubectl --context "$CTX" "$@"; }
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BFF_PORT=${BFF_PORT:-18080}
BASE=http://127.0.0.1:$BFF_PORT
TEXT=${TEXT:-"Reply with exactly T31-OK and nothing else."}
FAILS=0

say()  { echo "== $*"; }
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILS=$((FAILS+1)); }
check(){ [ "$1" = 0 ] && pass "$2" || fail "$2"; }

if [ "${REBUILD:-0}" = 1 ]; then
  say "0) rebuild + roll the BFF"
  "$ROOT/scripts/fixes/rebuild-bff.sh" || { echo "rebuild failed" >&2; exit 1; }
fi

PGPW=$(k -n flexprice get secret flexprice-postgresql -o jsonpath='{.data.password}' | base64 -d)
fp() { k -n flexprice exec -i flexprice-postgresql-0 -- env PGPASSWORD="$PGPW" \
  psql -U flexprice -d fleet_control -tA -F'|' -c "$1" </dev/null; }

# A member of an onboarded project, so requireAuth + assertMember both pass.
ROW=$(fp "select u.id, u.email, p.org_id, p.id, o.slug
           from users u
           join org_members m on m.user_id = u.id
           join projects p on p.org_id = m.org_id
           join orgs o on o.id = p.org_id
          where p.agent_name is not null
          order by p.created_at desc limit 1;")
read -r USER_ID EMAIL ORG PROJ ORG_SLUG <<<"$(echo "$ROW" | tr -d '[:space:]' | sed 's/|/ /g')"
[ -n "${PROJ:-}" ] || { echo "no onboarded project in fleet_control — run the wizard first" >&2; exit 1; }
echo "   user=$EMAIL org=$ORG project=$PROJ (slug=$ORG_SLUG)"

SESS=$(k -n fleet-system get secret fleet-bff-env -o jsonpath='{.data.FLEET_SESSION_SECRET}' | base64 -d)
[ -n "$SESS" ] || { echo "fleet-bff-env/FLEET_SESSION_SECRET not found" >&2; exit 1; }
# The BFF verifies this cookie with HS256 over FLEET_SESSION_SECRET (auth/session.ts).
TOKEN=$(node -e '
const [secret, uid, email] = process.argv.slice(1);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: "HS256", typ: "JWT" });
const body = b64({ sub: uid, email, iat: now, exp: now + 900 });
const sig = require("crypto").createHmac("sha256", secret).update(head + "." + body).digest("base64url");
process.stdout.write(`${head}.${body}.${sig}`);' "$SESS" "$USER_ID" "$EMAIL")
C=( -H "Cookie: _fleet_sess=$TOKEN" )
A2A=( "${C[@]}" -H 'Content-Type: application/a2a+json' -H 'Accept: application/a2a+json, text/event-stream'
      -H 'A2A-Version: 1.0' )
API="$BASE/api/a2a/orgs/$ORG/projects/$PROJ"

k -n fleet-system port-forward svc/fleet-bff "$BFF_PORT:8080" >/dev/null 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true' EXIT
# Not a fixed sleep: with replicas=1 and a 25%/25% rolling update the deployment
# can run with ZERO ready endpoints for minutes (an in-flight SSE keeps the old
# pod terminating), and every curl then answers 000 — a roll that looks like
# fifteen protocol failures. Wait for /healthz and say so if it never comes.
ready=0
until curl -sf -o /dev/null --max-time 3 "$BASE/healthz"; do
  ready=$((ready + 5))
  if [ "$ready" -ge "${READY_WAIT:-180}" ]; then
    echo "no ready fleet-bff pod after ${ready}s — kubectl -n fleet-system get pods; a stuck rollout cannot be gated" >&2
    exit 1
  fi
  sleep 5
done
echo "   bff ready (${ready}s)"

say "1) unauthenticated card call answers 401 as A2A JSON, not the SPA"
code=$(curl -s -o /tmp/t31-card-anon.json -w '%{http_code}' "$API/.well-known/agent-card.json")
ctype=$(curl -s -D - -o /dev/null "$API/.well-known/agent-card.json" | tr -d '\r' | awk -F': ' '/^content-type/{print tolower($2)}')
[ "$code" = 401 ] && pass "401 ($code)" || fail "expected 401, got $code"
echo "$ctype" | grep -q 'a2a+json\|json' && ! echo "$ctype" | grep -q html \
  && pass "content-type is JSON-ish ($ctype)" || fail "content-type $ctype (SPA fallback would be html)"
jq -e '.error.status == "UNAUTHENTICATED" and .error.code == 401' /tmp/t31-card-anon.json >/dev/null 2>&1 \
  && pass "error carries an A2A status the client can show" || fail "error body: $(head -c 200 /tmp/t31-card-anon.json)"

say "2) the card is rewritten to the facade, with no in-cluster URL"
curl -s "${C[@]}" -o /tmp/t31-card.json "$API/.well-known/agent-card.json"
jq -e '.name | length > 0' /tmp/t31-card.json >/dev/null 2>&1 \
  && pass "card has a name (the client rejects a nameless one)" || fail "card has no name: $(head -c 200 /tmp/t31-card.json)"
FACADE=$(jq -r '.supportedInterfaces[0].url // .url // ""' /tmp/t31-card.json)
echo "$FACADE" | grep -q "/api/a2a/orgs/$ORG/projects/$PROJ" \
  && pass "interface url is the facade ($FACADE)" || fail "interface url is not the facade: $FACADE"
grep -q 'kagent-controller\|\.svc' /tmp/t31-card.json \
  && fail "card still advertises an in-cluster address" || pass "no in-cluster address leaked"

say "3) message:stream relays controller frames and binds a contextId"
BODY=$(jq -nc --arg t "$TEXT" '{message:{role:"ROLE_USER",parts:[{kind:"text",text:$t}]}}')
curl -sN "${A2A[@]}" -X POST --max-time ${STREAM_TIMEOUT:-240} -d "$BODY" "$API/message:stream" \
  >/tmp/t31-stream.txt 2>/tmp/t31-stream.err
frames=$(grep -c '^data:' /tmp/t31-stream.txt)
[ "$frames" -ge 1 ] && pass "$frames data frames relayed" || fail "no frames: $(head -c 300 /tmp/t31-stream.txt)"
# Frames are forwarded VERBATIM (the client unwraps {jsonrpc,result} itself), so
# a jsonrpc envelope here is correct, not a leak — what must hold is that every
# frame is a parseable A2A event and one of them names a context.
badline=$(grep '^data:' /tmp/t31-stream.txt | sed 's/^data: *//' | jq -e '
  (.result // .) as $r | ($r|has("task") or has("statusUpdate") or has("status_update") or has("artifactUpdate") or has("artifact_update") or has("message") or has("error"))' 2>/dev/null | wc -l | tr -d ' ')
[ "${badline:-0}" = "$frames" ] && [ "$frames" -ge 1 ] && pass "every frame is a recognisable A2A event ($badline/$frames)" \
  || fail "only ${badline:-0}/$frames frames parsed"
CTXID=$(grep '^data:' /tmp/t31-stream.txt | sed 's/^data: *//' | jq -r '(.result // .) | (.contextId? // .task?.contextId // .statusUpdate?.contextId // empty)' | head -1)
# The state lives in three places depending on the frame kind: a bare task reply
# nests it under .task, a status update under .statusUpdate. Reading only the
# flat path silently reported WORKING for a turn that had already completed.
STATE=$(grep '^data:' /tmp/t31-stream.txt | sed 's/^data: *//' \
  | jq -r '(.result // .) | (.task?.status?.state // .statusUpdate?.status?.state // .status?.state // empty)' | tail -1)
[ -n "$CTXID" ] && pass "contextId on the wire ($CTXID)" || fail "no contextId in the stream"
case "$STATE" in
  *_COMPLETED|*_FAILED|*_CANCELLED|*_CANCELED|*_REJECTED|*_INPUT_REQUIRED|*_AUTH_REQUIRED)
    pass "the stream reached a settled state ($STATE)" ;;
  *) fail "the stream never settled (last state: ${STATE:-none})" ;;
esac

say "4) the session row says what the turn was, and for how long it ran"
sleep 2
# Not a pipe: a piped while-loop runs in a subshell and its failures would be
# counted nowhere.
bound=$(fp "select id || '|' || turn || '|' || status || '|' || coalesce(outcome,'NULL') || '|' || coalesce(meter_seconds::text,'-') || '|' || coalesce(close_reason,'-') || '|' || kagent_session_id
             from sessions where kagent_session_id = '$CTXID' order by started_at desc limit 1;")
if [ -z "$bound" ]; then
  fail "no session row bound to the wire contextId $CTXID"
else
  echo "   $bound"
  case "$bound" in
    *'|NULL|'*) fail "outcome is NULL — the UI would be blind again" ;;
    *) pass "outcome + meter_seconds written" ;;
  esac
  # "(no output)" has two causes and the row must tell them apart: a turn that
  # produced nothing at all, and a turn that produced an artifact.
  arts=$(grep -c 'artifactUpdate\|artifact_update' /tmp/t31-stream.txt)
  reason=$(echo "$bound" | awk -F'|' '{print $6}')
  case "$STATE" in
    *_COMPLETED)
      if [ "${arts:-0}" = 0 ]; then
        case "$reason" in
          *'without producing any output'*) pass "a silent completion explains the empty bubble" ;;
          *) fail "completed with no artifact frame, but close_reason does not say so: $reason" ;;
        esac
      else
        [ "$reason" = "-" ] && pass "an answered completion carries no false excuse" \
          || echo "   note: answered completion carries close_reason $reason"
      fi ;;
    *) echo "   note: turn ended $STATE, so the empty-output rule does not apply" ;;
  esac
fi
fp "select id, turn, status, coalesce(outcome,'-'), coalesce(meter_seconds::text,'-'), coalesce(billed_seconds::text,'-')
     from sessions order by started_at desc limit 5;" | sed 's/^/   /'

say "5) the refusals are honest, in the shape the client can render"
probe() { # name, expected_status, jq reason, body, path
  local name=$1 want=$2 reason=$3 body=$4 path=$5 out
  out=$(curl -s -o /tmp/t31-refuse.json -w '%{http_code}' "${A2A[@]}" -X POST -d "$body" "$API/$path")
  jq -e --arg r "$reason" '.error.status and .error.message and .error.details[0].reason == $r' /tmp/t31-refuse.json >/dev/null 2>&1
  local shape=$?
  [ "$out" = "$want" ] && [ "$shape" = 0 ] && pass "$name -> $out with a reason" \
    || fail "$name -> $out (want $want): $(head -c 220 /tmp/t31-refuse.json)"
}
probe "unknown conversation" 404 unknown_conversation \
  "$(jq -nc '{message:{role:"ROLE_USER",contextId:"00000000-0000-4000-8000-000000000000",parts:[{kind:"text",text:"hi"}]}}')" "message:stream"
probe "unknown model" 400 unknown_model \
  "$(jq -nc --arg t "$TEXT" '{message:{role:"ROLE_USER",metadata:{"fleet.dev/model":"not-a-model"},parts:[{kind:"text",text:$t}]}}')" "message:stream"
probe "push notifications" 501 push_notifications_unsupported \
  "$(jq -nc '{message:{role:"ROLE_USER",parts:[{kind:"text",text:"hi"}]},configuration:{taskPushNotificationConfig:{url:"http://example.invalid/hook"}}}')" "message:stream"
code=$(curl -s -o /tmp/t31-task.json -w '%{http_code}' "${C[@]}" "$API/tasks/00000000-0000-4000-8000-000000000000")
[ "$code" = 404 ] && pass "a task we never minted is 404, not dialed upstream" || fail "getTask foreign id -> $code"
if [ -n "${CTXID:-}" ]; then
  TID=$(grep '^data:' /tmp/t31-stream.txt | sed 's/^data: *//' | jq -r '(.result // .) | (.taskId? // .task?.id? // .statusUpdate?.taskId? // empty)' | head -1)
  if [ -n "$TID" ]; then
    code=$(curl -s -o /tmp/t31-task.json -w '%{http_code}' "${C[@]}" "$API/tasks/$TID")
    [ "$code" = 200 ] && pass "our own task $TID resolves (200)" || fail "getTask ours -> $code: $(head -c 200 /tmp/t31-task.json)"
  else
    fail "no taskId seen on the wire, so GetTask could not be exercised"
  fi
fi

say "6) the legacy /chat relay is gone"
# PR 3 deleted the bespoke browser relay, and this is the gate that notices if it
# comes back: the route must 404, not 405 (a registered route with the method
# removed) and not 200 answering index.html (the SPA fallback swallowing an unknown
# API path — gate 1 exists because that fallback once hid a whole class of errors).
code=$(curl -s -o /tmp/t31-legacy.txt -w '%{http_code}' "${C[@]}" -H 'Content-Type: application/json' \
  -X POST --max-time 30 -d "$(jq -nc --arg t "$TEXT" '{text:$t}')" \
  "$BASE/api/orgs/$ORG/projects/$PROJ/chat")
[ "$code" = 404 ] && pass "POST /chat -> 404 (the relay and its SSE frames are gone)" \
  || fail "legacy /chat -> $code, want 404: $(head -c 200 /tmp/t31-legacy.txt)"

say "7) a turn the platform could not run is not billed"
# The failure the user actually hit, and its sibling: kagent reports BOTH a dead
# credential and a retired model id as an ordinary TASK_STATE_FAILED carrying the
# provider's text ("...401 Unauthorized" from an expired key; "anthropic/...
# is no longer available on OpenRouter" / "OpenAI API error: 404 Not Found" from
# a slug that no longer exists). Either way the platform broke the turn, so it
# must land as upstream_error (skipped by the settlement policy) with the reason
# preserved for the UI — never as billable compute. FAULT_MODEL must name a model
# the platform currently cannot serve; set it empty to skip. The live case since
# the key was rotated is `claude`, whose OpenRouter slug is retired.
FAULT=${FAULT_MODEL:-claude}
if [ -z "$FAULT" ]; then
  echo "   skipped (FAULT_MODEL empty): no platform-broken model to exercise"
else
  fbody=$(jq -nc --arg t "$TEXT" --arg m "$FAULT" \
    '{message:{role:"ROLE_USER",metadata:{"fleet.dev/model":$m},parts:[{kind:"text",text:$t}]}}')
  curl -sN "${A2A[@]}" -X POST --max-time ${STREAM_TIMEOUT:-240} -d "$fbody" "$API/message:stream" \
    >/tmp/t31-fault.txt 2>/dev/null
  fstate=$(grep '^data:' /tmp/t31-fault.txt | sed 's/^data: *//' \
    | jq -r '(.result // .) | (.task?.status?.state // .statusUpdate?.status?.state // .status?.state // empty)' | tail -1)
  fctx=$(grep '^data:' /tmp/t31-fault.txt | sed 's/^data: *//' \
    | jq -r '(.result // .) | (.contextId? // .task?.contextId // .statusUpdate?.contextId // empty)' | head -1)
  if [ "$fstate" != "TASK_STATE_FAILED" ]; then
    echo "   note: $FAULT ended $fstate — the fault path is not reproducible (key healthy?), skipping"
  else
    # metered_seconds is what the sweeper actually SENT. A platform fault is
    # acknowledged with 0 seconds (so it never re-enters the sweep), which is
    # only provable once the sweep has run — hence the bounded wait.
    faultrow() { fp "select coalesce(outcome,'NULL') || '|' || coalesce(close_reason,'-') || '|' || coalesce(meter_seconds::text,'-') || '|' || coalesce(metered_seconds::text,'-') || '|' || coalesce(metered_outcome,'-')
                   from sessions where kagent_session_id = '$fctx' order by started_at desc limit 1;"; }
    row=$(faultrow)
    waited=0
    while [ -n "$row" ] && [ "$(echo "$row" | awk -F'|' '{print $4}')" = "-" ] && [ "$waited" -lt "${METER_WAIT:-90}" ]; do
      sleep 5; waited=$((waited + 5)); row=$(faultrow)
    done
    echo "   $row  (waited ${waited}s for the sweeper)"
    [ "${row%%|*}" = "upstream_error" ] && pass "a provider fault classifies as upstream_error, not 'failed'" \
      || fail "provider fault outcome: ${row%%|*} (want upstream_error)"
    echo "$row" | grep -qi '401\|404\|unauthorized\|api key\|rate limit\|quota\|no healthy upstream\|no longer available\|not accepted' \
      && pass "the provider's own words reach the row (the UI can show them)" \
      || fail "close_reason lost the provider error: $row"
    sent=$(echo "$row" | awk -F'|' '{print $4}')
    if [ "$sent" = "-" ]; then
      echo "   note: the sweeper had not run within ${waited}s — nothing billed yet, unverified"
    elif [ "$sent" = "0" ]; then
      pass "the platform's failure was written off at 0 seconds"
    else
      fail "a platform fault reached the invoice: metered_seconds=$sent"
    fi
  fi
fi

echo
say "8) a real A2A client speaks to this facade"
# Everything above is curl. This gate runs scripts/fixes/FleetA2AClient.ts (on
# top of @assistant-ui/react-a2a) against the live facade, because the two
# failure modes PR 2 lives or dies by are on the CLIENT side: its agent-card
# parser is strict, and a stream whose frames it cannot type throws
# "stream ended without any events" — which would look exactly like the old
# "(no output)". It also proves model choice survives the library's own call
# path, which passes metadata = void 0 and so could only ever carry the model on
# the message the client builds.
CATALOG=$(curl -s "${C[@]}" "$BASE/api/orgs/$ORG/projects/$PROJ/models" \
  | jq -r '.models[]? | select(.default == true) | .id' | head -1)
[ -n "$CATALOG" ] || CATALOG=mock
echo "   client model=$CATALOG"
node --disable-warning=ExperimentalWarning "$ROOT/scripts/fixes/t31-spa-client.ts" \
  "$API" "$TOKEN" "$CATALOG" "Reply with exactly T31-CLIENT-OK and nothing else." \
  >/tmp/t31-client.txt 2>/tmp/t31-client.err
cexit=$?
if [ "$cexit" != 0 ]; then
  fail "the A2A client could not complete a turn (exit $cexit): $(tail -3 /tmp/t31-client.err)"
else
  kv() { sed -n "s/^$1=//p" /tmp/t31-client.txt | head -1; }
  [ -n "$(kv card_name)" ] && pass "the library's strict card parser accepts our rewrite ($(kv card_name))" \
    || fail "card parse produced no name"
  [ "$(kv card_streaming)" = true ] && pass "the rewritten card still advertises streaming" \
    || fail "card streaming capability lost: $(head -c 200 /tmp/t31-client.txt)"
  kv iface | grep -q "/api/a2a/orgs/$ORG/projects/$PROJ" \
    && pass "the card the client read points at the facade" || fail "client iface: $(kv iface)"
  ev=$(kv events); [ "${ev:-0}" -ge 1 ] && pass "the client decoded $ev typed events" \
    || fail "the client decoded no events"
  case "$(kv kinds)" in
    *unknown*|'') fail "untyped frames reached the client: $(kv kinds)" ;;
    *) pass "every frame was a typed A2A event ($(kv kinds))" ;;
  esac
  case "$(kv state)" in
    completed|failed|canceled|rejected|input_required|auth_required)
      pass "the client saw the turn settle as $(kv state)" ;;
    *) fail "the client's stream never reached a settled state ($(kv state))" ;;
  esac
  # Answer TEXT needs a model that repeats the prompt back: `mock` streams, but it
  # answers with its own fixed "mock reply", so the T31-CLIENT-OK probe below can
  # only match a real model. ANSWER_MODEL names one; unset means "framing proven,
  # echoed content not".
  if [ -n "${ANSWER_MODEL:-}" ]; then
    aprobe=$(node --disable-warning=ExperimentalWarning "$ROOT/scripts/fixes/t31-spa-client.ts" \
      "$API" "$TOKEN" "$ANSWER_MODEL" "Reply with exactly T31-CLIENT-OK and nothing else." \
      | sed -n 's/^answer=//p')
    grep -q 'T31-CLIENT-OK' <<<"$aprobe" \
      && pass "the answer reached the client as content ($ANSWER_MODEL)" \
      || fail "the client never saw the answer from $ANSWER_MODEL: $aprobe"
  else
    echo "   note: answer content not asserted (ANSWER_MODEL unset — set it to a model that echoes the prompt)"
  fi
  cctx=$(kv context)
  crow=$(fp "select coalesce(model,'-') || '|' || coalesce(outcome,'NULL') from sessions where kagent_session_id = '$cctx' order by started_at desc limit 1;")
  echo "   session row: $crow"
  [ "${crow%%|*}" = "$CATALOG" ] \
    && pass "message.metadata['fleet.dev/model'] arrived through the library (model=$CATALOG)" \
    || fail "the client's model choice did not reach the session row: $crow (want $CATALOG)"
  [ "${crow##*|}" != "NULL" ] && pass "the client-driven turn settled with an outcome" \
    || fail "the client-driven turn left outcome NULL"
fi

echo
say "9) the AG-UI run endpoint carries a client-minted thread handle"
# The browser leg is AG-UI now, so this is the wire the SPA actually sits on:
# a RunAgentInput whose threadId the CLIENT invented (the app's useFleetAgUi mints
# a uuid per conversation), and the A2A turn behind the facade unchanged. It proves
# three things curl alone could not: the encoder's frames parse as AG-UI events,
# the refusal of a missing threadId is a real 400 rather than a silent merge onto
# one session, and the row records the handle the browser named — which is what
# "resume" reads back.
AGUI="$BASE/api/agui/orgs/$ORG/projects/$PROJ/agent"
uuid() { node -e 'process.stdout.write(crypto.randomUUID())'; }
AGUI_THREAD=$(uuid)
# The encoder writes data:-only frames — the event type lives inside the JSON
# (`data: ${JSON.stringify(event)}\n\n`, @ag-ui/encoder's encodeSSE) — so read
# .type rather than an event: line.
agui_run() {
  local body=$1 out=$2
  curl -sN "${C[@]}" -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
    -X POST --max-time ${STREAM_TIMEOUT:-240} -d "$body" "$AGUI" >"$out" 2>/dev/null
}
agui_types() { grep '^data:' "$1" | sed 's/^data: *//' | jq -r '.type // empty'; }

# First the refusal, because a run that silently resumed someone else's
# conversation would pass every assertion below.
code=$(curl -s -o /tmp/t31-agui-noid.json -w '%{http_code}' "${C[@]}" -H 'Content-Type: application/json' \
  -X POST --max-time 30 -d "$(jq -nc --arg t "$TEXT" '{runId:"r-1",messages:[{id:"m-1",role:"user",content:$t}]}')" "$AGUI")
reason=$(jq -r '.error.reason // empty' /tmp/t31-agui-noid.json 2>/dev/null)
[ "$code" = 400 ] && [ "$reason" = "missing_thread_id" ] \
  && pass "a run with no threadId is refused (400 missing_thread_id)" \
  || fail "threadId-less run -> $code reason=${reason:-none}: $(head -c 200 /tmp/t31-agui-noid.json)"

agui_body=$(jq -nc --arg th "$AGUI_THREAD" --arg rn "$(uuid)" --arg t "$TEXT" --arg m "$CATALOG" \
  '{threadId:$th, runId:$rn, state:{}, tools:[], context:[],
    forwardedProps:{"fleet.dev/model":$m},
    messages:[{id:"m-1",role:"user",content:$t}]}')
agui_run "$agui_body" /tmp/t31-agui.txt
types=$(agui_types /tmp/t31-agui.txt)
echo "   frames: $(echo "$types" | tr '\n' ' ')"
echo "$types" | grep -qx RUN_STARTED \
  && pass "the run opened with RUN_STARTED" \
  || fail "no RUN_STARTED head: $(head -c 200 /tmp/t31-agui.txt)"
# The client matches every frame to the run by these two handles, so an echo of
# the A2A context id instead of the client's threadId would drop the transcript.
started_thread=$(grep '^data:' /tmp/t31-agui.txt | sed 's/^data: *//' \
  | jq -r 'select(.type=="RUN_STARTED") | .threadId' | head -1)
[ "$started_thread" = "$AGUI_THREAD" ] \
  && pass "RUN_STARTED echoed the threadId the client named, not kagent's context id" \
  || fail "RUN_STARTED echoed '$started_thread' instead of the threadId we sent"
term=$(echo "$types" | grep -xE 'RUN_FINISHED|RUN_ERROR' | head -1)
if [ "$term" = RUN_FINISHED ]; then
  pass "the run settled with RUN_FINISHED"
elif [ "$term" = RUN_ERROR ]; then
  fail "the AG-UI run reported RUN_ERROR: $(grep '^data:' /tmp/t31-agui.txt | sed 's/^data: *//' | jq -r 'select(.type=="RUN_ERROR") | .message' | head -1)"
else
  fail "the stream ended without a terminal event (the client would hang)"
fi
ntext=$(echo "$types" | grep -c '^TEXT_MESSAGE_' || true)
if [ "${ntext:-0}" -ge 3 ]; then
  pass "answer text arrived as TEXT_MESSAGE_START/CONTENT/END ($ntext frames)"
else
  echo "   note: $ntext TEXT_MESSAGE_* frames — this run produced no answer text (the silent-completion case the failure notice exists for); ANSWER_MODEL asserts a generating model"
fi
if [ -n "${ANSWER_MODEL:-}" ]; then
  am_body=$(jq -nc --arg th "$(uuid)" --arg rn "$(uuid)" --arg t "$TEXT" --arg m "$ANSWER_MODEL" \
    '{threadId:$th, runId:$rn, state:{}, tools:[], context:[],
      forwardedProps:{"fleet.dev/model":$m},
      messages:[{id:"m-1",role:"user",content:$t}]}')
  agui_run "$am_body" /tmp/t31-agui-answer.txt
  grep -q 'T31-OK' /tmp/t31-agui-answer.txt \
    && pass "the answer reached the AG-UI stream ($ANSWER_MODEL)" \
    || fail "the AG-UI stream never carried the answer: $(head -c 200 /tmp/t31-agui-answer.txt)"
fi
# forwardedProps is the model channel the SPA's FleetAgUiAgent overrides
# prepareRunAgentInput to write; if it drifted, the row would name the default.
aguirow=$(fp "select coalesce(model,'-') || '|' || coalesce(outcome,'NULL') from sessions where thread_id = '$AGUI_THREAD';")
echo "   session row: $aguirow"
[ "${aguirow%%|*}" = "$CATALOG" ] \
  && pass "forwardedProps['fleet.dev/model'] arrived through the run input (model=$CATALOG)" \
  || fail "the client's model choice did not reach the session row: $aguirow (want $CATALOG)"
[ "${aguirow##*|}" != "NULL" ] \
  && pass "sessions.thread_id resolved the conversation and settled with an outcome" \
  || fail "no session row for thread_id=$AGUI_THREAD, or outcome stayed NULL"

echo
if [ "$FAILS" = 0 ]; then
  echo "t31: all facade gates passed."
  echo "MANUAL (browser, one session, 3 turns): a normal answer streams; an expired"
  echo "provider key shows its own 401 text inline with Retry (NOT '(no output)');"
  echo "a turn >60s does not 502; a requireApproval tool pauses as input-required"
  echo "and bills no think-time."
  exit 0
fi
echo "t31: $FAILS gate(s) failed."
exit 1
