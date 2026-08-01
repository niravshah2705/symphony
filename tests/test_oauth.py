"""Port of packages/shared/src/agent/oauth.test.js (Codex/OpenAI OAuth + PKCE)."""

import base64
import json
import re
import time
from urllib.parse import parse_qs, urlsplit

import pytest

from ai_fleet.agent import oauth
from ai_fleet.config import CONFIG


def _query(url):
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}


def _b64url(obj):
    raw = json.dumps(obj).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


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


def test_pkce_challenge_matches_rfc7636_vector():
    verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    assert oauth.challenge_from_verifier(verifier) == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"


def test_generate_verifier_url_safe_length():
    v = oauth.generate_verifier()
    assert re.match(r"^[A-Za-z0-9\-_]{43}$", v)
    assert oauth.generate_verifier() != oauth.generate_verifier()


def test_generate_state_random():
    a = oauth.generate_state()
    b = oauth.generate_state()
    assert re.match(r"^[A-Za-z0-9\-_]+$", a)
    assert a != b


def test_build_authorize_url_enforces_s256():
    q = _query(
        oauth.build_authorize_url(state="st", code_challenge="cc", redirect_uri=CONFIG.OAUTH.redirectUri)
    )
    assert q["response_type"] == "code"
    assert q["code_challenge_method"] == "S256"
    assert q["code_challenge"] == "cc"
    assert q["state"] == "st"
    assert q["client_id"] == CONFIG.OAUTH.clientId
    assert q["redirect_uri"] == CONFIG.OAUTH.redirectUri


def test_state_is_single_use():
    login = oauth.create_login()
    first = oauth.consume_login(login["state"])
    assert first and first["codeVerifier"]
    assert oauth.consume_login(login["state"]) is None  # replay rejected


def test_unknown_or_empty_state_rejected():
    assert oauth.consume_login("never-issued") is None
    assert oauth.consume_login("") is None
    assert oauth.consume_login(None) is None


def test_consumed_login_binds_challenge_to_verifier():
    login = oauth.create_login()
    challenge = _query(login["authorizeUrl"])["code_challenge"]
    consumed = oauth.consume_login(login["state"])
    assert oauth.challenge_from_verifier(consumed["codeVerifier"]) == challenge


def test_is_expired_cases():
    now = int(time.time() * 1000)
    assert oauth.is_expired(None) is True
    assert oauth.is_expired({"accessToken": "", "expiresAt": now + int(1e9)}) is True
    assert oauth.is_expired({"accessToken": "x", "expiresAt": now + 1000}) is True  # within skew
    assert oauth.is_expired({"accessToken": "x", "expiresAt": now + 3600 * 1000}) is False


def test_account_id_from_id_token_extracts():
    id_token = ".".join(
        [
            _b64url({"alg": "RS256", "typ": "JWT"}),
            _b64url({"https://api.openai.com/auth": {"chatgpt_account_id": "acc_123"}}),
            "sig",
        ]
    )
    assert oauth.account_id_from_id_token(id_token) == "acc_123"


def test_account_id_from_id_token_empty_on_malformed():
    assert oauth.account_id_from_id_token("") == ""
    assert oauth.account_id_from_id_token(None) == ""
    assert oauth.account_id_from_id_token("not-a-jwt") == ""  # not three segments
    no_claim = ".".join(["h", _b64url({"sub": "u"}), "s"])
    assert oauth.account_id_from_id_token(no_claim) == ""  # claim absent


def test_normalize_token_response_rotates_refresh_token():
    rotated = oauth.normalize_token_response(
        {"access_token": "a2", "refresh_token": "r2", "expires_in": 3600},
        {"refreshToken": "r1", "idToken": "id1"},
    )
    assert rotated["accessToken"] == "a2"
    assert rotated["refreshToken"] == "r2"  # rotation honored
    assert rotated["idToken"] == "id1"  # carried forward when absent

    kept = oauth.normalize_token_response({"access_token": "a3", "expires_in": 60}, {"refreshToken": "r1"})
    assert kept["refreshToken"] == "r1"  # no new refresh -> keep old
    assert kept["expiresAt"] > int(time.time() * 1000)


# ---- Token endpoint via the injectable client seam ------------------------- #


async def test_exchange_code_for_tokens_posts_form_encoded():
    resp = _FakeResponse(
        200, json.dumps({"access_token": "a", "refresh_token": "r", "id_token": "idt", "expires_in": 3600})
    )
    cap = {}
    tokens = await oauth.exchange_code_for_tokens(
        code="c", code_verifier="v", redirect_uri="http://cb", client=_FakeClient(resp, cap)
    )
    assert tokens["accessToken"] == "a"
    assert tokens["refreshToken"] == "r"
    assert tokens["idToken"] == "idt"
    # Codex token endpoint is form-encoded: params passed as `data`, not `json`.
    assert cap["data"]["grant_type"] == "authorization_code"
    assert cap["data"]["code_verifier"] == "v"
    assert cap["json"] is None


async def test_refresh_tokens_without_refresh_token_raises_401():
    with pytest.raises(Exception) as exc:
        await oauth.refresh_tokens({"refreshToken": ""})
    assert getattr(exc.value, "status", None) == 401


async def test_post_token_error_raises_502():
    resp = _FakeResponse(400, json.dumps({"error": "invalid_grant"}))
    with pytest.raises(Exception) as exc:
        await oauth.exchange_code_for_tokens(
            code="c", code_verifier="v", redirect_uri="http://cb", client=_FakeClient(resp)
        )
    assert getattr(exc.value, "status", None) == 502
    assert "invalid_grant" in str(exc.value)
