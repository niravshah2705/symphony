"""Gateway auth tests — port of services/gateway/src/auth.test.js.

The pure functions (``decode_verified_payload``, ``identity_from_claims``,
``public_auth_config``) plus ``config.build_auth_config`` are exercised directly.
The middleware is driven through a tiny FastAPI app with ``TestClient`` (the JS
test uses a hand-rolled Express response recorder).
"""

from __future__ import annotations

import base64
import json
import re
import time
import types

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware

from ai_fleet.config import build_auth_config
from ai_fleet.services.gateway.auth import (
    create_authentication_middleware,
    decode_verified_payload,
    identity_from_claims,
    public_auth_config,
)

PAYLOAD_HEADER = "x-ai-fleet-jwt-payload"


def istio_config(**overrides):
    base = dict(
        mode="istio",
        enabled=True,
        provider="auth0",
        payloadHeader=PAYLOAD_HEADER,
        domain="tenant.example.auth0.com",
        issuer="https://tenant.example.auth0.com/",
        clientId="client-id",
        audience="https://api.ai-fleet.example.com",
        requiredPermission="fleet:access",
        redirectUri="https://fleet.example.com/",
        logoutReturnTo="https://fleet.example.com/",
        scope="openid profile email",
        organization="",
    )
    base.update(overrides)
    return types.SimpleNamespace(**base)


def claims(**overrides):
    base = dict(
        iss="https://tenant.example.auth0.com/",
        aud=["unrelated", "https://api.ai-fleet.example.com"],
        sub="auth0|operator-123",
        exp=int(time.time()) + 3600,
        name="Fleet Operator",
        email="operator@example.com",
        scope="openid profile fleet:read",
        permissions=["fleet:access", "fleet:read", "fleet:operate"],
        unexpectedSecret="not-forwarded",
    )
    base.update(overrides)
    return base


def encoded(value):
    # Node's Buffer.from(x).toString('base64url') is unpadded url-safe base64.
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


def _build_app(config):
    app = FastAPI()
    app.add_middleware(BaseHTTPMiddleware, dispatch=create_authentication_middleware(config))

    @app.api_route("/api/protected", methods=["GET", "OPTIONS"])
    async def protected(request: Request):
        return getattr(request.state, "auth", None)

    return app


# --------------------------- config tests ------------------------------- #
def test_authentication_configuration_defaults_to_local_disabled_mode():
    assert vars(build_auth_config({})) == {
        "mode": "disabled",
        "enabled": False,
        "payloadHeader": PAYLOAD_HEADER,
    }


def test_istio_configuration_is_complete_and_public_settings_are_secret_free():
    config = build_auth_config(
        {
            "AUTH_MODE": "istio",
            "AUTH0_DOMAIN": "tenant.example.auth0.com",
            "AUTH0_CLIENT_ID": "public-spa-client",
            "AUTH0_AUDIENCE": "https://api.ai-fleet.example.com",
            "AUTH0_REQUIRED_PERMISSION": "fleet:access",
            "AUTH0_REDIRECT_URI": "https://fleet.example.com/",
            "AUTH0_ORGANIZATION": "org_123",
        }
    )
    assert config.issuer == "https://tenant.example.auth0.com/"
    assert config.payloadHeader == PAYLOAD_HEADER
    assert config.requiredPermission == "fleet:access"
    assert public_auth_config(config) == {
        "mode": "istio",
        "enabled": True,
        "provider": "auth0",
        "auth0": {
            "domain": "tenant.example.auth0.com",
            "clientId": "public-spa-client",
            "audience": "https://api.ai-fleet.example.com",
            "redirectUri": "https://fleet.example.com/",
            # NOTE: Python config derives this from URL origin WITHOUT the
            # trailing slash (JS normalizes via `new URL().href`, adding one).
            "logoutReturnTo": "https://fleet.example.com",
            "scope": "openid profile email",
            "organization": "org_123",
        },
    }
    assert not re.search(r"payloadHeader|issuer|secret", json.dumps(public_auth_config(config)), re.I)


def test_istio_configuration_fails_closed_when_values_are_unsafe_or_missing():
    with pytest.raises(Exception, match="AUTH_MODE"):
        build_auth_config({"AUTH_MODE": "production"})
    with pytest.raises(Exception, match="AUTH_MODE=istio"):
        build_auth_config({"NODE_ENV": "production"})
    with pytest.raises(Exception, match="AUTH_MODE=istio"):
        build_auth_config({"NODE_ENV": "production", "AUTH_MODE": "disabled"})
    with pytest.raises(Exception, match="AUTH0_DOMAIN"):
        build_auth_config({"AUTH_MODE": "istio"})
    with pytest.raises(Exception, match="AUTH0_REQUIRED_PERMISSION"):
        build_auth_config(
            {
                "AUTH_MODE": "istio",
                "AUTH0_DOMAIN": "tenant.example.auth0.com",
                "AUTH0_CLIENT_ID": "client",
                "AUTH0_AUDIENCE": "api",
                "AUTH0_REDIRECT_URI": "https://fleet.example.com/",
            }
        )
    with pytest.raises(Exception, match="hostname"):
        build_auth_config(
            {
                "AUTH_MODE": "istio",
                "AUTH0_DOMAIN": "https://tenant.example.auth0.com/",
                "AUTH0_CLIENT_ID": "client",
                "AUTH0_AUDIENCE": "api",
                "AUTH0_REDIRECT_URI": "https://fleet.example.com/",
            }
        )
    with pytest.raises(Exception, match="HTTPS"):
        build_auth_config(
            {
                "AUTH_MODE": "istio",
                "AUTH0_DOMAIN": "tenant.example.auth0.com",
                "AUTH0_CLIENT_ID": "client",
                "AUTH0_AUDIENCE": "api",
                "AUTH0_REDIRECT_URI": "http://fleet.example.com/",
            }
        )


# --------------------------- identity tests ----------------------------- #
def test_verified_payload_parsing_returns_only_normalized_identity_claims():
    decoded = decode_verified_payload(encoded(claims()))
    identity = identity_from_claims(decoded, istio_config())
    assert identity == {
        "sub": "auth0|operator-123",
        "name": "Fleet Operator",
        "email": "operator@example.com",
        "organizationId": "",
        "permissions": ["fleet:access", "fleet:read", "fleet:operate"],
        "scopes": ["openid", "profile", "fleet:read"],
    }
    assert identity.get("unexpectedSecret") is None


def test_identity_validation_rejects_malformed_expired_wrong_issuer_and_audience():
    with pytest.raises(Exception, match="malformed"):
        decode_verified_payload("not-json")
    with pytest.raises(Exception, match="expired"):
        identity_from_claims(claims(exp=1), istio_config())
    with pytest.raises(Exception, match="issuer"):
        identity_from_claims(claims(iss="https://attacker.example/"), istio_config())
    with pytest.raises(Exception, match="audience"):
        identity_from_claims(claims(aud="another-api"), istio_config())
    with pytest.raises(Exception, match="organization"):
        identity_from_claims(claims(org_id="org_other"), istio_config(organization="org_expected"))

    with pytest.raises(Exception) as excinfo:
        identity_from_claims(
            claims(permissions=[], scope="openid profile fleet:access"), istio_config()
        )
    error = excinfo.value
    assert getattr(error, "status", None) == 403
    assert getattr(error, "code", None) == "access_denied"
    assert "permission" in getattr(error, "message", "")

    with pytest.raises(Exception, match="subject"):
        identity_from_claims(claims(sub=""), istio_config())


# --------------------------- middleware tests --------------------------- #
def test_middleware_permits_local_mode_and_requires_istio_payload_in_production():
    disabled = types.SimpleNamespace(mode="disabled", enabled=False, payloadHeader=PAYLOAD_HEADER)
    with TestClient(_build_app(disabled)) as client:
        resp = client.get("/api/protected")
        assert resp.status_code == 200
        assert resp.json()["mode"] == "disabled"
        assert resp.json()["authenticated"] is False

    config = istio_config()
    with TestClient(_build_app(config)) as client:
        # Missing verified payload -> 401 with a Bearer challenge.
        missing = client.get("/api/protected")
        assert missing.status_code == 401
        assert missing.json()["code"] == "authentication_required"
        assert missing.headers["www-authenticate"].startswith("Bearer")

        # Valid verified payload -> authenticated identity on request state.
        ok = client.get("/api/protected", headers={PAYLOAD_HEADER: encoded(claims())})
        assert ok.status_code == 200
        body = ok.json()
        assert body["authenticated"] is True
        assert body["user"]["sub"] == "auth0|operator-123"

        # Verified but under-permissioned -> 403.
        denied = client.get(
            "/api/protected",
            headers={PAYLOAD_HEADER: encoded(claims(permissions=[], scope="openid profile"))},
        )
        assert denied.status_code == 403
        assert denied.json()["code"] == "access_denied"


def test_cors_preflight_can_reach_the_app_without_an_access_token():
    with TestClient(_build_app(istio_config())) as client:
        resp = client.options("/api/protected")
        assert resp.status_code == 200
        assert resp.json()["authenticated"] is False
