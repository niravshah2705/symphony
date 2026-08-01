"""Port of packages/shared/src/agent/claude-oauth.test.js (Claude/Anthropic OAuth)."""

import json
import time
from urllib.parse import parse_qs, urlsplit

import pytest

from ai_fleet.agent import claude_oauth as claude
from ai_fleet.agent import pkce
from ai_fleet.config import CONFIG


def _query(url):
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}


# ---- Injectable HTTP seam fakes (JS tests stub global.fetch) --------------- #


class _FakeResponse:
    def __init__(self, status_code, text):
        self.status_code = status_code
        self.text = text


class _FakeClient:
    def __init__(self, response, capture=None):
        self._response = response
        self.capture = capture if capture is not None else {}

    async def post(self, url, headers=None, data=None, json=None):
        self.capture.update({"url": url, "headers": headers, "data": data, "json": json})
        return self._response


def test_build_authorize_url_enforces_s256():
    q = _query(claude.build_authorize_url(state="st", code_challenge="cc"))
    assert q["response_type"] == "code"
    assert q["code_challenge_method"] == "S256"
    assert q["code_challenge"] == "cc"
    assert q["state"] == "st"
    assert q["client_id"] == CONFIG.CLAUDE.clientId
    assert q["redirect_uri"] == CONFIG.CLAUDE.redirectUri
    assert q["scope"] == CONFIG.CLAUDE.scope


def test_create_login_challenge_matches_stored_verifier():
    login = claude.create_login()
    challenge = _query(login["authorizeUrl"])["code_challenge"]
    consumed = claude.consume_login(login["state"])
    assert consumed and consumed["codeVerifier"]
    assert pkce.challenge_from_verifier(consumed["codeVerifier"]) == challenge


def test_state_is_single_use():
    login = claude.create_login()
    assert claude.consume_login(login["state"])
    assert claude.consume_login(login["state"]) is None


def test_unknown_or_empty_state_rejected():
    assert claude.consume_login("never-issued") is None
    assert claude.consume_login("") is None
    assert claude.consume_login(None) is None


def test_parse_code_input_variants():
    assert claude.parse_code_input("abc#xyz") == {"code": "abc", "state": "xyz"}
    assert claude.parse_code_input("  abc#xyz  ") == {"code": "abc", "state": "xyz"}
    assert claude.parse_code_input("bare-code") == {"code": "bare-code", "state": ""}
    assert claude.parse_code_input(
        "https://console.anthropic.com/oauth/code/callback?code=AAA&state=BBB"
    ) == {"code": "AAA", "state": "BBB"}
    assert claude.parse_code_input("") == {"code": "", "state": ""}


def test_normalize_token_response_rotates_refresh_token():
    rotated = claude.normalize_token_response(
        {"access_token": "a2", "refresh_token": "r2", "expires_in": 3600},
        {"refreshToken": "r1"},
    )
    assert rotated["accessToken"] == "a2"
    assert rotated["refreshToken"] == "r2"  # rotation honored
    assert rotated["expiresAt"] > int(time.time() * 1000)

    kept = claude.normalize_token_response({"access_token": "a3", "expires_in": 60}, {"refreshToken": "r1"})
    assert kept["refreshToken"] == "r1"  # no new refresh -> keep old
    # Claude token set carries no id_token.
    assert "idToken" not in kept


def test_is_expired_cases():
    now = int(time.time() * 1000)
    assert claude.is_expired(None) is True
    assert claude.is_expired({"accessToken": "", "expiresAt": now + int(1e9)}) is True
    assert claude.is_expired({"accessToken": "x", "expiresAt": now + 1000}) is True  # within skew
    assert claude.is_expired({"accessToken": "x", "expiresAt": now + 3600 * 1000}) is False


# ---- Token endpoint via the injectable client seam ------------------------- #


async def test_exchange_code_for_tokens_posts_json_body():
    resp = _FakeResponse(200, json.dumps({"access_token": "a", "refresh_token": "r", "expires_in": 3600}))
    cap = {}
    tokens = await claude.exchange_code_for_tokens(
        code="c", state="s", code_verifier="v", client=_FakeClient(resp, cap)
    )
    assert tokens["accessToken"] == "a"
    assert tokens["refreshToken"] == "r"
    # Claude token endpoint is JSON-bodied: payload passed as `json`, not `data`.
    assert cap["json"]["grant_type"] == "authorization_code"
    assert cap["json"]["state"] == "s"
    assert cap["data"] is None


async def test_refresh_tokens_without_refresh_token_raises_401():
    with pytest.raises(Exception) as exc:
        await claude.refresh_tokens({"refreshToken": ""})
    assert getattr(exc.value, "status", None) == 401


async def test_post_token_error_raises_502():
    resp = _FakeResponse(400, json.dumps({"error_description": "bad code"}))
    with pytest.raises(Exception) as exc:
        await claude.exchange_code_for_tokens(
            code="c", state="s", code_verifier="v", client=_FakeClient(resp)
        )
    assert getattr(exc.value, "status", None) == 502
    assert "bad code" in str(exc.value)
