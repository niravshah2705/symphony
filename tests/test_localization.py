"""Port of packages/shared/src/agent/localization.test.js."""

import sys
import types

import pytest

from ai_fleet.agent.localization import (
    LANGUAGE_CATALOG,
    LIMITS,
    LocalizationError,
    TranslationCache,
    clear_current_location_cache,
    is_public_ip,
    language_suggestions,
    locate_current_ip,
    locate_ip,
    normalize_ip,
    normalize_locale_tag,
    normalize_translation_model,
    normalize_translation_request,
    parse_language_hints,
    protect_text,
    supported_locale,
    translate_texts,
    translation_prompt,
)


@pytest.fixture
def fake_llm(monkeypatch):
    """translate_texts -> _configured_local_identity lazily imports agent.llm
    (ported in parallel); inject a minimal provider_for_role for role 'local'."""
    module = types.ModuleType("ai_fleet.agent.llm")

    def provider_for_role(settings, role):
        settings = settings or {}
        return settings.get("localLlmProvider") or settings.get("llmProvider")

    module.provider_for_role = provider_for_role
    monkeypatch.setitem(sys.modules, "ai_fleet.agent.llm", module)
    return module


class _FakeResponse:
    def __init__(self, ok, payload):
        self.ok = ok
        self._payload = payload

    async def json(self):
        return self._payload


def test_locale_tags_are_canonical_and_resolved_against_catalog():
    assert normalize_locale_tag(" gu_in ") == "gu-IN"
    assert normalize_locale_tag("EN-us") == "en-US"
    assert normalize_locale_tag("not a locale") is None
    assert supported_locale("gu-Gujr-IN") == "gu-IN"
    assert supported_locale("en-IN") == "en"
    assert supported_locale("it-IT") is None
    assert len(LANGUAGE_CATALOG) < 12
    assert next(item for item in LANGUAGE_CATALOG if item["tag"] == "gu-IN") == {
        "tag": "gu-IN",
        "label": "Gujarati",
        "nativeLabel": "ગુજરાતી",
        "direction": "ltr",
    }


def test_language_hints_honor_quality_canonicalize_dedupe_and_ignore_unsupported():
    assert parse_language_hints("de-DE;q=0.3, gu_IN;q=1, fr-FR;q=0.8, gu;q=0.5, it-IT") == ["gu-IN", "fr", "de"]
    assert parse_language_hints("*;q=1, en;q=0, ja-JP") == ["ja-JP"]
    assert parse_language_hints("fr;q=bogus, de;q=1.0000, en") == ["en"]
    assert len(parse_language_hints([f"en-{i}" for i in range(30)])) <= LIMITS["languageHints"]


def test_suggestions_ranked_by_browser_and_location_but_always_keep_en_and_gu():
    result = language_suggestions(
        browser_languages=["fr-FR", "de-DE", "ja-JP", "ar"],
        country_code="IN",
        region=" Gujarat\n",
    )
    assert result["locale"] == "fr"
    assert result["countryCode"] == "IN"
    assert result["region"] == "Gujarat"
    assert len(result["suggestions"]) <= 5
    assert any(item["tag"] == "en" for item in result["suggestions"])
    assert any(item["tag"] == "gu-IN" for item in result["suggestions"])
    assert result["suggestions"][0]["reason"] == "browser"


def test_ip_handling_accepts_public_and_rejects_local_or_reserved():
    assert normalize_ip("::ffff:8.8.8.8") == "8.8.8.8"
    assert is_public_ip("8.8.8.8") is True
    assert is_public_ip("10.1.2.3") is False
    assert is_public_ip("127.0.0.1") is False
    assert is_public_ip("192.168.2.2") is False
    assert is_public_ip("203.0.113.8") is False
    assert is_public_ip("::1") is False
    assert is_public_ip("2001:db8::1") is False


async def test_ip_geolocation_returns_bounded_country_region_and_fails_closed():
    requested = []

    async def fetch_impl(url):
        requested.append(url)
        return _FakeResponse(True, {"success": True, "country_code": "us", "region": " California\n", "ip": "8.8.8.8"})

    location = await locate_ip("8.8.8.8", fetch_impl=fetch_impl)
    assert location == {"countryCode": "US", "region": "California"}
    assert "ip" not in location
    assert len(requested) == 1

    async def must_not_fetch(url):
        raise AssertionError("must not fetch")

    assert await locate_ip("127.0.0.1", fetch_impl=must_not_fetch) is None

    async def offline(url):
        raise RuntimeError("offline")

    assert await locate_ip("8.8.4.4", fetch_impl=offline) is None


async def test_localhost_geolocation_uses_public_egress_without_returning_address():
    clear_current_location_cache()
    holder = {"requested": ""}

    async def fetch_impl(url):
        holder["requested"] = url
        return _FakeResponse(True, {"success": True, "country_code": "in", "region": "Gujarat", "ip": "198.51.100.2"})

    location = await locate_current_ip(fetch_impl=fetch_impl)
    assert holder["requested"] == "https://ipwho.is/?fields=success,country_code,region"
    assert location == {"countryCode": "IN", "region": "Gujarat"}
    assert "ip" not in location
    clear_current_location_cache()


def test_translation_request_bounds_count_item_size_and_total_size():
    assert normalize_translation_request("gu", ["Agent", "Settings"]) == {
        "locale": "gu-IN",
        "texts": ["Agent", "Settings"],
    }
    with pytest.raises(LocalizationError):
        normalize_translation_request("it", ["Agent"])
    with pytest.raises(LocalizationError, match="array of strings"):
        normalize_translation_request("gu-IN", "Agent")
    with pytest.raises(LocalizationError, match=r"texts\[0\]"):
        normalize_translation_request("gu-IN", [42])
    with pytest.raises(LocalizationError, match="2,500 characters or fewer"):
        normalize_translation_request("gu-IN", ["x" * (LIMITS["textChars"] + 1)])


def test_translation_protection_preserves_placeholders_urls_html_printf_and_code():
    source = "Open {project} at https://example.com/a?q=1, run `npm test`, then show <b>%1$s</b>."
    protection = protect_text(source)
    for leaked in ["example.com", "npm test", "{project}", "<b>", "%1$s"]:
        assert leaked not in protection["protectedText"]
    model_text = "ખોલો " + " અને ".join(entry["token"] for entry in protection["tokens"]) + "."
    (restored,) = normalize_translation_model({"translations": [model_text]}, [protection])
    for protected_value in ["{project}", "https://example.com/a?q=1,", "`npm test`", "<b>", "%1$s", "</b>"]:
        assert protected_value in restored
    with pytest.raises(ValueError, match="protected content"):
        normalize_translation_model(
            {"translations": [model_text.replace(protection["tokens"][0]["token"], "બદલ્યું")]},
            [protection],
        )
    with pytest.raises(ValueError, match="unknown protected token"):
        normalize_translation_model(
            {"translations": ["__AI_FLEET_L10N_The repository needs attention.__"]},
            [protect_text("The repository needs attention.")],
        )


def test_gujarati_prompt_requests_all_ui_and_internal_status_communication():
    prompt = translation_prompt("gu-IN", [protect_text("Agent started")])
    assert "Gujarati (ગુજરાતી), locale gu-IN" in prompt
    assert "including internal status messages" in prompt
    assert "untrusted_ui_strings" in prompt
    assert "beginning __AI_FLEET_L10N_" not in prompt

    protected_prompt = translation_prompt("gu-IN", [protect_text("Open {project}")])
    assert "Only copy tokens already present" in protected_prompt


async def test_translation_uses_deterministic_source_fallback_when_unavailable(fake_llm):
    input_texts = ["Agent started", "Open {project}"]

    async def resolve_local(settings):
        raise RuntimeError("offline")

    result = await translate_texts(
        {
            "locale": "gu-IN",
            "texts": input_texts,
            "settings": {"localLlmProvider": "ollama", "ollamaModel": "local-model"},
        },
        {"resolveLocal": resolve_local, "cache": None},
    )
    assert result["translations"] == input_texts
    assert result["provider"] == "ollama"
    assert result["model"] == "local-model"
    assert result["fallback"] is True


async def test_successful_local_translations_are_cached_without_raw_keys(fake_llm):
    cache = TranslationCache(max_entries=2, ttl_ms=60_000)
    calls = {"n": 0}

    async def resolve_local(settings):
        return {"provider": "ollama", "model": "gemma-local", "host": "http://localhost"}

    async def run_structured(normalize=None, **kwargs):
        calls["n"] += 1
        return {"value": normalize({"translations": ["એજન્ટ", "સેટિંગ્સ"]}), "usedFallback": False}

    deps = {"cache": cache, "resolveLocal": resolve_local, "runStructured": run_structured}
    request = {
        "locale": "gu-IN",
        "texts": ["Agent", "Settings"],
        "settings": {"localLlmProvider": "ollama", "ollamaModel": "gemma-local"},
    }
    first = await translate_texts(request, deps)
    second = await translate_texts(request, deps)
    assert first["translations"] == ["એજન્ટ", "સેટિંગ્સ"]
    assert first["cached"] is False
    assert second["cached"] is True
    assert second["fallback"] is False
    assert calls["n"] == 1
    assert not any("Agent" in key for key in cache.entries.keys())


async def test_english_identity_translation_does_not_invoke_a_model():
    async def resolve_local(settings):
        raise AssertionError("must not resolve a model")

    result = await translate_texts(
        {"locale": "en-US", "texts": ["Agent"], "settings": {}},
        {"resolveLocal": resolve_local, "cache": None},
    )
    assert result == {
        "locale": "en",
        "translations": ["Agent"],
        "provider": None,
        "model": None,
        "fallback": False,
        "cached": False,
    }
