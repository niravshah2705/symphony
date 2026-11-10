#!/usr/bin/env bash
# substrate-cleanup.sh — back the substrate up, then take its compute away.
#
# The order is the whole design: nothing is destroyed before the backup is proven,
# because the one object that cannot be rebuilt is the PD behind
# ate-system/data-postgres-0 — it holds the atespaces, actors and the WorkerPool
# record. Every pool, route and config map in here is reproducible from this repo;
# that disk is not.
#
# What lands in the bucket (and what deliberately does not):
#   postgres-<utc>.sql.gz   pg_dumpall of the control-plane DB
#   pools.json              the live node-pool config — the input to substrate-recreate.sh
#   workerpool.yaml         the WorkerPool CR (its NAME is the scheduler contract)
#   ate-system.yaml         the ate-system workload objects, credentials masked
#   front.yaml              Gateway / HTTPRoute / EnvoyProxy / BackendTrafficPolicy
#   secrets.json            Secret NAMES and data KEYS only. No value is ever written,
#                           and the substrate-credentials namespace is inventoried but
#                           never copied: a resolved provider key in a bucket is a
#                           second copy with its own rotation path and no audit trail.
#   manifest.json           index: what was taken, from where, how to put it back
# Actor snapshots in ate-snapshots-* are the workers' own state and are left alone.
#
# Verified against the live bucket on the first run: the dump carries 18 CREATE TABLE
# and 0 role password hashes — atepg authenticates its substrate_owner /
# substrate_readwrite roles by workload certificate, not by a stored secret — and the
# namespace export has 0 `kind: Secret` objects and no private key material, only the
# CA certificates that ConfigMaps legitimately hold. Treat the prefix as sensitive
# regardless: an actor's prompts and session bindings are in those COPY blocks.
#
# Usage:
#   deploy/gcp/substrate-cleanup.sh                     # backup, then delete the pools
#   deploy/gcp/substrate-cleanup.sh --dry-run           # show every step, change nothing
#   deploy/gcp/substrate-cleanup.sh --backup-only       # backup, clear nothing
#   deploy/gcp/substrate-cleanup.sh --keep-pools        # park at 0 nodes, keep the pools
#   deploy/gcp/substrate-cleanup.sh --release-ip        # also delete the static address
#   deploy/gcp/substrate-cleanup.sh --with-disk-snapshot
#   deploy/gcp/substrate-cleanup.sh --skip-backup       # clear without a DB dump
#   deploy/gcp/substrate-cleanup.sh --destroy-pvc --yes # irreversible: PD + all metadata
set -uo pipefail

PROJECT="${PROJECT:-adlc-9e72f}"
CLUSTER="${CLUSTER:-substrate-multitenant}"
ZONE="${ZONE:-asia-south1-a}"
REGION="${REGION:-asia-south1}"
ATE_NS="ate-system"
POOL_NS="${POOL_NS:-substrate-workers}"
WORKER_CR="${WORKER_CR:-planner-pool}"
BACKUP_BUCKET_URL="${BACKUP_BUCKET_URL:-gs://${PROJECT}-substrate-backup}"
STATE_DIR="${STATE_DIR:-.substrate-state}"
# The pool names are the terraform module's, not guesses: primary_nodes uses
# var.node_pool_name and system_nodes var.system_node_pool_name.
PRIMARY_POOL="${PRIMARY_POOL:-substrate-node-pool}"
WORKER_POOL="${WORKER_POOL:-substrate-worker-pool}"
SYSTEM_POOL="${SYSTEM_POOL:-substrate-system-node-pool}"

MODE=delete           # delete | park | backup
DRY_RUN=0; RELEASE_IP=0; DESTROY_PVC=0; CONFIRMED=0; DISK_SNAPSHOT=0; SKIP_BACKUP=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)            DRY_RUN=1 ;;
    --keep-pools)         MODE=park ;;
    --backup-only)        MODE=backup ;;
    --release-ip)         RELEASE_IP=1 ;;
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
# after <message> reports a step that SUCCEEDED. In a dry run run() has already
# printed the "would …" line, and repeating it in the past tense would make a
# rehearsal read like a teardown that happened — which is exactly the misreading
# this script must not invite.
after() { [ "$DRY_RUN" = 1 ] || note "$1"; }
# Every mutating step goes through run, so --dry-run is a real rehearsal rather than
# a comment describing what the script would do.
run()  { local desc="$1"; shift
  if [ "$DRY_RUN" = 1 ]; then printf '  would %s\n' "$desc"; return 0; fi
  "$@"; }

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
PREFIX="${CLUSTER}/${STAMP}"
WORK="$(mktemp -d)"
trap '[ -n "${WORK:-}" ] && rm -rf "$WORK"' EXIT
FILES=()
publish() { # publish <file> — remember it for the upload and the manifest
  [ -s "$1" ] && FILES+=("$(basename "$1")")
  return 0
}

say "Preconditions"
kubectl get ns >/dev/null 2>&1 \
  || gcloud container clusters get-credentials "$CLUSTER" --zone "$ZONE" --project "$PROJECT" >/dev/null 2>&1 \
  || die "cannot reach $CLUSTER in $ZONE"
note "context: $(kubectl config current-context)"
note "mode: $MODE$([ "$DRY_RUN" = 1 ] && echo ' (dry run)') | backup target: ${BACKUP_BUCKET_URL}/${PREFIX}"

LIVE=$(gcloud container node-pools list --cluster "$CLUSTER" --zone "$ZONE" --project "$PROJECT" --format="value(name)" 2>/dev/null || true)
POOLS=""
for p in "$WORKER_POOL" "$PRIMARY_POOL" "$SYSTEM_POOL"; do
  printf '%s\n' "$LIVE" | grep -qx "$p" && POOLS="$POOLS $p" || note "pool $p does not exist"
done
note "pools found:${POOLS:- none}"
PG_RUNNING=$(kubectl -n "$ATE_NS" get pods -l app=postgres --no-headers 2>/dev/null | grep -c 'Running' || true)
[ "${PG_RUNNING:-0}" -ge 1 ] || note "WARNING: no Running postgres pod — a logical dump is impossible"

# ---------------------------------------------------------------------------
say "1. Backup: the control-plane database"
if [ "$SKIP_BACKUP" = 1 ]; then
  note "--skip-backup: no dump will be taken"
  [ "$MODE" = delete ] && [ "$DESTROY_PVC" = 1 ] && die "--skip-backup cannot be combined with --destroy-pvc"
elif [ "${PG_RUNNING:-0}" -ge 1 ]; then
  DUMP="$WORK/postgres-${STAMP}.sql.gz"
  # The variables are read INSIDE the pod, so no credential passes through this shell.
  if [ "$DRY_RUN" = 1 ]; then
    note "would run pg_dumpall inside sts/postgres | gzip, verify it, upload it"
  elif kubectl -n "$ATE_NS" exec statefulset/postgres -- \
         sh -c 'pg_dumpall -U "${POSTGRES_USER:-postgres}" --no-password' 2>/dev/null | gzip > "$DUMP"; then
    gzip -t "$DUMP" || die "the gzip is corrupt — refusing to clear anything"
    BYTES=$(wc -c <"$DUMP" | tr -d ' ')
    [ "${BYTES:-0}" -gt 200 ] || die "the dump is ${BYTES} bytes, which is not a control-plane DB"
    gunzip -c "$DUMP" | grep -qE 'CREATE ROLE|\\connect' \
      || die "the dump contains no CREATE ROLE or \\connect — it is not a full cluster dump"
    note "dump verified: ${BYTES} bytes gzipped"
    publish "$DUMP"
  else
    die "pg_dumpall failed — nothing will be cleared"
  fi
else
  note "skipped: postgres is not Running. The disk snapshot is then the only real backup."
fi

if [ "$DISK_SNAPSHOT" = 1 ]; then
  PD_VOL=$(kubectl -n "$ATE_NS" get pvc data-postgres-0 -o jsonpath='{.spec.volumeName}' 2>/dev/null)
  if [ -n "${PD_VOL:-}" ]; then
    run "snapshot ${PD_VOL}" gcloud compute disks snapshot "${PD_VOL#pvc-}" --zone "$ZONE" --project "$PROJECT" \
      --snapshot-names="${CLUSTER}-pg-${STAMP}" --quiet >/dev/null \
      && after "disk snapshot ${CLUSTER}-pg-${STAMP} taken (crash-consistent unless postgres was quiesced)" \
      || note "WARNING: disk snapshot failed"
  fi
fi

# ---------------------------------------------------------------------------
say "2. Backup: the configuration"
# The pools' live JSON is what turns the recreate script into a reproduction instead
# of a re-guess. bootDisk is preferred over diskType because GKE mirrors a Hyperdisk
# boot disk into both, and only bootDisk carries the provisioned IOPS/throughput that
# the N4 machine type actually requires.
clean_pool() { # clean_pool <slot> <name>
  local slot="$1" name="$2"
  local out="$WORK/pool-$slot.json"
  if [ "$DRY_RUN" = 1 ]; then printf '{}\n' > "$WORK/pool-$slot.clean.json"; return 0; fi
  if gcloud container node-pools describe "$name" --cluster "$CLUSTER" --zone "$ZONE" \
       --project "$PROJECT" --format="json(name,config,autoscaling)" >"$out" 2>/dev/null; then
    jq '{name: .name, machineType: .config.machineType,
         diskType:  (.config.bootDisk.diskType // .config.diskType),
         diskSizeGb: (.config.bootDisk.sizeGb  // .config.diskSizeGb),
         provisionedIops:       .config.bootDisk.provisionedIops,
         provisionedThroughput: .config.bootDisk.provisionedThroughput,
         imageType: .config.imageType,
         minNodes: .autoscaling.minNodeCount, maxNodes: .autoscaling.maxNodeCount,
         taints: [(.config.taints // [])[] | {key, value, effect}],
         labels: (.config.labels // {})}' "$out" > "$WORK/pool-$slot.clean.json"
    note "pool $slot: $(jq -r '"\(.machineType) \(.diskSizeGb)GB \(.diskType) \(.imageType) min\(.minNodes)/max\(.maxNodes)"' "$WORK/pool-$slot.clean.json")"
  else
    printf '{}\n' > "$WORK/pool-$slot.clean.json"
    note "pool $slot ($name): absent"
  fi
}
clean_pool worker "$WORKER_POOL"
clean_pool primary "$PRIMARY_POOL"
clean_pool system "$SYSTEM_POOL"
jq -n --slurpfile w "$WORK/pool-worker.clean.json" --slurpfile p "$WORK/pool-primary.clean.json" \
      --slurpfile s "$WORK/pool-system.clean.json" \
   '{capturedAt: "'"$STAMP"'", cluster: "'"$CLUSTER"'", zone: "'"$ZONE"'",
     pools: {worker: $w[0], primary: $p[0], system: $s[0]}}' > "$WORK/pools.json"
publish "$WORK/pools.json"

run "capture the WorkerPool CR" bash -c \
  "kubectl -n '$POOL_NS' get workerpool.ate.dev '$WORKER_CR' -o yaml > '$WORK/workerpool.yaml'" 2>/dev/null \
  && publish "$WORK/workerpool.yaml" || note "WorkerPool $POOL_NS/$WORKER_CR not found"

# No `secret` in this list: values must not reach the bucket, and the workload objects
# reference them by name anyway, which is all a restore needs to know.
ATE_KINDS="deployment,statefulset,daemonset,service,configmap,persistentvolumeclaim,httproute,gateway"
run "export ate-system objects" bash -c \
  "kubectl -n '$ATE_NS' get $ATE_KINDS -o yaml > '$WORK/ate-system.yaml' 2>/dev/null"
run "export the actor front" bash -c \
  "kubectl -n '$ATE_NS' get gateway,httproute -o yaml > '$WORK/front.yaml' 2>/dev/null; \
   kubectl -n envoy-gateway-system get envoyproxy.gateway.envoyproxy.io,backendtrafficpolicy.gateway.envoyproxy.io,service -o yaml >> '$WORK/front.yaml' 2>/dev/null; \
   kubectl get certificate,clusterissuer -A -o yaml >> '$WORK/front.yaml' 2>/dev/null; true"

if [ "$DRY_RUN" = 1 ]; then
  printf '# dry run\n' > "$WORK/ate-system.yaml"; printf '# dry run\n' > "$WORK/front.yaml"
fi

# A mask pass, not a filter: an inline `value:` is legitimate config right up until a
# DSN with a password is pasted into a StatefulSet, and the bucket must never find out
# after the fact. Anything whose NAME says credential is reduced to a placeholder, and
# the count is printed so a silently-empty result is visible instead of plausible.
mask_creds() { # mask_creds <file>
  [ -s "$1" ] || return 0
  local before after
  before=$(grep -cE '^[[:space:]]*-?[[:space:]]*name:[[:space:]]*[A-Za-z0-9_.-]*(TOKEN|SECRET|KEY|PASSWORD|PASSWD|DSN|CREDENTIAL|AUTH_KEY)[A-Za-z0-9_.-]*[[:space:]]*$' "$1" || true)
  if [ "${before:-0}" -gt 0 ] && [ "$DRY_RUN" != 1 ]; then
    perl -0777 -pi -e 's/^([ \t]*)(-?[ \t]*name:[ \t]*\S*(TOKEN|SECRET|KEY|PASSWORD|PASSWD|DSN|CREDENTIAL|AUTH_KEY)\S*[ \t]*\n)([ \t]+value:)[ \t]*.*$/$1$2$4 "***masked by substrate-cleanup***"/gmie' "$1"
  fi
  after=$(grep -c '\*\*\*masked by substrate-cleanup\*\*\*' "$1" || true)
  note "$(basename "$1"): ${before:-0} credential-shaped env names, ${after:-0} values masked"
}
mask_creds "$WORK/ate-system.yaml"
mask_creds "$WORK/front.yaml"
publish "$WORK/ate-system.yaml"; publish "$WORK/front.yaml"

# Names and keys only — the inventory a restore needs, with nothing to steal.
run "inventory secrets (names and keys only)" bash -c \
  "kubectl get secret -A -o json | jq -c '[.items[] | {ns: .metadata.namespace, name: .metadata.name, type, keys: ((.data // {}) | keys)}] | sort_by(.ns,.name)' > '$WORK/secrets.json'"
[ -s "$WORK/secrets.json" ] && note "$(jq -r 'length' "$WORK/secrets.json") secrets inventoried, no values" || printf '[]\n' > "$WORK/secrets.json"
publish "$WORK/secrets.json"

PD_LINE=$(kubectl -n "$ATE_NS" get pvc data-postgres-0 -o jsonpath='{.spec.volumeName} {.spec.resources.requests.storage} {.status.phase}' 2>/dev/null)
ADDR_LINE=$(gcloud compute addresses list --project "$PROJECT" --filter="name~'substrate'" --format="value(name,address,status)" 2>/dev/null | head -1)
LB_LINE=$(kubectl get svc -A -o json 2>/dev/null | jq -r '[.items[]
  | select(.spec.type=="LoadBalancer")
  | select(.metadata.namespace=="envoy-gateway-system" or .metadata.namespace=="ate-system")
  | "\(.metadata.namespace)/\(.metadata.name)"] | join(",")')
HOST=$(kubectl -n "$ATE_NS" get httproute -o jsonpath='{.items[0].spec.hostnames[0]}' 2>/dev/null)

jq -n --arg stamp "$STAMP" --arg project "$PROJECT" --arg cluster "$CLUSTER" --arg zone "$ZONE" \
   --arg region "$REGION" --arg prefix "$PREFIX" --arg bucket "$BACKUP_BUCKET_URL" \
   --arg mode "$MODE" --arg pd "${PD_LINE:-absent}" --arg addr "${ADDR_LINE:-none}" \
   --arg lb "${LB_LINE:-none}" --arg host "${HOST:-none}" --arg cr "${WORKER_CR}" \
   --argjson files "$(printf '%s\n' "${FILES[@]:-}" | jq -R . | jq -s 'map(select(. != ""))')" \
   '{capturedAt: $stamp, project: $project, cluster: $cluster, zone: $zone, region: $region,
     backupUri: ($bucket + "/" + $prefix + "/"), files: $files, mode: $mode,
     hostname: $host, loadBalancerServices: $lb, staticAddress: $addr,
     postgresPvc: $pd, workerPoolCr: $cr,
     secretsPolicy: "names and keys only; credential-shaped values masked; substrate-credentials never copied",
     restore: "substrate-recreate.sh reads pools.json from this prefix; the WorkerPool CR and ate-system itself come from substrate-control-plane.yml mode=install",
     doNotDelete: "the PD named by postgresPvc holds every atespace, actor and session key — it survives this script unless --destroy-pvc --yes"}' \
   > "$WORK/manifest.json"
publish "$WORK/manifest.json"

# ---------------------------------------------------------------------------
say "3. Upload"
if [ "$DRY_RUN" = 1 ]; then
  note "would ensure $BACKUP_BUCKET_URL exists ($REGION, uniform access) and cp ${#FILES[@]} objects to ${BACKUP_BUCKET_URL}/${PREFIX}/"
  note "would mirror pools.json + manifest.json into $STATE_DIR/ for substrate-recreate.sh"
else
  gcloud storage buckets describe "$BACKUP_BUCKET_URL" >/dev/null 2>&1 \
    || run "create $BACKUP_BUCKET_URL" gcloud storage buckets create "$BACKUP_BUCKET_URL" \
         --project "$PROJECT" --location "$REGION" --uniform-bucket-level-access >/dev/null \
    || die "cannot create or access $BACKUP_BUCKET_URL"
  SRC=(); for f in "${FILES[@]:-}"; do [ -n "$f" ] && SRC+=("$WORK/$f"); done
  run "upload ${#SRC[@]} objects" gcloud storage cp "${SRC[@]}" "${BACKUP_BUCKET_URL}/${PREFIX}/" >/dev/null \
    || die "upload failed — refusing to clear anything"
  N=$(gcloud storage ls "${BACKUP_BUCKET_URL}/${PREFIX}/*" 2>/dev/null | wc -l | tr -d ' ')
  [ "${N:-0}" -ge "${#SRC[@]}" ] || die "only $n of ${#SRC[@]} objects are in ${BACKUP_BUCKET_URL}/${PREFIX}/"
  note "verified ${N}/${#SRC[@]} objects under ${BACKUP_BUCKET_URL}/${PREFIX}/"
  # The local mirror is deliberately the two non-sensitive files. pools.json is what
  # substrate-recreate.sh reads by default; the dump stays off the working tree where
  # `git add -A` could pick it up.
  mkdir -p "$STATE_DIR"
  cp "$WORK/pools.json" "$WORK/manifest.json" "$STATE_DIR/" 2>/dev/null \
    && note "mirrored pools.json + manifest.json to $STATE_DIR/"
fi

# ---------------------------------------------------------------------------
say "4. Force clear"
if [ "$DESTROY_PVC" = 1 ] && [ "$CONFIRMED" != 1 ]; then
  die "--destroy-pvc needs --yes as well: it deletes the PD and every atespace and actor in it"
fi
if [ "$SKIP_BACKUP" != 1 ] && [ "$DRY_RUN" != 1 ] && [ "${#FILES[@]}" -lt 3 ]; then
  die "the backup produced only ${#FILES[@]} files — not clearing anything"
fi

if [ "$MODE" = backup ] && { [ "$DESTROY_PVC" = 1 ] || [ "$RELEASE_IP" = 1 ]; }; then
  die "--backup-only takes no teardown flag"
fi
if [ "$MODE" != backup ]; then
# Park first, then delete. A node-pool delete drains, and the PDBs on ate-api-server
# and ate-idp-server (minAvailable 1) block that drain until it times out; a pool that
# is already at 0 nodes has nothing to drain.
park() { run "park $1" gcloud container node-pools update "$1" --cluster "$CLUSTER" --zone "$ZONE" \
           --project "$PROJECT" --enable-autoscaling --min-nodes=0 --max-nodes=0 --quiet >/dev/null \
         && after "parked $1" || note "could not park $1 (continuing)"; }
for p in $POOLS; do park "$p"; done

if [ "$MODE" = park ]; then
  note "--keep-pools: everything is at 0 nodes and reversible with substrate-recreate.sh or a terraform apply"
else
  # Tenant and worker pools first, system pool last: the platform add-ons are pinned to
  # the system pool by nodeSelector, and the control plane is still sitting on it.
  for p in $POOLS; do
    [ "$p" = "$SYSTEM_POOL" ] && continue
    run "delete $p" gcloud container node-pools delete "$p" --cluster "$CLUSTER" --zone "$ZONE" \
      --project "$PROJECT" --quiet >/dev/null && after "deleted $p" || note "FAILED to delete $p"
  done
  case " $POOLS " in *" $SYSTEM_POOL "*)
    run "delete $SYSTEM_POOL" gcloud container node-pools delete "$SYSTEM_POOL" --cluster "$CLUSTER" \
      --zone "$ZONE" --project "$PROJECT" --quiet >/dev/null \
      && after "deleted $SYSTEM_POOL" || note "FAILED to delete $SYSTEM_POOL" ;;
  esac
  # The load balancer belongs to the in-cluster Service, not to the node pool: with the
  # pools gone, GKE has no nodes left to reconcile it and the forwarding rule, target
  # pool and health check keep billing against nothing.
  if [ "$DRY_RUN" = 1 ]; then
    note "would delete the LoadBalancer Services (${LB_LINE:-none}) unowned, so the controller releases the LB artifacts"
  else
    for svc in ${LB_LINE//,/ }; do
      run "delete $svc" kubectl -n "${svc%%/*}" delete svc "${svc##*/}" --wait=false --force >/dev/null \
        && after "deleted $svc — its service controller drops the rule, target pool and health check"
    done
  fi
fi

if [ "$DESTROY_PVC" = 1 ]; then
  run "delete data-postgres-0" kubectl -n "$ATE_NS" delete pvc data-postgres-0 --wait=false --force >/dev/null \
    && after "PVC deleted — check step 5 for whether the PD went with it"
fi
if [ "$RELEASE_IP" = 1 ]; then
  A=$(printf '%s' "${ADDR_LINE:-}" | awk '{print $1}')
  [ -n "$A" ] && { run "delete address $A" gcloud compute addresses delete "$A" --region "$REGION" \
                     --project "$PROJECT" --quiet >/dev/null \
                   && after "deleted $A — its DNS A record now points at nothing and must be removed too"; }
fi
else
  note "--backup-only: ${#FILES[@]} files under ${BACKUP_BUCKET_URL}/${PREFIX}/ — no pool, node, Service or disk was touched"
fi

# ---------------------------------------------------------------------------
say "5. What is left (and what still bills)"
if [ "$DRY_RUN" = 1 ]; then
  note "would report pools, GKE instances, LB artifacts, the address, the PD and the bucket"
  exit 0
fi
printf '  pools:     %s\n' "$(gcloud container node-pools list --cluster "$CLUSTER" --zone "$ZONE" --project "$PROJECT" --format='value(name)' 2>/dev/null | tr '\n' ' ')"
printf '  instances: %s\n' "$(gcloud compute instances list --project "$PROJECT" --filter="zone=$ZONE" --format='value(name)' 2>/dev/null | grep -c gke || true)"
printf '  fwd rules: %s\n' "$(gcloud compute forwarding-rules list --project "$PROJECT" --format='value(name)' 2>/dev/null | tr '\n' ' ')"
printf '  tgt pools: %s\n' "$(gcloud compute target-pools list --project "$PROJECT" --format='value(name)' 2>/dev/null | tr '\n' ' ')"
printf '  address:   %s\n' "$(gcloud compute addresses list --project "$PROJECT" --filter="name~'substrate'" --format='value(name,status)' 2>/dev/null | tr '\n' ' ')"
printf '  disks:     %s\n' "$(gcloud compute disks list --project "$PROJECT" --filter="zone:asia-south1-a" --format='value(name,sizeGb,type)' 2>/dev/null | tr '\n' ' ')"
printf '  backup:    %s/%s/\n' "$BACKUP_BUCKET_URL" "$PREFIX"
if [ "$DESTROY_PVC" != 1 ]; then
  note "the postgres PD was kept on purpose: about \$6/month, and the only copy of the metadata."
  note "Restore capacity with: deploy/gcp/substrate-recreate.sh --snapshot=${BACKUP_BUCKET_URL}/${PREFIX}"
fi
