#!/usr/bin/env bash
# Guard the otel-system telemetry contract that actor-session billing reads, and
# keep the two ConfigMaps it depends on in the repo instead of only in the cluster.
#
# Why a guard and not an installer: inventorying kind-kind (see
# docs/SUBSTRATE_METRICS.md) found the cluster already runs everything the
# duration-based actor model needs — a Prometheus, a collector with a metrics
# pipeline, and per-atespace CPU from the substrate control plane. node-exporter,
# kube-state-metrics, cAdvisor and OpenCost are all absent and stay absent on
# purpose, because the model bills session seconds and not measured cpu/mem
# hours. So there is nothing to install here; what exists instead is the risk
# that the two contracts below change under us.
#
# The two contracts, both of which fail silently rather than loudly:
#
#   1. The otel-collector-self job ends in a `keep` on (substrate|otelcol)_.* .
#      Prometheus anchors a keep regex fully, so a metric named agent_substrate_*
#      is accepted over OTLP (HTTP 200, and it even increments
#      substrate_datapoints_total) and is then dropped at scrape time. The series
#      simply never exists.
#   2. The kubernetes-pods job discovers pods in two namespaces only, and keeps
#      them only with the prometheus.io/scrape annotation. Anything we want
#      scraped must live in ate-system or otel-system.
#
# Modes:
#   (default)   verify everything, install nothing, exit non-zero on a broken contract
#   --dry-run   verify, then rehearse --apply for real (server-side dry run + the
#               exact rollout it would perform) without mutating the cluster
#   --apply     push the in-tree ConfigMaps into the cluster and roll the pods
#   --snapshot  rewrite the in-tree ConfigMaps from the live cluster
#   --report    print the install/skip decision table and stop
set -uo pipefail

CTX="${KUBE_CONTEXT:-kind-kind}"
NS="otel-system"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KUSTOMIZE_DIR="$HERE/deploy/flexprice/kind"
PROM_LOCAL_PORT="${PROM_LOCAL_PORT:-19091}"

PROM_FILE="deploy/flexprice/kind/prometheus-configmap.yaml"
COL_FILE="deploy/flexprice/kind/otel-collector-configmap.yaml"

mode=verify
for a in "$@"; do
  case "$a" in
    --apply) mode=apply ;;
    --dry-run) mode=dryrun ;;
    --snapshot) mode=snapshot ;;
    --report) mode=report ;;
    -h|--help) sed -n '2,32p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown flag: $a (see --help)" >&2; exit 2 ;;
  esac
done

fails=0
ok()   { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }
note() { printf '  note  %s\n' "$1"; }

# norm — compare text with one trailing newline, so "no trailing newline from
# kubectl" never reads as a change.
norm() { printf '%s\n' "$(cat)"; }

# ---- YAML helpers (the repo already depends on `yaml`, so no new tooling) ----
# data_key <file> <key>  -> the block-scalar contents, verbatim
data_key() {
  node -e '
    const YAML = require("yaml");
    const fs = require("fs");
    const doc = YAML.parse(fs.readFileSync(process.argv[1], "utf8"));
    const v = doc && doc.data && doc.data[process.argv[2]];
    if (typeof v !== "string") { console.error("missing key " + process.argv[2]); process.exit(3); }
    process.stdout.write(v.endsWith("\n") ? v : v + "\n");
  ' "$1" "$2"
}

# emit_manifest <cm-name> <key> <header>  <- config text on stdin
emit_manifest() {
  node -e '
    const fs = require("fs");
    const [name, key, headerRaw] = process.argv.slice(1);
    let body = fs.readFileSync(0, "utf8");
    if (!body.endsWith("\n")) body += "\n";
    // A header without its own trailing newline would comment out apiVersion,
    // which the api server then rejects as "apiVersion not set".
    const header = headerRaw.replace(/\n+$/, "") + "\n";
    const indented = body.replace(/\n$/, "").split("\n")
      .map((l) => (l.trim() ? "    " + l : "")).join("\n");
    fs.writeFileSync(process.env.OUT,
      header + "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: " + name +
      "\n  namespace: otel-system\ndata:\n  " + key + ": |\n" + indented + "\n");
  ' "$1" "$2" "$3"
}

live_cm() { kubectl --context "$CTX" -n "$NS" get "cm/$1" -o "jsonpath={.data.$2}" 2>/dev/null; }

report() {
  cat <<'EOF'
== what the local telemetry stack does and does not run ==

Installed and reused (digest-pinned in the pod spec):
  prometheus                    prom/prometheus:v3.15.1        plain Deployment + ConfigMap
  opentelemetry-collector       otel/opentelemetry-collector-contrib:0.163.2
  jaeger                        (traces only; billing does not read it)
  ate-system pods on :9090      ate_actor_stats_*, ate_actor_lifecycle_*, ate_workerpool_workers

Deliberately NOT installed — each is a decision, and docs/SUBSTRATE_METRICS.md
section 6 is the restart point if the requirement changes:
  node-exporter        node cpu/ram is not a billing input for duration x tier
  kube-state-metrics   would need it for pod attribution, but actors are not pods
                       (only csidriverconfigs/sandboxconfigs/workerpools on ate.dev)
  cAdvisor standalone  ate_actor_stats_* already reads gVisor cgroups, which is
                       closer to what an actor burnt than cadvisor's pod view
  OpenCost             allocates shared-infrastructure cost; there is nothing to allocate
  kubelet :10250       not scraped; not required by the chosen model, left untested

Emitted by us, into the collector that already exists (no new scrape target):
  substrate_actor_start_timestamp_seconds
  substrate_actor_first_seen_timestamp_seconds
  substrate_actor_running_seconds_total
EOF
}

snapshot() {
  printf '== snapshotting %s ConfigMaps into %s ==\n' "$NS" "deploy/flexprice/kind"
  OUT="$HERE/$PROM_FILE" emit_manifest prometheus-config "prometheus.yml" \
    "# Snapshot of otel-system/prometheus-config, captured from the live cluster.
# See deploy/flexprice/kind/README.md for what billing depends on here.
#
# Generated, not hand-maintained: scripts/kind-metrics-install.sh --snapshot
# rewrites this file from the cluster. The default verify mode fails when this
# file and the cluster disagree, so drift is an error rather than a fork.
#" <<< "$(live_cm prometheus-config 'prometheus\.yml')"
  OUT="$HERE/$COL_FILE" emit_manifest opentelemetry-collector-config "otel-collector-config.yaml" \
    "# Snapshot of otel-system/opentelemetry-collector-config, captured from the
# live cluster. See deploy/flexprice/kind/README.md.
#
# Generated, not hand-maintained: scripts/kind-metrics-install.sh --snapshot.
#" <<< "$(live_cm opentelemetry-collector-config 'otel-collector-config\.yaml')"
  ok "wrote $PROM_FILE"
  ok "wrote $COL_FILE"

  # Prove the snapshot before trusting it: each file must parse as a ConfigMap
  # whose data round-trips to exactly what the cluster holds. A snapshot that
  # silently lost its apiVersion, or that the YAML parser flattens into the
  # document root, would otherwise only be noticed at --apply time.
  local triple
  for triple in "$PROM_FILE:prometheus-config:prometheus.yml" "$COL_FILE:opentelemetry-collector-config:otel-collector-config.yaml"; do
    local f="${triple%%:*}"
    local r="${triple#*:}"
    local n="${r%%:*}"
    local k="${r#*:}"
    local shape
    shape=$(node -e '
      const YAML = require("yaml"), fs = require("fs");
      const d = YAML.parse(fs.readFileSync(process.argv[1], "utf8"));
      const out = [d.apiVersion || "MISSING-apiVersion", d.kind || "MISSING-kind",
                   (d.metadata && d.metadata.name) || "MISSING-name",
                   d.data && typeof d.data[process.argv[2]] === "string" ? "data-ok" : "MISSING-data"];
      console.log(out.join(" "));
    ' "$HERE/$f" "$k" 2>&1)
    if [ "$shape" = "v1 ConfigMap $n data-ok" ]; then
      if diff -q <(live_cm "$n" "${k//./\\.}" | norm) <(data_key "$HERE/$f" "$k" | norm) >/dev/null 2>&1; then
        ok "$f: valid ConfigMap, content identical to the cluster"
      else
        bad "$f: parses, but its content differs from the cluster it was just taken from"
      fi
    else
      bad "$f: malformed manifest ($shape)"
    fi
  done
}

verify() {
  printf '== kind metrics contract (context: %s) ==\n' "$CTX"

  if ! kubectl --context "$CTX" get ns "$NS" >/dev/null 2>&1; then
    bad "namespace $NS not reachable on context $CTX (is the kind cluster up?)"
    return
  fi
  ok "context $CTX, namespace $NS"

  local ready
  ready=$(kubectl --context "$CTX" -n "$NS" get deploy \
    -o jsonpath='{range .items[*]}{.metadata.name}={.status.readyReplicas}{" "}{.spec.replicas}{"\n"}{end}' 2>/dev/null)
  local notready
  notready=$(awk '{split($0,a,"="); split(a[2],r," "); if (r[1]+0 < r[2]+0) print a[1]}' <<< "$ready")
  if [ -z "$notready" ]; then
    ok "deployments ready: $(tr '\n' ' ' <<< "$ready")"
  else
    bad "deployments not ready: $notready"
  fi

  # -- the two in-tree manifests must equal the live ones
  local pair drift=""
  for pair in "prometheus-config:prometheus\.yml:$PROM_FILE:prometheus.yml" \
              "opentelemetry-collector-config:otel-collector-config\.yaml:$COL_FILE:otel-collector-config.yaml"; do
    local cm key file want have
    cm="${pair%%:*}"; pair="${pair#*:}"; key="${pair%%:*}"; pair="${pair#*:}"; file="${pair%%:*}"; want_key="${pair#*:}"
    if [ ! -f "$HERE/$file" ]; then bad "$file missing from the repo"; continue; fi
    have=$(data_key "$HERE/$file" "$want_key" 2>/dev/null) || { bad "$file unreadable"; continue; }
    want=$(live_cm "$cm" "$key")
    if [ "$(printf '%s\n' "$have" | norm)" = "$(printf '%s\n' "$want" | norm)" ]; then
      ok "$cm matches the in-tree copy"
    else
      bad "$cm differs from $file (cluster: hand-patched? repo: stale?) — --snapshot or --apply"
      drift="$drift $file"
    fi
  done

  # -- contract 1: the keep regex must still cover the names we emit
  local prom_live col_live
  prom_live=$(live_cm prometheus-config 'prometheus\.yml')
  col_live=$(live_cm opentelemetry-collector-config 'otel-collector-config\.yaml')

  local keep_line
  keep_line=$(grep -n 'regex: (substrate|otelcol)_.\*' <<< "$prom_live" | head -1 | cut -d: -f1)
  if [ -z "$keep_line" ]; then
    note "no (substrate|otelcol)_.* keep filter on the collector job — every collector metric now reaches Prometheus"
    note "that is harmless for the names we emit, but check nothing re-exports the ate-system 9090 series twice (sum() would double)"
  else
    ok "collector job still keeps (substrate|otelcol)_.*  [prometheus.yml:$keep_line]"
  fi

  # -- contract 2: namespace allowlist
  if grep -q 'ate-system' <<< "$prom_live"; then
    ok "kubernetes-pods discovery still covers ate-system (source of ate_actor_stats_*)"
  else
    bad "ate-system dropped from the kubernetes-pods namespace allowlist — the reconciliation oracle goes dark"
  fi

  # -- the names we emit must satisfy whatever filter is in force
  local badname
  badname=$(node -e '
    const { ACTOR_SESSION_METRICS } = require("./packages/shared-core/src/billing/substrate-session.js");
    const bad = Object.entries(ACTOR_SESSION_METRICS).filter(([, n]) => !/^(substrate|otelcol)_/.test(n));
    if (bad.length) console.log(bad.map(([k, n]) => k + "=" + n).join(" "));
  ' 2>&1)
  if [ -z "$badname" ]; then
    ok "ACTOR_SESSION_METRICS all match ^(substrate|otelcol)_ (the scrape filter)"
  else
    bad "metric name would be dropped at scrape time: $badname"
  fi

  # -- collector actually exports to the port Prometheus reads
  if grep -q 'endpoint: 0.0.0.0:8889' <<< "$col_live" && grep -q 'exporters: \[prometheus, debug\]' <<< "$col_live"; then
    ok "collector metrics pipeline exports to :8889"
  else
    bad "collector no longer exports its metrics endpoint where Prometheus scrapes it"
  fi

  # -- live proof that the scrape path is alive right now
  kubectl --context "$CTX" -n "$NS" port-forward svc/prometheus "$PROM_LOCAL_PORT:9090" \
    >/tmp/fleet-metrics-pf.log 2>&1 &
  local pf=$!
  # disown so bash job control does not print "Terminated: 15" when the trap
  # below kills it; the pid is still killable, it is just no longer a job.
  disown "$pf" 2>/dev/null || true
  trap 'kill '"$pf"' >/dev/null 2>&1' RETURN
  sleep 3
  local up
  up=$(curl -s --max-time 8 "http://localhost:$PROM_LOCAL_PORT/api/v1/query" \
        --data-urlencode 'query=count(up{job="otel-collector-self"} == 1)' | node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const r=JSON.parse(d).data.result;console.log(r.length?r[0].value[1]:"0")}catch(e){console.log("ERR")}})')
  if [ "$up" = "2" ]; then
    ok "both collector scrape targets are up (8888 self-metrics, 8889 exported metrics)"
  else
    bad "expected 2 up targets on job otel-collector-self, got $up — see /tmp/fleet-metrics-pf.log"
  fi

  local ate
  ate=$(curl -s --max-time 8 "http://localhost:$PROM_LOCAL_PORT/api/v1/query" \
        --data-urlencode 'query=count(count by (ate_template_atespace) (ate_actor_stats_cpu_time_seconds_total))' | node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const r=JSON.parse(d).data.result;console.log(r.length?r[0].value[1]:"0")}catch(e){console.log("ERR")}})')
  if [ "${ate:-0}" != "0" ] && [ "$ate" != "ERR" ]; then
    ok "ate_actor_stats_* present for $ate atespace(s) — the reconciliation oracle has a source"
  else
    note "no ate_actor_stats_* series yet: the substrate control plane has sampled no actors in this cluster"
  fi

  printf '\n'
  if [ "$fails" -gt 0 ]; then
    printf 'FAIL: %d contract check(s) broken. Do not bill on this cluster until they pass;\n' "$fails"
    printf 'a dropped metric series looks identical to an actor that never ran.\n'
    return 1
  fi
  printf 'All contracts hold. For the end-to-end OTLP->scrape->PromQL proof run:\n'
  printf '  ./scripts/kind-otel-roundtrip.sh\n'
}

apply() {
  printf '== applying %s ==\n' "$KUSTOMIZE_DIR"
  kubectl --context "$CTX" apply -k "$KUSTOMIZE_DIR" || { bad "kubectl apply failed"; return 1; }
  # The ConfigMaps are mounted, not read once at startup, so a changed key needs
  # a restart to take effect; a rollout is what actually makes the config live.
  kubectl --context "$CTX" -n "$NS" rollout restart deploy/prometheus deploy/opentelemetry-collector
  kubectl --context "$CTX" -n "$NS" rollout status deploy/prometheus --timeout=120s
  kubectl --context "$CTX" -n "$NS" rollout status deploy/opentelemetry-collector --timeout=120s
  ok "config live; re-verifying"
  verify
}

dryrun() {
  printf '== dry run: what --apply would change (cluster untouched) ==\n'
  verify || note "verify already reported problems; the rehearsal below assumes them fixed"
  local pair file rest cm key
  for pair in "$PROM_FILE:prometheus-config:prometheus.yml" "$COL_FILE:opentelemetry-collector-config:otel-collector-config.yaml"; do
    file="${pair%%:*}"; rest="${pair#*:}"; cm="${rest%%:*}"; key="${rest#*:}"
    # kubectl's jsonpath prints no trailing newline while data_key adds one, so
    # both sides go through norm before diffing, or every file reads as changed.
    if ! [ -f "$HERE/$file" ]; then bad "$file missing from the repo"; continue; fi
    if diff -q <(live_cm "$cm" "${key//./\\.}" | norm) <(data_key "$HERE/$file" "$key" | norm) >/dev/null 2>&1; then
      ok "$file -> $cm: no change"
    else
      note "$file -> $cm: WOULD REWRITE, then rollout restart deploy/${cm%-config}"
      diff -u <(live_cm "$cm" "${key//./\\.}" | norm) <(data_key "$HERE/$file" "$key" | norm) | head -40
    fi
  done
  printf '\n  server-side validation (api server parses and admits the objects, then discards them):\n'
  if kubectl --context "$CTX" apply --dry-run=server -k "$KUSTOMIZE_DIR" >/dev/null 2>&1; then
    ok "manifests admitted by the api server"
  else
    bad "api server rejected the manifests"
  fi
  printf '\n  then it would run: kubectl -n %s rollout restart deploy/prometheus deploy/opentelemetry-collector\n' "$NS"
  printf '  (mounted ConfigMap, so without the rollout the new config is not live)\n'
}

case "$mode" in
  report)  report ;;
  snapshot) snapshot ;;
  verify)  verify ;;
  apply)   apply ;;
  dryrun)  dryrun ;;
esac
exit "$fails"
