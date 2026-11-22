#!/usr/bin/env bash
# T-30: self-hosted Flexprice dashboard UI + Temporal Web UI on kind.
#
# What this gives you (port 80 via ingress-nginx, hosts via /etc/hosts):
#   http://flexprice.local          -> flexprice-front (login: steps 4-5)
#   http://temporal.flexprice.local -> Temporal UI on the billing cluster's
#                                      flexprice-temporal-frontend:7233
# Login: email admin@flexprice.dev; the password is generated on first run and
# kept ONLY in gitignored fleet-local/.env as FLEXPRICE_UI_PASSWORD (step 4 —
# the chart seeds auths.token as plaintext but Login does
# bcrypt.CompareHashAndPassword, so the seeded row can never log in as-is).
#
# Steps (idempotent):
#   1) locate the pinned flexprice-front checkout (FLEXPRICE_FRONT_CHECKOUT or
#      /Users/niravshah/git/flexprice-front-pinned-*); clone v2.0.22 if missing
#   2) docker build the static UI image (VITE_API_URL is a BUILD arg — Vite
#      inlines import.meta.env, so it cannot be changed by container env later)
#      + kind load; skip the build if the image is already present
#   3) apply deploy/uis/uis.yaml (flexprice-ui + temporal-ui + ingresses),
#      roll pods (mutable local tag + imagePullPolicy=Never trap)
#   4) bootstrap the dashboard login: replace the plaintext seeded auths.token
#      with a bcrypt hash (pgcrypto crypt()) of FLEXPRICE_UI_PASSWORD from
#      fleet-local/.env, generating + storing one on first run
#   5) seed the workspace so the dashboard lands past its onboarding wizard:
#      grant the seeded admin the super_admin role (the chart leaves
#      users.roles NULL, and every RBAC-gated write then 403s) and PUT the
#      tenant name + onboarding metadata the "Just three quick questions"
#      screen would otherwise ask for
#   6) verify: both hosts answer over :80, login returns a JWT, the served
#      bundle carries the intended build args, and a headless browser completes
#      the real login form (t30-ui-login-check.mjs), and the Temporal UI can
#      reach its frontend
set -euo pipefail
CTX=${KCTX:-kind-flexprice-local}
KIND_CLUSTER=${KIND_CLUSTER:-flexprice-local}
k() { kubectl --context "$CTX" "$@"; }
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
FRONT_REF=${FRONT_REF:-v2.0.22}
FRONT_DEFAULT=/Users/niravshah/git/flexprice-front-pinned-${FRONT_REF}
FRONT=${FLEXPRICE_FRONT_CHECKOUT:-$FRONT_DEFAULT}
IMAGE=fleet-flexprice-ui:local
API_URL=${VITE_API_URL:-http://api.flexprice.local/v1}
# Must be 'self-hosted' or the built SPA's login button calls the Supabase mock
# instead of /v1/auth/login (T-17.11).
APP_ENV=${VITE_APP_ENV:-self-hosted}

echo "== 1) pinned flexprice-front checkout =="
if [ ! -f "$FRONT/package.json" ]; then
  echo "cloning flexprice-front $FRONT_REF -> $FRONT"
  git clone --depth 1 --branch "$FRONT_REF" https://github.com/flexprice/flexprice-front "$FRONT"
fi
echo "frontend source: $FRONT ($(git -C "$FRONT" describe --tags --always 2>/dev/null || echo unknown))"

echo "== 2) build + load $IMAGE =="
# --network host: npm ci in the vite build stage needs registry access from the
# default kind-buildx bridge; rebuild only when the image is absent, is older
# than the inlined build args, or FORCE=1.
image_build_info() {
  docker run --rm --entrypoint cat "$IMAGE" /usr/share/nginx/html/build-info.json 2>/dev/null || true
}
want="{\"apiUrl\":\"$API_URL\",\"appEnv\":\"$APP_ENV\"}"
have=$(tr -d ' \n' <<<"$(image_build_info)")
if [ "${FORCE:-0}" = 1 ]; then
  echo "FORCE=1: rebuilding"
elif [ -z "$have" ]; then
  echo "image missing (or predates build-info.json — the pre-self-hosted builds had no stamp): building"
elif [ "$have" != "$want" ]; then
  echo "image inlined a different build config:"
  echo "  have: $have"
  echo "  want: $want"
else
  echo "image present with the right build args, skipping build (FORCE=1 to rebuild)"
fi
if [ "${FORCE:-0}" = 1 ] || [ "$have" != "$want" ]; then
  docker build -f "$ROOT/deploy/uis/flexprice-ui/Dockerfile" \
    --build-arg VITE_API_URL="$API_URL" --build-arg VITE_APP_ENV="$APP_ENV" \
    -t "$IMAGE" "$FRONT"
  # An unchanged 'want' still needs one rebuild pass to become comparable:
  have=$(tr -d ' \n' <<<"$(image_build_info)")
  [ "$have" = "$want" ] || { echo "FAIL: build stamp $have != $want"; exit 1; }
fi
kind load docker-image "$IMAGE" --name "$KIND_CLUSTER"

echo "== 3) apply uis.yaml + roll =="
k apply -f "$ROOT/deploy/uis/uis.yaml"
# imagePullPolicy=Never + mutable tag: apply alone would not re-pull.
k -n flexprice rollout restart deploy/flexprice-ui
# temporal-ui is a pinned upstream tag, but restarting keeps this script's
# "apply -> everything current" contract cheap and idempotent.
k -n flexprice rollout restart deploy/temporal-ui
k -n flexprice rollout status deploy/flexprice-ui --timeout=180s
k -n flexprice rollout status deploy/temporal-ui --timeout=180s

echo "== 4) bootstrap dashboard login (bcrypt hash for the seeded admin) =="
ENVF="$ROOT/.env"
UIPW=$(grep -E '^FLEXPRICE_UI_PASSWORD=' "$ENVF" 2>/dev/null | tail -1 | cut -d= -f2- || true)
if [ -z "$UIPW" ]; then
  UIPW=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | cut -c1-20)
  printf 'FLEXPRICE_UI_PASSWORD=%s\n' "$UIPW" >> "$ENVF"
  echo "generated dashboard password -> fleet-local/.env (FLEXPRICE_UI_PASSWORD)"
else
  echo "reusing FLEXPRICE_UI_PASSWORD from fleet-local/.env"
fi
PGPW=$(k -n flexprice get secret flexprice-postgresql -o jsonpath='{.data.password}' | base64 -d)
# exec -i (without it psql reads empty stdin and exits 0 — silent no-op, T-16.7).
# psql variable :'PW' keeps the password out of the SQL string literal.
k -n flexprice exec -i flexprice-postgresql-0 -- env PGPASSWORD="$PGPW" \
  psql -U flexprice -d flexprice -v PW="$UIPW" -tA <<'EOSQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
UPDATE public.auths
   SET token = crypt(:'PW', gen_salt('bf', 8)),
       updated_at = CURRENT_TIMESTAMP
 WHERE provider = 'flexprice'
   AND user_id = '00000000-0000-0000-0000-000000000000'
RETURNING user_id;
EOSQL

echo "== 5) super_admin role + onboarding values (skip the wizard) =="
# The chart seeds users.roles NULL and the JWT carries no roles claim (the
# resolver re-reads the user row per request), so a fresh install 403s on every
# RBAC-gated write -- including the wizard's own PUT /v1/tenants/update.
# roles ONLY: users.type stays 'user'. 'owner' is not a valid UserType
# (internal/types/user.go:9-16 accepts user|service_account), and the dashboard
# passes user.type to GET /v1/rbac/roles?user_type=..., which then 400s with
# "User type must be 'user' or 'service_account'".
k -n flexprice exec -i flexprice-postgresql-0 -- env PGPASSWORD="$PGPW" \
  psql -U flexprice -d flexprice -tA <<'EOSQL'
UPDATE public.users
   SET roles = '["super_admin"]'::jsonb, updated_at = CURRENT_TIMESTAMP
 WHERE id = '00000000-0000-0000-0000-000000000000'
   AND (roles IS NULL OR roles <> '["super_admin"]'::jsonb)
RETURNING id;
EOSQL
# The user row is Redis-cached (internal/cache PrefixUser), and a raw UPDATE
# bypasses the repository's invalidation -- without this the API keeps serving
# the cached roles:[] and the PUT below 403s.
k -n flexprice exec flexprice-redis-0 -- sh -c \
  'for key in $(redis-cli --scan --pattern "*user:v1*"); do redis-cli del "$key" >/dev/null; done; echo user_cache_flushed'

# Same contract the onboarding wizard uses: PUT /v1/tenants/update with
# name + metadata{onboarding_completed,onboarding_referral_source,
# onboarding_organization_url}. Dashboard JWTs also need X-Environment-ID.
TENANT_NAME=${TENANT_NAME:-Fleet Local}
ORGHREF=${ONBOARDING_ORG_URL:-http://flexprice.local}
REFERRAL=${ONBOARDING_REFERRAL:-ChatGPT / Perplexity / Gemini}
LOGIN_JSON=$(curl -s --resolve api.flexprice.local:80:127.0.0.1 -X POST \
  http://api.flexprice.local/v1/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@flexprice.dev\",\"password\":\"$UIPW\"}")
DASH_JWT=$(printf '%s' "$LOGIN_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("token",""))')
if [ -z "$DASH_JWT" ]; then
  echo "FAIL: no dashboard JWT (login body above) — cannot set tenant metadata"; exit 1
fi
code=$(curl -s --resolve api.flexprice.local:80:127.0.0.1 -o /tmp/t30-tenant.json -w '%{http_code}' \
  -X PUT http://api.flexprice.local/v1/tenants/update \
  -H "Authorization: Bearer $DASH_JWT" -H 'X-Environment-ID: 00000000-0000-0000-0000-000000000001' \
  -H 'Content-Type: application/json' -d "$(cat <<EOF
{"name":"$TENANT_NAME","metadata":{"onboarding_completed":"true","onboarding_referral_source":"$REFERRAL","onboarding_organization_url":"$ORGHREF"}}
EOF
)")
if [ "$code" = "200" ]; then
  echo "tenant seeded: $TENANT_NAME (onboarding_completed=true, referral=$REFERRAL, url=$ORGHREF)"
else
  echo "FAIL: PUT /v1/tenants/update -> $code (body in /tmp/t30-tenant.json)"; exit 1
fi

echo "== 6) verify over host :80 =="
code=$(curl -s --resolve api.flexprice.local:80:127.0.0.1 -o /tmp/t30-login.json -w '%{http_code}' \
  -X POST http://api.flexprice.local/v1/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@flexprice.dev\",\"password\":\"$UIPW\"}")
if [ "$code" = "200" ] && grep -q '"token"' /tmp/t30-login.json; then
  echo "login OK — dashboard JWT issued for admin@flexprice.dev"
else
  echo "FAIL: login returned $code (body in /tmp/t30-login.json)"; exit 1
fi
curl -fsS -o /tmp/t30-flexprice-ui.html -w 'flexprice.local -> %{http_code}\n' http://flexprice.local/
# The served bundle must be the one step 2 just built (Vite inlines env at build
# time, so a stale image would still answer 200 above):
served=$(curl -fsS http://flexprice.local/build-info.json 2>/dev/null | tr -d ' \n' || true)
if [ "$served" = "$want" ]; then
  echo "served bundle build config: $served"
else
  echo "FAIL: served build-info.json is '$served', expected '$want' — pod is running an older image; re-run with FORCE=1 and check the rollout"; exit 1
fi
# Browser-level login: this is the only check that catches the SPA taking the
# Supabase branch instead of calling /v1/auth/login (T-17.11). Skipped when
# Playwright's chromium is not installed.
if node -e 'import("playwright").then(p=>p.chromium.executablePath())' >/dev/null 2>&1; then
  node "$ROOT/scripts/fixes/t30-ui-login-check.mjs" admin@flexprice.dev "$UIPW" \
    || { echo "FAIL: browser login check (see above)"; exit 1; }
else
  echo "NOTE: skipping the browser login check (npx playwright install chromium)"
fi
# SPA shell: the built index.html must reference /assets (Vite output), not the
# dev-server template.
grep -q '/assets/' /tmp/t30-flexprice-ui.html && echo "flexprice.local serves the built SPA" \
  || { echo "FAIL: no /assets/ reference — stale or dev build served"; exit 1; }
curl -fsS -o /tmp/t30-temporal-ui.html -w 'temporal.flexprice.local -> %{http_code}\n' http://temporal.flexprice.local/
grep -qi '<!doctype html>' /tmp/t30-temporal-ui.html || { echo "FAIL: no HTML shell from temporal.flexprice.local"; exit 1; }
# UI server -> temporal frontend reachability is the authoritative check (the
# SPA shell itself contains no "temporal" string to grep):
curl -fsS http://temporal.flexprice.local/api/v1/namespaces | grep -q '"default"' \
  && echo "temporal UI reaches the flexprice temporal cluster (default namespace visible)" \
  || { echo "FAIL: /api/v1/namespaces did not list default — k -n flexprice logs deploy/temporal-ui"; exit 1; }

echo
echo "DONE."
echo "  Flexprice dashboard: http://flexprice.local"
echo "    login: admin@flexprice.dev / grep FLEXPRICE_UI_PASSWORD $ENVF"
echo "    step 5 pre-answers the onboarding wizard, so login lands in the"
echo "    workspace; if the wizard still shows, clear the localStorage key"
echo "    flexprice_onboarding_completed_v1 and reload"
echo "  Temporal UI:         http://temporal.flexprice.local  (namespace: default)"
