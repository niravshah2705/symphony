#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Postgres sidecar entrypoint for the LiteLLM gateway (Cloud Run multi-container).
#
# Runs FIRST in the instance: the LiteLLM `app` container declares
# depends_on [postgres, redis] and its startup probe waits on
# /health/liveliness, so this container only has to bring Postgres up.
#
# EVERY BOOT IS A COLD BOOT. PGDATA lives on an emptyDir, which Cloud Run destroys
# on redeploy, restart and scale-to-zero. That is the accepted cost of not paying
# for Cloud SQL: spend logs and trace rows from the previous instance are gone,
# and nothing here tries to resurrect them. initdb-if-empty is the stock image's
# own job (it detects $PGDATA/PG_VERSION), so this wrapper adds no state logic.
#
# NEVER PRINT THE DATABASE URL OR ANY KEY MATERIAL. Cloud Run ships stdout to
# Cloud Logging, whose access is far broader than the secret's own IAM boundary
# (services/proxy/CLAUDE.md invariant 4). Log the SHAPE of what happened, not values.
set -euo pipefail

WAIT_SECONDS="${LITELLM_DB_WAIT_SECONDS:-300}"

log() { printf 'litellm-db: %s\n' "$*"; }

log "starting postgres (PGDATA=${PGDATA:-/var/lib/postgresql/data/pgdata})"
docker-entrypoint.sh postgres &
PG_PID=$!

# Readiness on loopback — the exact address LiteLLM and the probes use, so a
# socket-only success cannot mask a refused TCP listener.
deadline=$(( $(date +%s) + WAIT_SECONDS ))
until pg_isready -h 127.0.0.1 -p 5432 -U postgres -q; do
  if ! kill -0 "${PG_PID}" 2>/dev/null; then
    log "postgres exited before becoming ready; failing so Cloud Run restarts the instance"
    exit 1
  fi
  if [ "$(date +%s)" -ge "${deadline}" ]; then
    log "postgres not ready within ${WAIT_SECONDS}s; failing so Cloud Run restarts the instance"
    exit 1
  fi
  sleep 2
done
log "postgres ready on 127.0.0.1:5432"

# LiteLLM applies its own migrations at startup when DATABASE_URL is set, so no
# schema work happens here. If the CLI is ever added to this image the step below
# is idempotent and safe to enable.
if command -v litellm >/dev/null 2>&1; then
  log "litellm CLI present, applying schema migrations"
  litellm --migrate || log "migration reported a failure; the app container retries on its own boot"
fi

# A sidecar that exits ends the whole instance, so stay attached to the postmaster.
wait "${PG_PID}"
