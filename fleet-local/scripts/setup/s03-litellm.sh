#!/usr/bin/env bash
# Setup step 3 — LiteLLM (helm-first) + the offline mock provider.
# Fresh-install counterpart of scripts/30-litellm.sh (which PATCHES an existing
# release). Baseline values: deploy/litellm/values-base.yaml — no plaintext
# credential anywhere; every secret is created here, fetched inline:
#   litellm-postgres     <- copied from flexprice's postgres secret
#   litellm-masterkey    <- generated once, kept on re-runs
#   litellm-fleet-secrets<- OPENROUTER_API_KEY from your env + the Flexprice
#                          API key minted into deploy/flexprice/.env by step 2
# The langfuse callback is NOT here yet: Langfuse needs the RustFS bucket that
# arrives with substrate, so scripts/30-litellm.sh adds it in step 5. On a
# re-run of a cluster that already has it, this step re-applies that patch
# itself — values-base would otherwise switch tracing off again.
# Prereq for online models: export OPENROUTER_API_KEY=... (skippable — mock-gpt
# still works; the secret is created empty and re-runnable later).
set -euo pipefail
SD="$(cd "$(dirname "$0")" && pwd)"; cd "$SD/../.."
source "$SD/_common.sh"
# fleet-local/.env (gitignored) may hold OPENROUTER_API_KEY recovered from the
# cluster or supplied by the operator; load it so the secret block picks it up.
[ -f .env ] && { set -a; . ./.env; set +a; }
# Sanitize: an echo-piped .env line or key import leaves trailing \r\n in the
# value; base64'd into the Secret it becomes "Bearer <key>\n" at the upstream
# and aiohttp rejects the request ("Forbidden control character detected in
# headers. Potential header injection attack").
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  OPENROUTER_API_KEY=$(printf %s "$OPENROUTER_API_KEY" | tr -d ' \t\r\n')
fi

kc create namespace litellm --dry-run=client -o yaml | kc apply -f -

# --- flexprice store-name compatibility --------------------------------------
# The current flexprice chart (fullnameOverride: flexprice) names its stores
# flexprice-postgres / flexprice-redis. Every fleet script and values file was
# written against the running cluster's older names — flexprice-postgresql
# (+ pod -0, + secret) and flexprice-redis-master. Rather than fork those
# scripts, this creates the legacy names as pure aliases:
#   * ExternalName Services  -> DNS alias for litellm/langfuse/BFF/seed clients
#   * StatefulSet flexprice-postgresql (psql-client only, PGHOST -> real DB)
#     -> satisfies the `kubectl exec flexprice-postgresql-0` DB-creation calls
#   * the real DBs created here so 00-prereqs reports "exists" and never writes
#     to the wrong server.
apply_alias() { # <name> <target> <port>
  python3 -c "
import json,subprocess,sys
o={'apiVersion':'v1','kind':'Service','metadata':{'name':'$1','namespace':'flexprice'},
   'spec':{'type':'ExternalName','externalName':'$2.flexprice.svc.cluster.local','ports':[{'port':int('$3'),'name':'alias'}]}}
subprocess.run(['kubectl','--context','$CTX','apply','-f','-'],input=json.dumps(o),text=True,check=True)
" >/dev/null
}
apply_alias flexprice-postgresql flexprice-postgres 5432
apply_alias flexprice-redis-master flexprice-redis 6379
say "compat ExternalName services flexprice-postgresql + flexprice-redis-master applied"

if ! kc -n flexprice get sts flexprice-postgresql >/dev/null 2>&1; then
  REAL_IMG=$(kc -n flexprice get sts flexprice-postgres -o jsonpath='{.spec.template.spec.containers[0].image}')
  python3 - <<EOF >/dev/null
import json,subprocess
o={'apiVersion':'apps/v1','kind':'StatefulSet','metadata':{'name':'flexprice-postgresql','namespace':'flexprice','labels':{'fleet.local/role':'psql-alias'}},
   'spec':{'replicas':1,'serviceName':'flexprice-postgresql','selector':{'matchLabels':{'fleet.local/alias-of':'flexprice-postgres'}},
   'template':{'metadata':{'labels':{'fleet.local/alias-of':'flexprice-postgres'}},
    'spec':{'containers':[{'name':'psql','image':"$REAL_IMG",'command':['/bin/sh','-c','sleep infinity'],
      'env':[{'name':'PGHOST','value':'flexprice-postgres.flexprice.svc.cluster.local'},{'name':'PGUSER','value':'flexprice'}],
      'resources':{'requests':{'cpu':'5m','memory':'16Mi'},'limits':{'memory':'64Mi'}}}]}},
   'volumeClaimTemplates':[]}}
subprocess.run(['kubectl','--context','$CTX','apply','-f','-'],input=json.dumps(o),text=True,check=True)
EOF
  kc -n flexprice rollout status sts/flexprice-postgresql --timeout=3m
  say "compat psql-alias StatefulSet flexprice-postgresql-0 ready (client shell only, PGHOST -> real DB)"
fi

# --- secrets (idempotent: create once, never overwrite a rotation) -----------
# The flexprice chart keeps the postgres password in flexprice-secrets
# (key postgres-password; role name is pinned to "flexprice" by the seed
# contract). Older/live clusters also had a bitnami-style flexprice-postgresql
# secret, which scripts/20-langfuse.sh reads — create it as a compatibility
# bridge when missing so unmodified scripts keep working.
PGP=$(secret_value flexprice flexprice-secrets postgres-password)
if ! kc -n flexprice get secret flexprice-postgresql >/dev/null 2>&1; then
  kc -n flexprice create secret generic flexprice-postgresql \
    --from-literal=username=flexprice --from-literal=password="$PGP" \
    --dry-run=client -o yaml | kc apply -f -
  say "compat secret flexprice/flexprice-postgresql created from flexprice-secrets"
fi
if ! kc -n litellm get secret litellm-postgres >/dev/null 2>&1; then
  kc -n litellm create secret generic litellm-postgres \
    --from-literal=username=flexprice --from-literal=password="$PGP" \
    --dry-run=client -o yaml | kc apply -f -
  say "secret litellm-postgres created from flexprice-secrets"
fi
if ! kc -n litellm get secret litellm-masterkey >/dev/null 2>&1; then
  kc -n litellm create secret generic litellm-masterkey \
    --from-literal=masterkey="sk-$(openssl rand -hex 24)" \
    --dry-run=client -o yaml | kc apply -f -
  say "secret litellm-masterkey generated (read it back inline when needed; never print to shared logs)"
fi
if ! kc -n litellm get secret litellm-fleet-secrets >/dev/null 2>&1; then
  FP_KEY=$(env_file_value FLEXPRICE_API_KEY ../deploy/flexprice/.env)
  [ -n "$FP_KEY" ] || die "FLEXPRICE_API_KEY not in deploy/flexprice/.env — run step 2 first"
  kc -n litellm create secret generic litellm-fleet-secrets \
    --from-literal=OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}" \
    --from-literal=FLEXPRICE_API_KEY="$FP_KEY" \
    --from-literal=FLEXPRICE_API_URL=http://flexprice-api.flexprice.svc.cluster.local \
    --from-literal=FLEXPRICE_ENVIRONMENT_ID=00000000-0000-0000-0000-000000000000 \
    --dry-run=client -o yaml | kc apply -f -
  [ -n "${OPENROUTER_API_KEY:-}" ] && say "secret litellm-fleet-secrets created (OpenRouter online models enabled)" \
    || warn "OPENROUTER_API_KEY not exported — litellm-fleet-secrets created with an empty OpenRouter key; online models will 401 until you re-run this step with it set"
else
  # Self-heal the documented skip path: a secret created with an empty
  # OpenRouter key (no env export at first run) must pick the key up on a
  # re-run once it IS available — "keeping existing values" would otherwise
  # strand online models in 401 forever. Also repairs a key that was patched
  # in with echo — trailing \n in the Secret becomes a control character in
  # the upstream Authorization header and aiohttp rejects every call.
  # Never printed.
  STORED_OR=$(kc -n litellm get secret litellm-fleet-secrets -o jsonpath='{.data.OPENROUTER_API_KEY}' | base64 -d)
  STORED_OR_CLEAN=$(printf %s "$STORED_OR" | tr -d ' \t\r\n')
  if [ -n "$STORED_OR" ] && [ "$STORED_OR" != "$STORED_OR_CLEAN" ]; then
    kc -n litellm patch secret litellm-fleet-secrets -p \
      "{\"data\":{\"OPENROUTER_API_KEY\":\"$(printf %s "$STORED_OR_CLEAN" | base64)\"}}" >/dev/null
    kc -n litellm rollout restart deploy/litellm >/dev/null
    say "secret litellm-fleet-secrets: OPENROUTER_API_KEY re-keyed without whitespace/control chars — litellm restarting"
  elif [ -z "$STORED_OR" ] && [ -n "${OPENROUTER_API_KEY:-}" ]; then
    kc -n litellm patch secret litellm-fleet-secrets -p \
      "{\"data\":{\"OPENROUTER_API_KEY\":\"$(printf %s "$OPENROUTER_API_KEY" | base64)\"}}" >/dev/null
    kc -n litellm rollout restart deploy/litellm >/dev/null
    say "secret litellm-fleet-secrets: OPENROUTER_API_KEY filled (was empty) — litellm restarting"
  elif [ -n "${OPENROUTER_API_KEY:-}" ] && [ "$STORED_OR_CLEAN" != "$OPENROUTER_API_KEY" ]; then
    say "secret litellm-fleet-secrets exists — keeping existing OpenRouter key (delete it or patch to rotate)"
  else
    say "secret litellm-fleet-secrets exists — keeping existing values"
  fi
fi

# --- callbacks + mock provider ------------------------------------------------
# The LiteLLM schema lives in its own database on flexprice's postgres — the
# bitnami-era install had it pre-created; the fresh chart does not, and prisma
# fails startup with P1003 without it.
if ! kc -n flexprice exec sts/flexprice-postgres -- \
     psql -U flexprice -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='litellm'" \
     | grep -q 1; then
  kc -n flexprice exec sts/flexprice-postgres -- \
    psql -U flexprice -d postgres -c 'CREATE DATABASE litellm OWNER flexprice'
  say "database litellm created on flexprice-postgres"
  kc -n litellm delete job litellm-migrations --ignore-not-found >/dev/null 2>&1 || true
fi

kc -n litellm create configmap litellm-callback \
  --from-file=flexprice_callback.py=deploy/litellm/flexprice_callback.py \
  --from-file=fleet_metadata.py=deploy/litellm/fleet_metadata.py \
  --from-file=fleet_identity.py=deploy/litellm/fleet_identity.py \
  --dry-run=client -o yaml | kc apply -f -
kc -n litellm create configmap llm-mock-srv \
  --from-file=server.py=deploy/litellm/llm-mock-server.py \
  --dry-run=client -o yaml | kc apply -f -
kc apply -f deploy/litellm/llm-mock.yaml

helm upgrade --install litellm oci://ghcr.io/berriai/litellm-helm \
  --version 1.109.1 --namespace litellm \
  -f deploy/litellm/values-base.yaml --timeout 10m --wait

# values-base is the FULL fresh-install values set, so this upgrade REPLACES the
# user values a later `--reuse-values` added — and that silently drops the
# langfuse half of the callback chain (`- langfuse` + environmentSecrets
# litellm-langfuse-keys). The LiteLLM UI then reads "Hosted Langfuse tracing is
# disabled" and no trace lands, while Flexprice billing keeps working (its
# callback is in values-base), so nothing else complains. Re-apply the bridge
# instead of warning: the old guard read `helm get values` AFTER this upgrade,
# i.e. the values it had just replaced, so it never fired. Only when
# litellm-langfuse-keys already exists — on a fresh cluster Langfuse is not
# installed yet, and step 5/5b wires it from scratch with scripts/30-litellm.sh.
if kc -n litellm get secret litellm-langfuse-keys >/dev/null 2>&1; then
  say "litellm-langfuse-keys exists — values-base just replaced the langfuse half; re-applying the patch"
  helm upgrade litellm oci://ghcr.io/berriai/litellm-helm --version 1.109.1 -n litellm \
    --kube-context "$CTX" --reuse-values -f deploy/litellm/values-patch.yaml --timeout 5m --wait
fi

kc -n litellm rollout status deploy/litellm --timeout=180s
say "STEP3 OK — litellm up (mock-gpt via llm-mock; openrouter/* pending keys if not exported)"
