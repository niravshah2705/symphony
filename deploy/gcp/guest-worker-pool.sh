#!/usr/bin/env bash
# guest-worker-pool.sh — stand up the WorkerPool the guest guided demo names.
#
# Why a pool of its own instead of planner-pool: the guest flow is public traffic
# with no per-visitor bound (§2 of the guest demo plan), so an actor burst from it
# would queue a signed-in tenant's planner runs on the same nodes. One node with a
# ceiling of one keeps the demo's capacity separate AND capped: the worst the
# public can do to a paying workspace is occupy one sandbox.
#
# The name is the contract, and it is one string in three places:
#   * this script's WorkerPool metadata.name, which ate-controller stamps as the
#     pod label ate.dev/worker-pool=<name>;
#   * the Harness CR the demo renders — spec.substrate.workerPoolRef.name, filled
#     from CONFIG.GUEST_DEMO.workerPool (packages/shared-core/src/config.js);
#   * var.guest_worker_pool in deploy/gcp/terraform/variables.tf, which is what
#     puts that value on the deployed gateway.
# Anything else leaves every guest actor Pending: the selector matches no pod, and
# a pool named differently is simply not the one the CR asks for. The equality is
# asserted by deploy/gcp/guest-worker-pool.test.js, not by anything at runtime.
#
# Usage:
#   deploy/gcp/guest-worker-pool.sh                  # node pool + WorkerPool CR
#   deploy/gcp/guest-worker-pool.sh --dry-run        # print, change nothing
#   deploy/gcp/guest-worker-pool.sh --nodes=2        # raise the ceiling
#   deploy/gcp/guest-worker-pool.sh --name=guest-2   # (and then change the config too)
#   deploy/gcp/guest-worker-pool.sh --delete         # remove the CR and the pool
#
# Overrides: PROJECT CLUSTER ZONE POOL_NS GUEST_WP_NAME GUEST_NODE_POOL
#            G_MACHINE G_DISK_TYPE G_DISK_GB G_IOPS G_THROUGHPUT G_IMAGE
#            G_MIN G_MAX G_REPLICAS G_WORKER_IMAGE
#            G_POLL_TIMEOUT G_POLL_INTERVAL (the ready-wait bound, in seconds)
#
# This script does not read a substrate-cleanup snapshot the way
# substrate-recreate.sh does: a guest pool has no prior state to restore, and
# inventing one would mean trusting numbers from a teardown of the *planner*
# pools as if they described this one.

set -uo pipefail

PROJECT="${PROJECT:-adlc-9e72f}"
CLUSTER="${CLUSTER:-substrate-multitenant}"
ZONE="${ZONE:-asia-south1-a}"
POOL_NS="${POOL_NS:-substrate-workers}"

# Same N4 + hyperdisk + COS shape as the planner worker pool (substrate-recreate.sh
# :89-99 — N4 supports no Persistent Disk type, and the image must be COS for the
# gVisor class), but one node instead of four-to-eight.
GUEST_WP_NAME_DEFAULT=guest-demo-pool
GUEST_NODE_POOL_DEFAULT=substrate-guest-node-pool
G_MACHINE_DEFAULT=n4-standard-4
G_DISK_TYPE_DEFAULT=hyperdisk-balanced
G_DISK_GB_DEFAULT=100
G_IOPS_DEFAULT=3000
G_THROUGHPUT_DEFAULT=140
G_IMAGE_DEFAULT=COS_CONTAINERD
G_MIN_DEFAULT=0
G_MAX_DEFAULT=1
G_REPLICAS_DEFAULT=1
G_WORKER_IMAGE_DEFAULT=ghcr.io/agent-substrate/substrate/ateworker-gvisor:v1.0.0
# The taint key is upstream's contract, not ours to invent: ate-controller adds the
# matching toleration to the worker pods from spec.sandboxClasses, so a pool without
# it would also absorb non-substrate workloads, and one with a different value would
# tolerate nothing.
G_TAINT="ate.dev/sandboxClass=gvisor:NoSchedule"
# The ready-wait bound, overridable so a test can drive the timeout branch without
# waiting ten minutes for it.
: "${G_POLL_TIMEOUT:=600}"
: "${G_POLL_INTERVAL:=15}"

DRY_RUN=0
DELETE=0
NAME_SET=0
NODES_SET=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=1 ;;
    --delete)       DELETE=1 ;;
    --name=*)       GUEST_WP_NAME="${arg#*=}"; NAME_SET=1 ;;
    --nodes=*)      G_MAX_DEFAULT="${arg#*=}"; NODES_SET=1 ;;
    *) echo "unknown argument: $arg (expected --dry-run, --delete, --name=<pool>, --nodes=<max>)"; exit 2 ;;
  esac
done

: "${GUEST_WP_NAME:=$GUEST_WP_NAME_DEFAULT}"
: "${GUEST_NODE_POOL:=$GUEST_NODE_POOL_DEFAULT}"
: "${G_MACHINE:=$G_MACHINE_DEFAULT}"
: "${G_DISK_TYPE:=$G_DISK_TYPE_DEFAULT}"
: "${G_DISK_GB:=$G_DISK_GB_DEFAULT}"
: "${G_IOPS:=$G_IOPS_DEFAULT}"
: "${G_THROUGHPUT:=$G_THROUGHPUT_DEFAULT}"
: "${G_IMAGE:=$G_IMAGE_DEFAULT}"
: "${G_MIN:=$G_MIN_DEFAULT}"
: "${G_MAX:=$G_MAX_DEFAULT}"
: "${G_REPLICAS:=$G_REPLICAS_DEFAULT}"
: "${G_WORKER_IMAGE:=$G_WORKER_IMAGE_DEFAULT}"
G_LABEL="ate.dev/worker-pool=$GUEST_WP_NAME"

have() { command -v "$1" >/dev/null 2>&1; }
have kubectl || { echo "kubectl is required (gcloud components install kubectl)"; exit 2; }
have gcloud  || { echo "gcloud is required"; exit 2; }

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# run <description> <command...> — in dry-run mode print instead of executing.
# stderr, not stdout, so a `>/dev/null` at the call site cannot eat the rehearsal
# line (substrate-recreate.sh:126-131 learned that the hard way).
run() {
  local desc="$1"; shift
  if [ "$DRY_RUN" = 1 ]; then
    printf '  would %s: %s\n' "$desc" "$*" >&2
    return 0
  fi
  printf '  %s: %s\n' "$desc" "$*" >&2
  "$@"
}

pool_exists() {
  gcloud container node-pools describe "$1" --cluster "$CLUSTER" --zone "$ZONE" \
    --project "$PROJECT" --format="value(name)" >/dev/null 2>&1
}

# The manifest is a function so --dry-run can print the object it would apply:
# `kubectl apply -f - <<EOF` under run() rehearses the command and discards the
# YAML, which leaves a dry run with nothing to review about the CR that matters.
worker_pool_manifest() {
  cat <<EOF
apiVersion: ate.dev/v1
kind: WorkerPool
metadata:
  name: ${GUEST_WP_NAME}
  namespace: ${POOL_NS}
spec:
  replicas: ${G_REPLICAS}
  workerImage: ${G_WORKER_IMAGE}
  sandboxClasses:
  - name: gvisor
  template:
    nodeSelector:
      cloud.google.com/gke-nodepool: ${GUEST_NODE_POOL}
    resources:
      requests:
        cpu: 250m
        memory: 512Mi
      limits:
        cpu: "1"
        memory: 2Gi
EOF
}

say "Guest demo capacity"
printf '  WorkerPool %s/%s replicas=%s image=%s\n' "$POOL_NS" "$GUEST_WP_NAME" "$G_REPLICAS" "$G_WORKER_IMAGE"
printf '  node pool  %s: %s %sGB %s %s min %s/max %s\n' \
  "$GUEST_NODE_POOL" "$G_MACHINE" "$G_DISK_GB" "$G_DISK_TYPE" "$G_IMAGE" "$G_MIN" "$G_MAX"
printf '  taint %s   label %s\n' "$G_TAINT" "$G_LABEL"
if [ "$NAME_SET" = 1 ] && [ "$GUEST_WP_NAME" != "$GUEST_WP_NAME_DEFAULT" ]; then
  # Renaming here without renaming there is how a demo silently stops placing.
  printf '\n  \033[33mWARNING\033[0m: %s is not the name the demo renders. Set GUEST_WORKER_POOL\n' "$GUEST_WP_NAME"
  printf '  on the gateway and var.guest_worker_pool in terraform to the same string, or the\n  guest Harness selects a pool that does not exist.\n'
fi

say "Cluster credentials"
if ! kubectl get ns >/dev/null 2>&1; then
  run "get-credentials" gcloud container clusters get-credentials "$CLUSTER" --zone "$ZONE" --project "$PROJECT" \
    || { echo "could not reach $CLUSTER"; exit 2; }
fi
[ "$DRY_RUN" = 1 ] || echo "  context: $(kubectl config current-context)"

if [ "$DELETE" = 1 ]; then
  say "1. WorkerPool custom resource"
  if kubectl -n "$POOL_NS" get workerpool.ate.dev "$GUEST_WP_NAME" >/dev/null 2>&1; then
    run "delete WorkerPool $POOL_NS/$GUEST_WP_NAME" \
      kubectl delete workerpool.ate.dev -n "$POOL_NS" "$GUEST_WP_NAME"
  else
    echo "  WorkerPool $POOL_NS/$GUEST_WP_NAME does not exist — nothing to delete"
  fi

  say "2. Node pool"
  if pool_exists "$GUEST_NODE_POOL"; then
    run "delete node pool $GUEST_NODE_POOL" \
      gcloud container node-pools delete "$GUEST_NODE_POOL" --cluster "$CLUSTER" --zone "$ZONE" \
      --project "$PROJECT" --quiet
  else
    echo "  node pool $GUEST_NODE_POOL does not exist — nothing to delete"
  fi
  say "Done — the gateway still renders this pool's name into the demo Harness, so"
  printf '  publish stays simulated until it is created again or var.guest_worker_pool moves.\n'
  exit 0
fi

say "1. Node pool"
# The pool starts at its floor. --num-nodes defaults to 3 in gcloud and wins over
# the autoscaling floor at creation (substrate-recreate.sh:228-232 hit exactly
# that), so it is pinned to G_MIN rather than left to the default: with min 0 the
# demo costs nothing until an actor is actually placed, and the autoscaler brings
# the single node up behind it. Set G_MIN=1 for a warm node.
if pool_exists "$GUEST_NODE_POOL"; then
  echo "  pool $GUEST_NODE_POOL already exists — left as is (this script does not reconfigure)"
else
  args=(gcloud container node-pools create "$GUEST_NODE_POOL"
    --cluster "$CLUSTER" --zone "$ZONE" --project "$PROJECT"
    --machine-type "$G_MACHINE" --disk-type "$G_DISK_TYPE" --disk-size "${G_DISK_GB}GB"
    --image-type "$G_IMAGE"
    --num-nodes "$G_MIN"
    --enable-autoscaling --min-nodes "$G_MIN" --max-nodes "$G_MAX"
    --location-policy BALANCED
    --scopes cloud-platform --workload-metadata GKE_METADATA
    --shielded-integrity-monitoring --no-shielded-secure-boot
    --metadata disable-legacy-endpoints=true
    --node-taints "$G_TAINT" --node-labels "$G_LABEL" --quiet)
  # Provisioned IOPS and throughput are hyperdisk-only; GKE rejects them on a
  # Persistent Disk boot disk, so they ride only when the type says so.
  case "$G_DISK_TYPE" in
    hyperdisk-*) args+=(--boot-disk-provisioned-iops "$G_IOPS"
                        --boot-disk-provisioned-throughput "$G_THROUGHPUT") ;;
  esac
  run "create $GUEST_NODE_POOL" "${args[@]}" >/dev/null \
    || { echo "  FAILED to create $GUEST_NODE_POOL"; exit 1; }
fi

say "2. Namespace and WorkerPool"
# ate-controller makes the worker pods in POOL_NS; the installer creates it, but a
# guest pool on a cluster where the installer ran with a different namespace would
# otherwise strand the CR in a NotFound.
run "ensure namespace $POOL_NS" bash -c \
  "kubectl create namespace '$POOL_NS' --dry-run=client -o yaml | kubectl apply -f - >/dev/null"

if kubectl -n "$POOL_NS" get workerpool.ate.dev "$GUEST_WP_NAME" >/dev/null 2>&1; then
  echo "  WorkerPool $POOL_NS/$GUEST_WP_NAME already exists — left as is"
  [ "$DRY_RUN" = 1 ] && { say "Manifest it was created from, for comparison"; worker_pool_manifest; }
else
  if [ "$DRY_RUN" = 1 ]; then
    echo "  would apply WorkerPool $POOL_NS/$GUEST_WP_NAME:"
    worker_pool_manifest
  else
    worker_pool_manifest | run "apply WorkerPool $POOL_NS/$GUEST_WP_NAME" \
      kubectl apply -n "$POOL_NS" -f - >/dev/null \
      || { echo "  FAILED to apply WorkerPool $GUEST_WP_NAME"; exit 1; }
  fi
fi

say "3. Verify — is a guest worker actually ready?"
if [ "$DRY_RUN" = 1 ]; then
  echo "  (dry run) skipped; the commands above are what would run"
  exit 0
fi
# Poll for Ready rather than for existence: a cold pool needs atelet to create its
# worker socket and an ateapi epoch before the readiness probe flips, so a single
# check right after apply reports a false failure (substrate-recreate.sh:330-336).
deadline=$((SECONDS + G_POLL_TIMEOUT))
while :; do
  ready=$(kubectl get workerpools.ate.dev -n "$POOL_NS" "$GUEST_WP_NAME" \
    -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
  [ "${ready:-0}" -gt 0 ] 2>/dev/null && { echo "  $ready worker(s) ready"; break; }
  if [ "$SECONDS" -ge "$deadline" ]; then
    # With min 0 the pool is allowed to sit empty until an actor arrives, so a
    # timeout here is a placement question, not necessarily a broken pool.
    printf '  no ready worker after %ss — expected while the pool is idle at min_nodes=0.\n' "$G_POLL_TIMEOUT"
    echo "  Check the CR and the node pool, then place an actor:"
    printf '    kubectl get workerpool.ate.dev -n %s %s -o yaml\n' "$POOL_NS" "$GUEST_WP_NAME"
    printf '    kubectl get pods -n %s -l ate.dev/worker-pool=%s\n' "$POOL_NS" "$GUEST_WP_NAME"
    exit 1
  fi
  sleep "$G_POLL_INTERVAL"
done

kubectl get workerpool.ate.dev -n "$POOL_NS" "$GUEST_WP_NAME"
echo "  ok — the demo Harness (workerPoolRef: $GUEST_WP_NAME) now selects a live pool."
