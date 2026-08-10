# -----------------------------------------------------------------------------
# Cloud KMS — envelope-encryption key for per-org provider secrets.
# -----------------------------------------------------------------------------
# The settings service (services/settings) stores third-party credentials
# (GitHub/Linear/LLM keys) per organization, encrypted with AES-256-GCM under a
# per-secret data key that is WRAPPED by this KMS key (envelope encryption). Only
# settings-sa can encrypt/decrypt — it is the one auditable decryption surface;
# the egress proxy never touches KMS (it receives already-decrypted plaintext
# over the IAM+token-gated internal S2S endpoint).
#
# Rotation only re-wraps data keys (cheap); old records keep their key_version so
# they still decrypt. The key is protected from destroy (losing it makes every
# stored secret unrecoverable).

resource "google_kms_key_ring" "secrets" {
  project  = var.project_id
  name     = "aifleet-secrets"
  location = var.region

  depends_on = [google_project_service.services]
}

resource "google_kms_crypto_key" "org_secrets" {
  name     = "org-secrets"
  key_ring = google_kms_key_ring.secrets.id
  purpose  = "ENCRYPT_DECRYPT"

  # 90-day rotation of the primary version. Envelope design means rotation only
  # affects newly-wrapped data keys; existing ciphertext is untouched.
  rotation_period = "7776000s"

  labels = merge(local.common_labels, { component = "settings" })

  lifecycle {
    prevent_destroy = true
  }
}

# settings-sa is the ONLY principal granted encrypt/decrypt on the key.
resource "google_kms_crypto_key_iam_member" "settings_org_secrets" {
  crypto_key_id = google_kms_crypto_key.org_secrets.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.settings.email}"
}
