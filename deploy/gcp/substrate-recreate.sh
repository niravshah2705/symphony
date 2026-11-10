#!/usr/bin/env bash
# substrate-recreate.sh — bring the substrate back after the node pools are gone.
#
# Why a script and not `terraform apply`: the pools were removed out from under the
# state (Console deletes), so the only two ways back are an apply that has to
# re-create three pools plus every k8s object, or this: plain gcloud + kubectl, the
# same commands from docs.cloud.google.com/kubernetes-engine/ai-ml/install-overview-substrate,
# which can run while CI is its host. A later `terraform apply` still works — pool
# identity is the API URL, so refresh adopts what this script created instead of
# colliding with it.
#
# Config precedence, printed on every run so a restore is never a guess:
#   1. --snapshot=<path|gs://uri>  the pools.json written by substrate-cleanup.sh
#   2. .substrate-state/pools.json  the local mirror of the last cleanup
#   3. the DEFAULTS below, which mirror deploy/gcp/terraform-substrate-gke/
# If (3) is used the script says so, because the module is then the only place the
# numbers are right — keep the two in sync or stop using this script.
#
# Usage:
#   deploy/gcp/substrate-recreate.sh                 # worker + system pools
#   deploy/gcp/substrate-recreate.sh --with-primary  # also the tenant pool (2 nodes)
#   deploy/gcp/substrate-recreate.sh --dry-run       # print, change nothing
#   deploy/gcp/substrate-recreate.sh --snapshot=gs://BUCKET/CLUSTER/STAMP
#   SNAPSHOT=/tmp/pools.json deploy/gcp/substrate-recreate.sh
set -uo pipefail

PROJECT="${PROJECT:-adlc-9e72f}"
CLUSTER="${CLUSTER:-substrate-multitenant}"
ZONE="${ZONE:-asia-south1-a}"
POOL_NS="${POOL_NS:-substrate-workers}"
SNAPSHOT="${SNAPSHOT:-.substrate-state/pools.json}"
WITH_PRIMARY=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --with-primary) WITH_PRIMARY=1 ;;
    --dry-run)      DRY_RUN=1 ;;
    --snapshot=*)   SNAPSHOT="${arg#*=}" ;;
    *) echo "unknown argument: $arg (expected --snapshot=<path|gs://uri>, --with-primary or --dry-run)"; exit 2 ;;
  esac
done

# A gs:// URI is where the snapshot actually lives — substrate-cleanup.sh uploads it
# from whatever machine ran the teardown, which is usually not this one. Stage it
# locally instead of asking the operator to remember a manual copy step, and say so
# loudly if the fetch fails: silently dropping to baked-in defaults is how a restore
# ends up re-guessing the hyperdisk/IOPS values that took three attempts to get right.
if [ "${SNAPSHOT#gs://}" != "$SNAPSHOT" ]; then
  base="${SNAPSHOT%/}"
  case "$base" in
    */pools.json) src="$base" ;;
    *)            src="$base/pools.json" ;;
  esac
  staged="$(mktemp -d)"
  if gcloud storage cp "$src" "$staged/pools.json" >/dev/null 2>&1; then
    SNAPSHOT="$staged/pools.json"
  else
    echo "  WARNING: could not read $src — this run uses the module defaults below, NOT the last cleanup configuration" >&2
    SNAPSHOT="$staged/absent.json"
  fi
fi

# Defaults mirror the module: substrate.tf (worker), gke.tf (system, primary) and
# variables.tf for the values. The worker numbers are the ones that took three
# attempts to get right — N4 supports no Persistent Disk type, so the boot disk is
# hyperdisk-balanced, and the image must be COS for ComputeClass (see
# docs/SUBSTRATE_INTEGRATION.md §5.3).
WORKER_NAME_DEFAULT=substrate-worker-pool
WORKER_MACHINE_DEFAULT=n4-standard-4
WORKER_DISK_TYPE_DEFAULT=hyperdisk-balanced
WORKER_DISK_GB_DEFAULT=100
WORKER_IOPS_DEFAULT=3000
WORKER_THROUGHPUT_DEFAULT=140
WORKER_IMAGE_DEFAULT=COS_CONTAINERD
WORKER_MIN_DEFAULT=1
WORKER_MAX_DEFAULT=4
WORKER_TAINT_DEFAULT="ate.dev/sandboxClass=gvisor:NoSchedule"
WORKER_LABEL_DEFAULT="ate.dev/worker-pool=planner-pool"

SYSTEM_NAME_DEFAULT=substrate-system-node-pool
SYSTEM_MACHINE_DEFAULT=e2-standard-4   # 4 vCPU: postgres requests 2 CPU here
SYSTEM_DISK_TYPE_DEFAULT=pd-standard
SYSTEM_DISK_GB_DEFAULT=50
SYSTEM_IMAGE_DEFAULT=UBUNTU_CONTAINERD
SYSTEM_MIN_DEFAULT=1
SYSTEM_MAX_DEFAULT=3

PRIMARY_NAME_DEFAULT=substrate-node-pool
PRIMARY_MACHINE_DEFAULT=e2-standard-2
PRIMARY_DISK_TYPE_DEFAULT=pd-standard
PRIMARY_DISK_GB_DEFAULT=50
PRIMARY_IMAGE_DEFAULT=UBUNTU_CONTAINERD
PRIMARY_MIN_DEFAULT=2
PRIMARY_MAX_DEFAULT=8

WORKER_POOL_NAME_DEFAULT=planner-pool
WORKER_REPLICAS_DEFAULT=2
WORKER_IMAGE_TAG_DEFAULT=ghcr.io/agent-substrate/substrate/ateworker-gvisor:v1.0.0

have() { command -v "$1" >/dev/null 2>&1; }
have kubectl || { echo "kubectl is required (gcloud components install kubectl)"; exit 2; }
have gcloud  || { echo "gcloud is required"; exit 2; }
have jq      || { echo "jq is required (brew install jq)"; exit 2; }

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# run <description> <command...> — in dry-run mode print instead of executing.
run() {
  local desc="$1"; shift
  if [ "$DRY_RUN" = 1 ]; then
    printf '  would %s: %s\n' "$desc" "$*"
    return 0
  fi
  printf '  %s…\n' "$desc"
  "$@" || return $?
}

# A pool config is 10 fields. They come from the snapshot when there is one, so a
# restore reproduces what was running rather than what this file last guessed.
if [ -f "$SNAPSHOT" ]; then
  SRC="snapshot $SNAPSHOT"
  snap() { jq -r "$1 // empty" "$SNAPSHOT"; }
else
  SRC="module defaults baked into this script"
  snap() { printf ''; }
fi

WORKER_NAME="$(snap '.pools.worker.name')"            ; : "${WORKER_NAME:=$WORKER_NAME_DEFAULT}"
WORKER_MACHINE="$(snap '.pools.worker.machineType')"  ; : "${WORKER_MACHINE:=$WORKER_MACHINE_DEFAULT}"
WORKER_DISK_TYPE="$(snap '.pools.worker.diskType')"   ; : "${WORKER_DISK_TYPE:=$WORKER_DISK_TYPE_DEFAULT}"
WORKER_DISK_GB="$(snap '.pools.worker.diskSizeGb')"   ; : "${WORKER_DISK_GB:=$WORKER_DISK_GB_DEFAULT}"
WORKER_IOPS="$(snap '.pools.worker.provisionedIops')" ; : "${WORKER_IOPS:=$WORKER_IOPS_DEFAULT}"
WORKER_THROUGHPUT="$(snap '.pools.worker.provisionedThroughput')"
: "${WORKER_THROUGHPUT:=$WORKER_THROUGHPUT_DEFAULT}"
WORKER_IMAGE="$(snap '.pools.worker.imageType')"      ; : "${WORKER_IMAGE:=$WORKER_IMAGE_DEFAULT}"
WORKER_MIN="$(snap '.pools.worker.minNodes')"         ; : "${WORKER_MIN:=$WORKER_MIN_DEFAULT}"
WORKER_MAX="$(snap '.pools.worker.maxNodes')"         ; : "${WORKER_MAX:=$WORKER_MAX_DEFAULT}"
# GKE stores the effect in its own enum form (NO_SCHEDULE) while --node-taints is
# documented with the Kubernetes form (NoSchedule). Normalise on the way in so a
# snapshot round-trip does not depend on gcloud accepting the value it emitted.
WORKER_TAINT="$(snap '.pools.worker.taints' | jq -r '.[0] | "\(.key)=\(.value):\(.effect)"' 2>/dev/null \
                | sed -e 's|:NO_SCHEDULE$|:NoSchedule|' -e 's|:NO_EXECUTE$|:NoExecute|' -e 's|:PREFER_NO_SCHEDULE$|:PreferNoSchedule|')"
: "${WORKER_TAINT:=$WORKER_TAINT_DEFAULT}"
WORKER_LABEL="$(snap '.pools.worker.labels' | jq -r 'to_entries[] | "\(.key)=\(.value)"')"
: "${WORKER_LABEL:=$WORKER_LABEL_DEFAULT}"

SYSTEM_NAME="$(snap '.pools.system.name')"           ; : "${SYSTEM_NAME:=$SYSTEM_NAME_DEFAULT}"
SYSTEM_MACHINE="$(snap '.pools.system.machineType')" ; : "${SYSTEM_MACHINE:=$SYSTEM_MACHINE_DEFAULT}"
SYSTEM_DISK_TYPE="$(snap '.pools.system.diskType')"  ; : "${SYSTEM_DISK_TYPE:=$SYSTEM_DISK_TYPE_DEFAULT}"
SYSTEM_DISK_GB="$(snap '.pools.system.diskSizeGb')"  ; : "${SYSTEM_DISK_GB:=$SYSTEM_DISK_GB_DEFAULT}"
SYSTEM_IMAGE="$(snap '.pools.system.imageType')"     ; : "${SYSTEM_IMAGE:=$SYSTEM_IMAGE_DEFAULT}"
SYSTEM_MIN="$(snap '.pools.system.minNodes')"        ; : "${SYSTEM_MIN:=$SYSTEM_MIN_DEFAULT}"
SYSTEM_MAX="$(snap '.pools.system.maxNodes')"        ; : "${SYSTEM_MAX:=$SYSTEM_MAX_DEFAULT}"

PRIMARY_NAME="$(snap '.pools.primary.name')"         ; : "${PRIMARY_NAME:=$PRIMARY_NAME_DEFAULT}"
PRIMARY_MACHINE="$(snap '.pools.primary.machineType')" ; : "${PRIMARY_MACHINE:=$PRIMARY_MACHINE_DEFAULT}"
PRIMARY_DISK_TYPE="$(snap '.pools.primary.diskType')"  ; : "${PRIMARY_DISK_TYPE:=$PRIMARY_DISK_TYPE_DEFAULT}"
PRIMARY_DISK_GB="$(snap '.pools.primary.diskSizeGb')"  ; : "${PRIMARY_DISK_GB:=$PRIMARY_DISK_GB_DEFAULT}"
PRIMARY_IMAGE="$(snap '.pools.primary.imageType')"     ; : "${PRIMARY_IMAGE:=$PRIMARY_IMAGE_DEFAULT}"
PRIMARY_MIN="$(snap '.pools.primary.minNodes')"        ; : "${PRIMARY_MIN:=$PRIMARY_MIN_DEFAULT}"
PRIMARY_MAX="$(snap '.pools.primary.maxNodes')"         ; : "${PRIMARY_MAX:=$PRIMARY_MAX_DEFAULT}"

WP_NAME="$(snap '.workerPool.name')"           ; : "${WP_NAME:=$WORKER_POOL_NAME_DEFAULT}"
WP_REPLICAS="$(snap '.workerPool.replicas')"   ; : "${WP_REPLICAS:=$WORKER_REPLICAS_DEFAULT}"
WP_IMAGE="$(snap '.workerPool.workerImage')"   ; : "${WP_IMAGE:=$WORKER_IMAGE_TAG_DEFAULT}"

say "Config source: $SRC"
printf '  worker  %s: %s %sGB %s %s min %s/max %s taint %s\n' \
  "$WORKER_NAME" "$WORKER_MACHINE" "$WORKER_DISK_GB" "$WORKER_DISK_TYPE" "$WORKER_IMAGE" "$WORKER_MIN" "$WORKER_MAX" "$WORKER_TAINT"
printf '  system  %s: %s %sGB %s %s min %s/max %s\n' \
  "$SYSTEM_NAME" "$SYSTEM_MACHINE" "$SYSTEM_DISK_GB" "$SYSTEM_DISK_TYPE" "$SYSTEM_IMAGE" "$SYSTEM_MIN" "$SYSTEM_MAX"
printf '  WorkerPool %s/%s replicas=%s image=%s\n' "$POOL_NS" "$WP_NAME" "$WP_REPLICAS" "$WP_IMAGE"

say "Cluster credentials"
if ! kubectl get ns >/dev/null 2>&1; then
  run "get-credentials" gcloud container clusters get-credentials "$CLUSTER" --zone "$ZONE" --project "$PROJECT" \
    || { echo "could not reach $CLUSTER"; exit 2; }
fi
[ "$DRY_RUN" = 1 ] || echo "  context: $(kubectl config current-context)"

pool_exists() {
  gcloud container node-pools describe "$1" --cluster "$CLUSTER" --zone "$ZONE" \
    --project "$PROJECT" --format="value(name)" >/dev/null 2>&1
}

# create_pool <name> <machine> <disk-type> <disk-size> <image> <min> <max> [extra...]
# Hyperdisk-only flags ride on the worker pool alone: GKE rejects provisioned IOPS
# and throughput on a Persistent Disk boot disk.
create_pool() {
  local name="$1" machine="$2" dtype="$3" dsize="$4" image="$5" min="$6" max="$7"; shift 7
  if pool_exists "$name"; then
    echo "  pool $name already exists — left as is (this script does not reconfigure)"
    return 0
  fi
  local args=(gcloud container node-pools create "$name"
    --cluster "$CLUSTER" --zone "$ZONE" --project "$PROJECT"
    --machine-type "$machine" --disk-type "$dtype" --disk-size "${dsize}GB"
    --image-type "$image"
    --enable-autoscaling --min-nodes "$min" --max-nodes "$max"
    --location-policy BALANCED
    --scopes cloud-platform --workload-metadata GKE_METADATA
    --shielded-integrity-monitoring --no-shielded-secure-boot
    --metadata disable-legacy-endpoints=true)
  case "$dtype" in
    hyperdisk-*) args+=(--boot-disk-provisioned-iops "$WORKER_IOPS"
                        --boot-disk-provisioned-throughput "$WORKER_THROUGHPUT") ;;
  esac
  args+=("$@")
  run "create $name" "${args[@]}" >/dev/null \
    || { echo "  FAILED to create $name"; return 1; }
}

say "1. Node pools"
printf '  system pool (%s) first — ate-system needs a place to land before anything schedules onto workers\n' "$SYSTEM_NAME"
create_pool "$SYSTEM_NAME" "$SYSTEM_MACHINE" "$SYSTEM_DISK_TYPE" "$SYSTEM_DISK_GB" "$SYSTEM_IMAGE" \
  "$SYSTEM_MIN" "$SYSTEM_MAX" --quiet
printf '  worker pool (%s)\n' "$WORKER_NAME"
create_pool "$WORKER_NAME" "$WORKER_MACHINE" "$WORKER_DISK_TYPE" "$WORKER_DISK_GB" "$WORKER_IMAGE" \
  "$WORKER_MIN" "$WORKER_MAX" --node-taints "$WORKER_TAINT" --node-labels "$WORKER_LABEL" --quiet
if [ "$WITH_PRIMARY" = 1 ]; then
  printf '  tenant pool (%s) — asked for with --with-primary\n' "$PRIMARY_NAME"
  create_pool "$PRIMARY_NAME" "$PRIMARY_MACHINE" "$PRIMARY_DISK_TYPE" "$PRIMARY_DISK_GB" "$PRIMARY_IMAGE" \
    "$PRIMARY_MIN" "$PRIMARY_MAX" --quiet
else
  printf '  tenant pool %s skipped (it hosts no substrate component; --with-primary to add it,\n' "$PRIMARY_NAME"
  printf '    and a terraform apply re-creates it anyway because the module still owns it)\n'
fi

say "2. Waiting for Ready nodes"
deadline=$((SECONDS + 900))
while :; do
  ready=$(kubectl get nodes --no-headers 2>/dev/null | grep -c ' Ready' || true)
  [ "$DRY_RUN" = 1 ] && { echo "  (dry run) would wait for the pools to report Ready nodes"; break; }
  [ "${ready:-0}" -ge 2 ] && { echo "  $ready Ready node(s)"; break; }
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "  TIMEOUT after 900s with ${ready:-0} Ready node(s) — check the pool's operations and events"
    kubectl get events -A --field-selector reason=FailedScheduling --sort-by=.lastTimestamp 2>/dev/null | tail -5
    exit 1
  fi
  sleep 20
done

say "3. Resources"
# Two objects decide whether an actor can ever be placed, and neither is created by
# the installer: the namespace ate-controller makes worker pods in, and the
# WorkerPool whose NAME is the contract — ate-controller stamps
# ate.dev/worker-pool=<name> onto the pods, and the planner sends that as
# workerSelector. A pool named anything else leaves every actor Pending.
run "ensure namespace $POOL_NS" bash -c \
  "kubectl create namespace '$POOL_NS' --dry-run=client -o yaml | kubectl apply -f - >/dev/null"

if kubectl -n "$POOL_NS" get workerpool.ate.dev "$WP_NAME" >/dev/null 2>&1; then
  echo "  WorkerPool $POOL_NS/$WP_NAME already exists — left as is"
else
  run "apply WorkerPool $POOL_NS/$WP_NAME" kubectl apply -f - <<EOF
apiVersion: ate.dev/v1
kind: WorkerPool
metadata:
  name: ${WP_NAME}
  namespace: ${POOL_NS}
spec:
  replicas: ${WP_REPLICAS}
  workerImage: ${WP_IMAGE}
  sandboxClasses:
  - name: gvisor
  template:
    nodeSelector:
      cloud.google.com/gke-nodepool: ${WORKER_NAME}
    resources:
      requests:
        cpu: 500m
        memory: 1Gi
      limits:
        cpu: "2"
        memory: 4Gi
EOF
fi

say "4. Verify — can a worker pod actually be created?"
[ "$DRY_RUN" = 1 ] && { echo "  (dry run) skipped"; exit 0; }
fail=0
check() {
  local label="$1"; shift
  if out="$("$@" 2>&1)"; then printf '  \033[32mPASS\033[0m %s %s\n' "$label" "${out:-}";
  else printf '  \033[31mFAIL\033[0m %s %s\n' "$label" "${out:-}"; fail=$((fail+1)); fi
}

# The pods are the whole point: they only exist if ate-controller reconciled the
# WorkerPool, and they only schedule if the node pool's taint is one the worker
# template tolerates and the nodeSelector names a pool that exists.
# Poll for Ready, not merely for existence, because the two are minutes apart on a
# cold pool: the ateworker first needs atelet to create its worker-support socket, then
# an epoch from ateapi, and only then does its readiness probe flip. Checking once right
# after the pods appear reports a false failure — which happened on the first run of
# this script, against a pool that was healthy ten seconds later.
ready_line() {
  kubectl -n "$POOL_NS" get pods -l "ate.dev/worker-pool=$WP_NAME" --no-headers 2>/dev/null | \
    awk 'BEGIN{t=0;r=0} {t++; if ($2 ~ /^1\//) r++} END{printf "%d/%d", r, t}'
}
deadline=$((SECONDS + 420))
while :; do
  line="$(ready_line)"
  [ "$line" = "$WP_REPLICAS/$WP_REPLICAS" ] && break
  [ "$SECONDS" -ge "$deadline" ] && break
  sleep 15
done

check "worker pods created" bash -c \
  "n=\$(kubectl -n '$POOL_NS' get pods -l 'ate.dev/worker-pool=$WP_NAME' --no-headers 2>/dev/null | wc -l | tr -d ' '); \
   [ \"\$n\" -ge $WP_REPLICAS ] && echo \"\$n/$WP_REPLICAS exist\" || { echo \"\$n/$WP_REPLICAS — ate-controller created nothing\"; exit 1; }"

check "worker pods Ready" bash -c \
  "line='$line'; [ \"\$line\" = \"$WP_REPLICAS/$WP_REPLICAS\" ] && echo \"\$line (registered with ateapi)\" \
   || { echo \"\$line Ready after 420s — Running-but-not-Ready means atelet never wrote the worker socket or ateapi gave no epoch (check atelet, then ate-api-server migrations)\"; exit 1; }"

check "workers placed on $WORKER_NAME" bash -c \
  "kubectl -n '$POOL_NS' get pods -l 'ate.dev/worker-pool=$WP_NAME' -o jsonpath='{.items[*].spec.nodeName}' 2>/dev/null | \
    grep -q . && echo 'see below' || { echo 'no nodeName assigned'; exit 1; }"
kubectl -n "$POOL_NS" get pods -l "ate.dev/worker-pool=$WP_NAME" -o wide --no-headers 2>/dev/null | awk '{print "      "$1" node="$7" "$2" "$3}'

check "atelet on the worker node" bash -c \
  "wn=\$(kubectl get nodes -l 'cloud.google.com/gke-nodepool=$WORKER_NAME' -o jsonpath='{.items[0].metadata.name}' 2>/dev/null); \
   an=\$(kubectl get pods -n ate-system -l app=atelet -o jsonpath='{.items[*].spec.nodeName}' 2>/dev/null); \
   [ -n \"\$wn\" ] || { echo 'no worker node at all'; exit 1; }
   case \" \$an \" in *\" \$wn \"*) echo \"\$wn\";; *) echo \"no atelet on \$wn — the taint is not tolerated\"; exit 1;; esac"

check "postgres PVC re-attached" bash -c \
  "kubectl -n ate-system get pvc data-postgres-0 -o jsonpath='{.status.phase}' 2>/dev/null | grep -q Bound \
   && echo Bound || { echo 'PVC not Bound — the 50Gi disk is the whole control-plane DB'; exit 1; }"

check "control plane back up" bash -c \
  "kubectl -n ate-system get sts postgres --no-headers 2>/dev/null | awk '{exit (\$2==\"1/1\")?0:1}' \
   && echo 'postgres 1/1' || { echo 'postgres not Ready yet — roll again in a minute'; exit 1; }"

printf '\n\033[1msummary\033[0m  %d failed check(s)\n' "$fail"
if [ "$fail" = 0 ]; then
  echo "Sandbox capacity is back. Run deploy/gcp/substrate-check.sh for the full picture."
  echo "Note: terraform still owns these pools; the next apply refreshes and adopts them."
fi
[ "$fail" = 0 ] || exit 1
