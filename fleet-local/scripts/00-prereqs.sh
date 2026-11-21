#!/usr/bin/env bash
# P0 prerequisites for the fleet edge + control plane. Idempotent; safe to re-run.
#   - Secret fleet-system/google-oauth   (from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env)
#   - TLS Secret fleet-system/fleet-local-tls  (mkcert: app.fleet.dev + kagent.fleet.dev ONLY)
#   - /etc/hosts entries for those two hosts
#   - postgres dbs fleet_control + langfuse on flexprice-postgresql
#   - ClickHouse database langfuse
#   - RustFS bucket langfuse (Job, mirrors the existing ate-snapshots bucket-init)
# No credential is printed or written to a repo file. Google values come from the
# environment you export; everything else is fetched inline from in-cluster Secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

NS=fleet-system
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -

# --- Google OAuth secret -----------------------------------------------------
# Export the Firebase project's GCP Web client values before running:
#   export GOOGLE_CLIENT_ID=...apps.googleusercontent.com
#   export GOOGLE_CLIENT_SECRET=...
# The Web client must authorize redirect URIs:
#   https://app.fleet.dev/oauth2/callback   https://kagent.fleet.dev/oauth2/callback
if kubectl -n "$NS" get secret google-oauth >/dev/null 2>&1; then
  # oauth2-proxy uses the value VERBATIM: it must be exactly 16/24/32 chars
  # for AES. `openssl rand 32 | base64` yields 44 and crash-loops both proxies
  # ("cookie_secret must be 16, 24, or 32 bytes … but is 44"). Self-heal an
  # old-format secret in place; rotation only logs users out once.
  CSLEN=$(kubectl -n "$NS" get secret google-oauth -o jsonpath='{.data.cookie-secret}' | base64 -d | wc -c | tr -d ' \n')
  case "$CSLEN" in
    16|24|32) echo "secret google-oauth exists — keeping existing values" ;;
    *) kubectl -n "$NS" patch secret google-oauth -p \
         "{\"data\":{\"cookie-secret\":\"$(openssl rand -hex 16 | base64)\"}}" >/dev/null
       echo "secret google-oauth: cookie-secret re-keyed to 32 chars (was $CSLEN; oauth2-proxy needs 16/24/32)" ;;
  esac
else
  : "${GOOGLE_CLIENT_ID:?export GOOGLE_CLIENT_ID (GCP Web client id) before running}"
  : "${GOOGLE_CLIENT_SECRET:?export GOOGLE_CLIENT_SECRET (GCP Web client secret) before running}"
  COOKIE=$(openssl rand -hex 16)   # 32 chars — see the length contract above
  kubectl -n "$NS" create secret generic google-oauth \
    --from-literal=client-id="$GOOGLE_CLIENT_ID" \
    --from-literal=client-secret="$GOOGLE_CLIENT_SECRET" \
    --from-literal=cookie-secret="$COOKIE" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "created secret google-oauth"
fi

# --- TLS cert (mkcert) for the two exposed hosts -----------------------------
if kubectl -n "$NS" get secret fleet-local-tls >/dev/null 2>&1; then
  echo "secret fleet-local-tls exists — keeping existing cert"
else
  command -v mkcert >/dev/null 2>&1 || { echo "mkcert absent: brew install mkcert && mkcert -install" >&2; exit 1; }
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  mkcert -cert-file "$tmp/tls.crt" -key-file "$tmp/tls.key" app.fleet.dev kagent.fleet.dev >/dev/null 2>&1
  kubectl -n "$NS" create secret tls fleet-local-tls \
    --cert="$tmp/tls.crt" --key="$tmp/tls.key" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "created secret fleet-local-tls (app.fleet.dev, kagent.fleet.dev)"
fi

# --- /etc/hosts (needs sudo; best-effort) ------------------------------------
if grep -qE 'app\.fleet\.dev' /etc/hosts; then
  echo "/etc/hosts already maps app.fleet.dev"
else
  echo "adding app.fleet.dev + kagent.fleet.dev to /etc/hosts (sudo)"
  printf '127.0.0.1 app.fleet.dev kagent.fleet.dev\n' | sudo tee -a /etc/hosts >/dev/null \
    || echo "WARN: could not edit /etc/hosts — add '127.0.0.1 app.fleet.dev kagent.fleet.dev' manually"
fi

# --- postgres databases ------------------------------------------------------
PGPW=$(kubectl -n flexprice get secret flexprice-postgresql -o jsonpath='{.data.password}' | base64 -d)
for db in fleet_control langfuse; do
  exists=$(kubectl -n flexprice exec flexprice-postgresql-0 -- \
    env PGPASSWORD="$PGPW" psql -U flexprice -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='$db'" 2>/dev/null || true)
  if [ "$exists" = "1" ]; then
    echo "exists  database $db"
  else
    kubectl -n flexprice exec flexprice-postgresql-0 -- \
      env PGPASSWORD="$PGPW" psql -U flexprice -d postgres -c "CREATE DATABASE $db" >/dev/null
    echo "created database $db"
  fi
done

# --- ClickHouse database for Langfuse ----------------------------------------
# Quirk of the flexprice chart's CH config: connect as the IMPLICIT default
# user (plain `clickhouse-client`, no --user) — it has admin rights and
# localhost needs no password. Passing `--user default` explicitly instead
# fails Code 516 AUTHENTICATION_FAILED (users.d sets a password that config
# only consults for the named-user path), and `flexprice-secrets`'
# clickhouse-password belongs to the `flexprice` user, not `default`.
CH_POD=$(kubectl -n flexprice get pods --no-headers | grep clickhouse | awk '{print $1}' | head -1)
kubectl -n flexprice exec "$CH_POD" -- clickhouse-client \
  --query "CREATE DATABASE IF NOT EXISTS langfuse" >/dev/null
echo "clickhouse database langfuse ready"

# --- RustFS bucket langfuse (idempotent Job) ---------------------------------
# The bucket Job consumes ate-system/kagent-rustfs-credentials. s05 derives it
# too, but on a FRESH cluster s05 runs before step 6 created the rustfs
# deployment, so the same derivation must live here as well (ordering cycle:
# step 8 needs the bucket, the creds come from step 6). Values fetched inline,
# never printed; never overwrite a rotated secret.
if ! kubectl -n ate-system get secret kagent-rustfs-credentials >/dev/null 2>&1; then
  kubectl -n ate-system get deploy rustfs >/dev/null 2>&1 \
    || { echo "substrate rustfs deployment missing — run setup step 6 before this step" >&2; exit 1; }
  RAK=$(kubectl -n ate-system get deploy rustfs -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="RUSTFS_ACCESS_KEY")].value}')
  RSK=$(kubectl -n ate-system get deploy rustfs -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="RUSTFS_SECRET_KEY")].value}')
  [ -n "$RAK" ] && [ -n "$RSK" ] || { echo "rustfs deployment has no RUSTFS_ACCESS_KEY/SECRET_KEY envs" >&2; exit 1; }
  kubectl -n ate-system create secret generic kagent-rustfs-credentials \
    --from-literal=AWS_ACCESS_KEY_ID="$RAK" --from-literal=AWS_SECRET_ACCESS_KEY="$RSK" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "secret ate-system/kagent-rustfs-credentials derived from the rustfs deployment"
fi
# Additive rustfs policy (also applied by 20-langfuse.sh; applied HERE because
# this very Job needs it — its second rule admits pods labeled
# fleet.local/rustfs-bucket-init=true, matching the template label below).
kubectl apply -f deploy/networkpolicy/rustfs-langfuse.yaml
kubectl -n ate-system delete job rustfs-langfuse-bucket --ignore-not-found >/dev/null 2>&1 || true
kubectl apply -f - <<'YAML'
apiVersion: batch/v1
kind: Job
metadata:
  name: rustfs-langfuse-bucket
  namespace: ate-system
spec:
  backoffLimit: 3
  template:
    metadata:
      labels:
        fleet.local/rustfs-bucket-init: "true"
    spec:
      restartPolicy: Never
      containers:
        - name: aws
          image: amazon/aws-cli:2.38.5
          command: ["/bin/sh", "-c"]
          args:
            - |
              set -e
              for i in $(seq 1 60); do
                if aws s3api head-bucket --bucket langfuse 2>/dev/null; then
                  echo "bucket langfuse already exists"; exit 0
                fi
                if aws s3api create-bucket --bucket langfuse 2>/dev/null; then
                  echo "bucket langfuse created"; exit 0
                fi
                echo "waiting for rustfs... ($i/60)"; sleep 2
              done
              echo "timed out waiting for rustfs"; exit 1
          env:
            - name: AWS_ACCESS_KEY_ID
              valueFrom: { secretKeyRef: { name: kagent-rustfs-credentials, key: AWS_ACCESS_KEY_ID } }
            - name: AWS_SECRET_ACCESS_KEY
              valueFrom: { secretKeyRef: { name: kagent-rustfs-credentials, key: AWS_SECRET_ACCESS_KEY } }
            - name: AWS_REGION
              value: us-east-1
            - name: AWS_ENDPOINT_URL
              value: http://rustfs.ate-system.svc:9000
YAML
kubectl -n ate-system wait --for=condition=complete job/rustfs-langfuse-bucket --timeout=180s
echo "PREREQS OK"