# -----------------------------------------------------------------------------
# Firebase — project, web app, Hosting site, and Identity Platform (auth) config.
# -----------------------------------------------------------------------------
# These were originally created via the Firebase console/CLI and imported into
# Terraform (see docs/GCP_DEPLOY.md). All Firebase/Identity Platform resources
# require the google-beta provider.
#
# NOT managed here: the Google sign-in provider
# (google_identity_platform_default_supported_idp_config "google.com"). It
# requires the OAuth client_secret, which the Identity Toolkit API never returns
# on read — putting it in Terraform would risk overwriting the live secret and
# breaking sign-in. It stays console-managed. Its client_id is the public
# FIREBASE_API_KEY's companion OAuth web client.

# Marks Firebase as enabled on the GCP project.
resource "google_firebase_project" "default" {
  provider = google-beta
  project  = var.project_id

  depends_on = [google_project_service.services]
}

# The Firebase web app whose config (apiKey/appId/authDomain) the SPA loads via
# the gateway's /api/auth/config. ABANDON so `terraform destroy` never deletes it.
resource "google_firebase_web_app" "default" {
  provider        = google-beta
  project         = var.project_id
  display_name    = "adlc"
  deletion_policy = "ABANDON"

  depends_on = [google_firebase_project.default]
}

# The web app's client config (apiKey, authDomain, …) — PUBLIC values the SPA
# needs. Wiring these straight from the created web app means a new project needs
# NO FIREBASE_API_KEY repo variable / manual copy step: the gateway env below
# reads the key from here. See docs/GCP_DEPLOY.md.
data "google_firebase_web_app_config" "default" {
  provider   = google-beta
  project    = var.project_id
  web_app_id = google_firebase_web_app.default.app_id
}

# The default Hosting site → https://<project>.web.app. The SPA is deployed to it
# by CD (firebase deploy --only hosting); this resource just tracks the site.
resource "google_firebase_hosting_site" "default" {
  provider = google-beta
  project  = var.project_id
  site_id  = var.project_id

  depends_on = [google_firebase_project.default]
}

resource "google_firebase_hosting_custom_domain" "default" {
  for_each = toset(local.custom_domains)
  provider = google-beta

  project       = var.project_id
  site_id       = var.project_id
  custom_domain = each.value
  depends_on    = [google_firebase_hosting_site.default]
}

# -----------------------------------------------------------------------------
# Marketing site for www.archagentix.com — a second Hosting site in THIS
# project (previously a Hostinger FTP static host; see docs/SEO_AEO.md).
# The SPA-equivalent public/ tree is published to target "www" by
# .github/workflows/deploy-www.yml; firebase.json pins site_id "<project>-www".
# -----------------------------------------------------------------------------
resource "google_firebase_hosting_site" "marketing" {
  provider = google-beta
  project  = var.project_id
  site_id  = local.marketing_site_id

  depends_on = [google_firebase_project.default]
}

# Attach www.archagentix.com to the marketing site. wait_dns_verification=false
# keeps the apply non-blocking while DNS still points at the old host — the
# domain activates on its own once the cutover records are in (see docs).
resource "google_firebase_hosting_custom_domain" "marketing" {
  count = length(local.marketing_domains)

  provider = google-beta

  project       = var.project_id
  site_id       = google_firebase_hosting_site.marketing.site_id
  custom_domain = local.marketing_domains[count.index]

  wait_dns_verification = false

  depends_on = [google_firebase_hosting_site.marketing]
}

# -----------------------------------------------------------------------------
# Secret Share site for secrets.archagentix.com — a third Hosting site in this
# project (source tree secrets/, target "secrets", published by
# .github/workflows/deploy-secrets.yml alongside firestore.rules). Fully static;
# content is client-side encrypted and expires per the rules.
# -----------------------------------------------------------------------------
resource "google_firebase_hosting_site" "secrets" {
  provider = google-beta
  project  = var.project_id
  site_id  = local.secrets_site_id

  depends_on = [google_firebase_project.default]
}

resource "google_firebase_hosting_custom_domain" "secrets" {
  count = length(local.secrets_domains)

  provider = google-beta

  project       = var.project_id
  site_id       = google_firebase_hosting_site.secrets.site_id
  custom_domain = local.secrets_domains[count.index]

  wait_dns_verification = false

  depends_on = [google_firebase_hosting_site.secrets]
}

# Identity Platform (Firebase Authentication) project config. Manages the
# authorized domains that sign-in popups are allowed to run on. The list mirrors
# the live config (incl. legacy GCS origins from before the Firebase-Hosting move).
resource "google_identity_platform_config" "default" {
  provider = google-beta
  project  = var.project_id

  authorized_domains = concat([
    "localhost",
    "${var.project_id}.firebaseapp.com",
    "${var.project_id}.web.app",
    "storage.googleapis.com",
    "${var.spa_bucket_name}.storage.googleapis.com",
  ], local.custom_domains, local.marketing_domains, local.secrets_domains)

  depends_on = [google_project_service.services]
}
