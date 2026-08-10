"""KMS abstraction for wrapping/unwrapping data-encryption keys (DEKs).

Repositories never call this directly — only ``app.crypto.envelope`` does, to
wrap the per-secret DEK. Two implementations, selected by whether a KMS key
resource is configured:

- ``KmsClientGCP`` — Google Cloud KMS (``google.cloud.kms``), used in production.
- ``InMemoryKms``  — a dependency-free, reversible fake used by the test suite so
  the vault + S2S + org-isolation matrix runs without GCP (mirrors
  ``app.core.firestore.get_db`` selecting ``InMemoryDb`` when ``gcp_project_id``
  is unset).

Only the DEK (32 random bytes) is ever sent to KMS — never the secret plaintext.
"""
from __future__ import annotations

import base64
from typing import Protocol

from app.core.config import get_settings

# Marker prefix for InMemoryKms-wrapped DEKs so a real ciphertext can never be
# mistaken for a fake one (and vice versa) if configs get crossed.
_INMEM_PREFIX = b"INMEMKMS\x00"
_INMEM_VERSION = "inmemory/v1"


class KmsClient(Protocol):
    def encrypt(self, plaintext: bytes) -> tuple[bytes, str]:
        """Wrap ``plaintext`` (a DEK). Returns ``(wrapped, key_version)``."""
        ...

    def decrypt(self, ciphertext: bytes) -> bytes:
        """Unwrap a previously wrapped DEK."""
        ...


class InMemoryKms:
    """Reversible in-process fake — NOT cryptographically meaningful. Only used
    when no KMS key is configured (tests / local dev)."""

    def encrypt(self, plaintext: bytes) -> tuple[bytes, str]:
        return base64.b64encode(_INMEM_PREFIX + plaintext), _INMEM_VERSION

    def decrypt(self, ciphertext: bytes) -> bytes:
        raw = base64.b64decode(ciphertext)
        if not raw.startswith(_INMEM_PREFIX):
            raise ValueError("not an in-memory-wrapped DEK")
        return raw[len(_INMEM_PREFIX):]


class KmsClientGCP:
    """Google Cloud KMS symmetric encrypt/decrypt over the configured key.

    The KMS ``encrypt`` call uses the key's PRIMARY version; the response's
    ``name`` records the exact CryptoKeyVersion used (stored as ``key_version``
    so rotated keys still decrypt old records). ``decrypt`` auto-detects the
    version from the ciphertext, so it targets the CryptoKey resource.
    """

    def __init__(self, key_name: str) -> None:
        from google.cloud import kms  # imported lazily so tests need no GCP libs

        self._key_name = key_name
        self._client = kms.KeyManagementServiceClient()

    def encrypt(self, plaintext: bytes) -> tuple[bytes, str]:
        response = self._client.encrypt(
            request={"name": self._key_name, "plaintext": plaintext}
        )
        return response.ciphertext, response.name or self._key_name

    def decrypt(self, ciphertext: bytes) -> bytes:
        response = self._client.decrypt(
            request={"name": self._key_name, "ciphertext": ciphertext}
        )
        return response.plaintext


_kms: KmsClient | None = None


def get_kms() -> KmsClient:
    """Process-wide KmsClient. In-memory fake when no KMS key is configured."""
    global _kms
    if _kms is None:
        key_name = get_settings().kms_key_name
        _kms = KmsClientGCP(key_name) if key_name else InMemoryKms()
    return _kms


def set_kms(kms: KmsClient | None) -> None:
    """Override the process-wide KmsClient (tests)."""
    global _kms
    _kms = kms
