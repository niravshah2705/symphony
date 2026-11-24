#!/usr/bin/env bash
# Setup step 2 — Flexprice on kind, from the pinned upstream Helm chart.
# Everything happens in the repo-root tooling (this step deliberately does NOT
# reimplement it): deploy/flexprice/helm/values-kind.yaml + scripts/flexprice-helm.js,
# nine idempotent phases (preflight secrets chart infra dbinit temporal migration
# app verify). It refuses a non-kind kubectl context.
# Prereq: deploy/flexprice/.env exists with real secrets (mode 0600) — generated
# by `npm run billing:flexprice:bootstrap` at the repo root (it never prints them).
set -euo pipefail
SD="$(cd "$(dirname "$0")" && pwd)"; cd "$SD/../../.."          # repo root
source "$SD/_common.sh"
kc config current-context | grep -q 'kind-' || die "kubectl context is not a kind cluster"

if [ ! -f deploy/flexprice/.env ]; then
  die "deploy/flexprice/.env missing — run: npm run billing:flexprice:bootstrap  (repo root) first; it generates real secrets without printing them"
fi

# The chart is staged from the checkout named by FLEXPRICE_CHECKOUT in .env. It
# MUST sit at the deploy/flexprice/VERSION pin (21524530 / v2.1.48): a newer
# tree declares kafka/postgresql/redis/temporal subchart dependencies that the
# staging step strips, so `helm lint` fails at phase 3/9. Non-destructive fix:
#   git -C ~/git/flexprice worktree add --detach ~/git/flexprice-pinned-21524530 2152453032098000f8b76b07bc869013313ff338
# then point FLEXPRICE_CHECKOUT in deploy/flexprice/.env at that worktree.
CK=$(sed -n 's/^FLEXPRICE_CHECKOUT=//p' deploy/flexprice/.env | head -1)
PIN=$(sed -n 's/^commit=//p' deploy/flexprice/VERSION | head -1)
HEAD=$(git -C "${CK/#\~/$HOME}" rev-parse HEAD 2>/dev/null || echo missing)
if [ "${HEAD}" != "${PIN}" ]; then
  warn "FLEXPRICE_CHECKOUT ${CK} is at ${HEAD:0:8}, VERSION pins ${PIN:0:8} — staging may fail at 3/9 (see comment in this script)"
fi

if kc -n flexprice get deploy flexprice-api >/dev/null 2>&1 \
   && [ "$(helm --kube-context "$CTX" -n flexprice list -q 2>/dev/null | grep -c '^flexprice\s' || true)" = "1" ]; then
  say "flexprice release exists — re-running phases is idempotent, continuing"
fi

npm run billing:flexprice:helm -- --verbose
npm run billing:flexprice:provision          # mints THIS cluster's keys into .env (idempotent, never prints values)

kc -n flexprice wait --for=condition=Available deploy --all --timeout=5m
# api.flexprice.local over the retained nginx (seed-flexprice.sh + verify-e2e
# curl it via --resolve; the old cluster had this Ingress only ad-hoc — T-15.21).
kc apply -f fleet-local/deploy/ingress/flexprice-api.yaml
say "STEP2 OK — flexprice api/consumer/worker + postgres/clickhouse/kafka/redis/temporal up, api Ingress applied"
say "(no dashboard UI yet: the chart ships no frontend — run scripts/fixes/t30-selfhost-uis.sh for flexprice.local + temporal.flexprice.local; the fleet SPA at app.fleet.dev remains the operator UI)"
say "next: fleet meters/plan/price seed runs in step 9 (scripts/seed-flexprice.sh) once LiteLLM exists"
