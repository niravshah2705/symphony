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

# Identity Platform (Firebase Authentication) project config. Manages the
# authorized domains that sign-in popups are allowed to run on. The list mirrors
# the live config (incl. legacy GCS origins from before the Firebase-Hosting move).
resource "google_identity_platform_config" "default" {
  provider = google-beta
  project  = var.project_id

  authorized_domains = [
    "localhost",
    "${var.project_id}.firebaseapp.com",
    "${var.project_id}.web.app",
    "storage.googleapis.com",
    "${var.spa_bucket_name}.storage.googleapis.com",
  ]

  depends_on = [google_project_service.services]
}
