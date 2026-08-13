"""Operator Codex import and proxy rotation integration tests."""
from __future__ import annotations

import json
import uuid

import pytest

from app.api.v1.routes_internal import derive_org_internal_token
from app.models.enums import OrgRole
from tests.helpers import auth, make_user

pytestmark = pytest.mark.asyncio


def bundle(obtained_at: int, refresh: str = "refresh-one") -> dict:
    return {
        "accessToken": f"access-{obtained_at}",
        "refreshToken": refresh,
        "idToken": "header.payload.signature",
        "tokenType": "Bearer",
        "scope": "openid profile email offline_access",
        "expiresAt": obtained_at + 3_600_000,
        "obtainedAt": obtained_at,
    }


async def test_org_admin_imports_and_proxy_rotates_codex_bundle(client):
    org = uuid.uuid4()
    _admin, token = await make_user(
        email="operator@x.com", org_id=org, org_role=OrgRole.ORG_ADMIN
    )
    first = bundle(1_800_000_000_000)
    imported = await client.put(
        "/api/v1/operator/org/codex-tokens",
        headers=auth(token),
        json={"tokens": first},
    )
    assert imported.status_code == 200
    assert imported.json()["configured"] is True

    masked = await client.get("/api/v1/settings/org/secrets", headers=auth(token))
    assert masked.json()["secrets"]["codexTokenBundle"] == {
        "set": True,
        "source": "customer",
    }

    resolved_url = f"/api/v1/internal/s2s/orgs/{org}/secrets"
    resolved = await client.get(
        resolved_url,
        headers={"X-Org-Internal-Token": derive_org_internal_token(org)},
    )
    raw = resolved.json()["secrets"]["codexTokenBundle"]["value"]
    assert json.loads(raw)["refreshToken"] == "refresh-one"

    # Preflight reports the exact secret-free credential family selected by the
    # proxy. The org bundle takes precedence over any API-key fallback.
    preflight = await client.post(
        "/api/v1/settings/preflight",
        headers=auth(token),
        json={
            "stages": ["plan"],
            "providers": {"plan": "codex"},
            "models": {"plan": "codex-gpt-5-6-sol"},
        },
    )
    assert preflight.status_code == 200
    assert preflight.json()["stages"][0]["credential"] == {
        "ready": True,
        "source": "customer",
        "kind": "codexTokenBundle",
    }

    second = bundle(1_800_000_100_000, "refresh-two")
    rotated = await client.put(
        f"/api/v1/internal/s2s/orgs/{org}/codex-tokens",
        headers={"X-Org-Internal-Token": derive_org_internal_token(org)},
        json={"expectedObtainedAt": first["obtainedAt"], "tokens": second},
    )
    assert rotated.status_code == 200
    assert rotated.json()["updated"] is True
    assert rotated.json()["tokens"]["refreshToken"] == "refresh-two"

    stale = await client.put(
        f"/api/v1/internal/s2s/orgs/{org}/codex-tokens",
        headers={"X-Org-Internal-Token": derive_org_internal_token(org)},
        json={"expectedObtainedAt": first["obtainedAt"], "tokens": bundle(1_800_000_200_000)},
    )
    assert stale.status_code == 200
    assert stale.json()["updated"] is False
    assert stale.json()["tokens"]["refreshToken"] == "refresh-two"


async def test_non_admin_cannot_import_codex_bundle(client):
    org = uuid.uuid4()
    _member, token = await make_user(email="member@x.com", org_id=org)
    response = await client.put(
        "/api/v1/operator/org/codex-tokens",
        headers=auth(token),
        json={"tokens": bundle(1_800_000_000_000)},
    )
    assert response.status_code == 403
