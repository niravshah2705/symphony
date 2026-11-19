#!/usr/bin/env bash
# flexprice-recreate.sh — bring the FlexPrice node pool back after it is gone.
#
# Sibling of substrate-recreate.sh, and the same two answers apply:
#
# Why a script and not `terraform apply`: the pool may have been removed out from under
# the state (Console deletes, a cleanup run), so the only ways back are an apply that
# re-creates the pool plus every k8s object, or this: plain gcloud + kubectl, which can
# run while CI is its host. A later flexprice_reconcile apply still works — pool identity
# is the API URL, so refresh adopts what this script created instead of colliding with it.
#
# What this script does NOT restore: the workloads. Unlike the substrate teardown, the
# flexprice cleanup deletes only compute. The namespace, StatefulSets, Deployments and —
# critically — the PVCs and their Retain PDs all survived; the pods have been sitting
# Pending waiting for a node that tolerates fleet.dev/dedicated=flexprice:NoSchedule and
# carries the matching nodeSelector label. So the restore is: create the pool, wait for
# the node, prove every store reattached its OLD disk and rolled out. A PVC-level restore
# (after cleanup --destroy-pvc) is terraform's job: run deploy.yml's flexprice_reconcile.
#
# Config precedence, printed on every run so a restore is never a guess:
#   1. --snapshot=latest            the newest pools.json in the backup bucket
#   2. --snapshot=<path|gs://uri>   a specific flexprice-cleanup.sh snapshot
#   3. .flexprice-state/pools.json  the local mirror of the last cleanup
#   4. the DEFAULTS below, which mirror deploy/gcp/terraform-flexprice/node_pool.tf
# If (4) is used the script says so, because the module is then the only place the
# numbers are right — keep the two in sync or stop using this script.
#
# Usage:
#   deploy/gcp/flexprice-recreate.sh                    # restore flexprice-pool
#   deploy/gcp/flexprice-recreate.sh --snapshot=latest
#   deploy/gcp/flexprice-recreate.sh --snapshot=gs://BUCKET/CLUSTER/STAMP
#   deploy/gcp/flexprice-recreate.sh --dry-run          # print, change nothing
#   SNAPSHOT=/tmp/pools.json deploy/gcp/flexprice-recreate.sh
set -uo pipefail

PROJECT="${PROJECT:-adlc-9e72f}"
CLUSTER="${CLUSTER:-substrate-multitenant}"
ZONE="${ZONE:-asia-south1-a}"
FP_NS="${FP_NS:-flexprice}"
SNAPSHOT="${SNAPSHOT:-.flexprice-state/pools.json}"
DRY_RUN=0
EXPLICIT_SNAPSHOT=0
WARNED=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=1 ;;
    --snapshot=*)   SNAPSHOT="${arg#*=}"; EXPLICIT_SNAPSHOT=1 ;;
    *) echo "unknown argument: $arg (expected --snapshot=<path|gs://uri|latest> or --dry-run)"; exit 2 ;;
  esac
done

# `latest` resolves the newest snapshot the cleanup wrote, so a restore after an
# unplanned teardown needs no copy-pasted URI. flexprice-cleanup.sh keys each run as
# <cluster>/<%Y-%m-%dT%H%M%SZ>/pools.json — fixed-width and already UTC — so the
# lexical maximum IS the chronological one.
BACKUP_BUCKET_URL="${BACKUP_BUCKET_URL:-gs://${PROJECT}-flexprice-backup}"
if [ "$SNAPSHOT" = latest ]; then
  SNAPSHOT="$(gcloud storage ls "$BACKUP_BUCKET_URL/$CLUSTER/*/pools.json" 2>/dev/null | sort | tail -1)"
  if [ -z "$SNAPSHOT" ]; then
    echo "  WARNING: no pools.json under $BACKUP_BUCKET_URL/$CLUSTER/ — nothing to restore from" >&2
    SNAPSHOT="$BACKUP_BUCKET_URL/_absent_/pools.json"
  fi
fi

# A gs:// URI is where the snapshot actually lives — flexprice-cleanup.sh uploads it from
# whatever machine ran the teardown. Stage it locally, and say so loudly if the fetch
# fails: silently dropping to baked-in defaults is how a restore ends up re-guessing the
# taint that makes the pool dedicated at all.
if [ "${SNAPSHOT#gs://}" != "$SNAPSHOT" ]; then
  base="${SNAPSHOT%/}"
  case "$base" in
    */pools.json) src="$base" ;;
    *)            src="$base/pools.json" ;;
  esac
  echo "  snapshot: $src"
  staged="$(mktemp -d)"
  if gcloud storage cp "$src" "$staged/pools.json" >/dev/null 2>&1; then
    SNAPSHOT="$staged/pools.json"
  else
    echo "  WARNING: could not read $src — this run uses the module defaults below, NOT the last cleanup configuration" >&2
    SNAPSHOT="$staged/absent.json"
    WARNED=1
  fi
fi

# Defaults mirror the module: node_pool.tf (taint, image, scopes, surge upgrade) and
# variables.tf (name, machine, min/max, disk). The machine is e2-standard-4 because the
# four stores plus three apps fit into 4 vCPU / 16 GiB with headroom for the probe
# timeouts (variables.tf says the same); COS is what GKE's node auto-repair assumes.
POOL_NAME_DEFAULT=flexprice-pool
POOL_MACHINE_DEFAULT=e2-standard-4
POOL_DISK_TYPE_DEFAULT=pd-standard
POOL_DISK_GB_DEFAULT=100
POOL_IMAGE_DEFAULT=COS_CONTAINERD
POOL_MIN_DEFAULT=1
POOL_MAX_DEFAULT=3
POOL_TAINT_DEFAULT="fleet.dev/dedicated=flexprice:NoSchedule"
# node_config.labels in this module are GCE instance labels (dotted fleet.dev/* keys are
# rejected at apply time — see main.tf), so the restore writes the underscore form back.
POOL_LABELS_DEFAULT="fleet_dev_managed_by=terraform,fleet_dev_component=billing,fleet_dev_root=terraform-flexprice"

have() { command -v "$1" >/dev/null 2>&1; }
have kubectl || { echo "kubectl is required (gcloud components install kubectl)"; exit 2; }
have gcloud  || { echo "gcloud is required"; exit 2; }
have jq      || { echo "jq is required (brew install jq)"; exit 2; }

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# run <description> <command...> — in dry-run mode print instead of executing.
run() {
  local desc="$1"; shift
  if [ "$DRY_RUN" = 1 ]; then
    # stderr: the call sites pipe the real command's noise away, and that redirect would
    # otherwise eat the rehearsal line too.
    printf '  would %s: %s\n' "$desc" "$*" >&2
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
  [ "$EXPLICIT_SNAPSHOT" = 1 ] && [ "$WARNED" = 0 ] \
    && printf '  WARNING: %s is not readable — restoring module defaults, NOT that snapshot\n' "$SNAPSHOT" >&2
  SRC="module defaults baked into this script"
  snap() { printf ''; }
fi

POOL_NAME="$(snap '.pool.name')"          ; : "${POOL_NAME:=$POOL_NAME_DEFAULT}"
POOL_MACHINE="$(snap '.pool.machineType')" ; : "${POOL_MACHINE:=$POOL_MACHINE_DEFAULT}"
POOL_DISK_TYPE="$(snap '.pool.diskType')"  ; : "${POOL_DISK_TYPE:=$POOL_DISK_TYPE_DEFAULT}"
POOL_DISK_GB="$(snap '.pool.diskSizeGb')"  ; : "${POOL_DISK_GB:=$POOL_DISK_GB_DEFAULT}"
POOL_IOPS="$(snap '.pool.provisionedIops')"
POOL_THROUGHPUT="$(snap '.pool.provisionedThroughput')"
POOL_IMAGE="$(snap '.pool.imageType')"     ; : "${POOL_IMAGE:=$POOL_IMAGE_DEFAULT}"
POOL_MIN="$(snap '.pool.minNodes')"        ; : "${POOL_MIN:=$POOL_MIN_DEFAULT}"
POOL_MAX="$(snap '.pool.maxNodes')"        ; : "${POOL_MAX:=$POOL_MAX_DEFAULT}"
# GKE stores the effect in its own enum form (NO_SCHEDULE) while --node-taints is
# documented with the Kubernetes form (NoSchedule). Normalise on the way in so a
# snapshot round-trip does not depend on gcloud accepting the value it emitted.
POOL_TAINT="$(snap '.pool.taints' | jq -r '.[0] | "\(.key)=\(.value):\(.effect)"' 2>/dev/null \
              | sed -e 's|:NO_SCHEDULE$|:NoSchedule|' -e 's|:NO_EXECUTE$|:NoExecute|' -e 's|:PREFER_NO_SCHEDULE$|:PreferNoSchedule|')"
: "${POOL_TAINT:=$POOL_TAINT_DEFAULT}"
POOL_LABELS="$(snap '.pool.labels' | jq -r 'to_entries[] | "\(.key)=\(.value)"' 2>/dev/null | paste -sd, -)"
: "${POOL_LABELS:=$POOL_LABELS_DEFAULT}"

say "Config source: $SRC"
printf '  pool    %s: %s %sGB %s %s min %s/max %s taint %s\n' \
  "$POOL_NAME" "$POOL_MACHINE" "$POOL_DISK_GB" "$POOL_DISK_TYPE" "$POOL_IMAGE" "$POOL_MIN" "$POOL_MAX" "$POOL_TAINT"

say "Cluster credentials"
if ! kubectl get ns "$FP_NS" >/dev/null 2>&1; then
  run "get-credentials" gcloud container clusters get-credentials "$CLUSTER" --zone "$ZONE" --project "$PROJECT" \
    || { echo "could not reach $CLUSTER"; exit 2; }
fi
[ "$DRY_RUN" = 1 ] || echo "  context: $(kubectl config current-context)"

say "1. Node pool"
if gcloud container node-pools describe "$POOL_NAME" --cluster "$CLUSTER" --zone "$ZONE" \
     --project "$PROJECT" --format="value(name)" >/dev/null 2>&1; then
  echo "  pool $POOL_NAME already exists — left as is (this script does not reconfigure)"
else
  args=(gcloud container node-pools create "$POOL_NAME"
    --cluster "$CLUSTER" --zone "$ZONE" --project "$PROJECT"
    --machine-type "$POOL_MACHINE" --disk-type "$POOL_DISK_TYPE" --disk-size "${POOL_DISK_GB}GB"
    --image-type "$POOL_IMAGE"
    # --num-nodes defaults to 3 and wins over the autoscaling floor at creation: a
    # cold-started flexprice pool would buy three e2-standard-4 machines for a pool
    # whose min_nodes is 1. Pin the start size to the floor.
    --num-nodes "$POOL_MIN"
    --enable-autoscaling --min-nodes "$POOL_MIN" --max-nodes "$POOL_MAX"
    --location-policy BALANCED
    --scopes cloud-platform --workload-metadata GKE_METADATA
    --shielded-integrity-monitoring --no-shielded-secure-boot
    --metadata disable-legacy-endpoints=true
    --node-taints "$POOL_TAINT" --resource-labels "$POOL_LABELS" --quiet)
  # Hyperdisk-only flags ride along only when the snapshot says the old pool had them:
  # GKE rejects provisioned IOPS on a Persistent Disk boot disk.
  case "$POOL_DISK_TYPE" in
    hyperdisk-*) [ -n "$POOL_IOPS" ] && args+=(--boot-disk-provisioned-iops "$POOL_IOPS")
                 [ -n "$POOL_THROUGHPUT" ] && args+=(--boot-disk-provisioned-throughput "$POOL_THROUGHPUT") ;;
  esac
  run "create $POOL_NAME" "${args[@]}" >/dev/null \
    || { echo "  FAILED to create $POOL_NAME"; exit 1; }
fi

say "2. Waiting for a Ready node in $POOL_NAME"
# Not a cluster-wide Ready count (the substrate pools are neighbours): exactly the
# min count this pool must hold before its StatefulSets can converge.
ready_nodes() {
  kubectl get nodes -l "cloud.google.com/gke-nodepool=$POOL_NAME" -o json 2>/dev/null | jq -r \
    '[.items[] | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))] | length'
}
deadline=$((SECONDS + 900))
while :; do
  [ "$DRY_RUN" = 1 ] && { echo "  (dry run) would wait for >= $POOL_MIN Ready node(s), then the rollouts below"; break; }
  ready="$(ready_nodes)"
  [ "${ready:-0}" -ge "$POOL_MIN" ] && { echo "  $ready Ready node(s) in $POOL_NAME"; break; }
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "  TIMEOUT after 900s with ${ready:-0} Ready node(s) — check the pool's operations and events"
    kubectl get events -n "$FP_NS" --field-selector reason=FailedScheduling --sort-by=.lastTimestamp 2>/dev/null | tail -5
    exit 1
  fi
  sleep 20
done

say "3. Verify — do the stores reattach their Retain disks?"
[ "$DRY_RUN" = 1 ] && { echo "  (dry run) skipped"; exit 0; }
fail=0
check() {
  local label="$1"; shift
  if out="$("$@" 2>&1)"; then printf '  \033[32mPASS\033[0m %s %s\n' "$label" "${out:-}";
  else printf '  \033[31mFAIL\033[0m %s %s\n' "$label" "${out:-}"; fail=$((fail+1)); fi
}

# The PVCs were never deleted by flexprice-cleanup.sh, so "Bound" here proves the Retain
# PVs are still live; the rollouts then prove the pods reattached the SAME disks (a PV
# that silently re-provisioned would Bound too — the PD-name comparison catches that only
# across a before/after inventory, which the cleanup's pv-inventory.json records).
check "all PVCs Bound" bash -c \
  "n=\$(kubectl -n '$FP_NS' get pvc --no-headers 2>/dev/null | grep -vc ' Bound' || true); \
   [ \"\${n:-0}\" -eq 0 ] && kubectl -n '$FP_NS' get pvc --no-headers 2>/dev/null | wc -l | xargs echo 'claims Bound:' \
   || { echo \"\$n claim(s) not Bound — check 'kubectl -n '$FP_NS' get pvc\"; exit 1; }"

# Everything in the namespace selects the pool by name, so a pod placed elsewhere means
# the nodeSelector and the pool disagree — the same naming contract the taint enforces.
check "workloads rolling out on $POOL_NAME" bash -c \
  "for w in \$(kubectl -n '$FP_NS' get statefulset,deployment -o name 2>/dev/null); do \
     kubectl -n '$FP_NS' rollout status \"\$w\" --timeout=600s >/dev/null || { echo \"\$w did not converge\"; exit 1; }; \
   done; echo 'every statefulset/deployment rolled out'"

check "no pod of $FP_NS Pending" bash -c \
  "p=\$(kubectl -n '$FP_NS' get pods --no-headers 2>/dev/null | awk '\$3==\"Pending\"' | wc -l | tr -d ' '); \
   [ \"\$p\" -eq 0 ] && echo 'none pending' || { echo \"\$p Pending — check taint/toleration\"; exit 1; }"

check "pods placed on $POOL_NAME" bash -c \
  "nodes=\$(kubectl get nodes -l 'cloud.google.com/gke-nodepool=$POOL_NAME' -o jsonpath='{.items[*].metadata.name}'); \
   bad=0; \
   for pn in \$(kubectl -n '$FP_NS' get pods -o jsonpath='{range .items[*]}{.metadata.name}{\" \"}{.spec.nodeName}{\"\n\"}{end} 2>/dev/null | grep -v '^$' | awk '\$2!=\"\"{print \$2}' | sort -u); do \
     case \" \$nodes \" in *\" \$pn \"*) ;; *) echo \"pod(s) landed on \$pn, outside the pool\"; bad=1;; esac; \
   done; [ \"\$bad\" -eq 0 ] && echo 'all on the pool'"

printf '\n\033[1msummary\033[0m  %d failed check(s)\n' "$fail"
if [ "$fail" = 0 ]; then
  echo "FlexPrice capacity is back; the stores are on their original Retain disks."
  echo "Note: terraform still owns this pool; the next flexprice_reconcile refreshes and adopts it."
  echo "If pods CrashLoop after the reattach (Kafka cluster id, ClickHouse WAL), read the cleanup's"
  echo "pv-inventory.json from the same snapshot prefix and compare PD names before restoring a disk."
fi
[ "$fail" = 0 ] || exit 1
