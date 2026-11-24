#!/usr/bin/env bash
# Install Langfuse v3 (image 3.224.1) on external stores, unexposed (ClusterIP).
# Builds Secret/langfuse-stores once (stable salt/encryption keys across re-runs),
# then helm upgrade --install. No credential is printed or written to a repo file.
set -euo pipefail
cd "$(dirname "$0")/.."

NS=langfuse
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -

if kubectl -n "$NS" get secret langfuse-stores >/dev/null 2>&1; then
  echo "secret langfuse-stores exists — keeping existing keys"
else
  PGPW=$(kubectl -n flexprice get secret flexprice-postgresql -o jsonpath='{.data.password}' | base64 -d)
  S3AK=$(kubectl -n ate-system get secret kagent-rustfs-credentials -o jsonpath='{.data.AWS_ACCESS_KEY_ID}' | base64 -d)
  S3SK=$(kubectl -n ate-system get secret kagent-rustfs-credentials -o jsonpath='{.data.AWS_SECRET_ACCESS_KEY}' | base64 -d)
  SALT=$(openssl rand -base64 32)
  ENC=$(openssl rand -hex 32)
  NA=$(openssl rand -base64 32)
  LFSK=$(openssl rand -hex 32)
  ADMINPW=$(openssl rand -base64 24)
  kubectl -n "$NS" create secret generic langfuse-stores \
    --from-literal=postgres-password="$PGPW" \
    --from-literal=salt="$SALT" \
    --from-literal=encryption-key="$ENC" \
    --from-literal=nextauth-secret="$NA" \
    --from-literal=s3-access-key="$S3AK" \
    --from-literal=s3-secret-key="$S3SK" \
    --from-literal=langfuse-secret-key="$LFSK" \
    --from-literal=langfuse-admin-password="$ADMINPW" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "created secret langfuse-stores"
fi

# Dedicated ClickHouse user: the Langfuse v3 migration script requires a
# non-empty CLICKHOUSE_PASSWORD, so keep it in langfuse-stores and sync the CH
# user to it on every run. Admin calls connect as the IMPLICIT default user
# (no --user flag — same 516 quirk documented in 00-prereqs.sh), and no ||
# true: a failed CREATE/GRANT must break the run, not poison Langfuse later.
CH_POD=$(kubectl -n flexprice get pods --no-headers | grep clickhouse | awk '{print $1}' | head -1)
if kubectl -n "$NS" get secret langfuse-stores -o jsonpath='{.data.clickhouse-password}' 2>/dev/null | grep -q .; then
  CHPW=$(kubectl -n "$NS" get secret langfuse-stores -o jsonpath='{.data.clickhouse-password}' | base64 -d)
else
  CHPW=$(openssl rand -hex 24)
  kubectl -n "$NS" patch secret langfuse-stores -p "{\"data\":{\"clickhouse-password\":\"$(printf %s "$CHPW" | base64)\"}}" >/dev/null
fi
kubectl -n flexprice exec "$CH_POD" -- clickhouse-client --query "CREATE USER IF NOT EXISTS langfuse IDENTIFIED WITH plaintext_password BY '$CHPW'" >/dev/null
kubectl -n flexprice exec "$CH_POD" -- clickhouse-client --query "ALTER USER langfuse IDENTIFIED WITH plaintext_password BY '$CHPW'" >/dev/null
kubectl -n flexprice exec "$CH_POD" -- clickhouse-client --query "GRANT ALL ON langfuse.* TO langfuse" >/dev/null
kubectl -n flexprice exec "$CH_POD" -- clickhouse-client --query "GRANT SELECT ON system.* TO langfuse" >/dev/null
echo "clickhouse user langfuse ready"

# Langfuse uploads trace blobs to RustFS (ate-system, default-deny-ingress).
# Admit the langfuse namespace to rustfs:9000 or OTLP ingestion hangs on S3 PUT.
# (The `langfuse` bucket itself is created in P0 via the rustfs-bucket-init Job.)
kubectl apply -f deploy/networkpolicy/rustfs-langfuse.yaml

helm upgrade --install langfuse oci://ghcr.io/langfuse/langfuse-k8s/charts/langfuse \
  --version 2.2.0 -n "$NS" -f deploy/langfuse/values.yaml --timeout 10m --wait

echo "=== helm status (authoritative, not the exit code) ==="
# sed reads the whole stream; `| head -6` here SIGPIPE-killed helm (rc 141)
# and aborted the caller under set -o pipefail.
helm status langfuse -n "$NS" | sed -n '1,6p'
kubectl -n "$NS" get pods -o wide