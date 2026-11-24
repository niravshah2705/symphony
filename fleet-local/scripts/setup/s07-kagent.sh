#!/usr/bin/env bash
# Setup step 7 — kagent (helm) + the load-bearing :8083 NetworkPolicy.
#   - kagent-crds 1.0.1, then kagent 1.0.0 with deploy/kagent/values-base.yaml:
#     trusted-proxy auth (userIdClaim=email), substrate endpoints + client cert,
#     kagent-default WorkerPool (gvisor ateworker image), UI forwarded-header
#     allowlist. Fresh install already matches scripts/40-kagent-fix.sh's patch,
#     so that script becomes a no-op re-assert on this path.
#   - deploy/networkpolicy/kagent-controller.yaml admits kagent + fleet-system +
#     (ate-system AND app=atenet-egress) on 8083. The third entry is the T-08
#     fix: without it every actor golden-build dies on the bootstrap call
#     (gateway ~3s connect deadline vs packet drop). Never "simplify" it away.
#   - deploy/networkpolicy/postgres-kagent.yaml opens ate-system/postgres:5432
#     to the kagent controller (the substrate-owned policy allows ate-api-server
#     only; kagent's migrations otherwise die on a dial timeout). Separate
#     policy on purpose: NetworkPolicies union, so a substrate helm rerun
#     cannot undo it.
set -euo pipefail
SD="$(cd "$(dirname "$0")" && pwd)"; cd "$SD/../.."
source "$SD/_common.sh"

# --- kagent database on the bundled substrate postgres (atepg) ----------------
# The chart ships no DB bootstrap: the controller mounts two DSN Secrets
# (kagent-postgres-{owner,readwrite}) and authenticates with podcert client
# certificates only (setup.sql leaves the *_user logins password-less). Roles
# + the kagent schema come from substrate's parameterized setup.sql run a
# second time under kagent_* names; docs/SUBSTRATE_KAGENT_LOCAL.md §1b is the
# grant contract (ALTER DEFAULT PRIVILEGES FOR ROLE kagent_owner included —
# without it migrations work but the app gets 42501 on its own tables).
SUBSTRATE_WORKTREE="${SUBSTRATE_WORKTREE:-$HOME/git/ate/substrate-v1.0.1}"
SETUP_SQL="$SUBSTRATE_WORKTREE/pkg/postgressetup/setup.sql"
# Guard on the ROLES, not the secrets: an exec without -i sends no stdin, so a
# previous run could create the DSN secrets while psql silently committed
# nothing (symptom much later: FATAL role "kagent_owner_user" does not exist).
if ! kc -n ate-system exec postgres-0 -c postgres -- psql --no-psqlrc -U postgres \
       -d atepg -Atc "select 1 from pg_roles where rolname='kagent_owner_user'" | grep -q 1; then
  [ -f "$SETUP_SQL" ] || die "need substrate source at $SUBSTRATE_WORKTREE (step 6 creates the worktree) for kagent db bootstrap"
  kc -n kagent get ns kagent >/dev/null 2>&1 || kc create namespace kagent
  kc -n ate-system exec -i postgres-0 -c postgres -- \
    psql --no-psqlrc --set=ON_ERROR_STOP=1 --single-transaction \
    --username=postgres --dbname=atepg \
    --set=substrate_schema=kagent --set=substrate_owner_role=kagent_owner \
    --set=substrate_owner_user=kagent_owner_user --set=substrate_owner_password= \
    --set=substrate_readwrite_role=kagent_readwrite \
    --set=substrate_readwrite_user=kagent_readwrite_user --set=substrate_readwrite_password= \
    < "$SETUP_SQL"
  say "kagent schema + kagent_{owner,readwrite} roles created on atepg"
  for pair in "kagent_readwrite_user:kagent-postgres-readwrite:readWriteConnectionString" \
              "kagent_owner_user:kagent-postgres-owner:ownerConnectionString"; do
    user="${pair%%:*}"; rest="${pair#*:}"; secret="${rest%%:*}"; key="${rest#*:}"
    # CA path differs from the substrate installer's DSN on purpose: the kagent
    # chart projects ONE volume (kagent_*.pem + trust-bundle.pem) at
    # /run/postgres.podcert.ate.dev — there is no servicedns mount in the
    # controller pod, and pgx reads sslrootcert AT PARSE TIME (a wrong path is
    # "invalid PostgreSQL connection string", not a runtime error).
    dsn="postgresql://$user@postgres.ate-system.svc:5432/atepg?sslmode=verify-full&sslrootcert=/run/postgres.podcert.ate.dev/trust-bundle.pem&sslcert=/run/postgres.podcert.ate.dev/$user.pem&sslkey=/run/postgres.podcert.ate.dev/$user.pem"
    kc -n kagent create secret generic "$secret" \
      --from-literal="$key=$dsn" --dry-run=client -o yaml | kc apply -f -
  done
  say "DSN secrets kagent-postgres-readwrite + kagent-postgres-owner created (podcert DSNs, no secrets printed)"
else
  say "kagent roles present on atepg — keeping existing schema/DSN secrets (drop role kagent_owner_user to re-run bootstrap)"
fi

# The postgres podcert signer only mints login certs for identities listed in
# the podcertificate-controller deployment's --postgres-client args (default:
# ate-system/ate-api-server). That deployment is bootstrap-applied and NOT
# helm-owned, so a step-6 rerun reverts this allowlist — s07 re-asserts it on
# every run (it runs after step 6 in the setup-env.sh order).
PC_ARG="--postgres-client=kagent/kagent-controller=kagent_owner_user,kagent_readwrite_user"
if ! kc -n podcertificate-controller-system get deploy podcertificate-controller \
     -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -qF "$PC_ARG"; then
  kc -n podcertificate-controller-system patch deploy podcertificate-controller --type=json \
    -p "[{\"op\":\"add\",\"path\":\"/spec/template/spec/containers/0/args/-\",\"value\":\"$PC_ARG\"}]" >/dev/null
  kc -n podcertificate-controller-system rollout status deploy/podcertificate-controller --timeout=3m
  say "signer allowlist extended: kagent-controller may mint kagent_*_user login certs"
fi

# Same revert-on-step-6-rerun problem for the DB host map: postgres-config's
# pg_hba.conf (static manifest inside ate-setup) admits only
# substrate_*_user logins on atepg, so kagent connections are refused with
# FATAL 28000 "no pg_hba.conf entry" even though TLS completes. The pod's
# tls-reloader sidecar hashes pg_hba.conf every 60s and SIGHUPs postgres on
# change, so a ConfigMap patch takes effect without a restart.
HBA_LINE="hostssl atepg kagent_owner_user,kagent_readwrite_user all cert"
if ! kc -n ate-system get cm postgres-config -o jsonpath='{.data.pg_hba\.conf}' | grep -qF "$HBA_LINE"; then
  kc -n ate-system get cm postgres-config -o json | python3 -c '
import json,sys
cm=json.load(sys.stdin)
line="'"$HBA_LINE"'"
cm["data"]["pg_hba.conf"]=cm["data"]["pg_hba.conf"].rstrip("\n")+"\n"+line+"  # fleet-local s07: kagent controller shares atepg (podcert auth, see postgres-kagent NetworkPolicy)\n"
for k in ("resourceVersion","uid","creationTimestamp","managedFields","ownerReferences"): cm["metadata"].pop(k,None)
print(json.dumps(cm))' | kc replace -f - >/dev/null
  # Allow one reloader interval (60s) plus slack before the controller's next
  # dial; without this the first helm --wait attempt can lose to the race.
  sleep 75
  say "pg_hba.conf extended for kagent_*_user (postgres tls-reloader hot-reloads)"
fi

# A PodCertificateRequest denial is PERMANENT for that request object; the
# stuck deployment also keeps its ProgressDeadlineExceeded condition after the
# fix lands. Restart so the pods re-issue requests with a fresh progress clock.
if kc -n kagent get deploy kagent-controller >/dev/null 2>&1; then
  if kc -n kagent get deploy kagent-controller -o jsonpath='{.status.conditions}' | grep -q ProgressDeadlineExceeded; then
    kc -n kagent rollout restart deploy/kagent-controller >/dev/null
    say "cleared stuck ProgressDeadlineExceeded on kagent-controller (rollout restart)"
  fi
fi

# Gate §1a for the kagent namespace itself: the ate-api-server NetworkPolicy
# admits :443 only from namespaces labeled ate.dev/api-access=true (minus
# worker-pool pods). Without it the controller boots, migrates, then dies on
# "substrate: dial ate-api dns:///api.ate-system.svc:443: context deadline
# exceeded". --overwrite keeps a substrate rerun from having dropped it.
kc label ns kagent ate.dev/api-access=true --overwrite >/dev/null

# Apply BEFORE the helm install: the substrate postgres NetworkPolicy admits
# :5432 only from ate-api-server, so without postgres-kagent the controller's
# first migration dials into a packet drop ("dial error: timeout").
kc apply -f deploy/networkpolicy/postgres-kagent.yaml \
         -f deploy/networkpolicy/kagent-controller.yaml

helm upgrade --install kagent-crds oci://ghcr.io/kagent-dev/kagent/helm/kagent-crds \
  --version 1.0.1 --namespace kagent --kube-context "$CTX" --wait

helm upgrade --install kagent oci://ghcr.io/kagent-dev/kagent/helm/kagent \
  --version 1.0.0 --namespace kagent --kube-context "$CTX" \
  -f deploy/kagent/values-base.yaml --wait --timeout 15m

# The chart renders the kagent-api RemoteMCPServer (the controller's own
# /mcp) without an opt-out label, but under trusted-proxy auth the controller
# has no caller token for its own discovery call -> endless "Unauthorized"
# reconcile errors and Accepted=False forever. kagent upstream's documented
# remedy (go/core/pkg/consts/labels.go): label the server
# kagent.dev/discovery=disabled — agents then resolve its tools at runtime
# with the credentials they carry. --overwrite because the chart re-applies
# the CR on every upgrade.
kc -n kagent label remotemcpserver kagent-api kagent.dev/discovery=disabled --overwrite >/dev/null

kc -n kagent rollout status deploy/kagent-controller --timeout=5m
kc -n kagent get cm kagent-controller -o yaml | grep -q 'mode: trusted-proxy' \
  && say "controller auth = trusted-proxy (userIdClaim: email)" \
  || die "controller configmap does not show trusted-proxy — check values-base vs helm status"
helm status kagent --namespace kagent --kube-context "$CTX" >/dev/null \
  && say "STEP7 OK — kagent 1.0.0 deployed (helm status is authoritative, not exit codes)"
