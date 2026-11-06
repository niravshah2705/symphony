"""Dynamic managed secret source (the Substrate ateapi token).

The value is read from Secret Manager at request time into a short-TTL, in-
process memo. These cover the cache contract directly (no HTTP/db): it resolves
on a successful fetch, reuses the value inside the TTL and refetches after it, a
failed fetch yields an ABSENT key rather than raising (callers fail closed), and
the credential never reaches a log line. The Secret Manager call is faked by
patching ``secret_manager.access_latest`` (the module attribute secrets_service
resolves through).
"""
from __future__ import annotations

import logging

import pytest

from app.core import secret_manager
from app.services import secrets_service as s

pytestmark = pytest.mark.asyncio

# A stand-in for the projected SA token (a JWT-shaped string); the literal must
# never appear in logs, so it doubles as the no-log canary.
TOKEN = "eyJhbGciOiJSUzI1NiJ9.substrate-rotating-control-plane-token.signature"
SECRET_ID = "substrate-ateapi-token"


def _fake_fetch(value: str, calls: list[str]):
    async def access_latest(secret_id, *, version="latest", timeout=None):
        calls.append(secret_id)
        return value

    return access_latest


async def test_dynamic_secret_resolves_from_secret_manager(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(secret_manager, "access_latest", _fake_fetch(TOKEN, calls))
    await s._prefetch_dynamic_managed(now=1.0)
    assert s._managed_value("substrateApiToken") == TOKEN
    assert calls == [SECRET_ID]


async def test_dynamic_secret_is_not_read_from_the_environment(monkeypatch):
    # Even with a stray env var set, the dynamic key is served from the cache,
    # never from os.environ — that is the whole point (no stale env mount).
    monkeypatch.setenv("substrateApiToken", "stale-env-value")
    calls: list[str] = []
    monkeypatch.setattr(secret_manager, "access_latest", _fake_fetch(TOKEN, calls))
    await s._prefetch_dynamic_managed(now=1.0)
    assert s._managed_value("substrateApiToken") == TOKEN


async def test_cached_within_ttl_and_refetched_after(monkeypatch):
    monkeypatch.setenv("SUBSTRATE_ATEAPI_TOKEN_TTL_SECONDS", "300")
    calls: list[str] = []
    versions = iter(["token-v1", "token-v2", "token-v3"])

    async def access_latest(secret_id, **_kw):
        calls.append(secret_id)
        return next(versions)

    monkeypatch.setattr(secret_manager, "access_latest", access_latest)

    await s._prefetch_dynamic_managed(now=0.0)  # cold -> fetch v1
    assert s._managed_value("substrateApiToken") == "token-v1"

    await s._prefetch_dynamic_managed(now=299.0)  # inside TTL -> reused, no fetch
    assert calls == [SECRET_ID]
    assert s._managed_value("substrateApiToken") == "token-v1"

    await s._prefetch_dynamic_managed(now=301.0)  # expired -> fetch v2
    assert calls == [SECRET_ID, SECRET_ID]
    assert s._managed_value("substrateApiToken") == "token-v2"


async def test_custom_ttl_controls_refetch(monkeypatch):
    monkeypatch.setenv("SUBSTRATE_ATEAPI_TOKEN_TTL_SECONDS", "60")
    calls: list[str] = []
    monkeypatch.setattr(secret_manager, "access_latest", _fake_fetch(TOKEN, calls))
    await s._prefetch_dynamic_managed(now=0.0)
    await s._prefetch_dynamic_managed(now=61.0)  # past the 60s TTL
    assert len(calls) == 2


async def test_fetch_failure_yields_absent_key_not_error(monkeypatch):
    async def boom(secret_id, **_kw):
        raise secret_manager.SecretManagerError("secret version access failed")

    monkeypatch.setattr(secret_manager, "access_latest", boom)
    await s._prefetch_dynamic_managed(now=0.0)  # must not raise
    assert s._managed_value("substrateApiToken") is None


async def test_expired_then_failing_fetch_does_not_serve_stale(monkeypatch):
    monkeypatch.setenv("SUBSTRATE_ATEAPI_TOKEN_TTL_SECONDS", "60")
    state = {"n": 0}

    async def flaky(secret_id, **_kw):
        state["n"] += 1
        if state["n"] == 1:
            return "good-token"
        raise secret_manager.SecretManagerError("upstream unavailable")

    monkeypatch.setattr(secret_manager, "access_latest", flaky)
    await s._prefetch_dynamic_managed(now=0.0)
    assert s._managed_value("substrateApiToken") == "good-token"
    # After the TTL the cached token may already be expired; a failed refetch
    # must drop it (fail closed), not keep serving a stale credential.
    await s._prefetch_dynamic_managed(now=120.0)
    assert s._managed_value("substrateApiToken") is None


async def test_value_never_logged_on_success_or_failure(monkeypatch, caplog):
    async def boom(secret_id, **_kw):
        raise secret_manager.SecretManagerError("upstream 500")

    monkeypatch.setattr(secret_manager, "access_latest", boom)
    with caplog.at_level(logging.DEBUG):
        await s._prefetch_dynamic_managed(now=0.0)
    assert TOKEN not in caplog.text

    monkeypatch.setattr(secret_manager, "access_latest", _fake_fetch(TOKEN, []))
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        # Advance past the TTL so the prior failed entry is refreshed, not reused.
        await s._prefetch_dynamic_managed(now=10_000.0)
    assert TOKEN not in caplog.text
    assert s._managed_value("substrateApiToken") == TOKEN
