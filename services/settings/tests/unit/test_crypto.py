"""Crypto module: envelope encryption + vault round-trips under InMemoryKms.

No GCP libs required — the in-memory KMS fake is selected because no KMS key is
configured in the test env (mirrors the Firestore fake selection).
"""
from __future__ import annotations

import pytest

from app.crypto import envelope
from app.crypto.envelope import DecryptError, EncryptedSecret, is_encrypted_doc
from app.crypto.kms import InMemoryKms
from app.crypto.vault import SecretVault

SECRET = "sk-ant-example-0123456789abcdef"


def test_encrypt_then_decrypt_round_trips():
    kms = InMemoryKms()
    record = envelope.encrypt(SECRET, kms)
    assert envelope.decrypt(record, kms) == SECRET


def test_ciphertext_never_contains_plaintext():
    kms = InMemoryKms()
    record = envelope.encrypt(SECRET, kms)
    blob = record.ciphertext + record.iv + record.tag + record.wrapped_dek
    assert SECRET.encode() not in blob


def test_each_encryption_uses_a_fresh_nonce_and_dek():
    kms = InMemoryKms()
    a = envelope.encrypt(SECRET, kms)
    b = envelope.encrypt(SECRET, kms)
    # Same plaintext, but unique nonce + DEK => different ciphertext each time.
    assert a.iv != b.iv
    assert a.ciphertext != b.ciphertext
    assert a.wrapped_dek != b.wrapped_dek


def test_to_doc_from_doc_is_stable():
    kms = InMemoryKms()
    record = envelope.encrypt(SECRET, kms)
    doc = record.to_doc()
    assert is_encrypted_doc(doc)
    restored = EncryptedSecret.from_doc(doc)
    assert envelope.decrypt(restored, kms) == SECRET
    assert restored.alg == "AES-256-GCM"


def test_tampered_ciphertext_fails_closed():
    kms = InMemoryKms()
    record = envelope.encrypt(SECRET, kms)
    tampered = EncryptedSecret(
        ciphertext=record.ciphertext[:-1] + bytes([record.ciphertext[-1] ^ 0x01]),
        iv=record.iv,
        tag=record.tag,
        wrapped_dek=record.wrapped_dek,
        key_version=record.key_version,
    )
    with pytest.raises(DecryptError):
        envelope.decrypt(tampered, kms)


def test_is_encrypted_doc_rejects_plaintext():
    assert is_encrypted_doc("plain-text-legacy-value") is False
    assert is_encrypted_doc({"unrelated": "shape"}) is False


def test_vault_encrypt_map_and_decrypt_map_round_trip():
    vault = SecretVault(InMemoryKms())
    plain = {"githubToken": "ghp_xxx", "linearApiKey": "lin_yyy"}
    records = vault.encrypt_map(plain)
    assert set(records) == set(plain)
    assert all(isinstance(v, EncryptedSecret) for v in records.values())
    assert vault.decrypt_map(records) == plain


def test_vault_dek_cache_serves_repeat_reads():
    vault = SecretVault(InMemoryKms())
    records = vault.encrypt_map({"githubToken": "ghp_xxx"})
    # Two decrypts: the second should hit the DEK cache (still correct).
    assert vault.decrypt_map(records) == {"githubToken": "ghp_xxx"}
    assert vault.decrypt_map(records) == {"githubToken": "ghp_xxx"}
