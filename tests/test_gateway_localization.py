"""Port of services/gateway/src/routes/localization.test.js.

``ai_fleet.agent.localization`` has not landed yet, so these tests inject a fake
localization module onto the route and assert the ROUTE/helper wiring (the JS
suite likewise drives the pure helpers with injected seams). The localization
primitives themselves are covered by that module's own test when it ships.
"""

import json
import types

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import ai_fleet.services.gateway.routes.localization as loc_route
from ai_fleet import store
from ai_fleet.services.common import register_exception_handlers


class FakeLocalizationError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def _make_fake(**overrides):
    """A stand-in for ai_fleet.agent.localization with allowlisting semantics."""
    ns = types.SimpleNamespace()
    ns.parse_language_hints = lambda langs, accept=None: ["fr", "en", "gu-IN"]
    ns.request_ip = lambda req: (req.get("ip") if isinstance(req, dict) else None)
    # Public unless loopback/empty (enough to exercise the two branches).
    ns.is_public_ip = lambda ip: bool(ip) and ip != "127.0.0.1"
    ns.normalize_geo_result = lambda value: (
        {"countryCode": value.get("countryCode"), "region": value.get("region")}
        if isinstance(value, dict)
        else None
    )
    ns.language_suggestions = lambda browser_languages, country_code, region: {
        "locale": browser_languages[0] if browser_languages else "en",
        "countryCode": country_code,
        "region": region,
        "suggestions": [{"tag": tag} for tag in browser_languages],
    }

    async def _locate_ip(ip):
        return {}

    async def _locate_current_ip():
        return {}

    async def _translate_texts(request):
        return {}

    ns.locate_ip = _locate_ip
    ns.locate_current_ip = _locate_current_ip
    ns.translate_texts = _translate_texts
    ns.LocalizationError = FakeLocalizationError
    for key, value in overrides.items():
        setattr(ns, key, value)
    return ns


@pytest.fixture(autouse=True)
def _fake_localization(monkeypatch):
    fake = _make_fake()
    monkeypatch.setattr(loc_route, "localization", fake)
    return fake


def test_localization_router_exposes_the_agreed_suggestions_and_translation_routes():
    routes = [
        (route.path, sorted(m for m in route.methods if m in ("GET", "POST")))
        for route in loc_route.router.routes
    ]
    assert ("/suggestions", ["GET"]) in routes
    assert ("/translate", ["POST"]) in routes


async def test_suggestions_use_browser_hints_and_coarse_ip_without_returning_the_address(_fake_localization):
    looked_up = {"ip": None}
    called_current = {"count": 0}

    async def geolocate(ip):
        looked_up["ip"] = ip
        return {"countryCode": "IN", "region": "Gujarat", "ip": ip, "latitude": 23.2}

    async def geolocate_current():
        called_current["count"] += 1
        return {}

    payload = await loc_route.suggestions_for_request(
        {
            "query": {"languages": "fr-FR,hi-IN;q=0.8"},
            "headers": {"accept-language": "de-DE;q=0.5"},
            "ip": "8.8.8.8",
            "socket": {},
        },
        geolocate=geolocate,
        geolocate_current=geolocate_current,
    )

    assert looked_up["ip"] == "8.8.8.8"
    assert called_current["count"] == 0
    assert payload["countryCode"] == "IN"
    assert payload["region"] == "Gujarat"
    # The transient address and precise coordinates must never reach the browser.
    assert "8.8.8.8" not in json.dumps(payload)
    assert "latitude" not in json.dumps(payload)


async def test_suggestions_remain_usable_when_lookup_offline_or_address_is_private(_fake_localization):
    async def offline_geolocate(ip):
        raise RuntimeError("offline")

    offline = await loc_route.suggestions_for_request(
        {"query": {"languages": "gu"}, "headers": {}, "ip": "1.1.1.1", "socket": {}},
        geolocate=offline_geolocate,
    )
    assert offline["countryCode"] is None
    assert offline["region"] is None

    calls = {"count": 0}

    async def unexpected_geolocate(ip):
        calls["count"] += 1
        return {}

    async def geolocate_current():
        return {"countryCode": "IN", "region": "Gujarat", "ip": "must-not-leak"}

    local = await loc_route.suggestions_for_request(
        {"query": {}, "headers": {"accept-language": "en-US"}, "ip": "127.0.0.1", "socket": {}},
        geolocate=unexpected_geolocate,
        geolocate_current=geolocate_current,
    )
    assert calls["count"] == 0
    assert local["countryCode"] == "IN"
    assert local["region"] == "Gujarat"
    assert "must-not-leak" not in json.dumps(local)


async def test_translation_body_passes_only_locale_texts_and_settings():
    settings = {"localLlmProvider": "ollama", "ollamaModel": "gemma-local"}
    received = {"request": None}

    async def translator(request):
        received["request"] = request
        return {
            "locale": "gu-IN",
            "translations": ["એજન્ટ", "સેટિંગ્સ"],
            "provider": "ollama",
            "model": "gemma-local",
            "fallback": False,
        }

    payload = await loc_route.translation_for_body(
        {"locale": "gu-IN", "texts": ["Agent", "Settings"], "ignored": "not forwarded"},
        settings_provider=lambda: settings,
        translator=translator,
    )
    assert received["request"] == {"locale": "gu-IN", "texts": ["Agent", "Settings"], "settings": settings}
    assert payload["translations"] == ["એજન્ટ", "સેટિંગ્સ"]
    assert payload["fallback"] is False


async def test_translation_helper_rejects_missing_json_object_before_reading_settings():
    settings_read = {"value": False}

    def settings_provider():
        settings_read["value"] = True
        return {}

    with pytest.raises(FakeLocalizationError) as excinfo:
        await loc_route.translation_for_body(None, settings_provider=settings_provider)
    assert excinfo.value.status == 400
    assert "JSON request body" in excinfo.value.message
    assert settings_read["value"] is False


def _app():
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(loc_route.router, prefix="/api/locale")
    return app


def test_translate_route_forwards_body_end_to_end(monkeypatch, _fake_localization):
    settings = {"localLlmProvider": "ollama"}
    received = {"request": None}

    async def translator(request):
        received["request"] = request
        return {"locale": "gu-IN", "translations": ["એજન્ટ"], "fallback": False}

    monkeypatch.setattr(store, "get_settings", lambda: settings)
    monkeypatch.setattr(_fake_localization, "translate_texts", translator)

    client = TestClient(_app())
    resp = client.post("/api/locale/translate", json={"locale": "gu-IN", "texts": ["Agent"]})
    assert resp.status_code == 200
    assert resp.json()["translations"] == ["એજન્ટ"]
    assert received["request"] == {"locale": "gu-IN", "texts": ["Agent"], "settings": settings}


def test_suggestions_route_builds_request_and_returns_payload(monkeypatch, _fake_localization):
    # Force the private-IP branch so the server-egress lookup runs deterministically
    # regardless of the TestClient's synthetic client host.
    monkeypatch.setattr(_fake_localization, "is_public_ip", lambda ip: False)

    async def geolocate_current():
        return {"countryCode": "IN", "region": "Gujarat", "ip": "must-not-leak"}

    monkeypatch.setattr(_fake_localization, "locate_current_ip", geolocate_current)

    client = TestClient(_app())
    resp = client.get("/api/locale/suggestions", params={"languages": "gu-IN,en-US"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["countryCode"] == "IN"
    assert body["region"] == "Gujarat"
    assert "must-not-leak" not in json.dumps(body)
