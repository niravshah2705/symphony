#!/usr/bin/env bash
# Prove the actor-session metrics path end to end on the local kind cluster:
# OTLP push -> otel-system collector -> prometheus scrape -> PromQL accrual.
#
# It exists because of a trap found while inventorying the cluster: the
# otel-collector-self scrape job keeps only metrics matching
# (substrate|otelcol)_.* , and Prometheus anchors that regex fully, so a
# metric named agent_substrate_* is accepted by the collector (it shows up in
# substrate_datapoints_total) and then silently dropped at scrape time. A
# missing billing series with no error is the failure mode this checks for.
#
# Read-mostly: the only mutation is one synthetic OTLP datapoint per run, from
# service.name=fleet-billing-probe, which no product code path emits.
set -uo pipefail

CTX="${KUBE_CONTEXT:-kind-kind}"
PROM_LOCAL_PORT="${PROM_LOCAL_PORT:-19090}"
OTLP_LOCAL_PORT="${OTLP_LOCAL_PORT:-14318}"
NS="otel-system"
ORG="org-probe"
TIER="standard-1v1g"

pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" >/dev/null 2>&1; done; }
trap cleanup EXIT

start_pf() { # start_pf <svc> <local:remote> <logfile>
  kubectl --context "$CTX" -n "$NS" port-forward "svc/$1" "$2" >"$3" 2>&1 &
  pids+=($!)
}

prom() { curl -s --max-time 10 "http://localhost:$PROM_LOCAL_PORT/api/v1/query" --data-urlencode "query=$1"; }

jsonq() { # jsonq <node-expr-on-parsed-body>
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let j;try{j=JSON.parse(d)}catch(e){console.log("PARSE_FAIL:",d.slice(0,200));return}const r=(j.data&&j.data.result)||[];'"$1"'})'
}

echo "== kind actor-session metrics round trip (context: $CTX) =="
start_pf prometheus "$PROM_LOCAL_PORT:9090" /tmp/fleet-probe-prom.log
start_pf opentelemetry-collector "$OTLP_LOCAL_PORT:4318" /tmp/fleet-probe-otlp.log
sleep 4

NOW=$(date +%s)
TSN="${NOW}000000000"
push() { # push <metric-name> <kind> <value>
  curl -s --max-time 10 -o /tmp/fleet-probe-out -w '%{http_code}' \
    -XPOST "http://localhost:$OTLP_LOCAL_PORT/v1/metrics" \
    -H 'Content-Type: application/json' \
    -d "{\"resourceMetrics\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"fleet-billing-probe\"}}]},\"scopeMetrics\":[{\"scope\":{\"name\":\"fleet.probe\"},\"metrics\":[{\"name\":\"$1\",\"$2\":{\"dataPoints\":[{\"attributes\":[{\"key\":\"agent_id\",\"value\":{\"stringValue\":\"probe-$NOW\"}},{\"key\":\"substrate_tier\",\"value\":{\"stringValue\":\"$TIER\"}},{\"key\":\"fleet_org_id\",\"value\":{\"stringValue\":\"$ORG\"}}],\"asDouble\":$3,\"timeUnixNano\":\"$TSN\"}]}}]}]}]}"
}

verdict() { printf '  %-58s %s\n' "$1" "$2"; }

# 1. The control case: a name that does NOT satisfy the keep regex.
code=$(push "agent_substrate_start_timestamp_seconds" gauge "$NOW")
echo "[1] push agent_substrate_* (house name the reference formula uses) -> HTTP $code"

# 2. The candidate fix: the cluster's own substrate_* naming convention.
code=$(push "substrate_actor_start_timestamp_seconds" gauge "$NOW")
echo "[2] push substrate_actor_start_timestamp_seconds -> HTTP $code"

echo "    waiting for one scrape interval (15s) + margin..."
sleep 22

echo "[3] scrape-filter behaviour"
# NOTE on the label filter: the collector's prometheus exporter writes the
# OTel resource service.name as a `job` label, and Prometheus overwrites
# `job` with the scrape job's own name, renaming the original to
# `exported_job`. So a pushed metric carries NO service_name label, while the
# count connector's series do (it sets it as an attribute). Filter on our own
# attribute (fleet_org_id) instead, or the query returns nothing and the
# metric looks missing when it is present.
a_name='agent_substrate_start_timestamp_seconds'
b_name='substrate_actor_start_timestamp_seconds'
a=$(prom "{__name__=\"$a_name\",fleet_org_id=\"$ORG\"}" | jsonq 'console.log(r.length)')
b=$(prom "{__name__=\"$b_name\",fleet_org_id=\"$ORG\"}" | jsonq 'console.log(r.length)')
accepted=$(prom 'substrate_datapoints_total{service_name="fleet-billing-probe"}' | jsonq 'console.log(r.length?Number(r[0].value[1]):0)')
if [ "${a:-0}" -gt 0 ]; then a_seen=YES; else a_seen='NO - dropped at scrape time'; fi
if [ "${b:-0}" -gt 0 ]; then b_seen=YES; else b_seen='NO - dropped at scrape time'; fi
verdict "collector accepted our datapoints (substrate_datapoints_total)" "$accepted"
verdict "$a_name visible in prometheus" "$a_seen"
verdict "$b_name visible in prometheus" "$b_seen"
if [ "${b:-0}" -gt 0 ]; then
  verdict "naming contract" "actor-session metrics MUST be named substrate_* (or otelcol_*)"
else
  verdict "naming contract" "UNRESOLVED - substrate_actor_* also absent; inspect the collector metrics pipeline"
fi

echo "[4] live accrual for a session with no STOP (the reference formula, minus the rate)"
prom "(time() - max by (substrate_tier,fleet_org_id) (substrate_actor_start_timestamp_seconds{fleet_org_id=\"$ORG\"} > 0))" \
  | jsonq 'if(!r.length){console.log("  (no series)")}else{r.forEach(s=>console.log("  ",JSON.stringify(s.metric),"accrued_sec =",Number(s.value[1]).toFixed(1)))}'

echo "[5] what the substrate control plane already publishes (do not re-emit)"
for q in 'count(ate_actor_stats_cpu_time_seconds_total)' 'sum by (ate_template_atespace) (increase(ate_actor_stats_cpu_time_seconds_total[1h]))' 'count(substrate_actor_state_changes_total)' 'sum by (ate_worker_state) (ate_workerpool_workers)'; do
  printf '  %-72s ' "$q"
  prom "$q" | jsonq 'if(!r.length){console.log("(no series yet)")}else{console.log(r.map(s=>(s.metric.ate_template_atespace||s.metric.ate_worker_state||"")+"="+Number(s.value[1]).toFixed(2)).join(" "))}'
done

echo
echo "Readiness of the two jobs that matter for billing:"
prom 'up' | jsonq 'r.forEach(s=>console.log("  ",s.metric.job,s.metric.instance,s.value[1]))'
