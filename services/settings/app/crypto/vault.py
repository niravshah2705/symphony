"""Key-agnostic secret vault over the AES-256-GCM envelope + KMS.

The whole per-org key feature funnels through ``SecretVault``: it encrypts and
decrypts a MAP of ``{secret_key: value}`` without knowing anything about which
provider a key belongs to, so adding a new token type needs no new crypto code.

A small, bounded, TTL'd DEK cache bounds KMS latency for repeated reads. Only
DEKs are cached (never plaintext secrets); the cache is process-local and gone
on restart.
"""
from __future__ import annotations

import hashlib
import time

from app.crypto import envelope
from app.crypto.envelope import EncryptedSecret
from app.crypto.kms import KmsClient, get_kms

# DEK cache tuning. DEKs are wrapped-key-derived, not secrets, so a short TTL is
# purely a KMS-latency optimization.
_DEK_CACHE_TTL_SECONDS = 300  # 5 minutes
_DEK_CACHE_MAX = 512


class _DekCache:
    """Bounded TTL cache: hash(wrapped_dek) -> (dek, expires_at)."""

    def __init__(self, ttl: float = _DEK_CACHE_TTL_SECONDS, maxsize: int = _DEK_CACHE_MAX) -> None:
        self._ttl = ttl
        self._maxsize = maxsize
        self._entries: dict[str, tuple[bytes, float]] = {}

    @staticmethod
    def _key(wrapped_dek: bytes) -> str:
        return hashlib.sha256(wrapped_dek).hexdigest()

    def get(self, wrapped_dek: bytes) -> bytes | None:
        entry = self._entries.get(self._key(wrapped_dek))
        if entry is None:
            return None
        dek, expires_at = entry
        if time.monotonic() >= expires_at:
            self._entries.pop(self._key(wrapped_dek), None)
            return None
        return dek

    def put(self, wrapped_dek: bytes, dek: bytes) -> None:
        if len(self._entries) >= self._maxsize:
            # Cheap eviction: drop the oldest-inserted entry.
            self._entries.pop(next(iter(self._entries)), None)
        self._entries[self._key(wrapped_dek)] = (dek, time.monotonic() + self._ttl)

    def clear(self) -> None:
        self._entries.clear()


class SecretVault:
    def __init__(self, kms: KmsClient) -> None:
        self._kms = kms
        self._dek_cache = _DekCache()

    def encrypt_map(self, plaintext_by_key: dict[str, str]) -> dict[str, EncryptedSecret]:
        """Encrypt every value; each gets its own DEK + nonce."""
        return {key: envelope.encrypt(value, self._kms) for key, value in plaintext_by_key.items()}

    def decrypt_map(self, records: dict[str, EncryptedSecret]) -> dict[str, str]:
        """Decrypt every record. Propagates ``DecryptError`` (fail closed) — a
        caller must never treat a decryption failure as an absent key."""
        out: dict[str, str] = {}
        for key, record in records.items():
            dek = self._dek_cache.get(record.wrapped_dek)
            if dek is None:
                dek = envelope.unwrap_dek(record, self._kms)
                self._dek_cache.put(record.wrapped_dek, dek)
            out[key] = envelope.decrypt(record, self._kms, dek=dek)
        return out


_vault: SecretVault | None = None


def get_vault() -> SecretVault:
    """Process-wide vault bound to the configured KmsClient."""
    global _vault
    if _vault is None:
        _vault = SecretVault(get_kms())
    return _vault


def set_vault(vault: SecretVault | None) -> None:
    """Override the process-wide vault (tests)."""
    global _vault
    _vault = vault
