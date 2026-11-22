#!/usr/bin/env bash
# Setup step 9 — fleet services on the edge + Flexprice catalog seed.
# Delegates to the existing per-phase scripts (kept unmodified — they are also
# the patch path for a running cluster):
#   scripts/10-ingress-oauth.sh  oauth2-proxy (fleet + kagent, upstream mode,
#                                --set-authorization-header) + TLS Ingresses on
#                                app.fleet.dev / kagent.fleet.dev + nginx
#                                snippet-annotation enable + identity-header strip
#   scripts/40-kagent-fix.sh     re-assert trusted-proxy values-patch (no-op on
#                                the s07 path) + stale-Agent cleanup + :8083 NP
#   scripts/50-bff-spa.sh        build + kind-load the arm64 BFF/SPA image,
#                                deploy fleet-bff (inline Secret assembled from
#                                in-cluster Secrets — nothing plaintext), wait Ready
#   scripts/seed-flexprice.sh    fleet meters/plan/prices (idempotent; reads the
#                                Flexprice key from litellm-fleet-secrets, with
#                                the legacy deploy-env literal as fallback; also
#                                publishes the seeded plan ID into fleet-bff-config
#                                + restarts the BFF — T-15 item 23)
# After this step: log in at https://app.fleet.dev and run the 9-step wizard for
# org-demo (that is onboarding, per-tenant — not cluster setup).
set -euo pipefail
SD="$(cd "$(dirname "$0")" && pwd)"; cd "$SD/../.."
source "$SD/_common.sh"

bash scripts/10-ingress-oauth.sh
bash scripts/40-kagent-fix.sh
bash scripts/50-bff-spa.sh
bash scripts/seed-flexprice.sh

kc -n fleet-system rollout status deploy/fleet-bff --timeout=5m
say "STEP9 OK — edge auth, BFF+SPA, Flexprice catalog. Next: browser wizard (see docs/SETUP-ENVIRONMENT.md step 9 tail)"
