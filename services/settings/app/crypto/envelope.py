"""AES-256-GCM envelope encryption primitive.

Each secret is encrypted under its OWN random 256-bit data-encryption key (DEK)
with a fresh 96-bit nonce; the DEK is then wrapped by KMS. The stored record
keeps only ciphertext — never the DEK or the plaintext:

    {ciphertext, iv, tag, wrapped_dek, key_version, alg, created_at}

Envelope (vs. calling KMS ``Encrypt`` on the secret directly) is chosen so DEKs
can be cached to bound KMS latency and so KMS-key rotation only re-wraps DEKs
rather than rewriting every ciphertext.

Security (cryptography-secrets checklist): AES-256-GCM is AEAD (never ECB or
CBC-without-MAC); the nonce is unique per encryption (``os.urandom(12)``); key
material is CSPRNG (``os.urandom``); DEKs are per-secret, never hardcoded.
"""
from __future__ import annotations

import base64
import os
from dataclasses import dataclass, field
from datetime import datetime

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.crypto.kms import KmsClient
from app.models.base import utcnow

ALG = "AES-256-GCM"
_DEK_BYTES = 32  # 256-bit
_NONCE_BYTES = 12  # 96-bit, the AES-GCM standard nonce size
_TAG_BYTES = 16  # 128-bit GCM authentication tag

# Fields that identify an encrypted record when reading a raw Firestore doc
# (used by the dual-read migration path to tell ciphertext from legacy plaintext).
_REQUIRED_FIELDS = ("ciphertext", "iv", "tag", "wrapped_dek")


class DecryptError(Exception):
    """Raised on any decryption failure. Never returns partial/empty plaintext —
    callers MUST fail closed (never silently substitute a wrong/empty secret)."""


def _b64e(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _b64d(text: str) -> bytes:
    return base64.b64decode(text)


@dataclass
class EncryptedSecret:
    ciphertext: bytes
    iv: bytes
    tag: bytes
    wrapped_dek: bytes
    key_version: str
    alg: str = ALG
    created_at: datetime = field(default_factory=utcnow)

    def to_doc(self) -> dict:
        return {
            "ciphertext": _b64e(self.ciphertext),
            "iv": _b64e(self.iv),
            "tag": _b64e(self.tag),
            "wrapped_dek": _b64e(self.wrapped_dek),
            "key_version": self.key_version,
            "alg": self.alg,
            "created_at": self.created_at,
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "EncryptedSecret":
        return cls(
            ciphertext=_b64d(doc["ciphertext"]),
            iv=_b64d(doc["iv"]),
            tag=_b64d(doc["tag"]),
            wrapped_dek=_b64d(doc["wrapped_dek"]),
            key_version=str(doc.get("key_version", "")),
            alg=str(doc.get("alg", ALG)),
            created_at=doc.get("created_at") or utcnow(),
        )


def is_encrypted_doc(value: object) -> bool:
    """True when ``value`` looks like a stored ``EncryptedSecret`` doc (as opposed
    to a legacy plaintext string). Used by the dual-read migration path."""
    return isinstance(value, dict) and all(k in value for k in _REQUIRED_FIELDS)


def encrypt(plaintext: str, kms: KmsClient) -> EncryptedSecret:
    """Encrypt ``plaintext`` with a fresh per-secret DEK wrapped by ``kms``."""
    dek = os.urandom(_DEK_BYTES)
    nonce = os.urandom(_NONCE_BYTES)
    sealed = AESGCM(dek).encrypt(nonce, plaintext.encode("utf-8"), None)
    # AESGCM appends the 16-byte tag to the ciphertext; split it out for storage.
    ciphertext, tag = sealed[:-_TAG_BYTES], sealed[-_TAG_BYTES:]
    wrapped_dek, key_version = kms.encrypt(dek)
    return EncryptedSecret(
        ciphertext=ciphertext,
        iv=nonce,
        tag=tag,
        wrapped_dek=wrapped_dek,
        key_version=key_version,
    )


def decrypt(record: EncryptedSecret, kms: KmsClient, *, dek: bytes | None = None) -> str:
    """Decrypt ``record``. ``dek`` may be supplied by a caller-side cache to skip
    the KMS unwrap. Any failure raises ``DecryptError`` (fail closed)."""
    try:
        key = dek if dek is not None else kms.decrypt(record.wrapped_dek)
        opened = AESGCM(key).decrypt(record.iv, record.ciphertext + record.tag, None)
        return opened.decode("utf-8")
    except DecryptError:
        raise
    except Exception as exc:  # invalid tag, KMS error, corrupt record, …
        raise DecryptError("failed to decrypt secret") from exc


def unwrap_dek(record: EncryptedSecret, kms: KmsClient) -> bytes:
    """Unwrap just the DEK (for the vault's DEK cache)."""
    try:
        return kms.decrypt(record.wrapped_dek)
    except Exception as exc:
        raise DecryptError("failed to unwrap DEK") from exc
