# -----------------------------------------------------------------------------
# Substrate control-plane bearer token — the Secret Manager container plus its
# two narrow grants (CI writes, settings reads).
# -----------------------------------------------------------------------------
# The Substrate `api` service (GKE namespace `ate-system`) admits exactly one
# credential: a Kubernetes PROJECTED service-account token — issuer
# `https://container.googleapis.com/v1/projects/<project>/locations/<zone>/clusters/<cluster>`,
# audience `api.ate-system.svc`, subject
# `system:serviceaccount:ate-system:ate-client`. A Cloud Run workload cannot
# mint one for itself (docs/SUBSTRATE_INTEGRATION.md §5.3 item 4), so a
# scheduled CI job mints it and publishes it here; the settings service then
# supplies it on the outbound gRPC call.
#
# Deliberately NOT in var.managed_provider_secrets. That map is a cold-start
# contract — every entry is mounted as an env `value_source` on the settings
# revision (settings_service.tf:223-234) and is therefore resolved once, at
# container start. This credential has a bounded lifetime (minted for 12 h,
# republished every 6 h by .github/workflows/substrate-token-rotate.yml), so a
# mount hands the caller a stale credential the first time a revision outlives a
# rotation. An env is also precisely where a model run looks: a
# cluster-privileged bearer must not sit in `process.env`. Accessor only, no env
# — settings reads `versions/latest` on demand and memoises it for at most
# `SUBSTRATE_ATEAPI_TOKEN_TTL_SECONDS` (default 300 s), so the cache can never
# outlive the credential it holds.
#
# The VALUE is written out-of-band by the rotator, never by Terraform (same
# rule as secrets.tf), so nothing here lands a token in state.

resource "google_secret_manager_secret" "substrate_ateapi_token" {
  project   = var.project_id
  secret_id = "substrate-ateapi-token"
  labels    = merge(local.common_labels, { component = "substrate" })

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

# Reader: settings-sa, scoped to this one secret (not project-wide) so holding
# it grants no visibility into the provider keys the same SA mounts.
resource "google_secret_manager_secret_iam_member" "settings_substrate_ateapi_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.substrate_ateapi_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.settings.email}"
}

# Writer: the CI identity the rotator runs as. VersionAdd ONLY — the job may
# append a version and must never read back what it wrote, otherwise the one
# identity that can mint a cluster token could also harvest every version it
# ever published. The member is spelled from var.project_id instead of read
# through a data source because `gh-deployer` is created by
# deploy/gcp/bootstrap.sh step 3, outside this state.
resource "google_secret_manager_secret_iam_member" "substrate_ateapi_token_writer" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.substrate_ateapi_token.secret_id
  role      = "roles/secretmanager.secretVersionAdd"
  member    = "serviceAccount:gh-deployer@${var.project_id}.iam.gserviceaccount.com"
}
