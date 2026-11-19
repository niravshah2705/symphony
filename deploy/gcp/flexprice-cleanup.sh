#!/usr/bin/env bash
# flexprice-cleanup.sh — back the FlexPrice stack's config up, then take its compute away.
#
# The order is the whole design (inherited from substrate-cleanup.sh): nothing is
# destroyed before the config backup is proven. But what "cannot be rebuilt" differs
# here, and that difference is the one thing an operator must understand before running
# this.
#
# FlexPrice's databases (postgres, ClickHouse, Kafka, Redis, Temporal) are single-replica
# StatefulSets whose volumes are zonal PersistentDisks under the chart-owned
# `flexprice-retained` StorageClass (reclaimPolicy: Retain). Deleting the NODE POOL does
# not delete those PDs: GKE tears down the instances, the PVs stay Bound-to-Available and
# Retain, and the next recreate reattaches the same disks. So this script can clear a pool
# without a logical DB dump and lose nothing — the disk is the backup.
#
# The logical dump is still taken when postgres is reachable, because it is cheap and it
# is the only copy that survives a disk-level accident. But it is NOT a precondition for
# the teardown the way the substrate control-plane dump is: here the Retain volumes are the
# precondition, and this script VERIFIES them (reclaimPolicy + PD name) before it clears
# anything. A volume that comes back Delete is the failure mode this checks for, because a
# Delete PV behind a torn-down pool is an unrecoverable ClickHouse WAL and a Kafka cluster
# id pointing at a disk that no longer exists.
#
# What lands in the bucket (and what deliberately does not):
#   postgres-<utc>.sql.gz   pg_dumpall of the billing-metadata DB, when reachable
#   pools.json              the live node-pool config — the input to flexprice-recreate.sh
#   pv-inventory.json       every PVC in the namespace -> PV -> PD name + reclaimPolicy
#   pvc.yaml                the PVCs and their workloads (so a restore knows the shapes)
#   secrets.json            Secret NAMES and data KEYS only. No value is ever written.
#   manifest.json           index: what was taken, from where, how to put it back
#
# Usage:
#   deploy/gcp/flexprice-cleanup.sh                     # backup, then delete the pool
#   deploy/gcp/flexprice-cleanup.sh --dry-run           # show every step, change nothing
#   deploy/gcp/flexprice-cleanup.sh --backup-only       # backup, clear nothing
#   deploy/gcp/flexprice-cleanup.sh --keep-pool         # park at 0 nodes, keep the pool
#   deploy/gcp/flexprice-cleanup.sh --with-disk-snapshot
#   deploy/gcp/flexprice-cleanup.sh --skip-backup       # clear without a DB dump (still proves Retain)
#   deploy/gcp/flexprice-cleanup.sh --destroy-pvc --yes # irreversible: every Retain PD = all billing data
set -uo pipefail

PROJECT="${PROJECT:-adlc-9e72f}"
CLUSTER="${CLUSTER:-substrate-multitenant}"
ZONE="${ZONE:-asia-south1-a}"
REGION="${REGION:-asia-south1}"
FP_NS="${FP_NS:-flexprice}"
POOL="${POOL:-flexprice-pool}"
BACKUP_BUCKET_URL="${BACKUP_BUCKET_URL:-gs://${PROJECT}-flexprice-backup}"
STATE_DIR="${STATE_DIR:-.flexprice-state}"

MODE=delete          # delete | park | backup
DRY_RUN=0; CONFIRMED=0; DESTROY_PVC=0; DISK_SNAPSHOT=0; SKIP_BACKUP=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)            DRY_RUN=1 ;;
    --keep-pool)          MODE=park ;;
    --backup-only)        MODE=backup ;;
    --destroy-pvc)        DESTROY_PVC=1 ;;
    --with-disk-snapshot) DISK_SNAPSHOT=1 ;;
    --skip-backup)        SKIP_BACKUP=1 ;;
    --yes)                CONFIRMED=1 ;;
    *) echo "unknown argument: $arg"; exit 2 ;;
  esac
done

for c in gcloud kubectl jq; do command -v "$c" >/dev/null 2>&1 || { echo "$c is required"; exit 2; }; done

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
note() { printf '  %s\n' "$1"; }
die()  { printf '\n\033[31mABORT\033[0m %s\n' "$1"; exit 1; }
after() { [ "$DRY_RUN" = 1 ] || note "$1"; }
run()  { local desc="$1"; shift
  if [ "$DRY_RUN" = 1 ]; then printf '  would %s: %s\n' "$desc" "$*" >&2; return 0; fi
  "$@"; }

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
PREFIX="${CLUSTER}/${STAMP}"
WORK="$(mktemp -d)"
trap '[ -n "${WORK:-}" ] && rm -rf "$WORK"' EXIT
FILES=()
publish() { [ -s "$1" ] && FILES+=("$(basename "$1")"); return 0; }

say "Preconditions"
kubectl get ns "$FP_NS" >/dev/null 2>&1 \
  || gcloud container clusters get-credentials "$CLUSTER" --zone "$ZONE" --project "$PROJECT" >/dev/null 2>&1 \
  || die "cannot reach $CLUSTER in $ZONE"
note "context: $(kubectl config current-context)"
note "mode: $MODE$([ "$DRY_RUN" = 1 ] && echo ' (dry run)') | backup target: ${BACKUP_BUCKET_URL}/${PREFIX}"

POOL_LIVE=$(gcloud container node-pools describe "$POOL" --cluster "$CLUSTER" --zone "$ZONE" \
             --project "$PROJECT" --format="value(name)" 2>/dev/null || true)
[ -n "$POOL_LIVE" ] && note "pool $POOL found" || note "pool $POOL does not exist (nothing to clear)"

# ---------------------------------------------------------------------------
say "1. Prove the data survives the pool (Retain volumes)"
# This is the substrate "backup before destroy" step, re-expressed for FlexPrice: the
# backup that matters is the PVs' reclaim policy, not a file we copy. A Delete PV means
# tearing down the pool can take the disk with it — so refuse to proceed on one.
if [ "$DRY_RUN" = 1 ]; then
  note "would list every PVC in $FP_NS and assert its PV is Retain"
  printf '[]\n' > "$WORK/pv-inventory.json"
else
  kubectl -n "$FP_NS" get pvc -o json > "$WORK/pvc.json" 2>/dev/null || printf '{"items":[]}\n' > "$WORK/pvc.json"
  # Map each claim to its bound volume, then read that PV's reclaimPolicy + backing disk.
  PV_LIST=$(jq -r '[.items[] | select(.spec.volumeName) | .spec.volumeName] | .[]' "$WORK/pvc.json")
  INVENTORY='[]'
  BAD_RETAIN=""
  for pv in $PV_LIST; do
    meta="$(kubectl get pv "$pv" -o json 2>/dev/null \
            | jq -c '{name: .metadata.name, reclaimPolicy: .spec.persistentVolumeReclaimPolicy,
                      phase: .status.phase, disk: (.spec.csi.volumeHandle // ""),
                      sc: .spec.storageClassName}')"
    [ -n "$meta" ] || continue
    INVENTORY=$(printf '%s' "$INVENTORY" | jq -c --argjson m "$meta" '. + [$m]')
    if [ "$(printf '%s' "$meta" | jq -r '.reclaimPolicy')" != "Retain" ]; then
      BAD_RETAIN="$BAD_RETAIN $(printf '%s' "$meta" | jq -r '.name')"
    fi
  done
  printf '%s\n' "$INVENTORY" | jq '.' > "$WORK/pv-inventory.json"
  publish "$WORK/pv-inventory.json"
  N_PV=$(printf '%s' "$INVENTORY" | jq 'length')
  note "$N_PV bound volume(s) inventoried"
  printf '%s\n' "$INVENTORY" | jq -r '.[] | "    \(.name) [\(.reclaimPolicy)] \(.sc) disk=\(.disk)"' 2>/dev/null
  # A Delete volume is the exact thing this script cannot undo. The pg_dump cannot rebuild
  # a ClickHouse WAL or re-match a Kafka cluster id, so the run stops here rather than
  # trusting the logical dump to cover a disk it was never able to restore.
  if [ -n "$BAD_RETAIN" ]; then
    die "these volumes are NOT Retain:$BAD_RETAIN — a pool teardown could destroy them and the databases are not rebuildable from a SQL dump. Fix the StorageClass/PV policy, or run --backup-only."
  fi
  [ "$N_PV" -ge 1 ] || note "WARNING: no bound PVCs found in $FP_NS — either the stack is already down or the namespace moved"
fi

# ---------------------------------------------------------------------------
say "2. Backup: the billing-metadata database"
# Postgres is the one store a dump genuinely restores (it is relational and small — the
# variables.tf note says billing metadata is a 5Gi volume). ClickHouse/Kafka state is
# covered by the Retain PDs above, not by a dump, so this is best-effort belt-and-braces.
# The sts is the chart's `flexprice-postgres` (fullnameOverride: flexprice), not the
# substrate bare `postgres`; matching on a label here would guess the chart's selector keys.
PG_RUNNING=0
if kubectl -n "$FP_NS" get pods --no-headers 2>/dev/null | grep '^flexprice-postgres-' | grep -q ' Running'; then
  PG_RUNNING=1
fi
if [ "$SKIP_BACKUP" = 1 ]; then
  note "--skip-backup: no dump will be taken (the Retain PDs are the recovery path)"
elif [ "${PG_RUNNING:-0}" -ge 1 ]; then
  DUMP="$WORK/postgres-${STAMP}.sql.gz"
  # Read the credential INSIDE the pod, so no password passes through this shell or the log.
  if [ "$DRY_RUN" = 1 ]; then
    note "would run pg_dumpall inside the postgres pod | gzip, verify it, upload it"
  elif kubectl -n "$FP_NS" exec statefulset/flexprice-postgres -- \
         sh -c 'PGPASSWORD="${POSTGRES_PASSWORD:-}" pg_dumpall -U "${POSTGRES_USER:-flexprice}" --no-password' 2>/dev/null | gzip > "$DUMP"; then
    gzip -t "$DUMP" || die "the gzip is corrupt — refusing to clear anything"
    BYTES=$(wc -c <"$DUMP" | tr -d ' ')
    [ "${BYTES:-0}" -gt 200 ] || die "the dump is ${BYTES} bytes, which is not a billing DB"
    gunzip -c "$DUMP" | grep -qE 'CREATE ROLE|\\connect' \
      || die "the dump contains no CREATE ROLE or \\connect — it is not a full cluster dump"
    note "dump verified: ${BYTES} bytes gzipped"
    publish "$DUMP"
  else
    die "pg_dumpall failed — nothing will be cleared (or pass --skip-backup to rely on the Retain PDs)"
  fi
else
  note "skipped: no Running postgres pod. The Retain PD from step 1 is the only recovery path."
fi

if [ "$DISK_SNAPSHOT" = 1 ]; then
  # Snapshot every Retain disk the pool is carrying, so a bad recreate has an offline copy.
  while read -r disk; do
    [ -n "$disk" ] || continue
    d="${disk##*/}"   # csi.volumeHandle is projects/<p>/zones/<z>/disks/<name> — take the last field
    run "snapshot ${d}" gcloud compute disks snapshot "$d" --zone "$ZONE" --project "$PROJECT" \
      --snapshot-names="${CLUSTER}-fp-${d}-${STAMP}" --quiet >/dev/null \
      && after "disk snapshot ${CLUSTER}-fp-${d}-${STAMP} taken (crash-consistent unless the DB was quiesced)" \
      || note "WARNING: disk snapshot of $d failed"
  done < <([ "$DRY_RUN" = 1 ] && echo "would-snapshot-each-pd" || printf '%s\n' "$INVENTORY" | jq -r '.[].disk' 2>/dev/null)
fi

# ---------------------------------------------------------------------------
say "3. Backup: the configuration"
# The pool's live JSON is what turns the recreate into a reproduction, not a re-guess.
# bootDisk is preferred over diskType because GKE mirrors some disk types into both, and
# only bootDisk carries provisioned IOPS/throughput if the pool ever moves to Hyperdisk.
if [ "$DRY_RUN" = 1 ]; then
  printf '{}\n' > "$WORK/pool.clean.json"
else
  if gcloud container node-pools describe "$POOL" --cluster "$CLUSTER" --zone "$ZONE" \
       --project "$PROJECT" --format="json(name,config,autoscaling)" >"$WORK/pool.json" 2>/dev/null; then
    jq '{name: .name, machineType: .config.machineType,
         diskType:  (.config.bootDisk.diskType // .config.diskType),
         diskSizeGb: (.config.bootDisk.sizeGb  // .config.diskSizeGb),
         provisionedIops:       .config.bootDisk.provisionedIops,
         provisionedThroughput: .config.bootDisk.provisionedThroughput,
         imageType: .config.imageType,
         minNodes: .autoscaling.minNodeCount, maxNodes: .autoscaling.maxNodeCount,
         taints: [(.config.taints // [])[] | {key, value, effect}],
         labels: (.config.labels // {})}' "$WORK/pool.json" > "$WORK/pool.clean.json"
    note "pool: $(jq -r '"\(.machineType) \(.diskSizeGb)GB \(.diskType) \(.imageType) min\(.minNodes)/max\(.maxNodes)"' "$WORK/pool.clean.json")"
  else
    printf '{}\n' > "$WORK/pool.clean.json"
    note "pool $POOL: absent (nothing to capture)"
  fi
fi
jq -n --slurpfile p "$WORK/pool.clean.json" \
   '{capturedAt: "'"$STAMP"'", cluster: "'"$CLUSTER"'", zone: "'"$ZONE"'", pool: $p[0]}' \
   > "$WORK/pools.json"
publish "$WORK/pools.json"

# The PVCs and their workloads, so a restore knows what should be scheduled. No Secret
# objects: values must not reach the bucket, and the workloads reference them by name.
if [ "$DRY_RUN" = 1 ]; then
  printf '# dry run\n' > "$WORK/pvc.yaml"
else
  kubectl -n "$FP_NS" get statefulset,deployment,persistentvolumeclaim -o yaml > "$WORK/pvc.yaml" 2>/dev/null || true
fi
publish "$WORK/pvc.yaml"

# Names and keys only — the inventory a restore needs, with nothing to steal.
run "inventory secrets (names and keys only)" bash -c \
  "kubectl -n '$FP_NS' get secret -o json | jq -c '[.items[] | {name: .metadata.name, type, keys: ((.data // {}) | keys)}] | sort_by(.name)' > '$WORK/secrets.json'"
[ -s "$WORK/secrets.json" ] && note "$(jq -r 'length' "$WORK/secrets.json") secrets inventoried, no values" || printf '[]\n' > "$WORK/secrets.json"
publish "$WORK/secrets.json"

ADDR_LINE=$(gcloud compute addresses list --project "$PROJECT" --filter="name~'flexprice'" --format="value(name,address,status)" 2>/dev/null | head -1)
HOST=$(kubectl -n "$FP_NS" get httproute -o jsonpath='{.items[0].spec.hostnames[0]}' 2>/dev/null)
jq -n --arg stamp "$STAMP" --arg project "$PROJECT" --arg cluster "$CLUSTER" --arg zone "$ZONE" \
   --arg region "$REGION" --arg prefix "$PREFIX" --arg bucket "$BACKUP_BUCKET_URL" \
   --arg mode "$MODE" --arg pool "$POOL" --arg ns "$FP_NS" \
   --arg addr "${ADDR_LINE:-none}" --arg host "${HOST:-none}" \
   --argjson files "$(printf '%s\n' "${FILES[@]:-}" | jq -R . | jq -s 'map(select(. != ""))')" \
   --argjson volumes "$(cat "$WORK/pv-inventory.json" 2>/dev/null || echo '[]')" \
   '{capturedAt: $stamp, project: $project, cluster: $cluster, zone: $zone, region: $region,
     backupUri: ($bucket + "/" + $prefix + "/"), files: $files, mode: $mode,
     pool: $pool, namespace: $ns, hostname: $host, staticAddress: $addr,
     volumes: $volumes,
     secretsPolicy: "names and keys only; substrate-credentials and flexprice-secrets values never copied",
     restore: "flexprice-recreate.sh reads pools.json from this prefix; the workloads reattach their Retain PVs on their own",
     doNotDelete: "the Retain PDs named in volumes[] hold every plan, invoice and usage event — a pool teardown keeps them, a PVC delete does not"}' \
   > "$WORK/manifest.json"
publish "$WORK/manifest.json"

# ---------------------------------------------------------------------------
say "4. Upload"
if [ "$DRY_RUN" = 1 ]; then
  note "would ensure $BACKUP_BUCKET_URL exists ($REGION, uniform access) and cp ${#FILES[@]} objects to ${BACKUP_BUCKET_URL}/${PREFIX}/"
  note "would mirror pools.json + manifest.json into $STATE_DIR/ for flexprice-recreate.sh"
else
  gcloud storage buckets describe "$BACKUP_BUCKET_URL" >/dev/null 2>&1 \
    || run "create $BACKUP_BUCKET_URL" gcloud storage buckets create "$BACKUP_BUCKET_URL" \
         --project "$PROJECT" --location "$REGION" --uniform-bucket-level-access >/dev/null \
    || die "cannot create or access $BACKUP_BUCKET_URL"
  SRC=(); for f in "${FILES[@]:-}"; do [ -n "$f" ] && SRC+=("$WORK/$f"); done
  run "upload ${#SRC[@]} objects" gcloud storage cp "${SRC[@]}" "${BACKUP_BUCKET_URL}/${PREFIX}/" >/dev/null \
    || die "upload failed — refusing to clear anything"
  N=$(gcloud storage ls "${BACKUP_BUCKET_URL}/${PREFIX}/*" 2>/dev/null | wc -l | tr -d ' ')
  [ "${N:-0}" -ge "${#SRC[@]}" ] || die "only $N of ${#SRC[@]} objects are in ${BACKUP_BUCKET_URL}/${PREFIX}/"
  note "verified ${N}/${#SRC[@]} objects under ${BACKUP_BUCKET_URL}/${PREFIX}/"
  mkdir -p "$STATE_DIR"
  cp "$WORK/pools.json" "$WORK/manifest.json" "$STATE_DIR/" 2>/dev/null \
    && note "mirrored pools.json + manifest.json to $STATE_DIR/"
fi

# ---------------------------------------------------------------------------
say "5. Clear"
if [ "$DESTROY_PVC" = 1 ] && [ "$CONFIRMED" != 1 ]; then
  die "--destroy-pvc needs --yes as well: it deletes every claim, and Retain only keeps the orphaned PDs, not a working stack"
fi
if [ "$MODE" = backup ] && [ "$DESTROY_PVC" = 1 ]; then
  die "--backup-only takes no teardown flag"
fi
if [ "$SKIP_BACKUP" != 1 ] && [ "$DRY_RUN" != 1 ] && [ "${#FILES[@]}" -lt 3 ]; then
  die "the backup produced only ${#FILES[@]} files — not clearing anything"
fi

if [ "$MODE" = backup ]; then
  note "--backup-only: ${#FILES[@]} files under ${BACKUP_BUCKET_URL}/${PREFIX}/ — no pool, node or disk was touched"
else
  if [ -z "$POOL_LIVE" ]; then
    note "pool $POOL is already gone — nothing to park or delete"
  else
    # Park first, then delete. A node-pool delete drains, and a StatefulSet pod with a
    # Retain volume that cannot reschedule anywhere (the pool is the only tainted target)
    # blocks its own eviction; driving the pool to 0 first releases the nodes cleanly.
    park() { run "park $1" gcloud container node-pools update "$1" --cluster "$CLUSTER" --zone "$ZONE" \
               --project "$PROJECT" --enable-autoscaling --min-nodes=0 --max-nodes=0 --quiet >/dev/null \
             && after "parked $1" || note "could not park $1 (continuing)"; }
    park "$POOL"
    if [ "$MODE" = park ]; then
      note "--keep-pool: the pool is at 0 nodes and reversible with flexprice-recreate.sh or a terraform apply"
    else
      run "delete $POOL" gcloud container node-pools delete "$POOL" --cluster "$CLUSTER" --zone "$ZONE" \
        --project "$PROJECT" --quiet >/dev/null \
        && after "deleted $POOL" || note "FAILED to delete $POOL"
    fi
  fi
  # The PVC tier, after the pool: deleting claims while nodes still exist just strands
  # Running pods on volumes under deletion. Retain keeps the PDs (orphaned, recoverable
  # by hand); this step is for decommissioning, not for cost-cutting.
  if [ "$DESTROY_PVC" = 1 ]; then
    run "delete all PVCs in $FP_NS" kubectl -n "$FP_NS" delete pvc --all --wait=false --force >/dev/null \
      && after "claims deleted — the Retain PDs survive as orphaned released PVs until a human deletes them"
  fi
fi

# ---------------------------------------------------------------------------
say "6. What is left (and what still bills)"
if [ "$DRY_RUN" = 1 ]; then
  note "would report the pool, the retained PDs, the address and the bucket"
  exit 0
fi
printf '  pools:     %s\n' "$(gcloud container node-pools list --cluster "$CLUSTER" --zone "$ZONE" --project "$PROJECT" --format='value(name)' 2>/dev/null | tr '\n' ' ')"
printf '  instances: %s\n' "$(gcloud compute instances list --project "$PROJECT" --filter="zone=$ZONE" --format='value(name)' 2>/dev/null | grep -c gke || true)"
printf '  address:   %s\n' "$(gcloud compute addresses list --project "$PROJECT" --filter="name~'flexprice'" --format='value(name,status)' 2>/dev/null | tr '\n' ' ')"
printf '  disks:     %s\n' "$(gcloud compute disks list --project "$PROJECT" --filter="zone=$ZONE" --format='value(name,sizeGb,type)' 2>/dev/null | tr '\n' ' ')"
printf '  backup:    %s/%s/\n' "$BACKUP_BUCKET_URL" "$PREFIX"
if [ "$MODE" != park ]; then
  note "the Retain PDs were kept on purpose: they are the whole billing data plane, and about \$7/month for five 5Gi pd-ssd disks."
  note "Restore capacity with: deploy/gcp/flexprice-recreate.sh --snapshot=${BACKUP_BUCKET_URL}/${PREFIX}"
  note "  (or --snapshot=latest once this run's prefix is the newest one in the bucket)"
  note "Or from CI: the 'FlexPrice node pool (cleanup / recreate)' workflow, action=recreate."
fi
