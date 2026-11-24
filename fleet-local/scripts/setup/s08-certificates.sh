#!/usr/bin/env bash
# Setup step 8 — certificates + tenant-agnostic prerequisites, via the existing
# scripts/00-prereqs.sh (unchanged). Creates:
#   - Secret fleet-system/google-oauth      (client id/secret + cookie secret)
#   - Secret fleet-system/fleet-local-tls   (mkcert cert for app.fleet.dev +
#                                            kagent.fleet.dev ONLY)
#   - /etc/hosts entries, fleet_control + langfuse postgres dbs, langfuse CH db,
#     RustFS langfuse bucket
# Prereqs you supply (00-prereqs.sh refuses without them and prints the shape):
#   export GOOGLE_CLIENT_ID=...apps.googleusercontent.com
#   export GOOGLE_CLIENT_SECRET=...
#   and the GCP Web client must allow the redirect URIs
#   https://app.fleet.dev/oauth2/callback  https://kagent.fleet.dev/oauth2/callback
#   brew install mkcert && mkcert -install   (mkcert binary checked below)
set -euo pipefail
SD="$(cd "$(dirname "$0")" && pwd)"; cd "$SD/../.."
source "$SD/_common.sh"

command -v mkcert >/dev/null || die "mkcert missing: brew install mkcert && mkcert -install"
if ! kc -n fleet-system get secret google-oauth >/dev/null 2>&1; then
  : "${GOOGLE_CLIENT_ID:?export GOOGLE_CLIENT_ID (GCP Web client id) before running}"
  : "${GOOGLE_CLIENT_SECRET:?export GOOGLE_CLIENT_SECRET (GCP Web client secret) before running}"
fi

bash scripts/00-prereqs.sh
say "STEP8 OK — google-oauth + fleet-local-tls secrets, hosts entries, control/langfuse dbs, bucket"
