#!/usr/bin/env bash
# substrate-check.sh — read-only verification of the Agent Substrate control plane,
# using only the gcloud/kubectl commands from the official install guide. No state
# is changed: nothing here creates, applies, deletes or restarts anything.
#
# Why a script and not the workflow: the installer itself (install.sh -> setup-gcp +
# ate-setup) needs Go, make and Docker and must run on a real machine (the guide
# rules out Cloud Shell), so CI stays its host. Everything AFTER the install — the
# guide's "Verify the installation" section plus the four things that decide whether
# a sandbox is ever placeable — is plain kubectl/gcloud and belongs here.
#
# Usage:
#   deploy/gcp/substrate-check.sh                 # defaults below
#   deploy/gcp/substrate-check.sh --project P --cluster C --zone Z
#   POOL=planner-pool deploy/gcp/substrate-check.sh
set -uo pipefail

PROJECT="${PROJECT:-adlc-9e72f}"
CLUSTER="${CLUSTER:-substrate-multitenant}"
ZONE="${ZONE:-asia-south1-a}"
REGION="${REGION:-asia-south1}"
POOL="${POOL:-planner-pool}"
POOL_NS="${POOL_NS:-substrate-workers}"
WORKER_NODE_POOL="${WORKER_NODE_POOL:-substrate-worker-pool}"
POSTGRES_CLAIM_GB="${POSTGRES_CLAIM_GB:-50}"
SSD_QUOTA_GB="${SSD_QUOTA_GB:-500}"

pass=0 fail=0 note=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
hint() { printf '  \033[33mHINT\033[0m %s\n' "$1"; note=$((note+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

have kubectl || { echo "kubectl is required (gcloud components install kubectl)"; exit 2; }
have gcloud  || { echo "gcloud is required"; exit 2; }

head_ "Cluster credentials"
if ! kubectl get ns >/dev/null 2>&1; then
  gcloud container clusters get-credentials "$CLUSTER" --zone "$ZONE" --project "$PROJECT" \
    || { echo "could not reach $CLUSTER"; exit 2; }
fi
echo "  context: $(kubectl config current-context)"

head_ "Guide: Verify the installation"
# kubectl get pods -n ate-system ; kubectl get pods -n podcertificate-controller-system
for ns in ate-system podcertificate-controller-system; do
  line=$(kubectl get pods -n "$ns" --no-headers 2>/dev/null |
    awk 'BEGIN{t=0;r=0} {t++; if ($3=="Running" || $3=="Completed") r++} END{printf "%d/%d", r, t}')
  case "${line:-0/0}" in
    */0)   bad "$ns: no pods — the installer has not run";;
    *)     [ "${line%/*}" = "${line#*/}" ] && ok "$ns: all pods Running ($line)" \
             || bad "$ns: $line pods Ready — a control-plane pod is down";;
  esac
done

head_ "Sandbox capacity — the four things that must line up"
# 1. A WorkerPool must EXIST. ate-setup only installs the CRD; upstream creates a
#    pool only for --demo, so a green install still schedules nothing.
pools=$(kubectl get workerpools.ate.dev -A --no-headers 2>/dev/null)
if [ -z "$pools" ]; then
  bad "WorkerPool: none exists — nothing serves actors (docs/SUBSTRATE_INTEGRATION.md §5.3)"
else
  printf '%s\n' "$pools" | while read -r _ ns name rest; do
    [ -n "${name:-}" ] || continue
    echo "  pool: $ns/$name $rest"
  done
  if printf '%s\n' "$pools" | grep -qw "$POOL"; then
    ready=$(kubectl get workerpools.ate.dev -n "$POOL_NS" "$POOL" \
      -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
    want=$(kubectl get workerpools.ate.dev -n "$POOL_NS" "$POOL" \
      -o jsonpath='{.spec.replicas}' 2>/dev/null)
    if [ -n "${ready:-}" ] && [ "$ready" -gt 0 ] 2>/dev/null; then
      ok "WorkerPool $POOL: $ready/$want replicas ready"
    else
      bad "WorkerPool $POOL: 0/$want ready — workers are Pending (see placement below)"
    fi
  else
    bad "WorkerPool: the planner selects '$POOL' and no pool of that name exists"
  fi
fi

# 2. The worker node pool's taint must be one atelet tolerates.
taints=$(gcloud container node-pools describe "$WORKER_NODE_POOL" \
  --cluster="$CLUSTER" --zone="$ZONE" --project="$PROJECT" \
  --format="json(config.taints)" 2>/dev/null | jq -r '[.config.taints[]?.key] | join(" ")')
atelet_tol=$(kubectl get ds atelet -n ate-system \
  -o jsonpath='{.spec.template.spec.tolerations[*].key}' 2>/dev/null)
if [ -z "$taints" ]; then
  hint "node pool $WORKER_NODE_POOL carries no taint (a dedicated pool should be tainted ate.dev/sandboxClass=gvisor)"
else
  bad_key=""
  for k in $taints; do
    case " $atelet_tol " in
      *" $k "*) : ;;
      *) bad_key="$bad_key $k" ;;
    esac
  done
  if [ -n "$bad_key" ]; then
    bad "taint tolerated by nothing:$bad_key — atelet cannot run on these nodes, so no sandbox is placeable (atelet tolerates: $atelet_tol)"
  else
    ok "taint is tolerated by atelet ($taints)"
  fi
fi

# 3. Nodes must actually exist in the worker pool. Capacity is demand-driven: the
#    WorkerPool's worker pods are the only thing that pulls the pool off zero.
nodes=$(kubectl get nodes -l "cloud.google.com/gke-nodepool=$WORKER_NODE_POOL" \
  --no-headers 2>/dev/null | awk '$2=="Ready"' | wc -l | tr -d ' ')
if [ "${nodes:-0}" -gt 0 ]; then
  ok "$WORKER_NODE_POOL: $nodes Ready node(s)"
  # Compare by node NAME: a node's name is a truncated MIG name
  # (gke-<cluster>-substrate-worker-1b371960-mvvb), not the pool name, so a
  # substring match on the pool name never hits.
  worker_nodes=$(kubectl get nodes -l "cloud.google.com/gke-nodepool=$WORKER_NODE_POOL" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null)
  atelet_nodes=$(kubectl get pods -n ate-system -l app=atelet \
    -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' 2>/dev/null)
  missing=""
  for n in $worker_nodes; do
    printf '%s\n' "$atelet_nodes" | grep -qx "$n" || missing="$missing $n"
  done
  if [ -n "$missing" ]; then
    bad "no atelet pod on:$missing — atelet is repelled by the taint or filtered by a selector, so no sandbox can be created on that node"
  else
    ok "atelet runs on every worker node"
  fi
else
  bad "$WORKER_NODE_POOL: 0 Ready nodes — pending worker pods are what force the autoscaler to add one"
fi

# 4. Regional disk quota. pd-balanced and pd-ssd — which is what the bundled
#    postgres claim is (dynamic-rwo provisions pd-balanced here) — bill against one
#    shared SSD_TOTAL_GB limit, and that is how the old 500Gi claim starved every
#    other disk. Hyperdisk does not: measured 2026-11-10, a 100 GB hyperdisk-balanced
#    worker boot disk left SSD_TOTAL_GB at 50/500, and asia-south1 reports no
#    Hyperdisk capacity quota among its 113 regional metrics.
usage=$(gcloud compute regions describe "$REGION" --project="$PROJECT" \
  --format="json(quotas)" | jq -r '.quotas[] | select(.metric=="SSD_TOTAL_GB") | .usage' 2>/dev/null)
limit=$(gcloud compute regions describe "$REGION" --project="$PROJECT" \
  --format="json(quotas)" | jq -r '.quotas[] | select(.metric=="SSD_TOTAL_GB") | .limit' 2>/dev/null)
read -r max_nodes disk_gb disk_type machine_type <<<"$(gcloud container node-pools describe \
  "$WORKER_NODE_POOL" --cluster="$CLUSTER" --zone="$ZONE" --project="$PROJECT" \
  --format="value(autoscaling.maxNodeCount,config.diskSizeGb,config.diskType,config.machineType)" 2>/dev/null)"
# Compute refuses these series for EVERY Persistent Disk type, and it does so when
# the MIG creates the instance — after `node-pools update` and `terraform apply` have
# both reported success. The visible symptom is a pool that keeps its old template.
case "${machine_type}" in
  n4*|c4*|m4*|x4*|g4*|a4*|a5*|h4d*)
    case "${disk_type}" in
      pd-*) bad "$machine_type supports no Persistent Disk: $disk_type is refused at instance creation — use hyperdisk-balanced" ;;
      *) ok "worker nodes are $machine_type on ${disk_type:-unknown} (that series has no Persistent Disk option)" ;;
    esac ;;
  *) [ -n "${machine_type:-}" ] && ok "worker nodes are $machine_type on ${disk_type:-unknown}" ;;
esac
if [ -z "${usage:-}" ]; then
  hint "SSD_TOTAL_GB: could not read the regional quota"
else
  case "${disk_type:-}" in
    hyperdisk-*)
      # The usage on this line is every PD-type disk in the region — the postgres
      # claim today, plus any substrate-snapshot PV once actors snapshot (that
      # StorageClass is pd-balanced), but never the worker boot disks.
      ok "SSD_TOTAL_GB: ${usage%.*}/${limit%.*} used, by PD-type disks only; $disk_type worker disks do not bill against it" ;;
    pd-standard)
      ok "worker boot disks are pd-standard (billed against DISKS_TOTAL_GB, not SSD_TOTAL_GB)" ;;
    *)
      left=$(( ${limit%.*} - ${usage%.*} ))
      need=$(( ${max_nodes:-0} * ${disk_gb:-0} ))
      if [ "$left" -ge "$need" ]; then
        ok "SSD_TOTAL_GB: ${usage%.*}/${limit%.*} used, $left GB free, worker pool needs $need GB ($max_nodes x $disk_gb $disk_type)"
      else
        bad "SSD_TOTAL_GB: ${usage%.*}/${limit%.*} used, $left GB free < the $need GB this pool can request ($max_nodes x $disk_gb) — nodes fail to provision with a quota error"
      fi ;;
  esac
fi

head_ "Bundled postgres claim"
claim=$(kubectl get pvc data-postgres-0 -n ate-system \
  -o jsonpath='{.status.capacity.storage}' 2>/dev/null)
case "${claim:-}" in
  "") bad "ate-system/data-postgres-0 is missing";;
  ${POSTGRES_CLAIM_GB}Gi) ok "data-postgres-0 is $claim";;
  *) bad "data-postgres-0 is $claim, wants ${POSTGRES_CLAIM_GB}Gi — the install deletes the claim and its atespace/actor metadata";;
esac

head_ "Control-plane schema"
# ate-api-server applies PostgreSQL migrations ONLY at startup ("PostgreSQL
# migrations ready" in its first log lines). Recreating the database under a
# running API server — which is exactly what the 50Gi claim rewrite does — leaves
# every table missing while all pods stay Running: workers cannot register, and
# the symptom is a run queue that never drains with an otherwise healthy control
# plane. No check above catches that; this one does.
if kubectl -n ate-system logs deploy/ate-api-server --tail=500 2>&1 |
   grep -q 'relation "workers" does not exist'; then
  bad "ate-api-server is talking to an unmigrated database — kubectl -n ate-system rollout restart deploy/ate-api-server"
else
  ok "ate-api-server sees its schema (no missing-relation errors in recent logs)"
fi

head_ "Worker registration"
# A worker is Ready only after it acquired an epoch from ateapi, which needs the
# schema above. readyReplicas=0 with pods Running is the signature of the two
# failures before it, not of a scheduling problem.
reg=$(kubectl -n substrate-workers get pods -l "ate.dev/worker-pool=$POOL" --no-headers 2>/dev/null |
  awk 'BEGIN{t=0;r=0} {t++; if ($2 ~ /^1\//) r++} END{printf "%d/%d", r, t}')
case "${reg:-0/0}" in
  0/0) hint "no worker pods at all in $POOL_NS/$POOL";;
  *)   [ "${reg%/*}" = "${reg#*/}" ] && ok "workers registered ($reg Ready)" \
         || bad "workers Running but not Ready ($reg) — they never acquired an epoch from ateapi";;
esac

head_ "Actor data plane"
if kubectl get httproute -n ate-system >/dev/null 2>&1; then
  programmed=$(kubectl get gateway -n ate-system -o jsonpath='{range .items[*]}{.metadata.name}={.status.conditions[?(@.type=="Programmed")].status}{"\n"}{end}' 2>/dev/null | tr '\n' ' ')
  [ -n "$programmed" ] && ok "gateway conditions: $programmed" || hint "no Gateway objects in ate-system"
  # A Route is Accepted even when its backendRef names a Service that does not
  # exist: the gateway takes the object, Envoy has nowhere to send the traffic,
  # and every call through that path prefix fails while the front reports itself
  # healthy. The public ateapi route sat like that for a week — it referenced
  # ate-system/ateapi, and the Service `ate-setup` actually creates is named api.
  for r in $(kubectl get httproute -n ate-system -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null); do
    st=$(kubectl get httproute -n ate-system "$r" \
      -o jsonpath='{.status.parents[*].conditions[?(@.type=="ResolvedRefs")].status}' 2>/dev/null)
    if [ "${st:-}" = "True" ]; then
      ok "route $r resolves its backend"
    else
      msg=$(kubectl get httproute -n ate-system "$r" \
        -o jsonpath='{.status.parents[*].conditions[?(@.type=="ResolvedRefs")].message}' 2>/dev/null)
      bad "route $r does not resolve: ${msg:-no ResolvedRefs condition} — the front accepts the connection and has nowhere to send it"
    fi
  done
else
  hint "no HTTPRoute CRDs reachable — the substrate ingress front is not installed"
fi

head_ "kubectl ate (optional, needs Go)"
if have kubectl-ate || kubectl ate --help >/dev/null 2>&1; then
  ok "kubectl ate is installed — 'kubectl ate get actors' reads actors straight from ateapi"
else
  hint "install it to read actors/workers: brew install go && git clone --depth 1 --branch v1.0.0 https://github.com/agent-substrate/substrate.git /tmp/substrate && (cd /tmp/substrate && go install ./cmd/kubectl-ate)"
  hint "the guide runs the installer locally for exactly this reason; Go, make and Docker are prerequisites, and Cloud Shell is excluded (5 GB disk)"
fi

printf '\n\033[1m%s\033[0m  %d passed, %d failed, %d hints\n' "summary" "$pass" "$fail" "$note"
[ "$fail" -eq 0 ] || exit 1
