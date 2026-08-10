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
#
# GATED OFF by default (var.secret_vault_kms_enabled = false): provisioning a KMS
# keyring requires the deployer service account to hold `roles/cloudkms.admin`
# (cloudkms.keyRings.create), which the CD SA does not have out of the box. Until
# an operator enables the encrypted vault (and grants that role), no KMS resource
# is created and the settings service falls back to its in-memory KMS (the vault
# is dev-only). Flip this on together with the egress-proxy vault feature.

resource "google_kms_key_ring" "secrets" {
  count    = var.secret_vault_kms_enabled ? 1 : 0
  project  = var.project_id
  name     = "aifleet-secrets"
  location = var.region

  depends_on = [google_project_service.services]
}

resource "google_kms_crypto_key" "org_secrets" {
  count    = var.secret_vault_kms_enabled ? 1 : 0
  name     = "org-secrets"
  key_ring = google_kms_key_ring.secrets[0].id
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
  count         = var.secret_vault_kms_enabled ? 1 : 0
  crypto_key_id = google_kms_crypto_key.org_secrets[0].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.settings.email}"
}
