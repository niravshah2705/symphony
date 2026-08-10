"""Field-level secret encryption (GCP KMS envelope encryption).

This package is the ONE place the settings service turns plaintext provider
credentials into ciphertext and back. Storage keeps only ciphertext; the
plaintext exists in memory just long enough to encrypt on write or to hand to
the IAM+token-gated internal S2S endpoint on read.

- ``kms``     — a tiny ``KmsClient`` abstraction (GCP + in-memory fake), mirroring
                the ``FirestoreDb``/``InMemoryDb`` split in ``app.core.firestore``
                so the whole vault runs under the test suite with no GCP libs.
- ``envelope``— the AES-256-GCM AEAD envelope primitive (per-secret DEK wrapped
                by KMS).
- ``vault``   — a key-agnostic ``SecretVault`` (encrypt/decrypt maps) with a
                bounded DEK cache; any future token type uses the same path.
"""
from __future__ import annotations

from app.crypto.envelope import DecryptError, EncryptedSecret, is_encrypted_doc
from app.crypto.kms import InMemoryKms, KmsClient, KmsClientGCP, get_kms
from app.crypto.vault import SecretVault, get_vault

__all__ = [
    "DecryptError",
    "EncryptedSecret",
    "is_encrypted_doc",
    "InMemoryKms",
    "KmsClient",
    "KmsClientGCP",
    "get_kms",
    "SecretVault",
    "get_vault",
]
