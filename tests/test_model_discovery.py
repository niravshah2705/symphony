"""Port of packages/shared/src/agent/model-discovery.test.js.

Uses injected ``fetch_impl`` / ``create_anthropic_client`` fakes so no test hits
the network or requires the (uninstalled) ``anthropic`` SDK. The final JS test
(``ultra is forwarded only by the ChatGPT Codex backend``) exercises
``createChatModel`` from the LLM module, which is out of scope for this port.
"""

from datetime import datetime, timezone

import pytest

from ai_fleet.config import CONFIG
from ai_fleet.agent import model_discovery
from ai_fleet.agent.model_discovery import discover_models, get_cached_model


def _date_utc_ms(year, month0, day):
    """JS ``Date.UTC(year, month0, day)`` -> epoch milliseconds."""
    dt = datetime(year, month0 + 1, day, tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


class FakeResponse:
    def __init__(self, body, status=200):
        self.ok = 200 <= status < 300
        self.status = status
        self._body = body

    async def json(self):
        return self._body


def json_response(body, status=200):
    return FakeResponse(body, status)


@pytest.fixture(autouse=True)
def _reset_cache():
    model_discovery.reset_cache_for_tests()
    yield
    model_discovery.reset_cache_for_tests()


async def test_fallback_catalogs_are_synchronously_seeded_with_current_models():
    sol = get_cached_model("codex", "gpt-5.6-sol")
    assert sol["defaultReasoningEffort"] == "xhigh"
    assert [item["value"] for item in sol["reasoningEfforts"]] == ["low", "medium", "high", "xhigh", "max", "ultra"]

    fable = get_cached_model("claude", "claude-fable-5")
    assert fable["contextWindow"] == 1000000
    assert fable["maxOutputTokens"] == 128000
    assert fable["reasoningAdapter"] == "anthropic-adaptive"

    disconnected = await discover_models("claude", {"credentials": None})
    assert disconnected["connected"] is False
    assert disconnected["source"] == "fallback"
    assert disconnected["refreshedAt"] is None
    assert any(model["id"] == "claude-sonnet-5" for model in disconnected["models"])


async def test_codex_discovery_maps_live_catalog_filters_hidden_and_caches():
    calls = {"n": 0}

    async def fetch_impl(url, options=None):
        calls["n"] += 1
        from urllib.parse import urlparse, parse_qs

        parsed = urlparse(url)
        assert parsed.path.endswith("/models")
        assert parse_qs(parsed.query)["client_version"] == [CONFIG.OAUTH.clientVersion]
        assert options["headers"]["Authorization"] == "Bearer token"
        assert options["headers"]["chatgpt-account-id"] == "acct_1"
        return json_response(
            {
                "models": [
                    {
                        "slug": "gpt-5.6-sol",
                        "display_name": "GPT-5.6-Sol",
                        "description": "Live Sol",
                        "default_reasoning_level": "xhigh",
                        "supported_reasoning_levels": [
                            {"effort": "low", "description": "Quick"},
                            {"effort": "xhigh", "description": "Deep"},
                            {"effort": "max", "description": "Maximum"},
                            {"effort": "ultra", "description": "Delegates"},
                        ],
                        "visibility": "list",
                        "supported_in_api": True,
                        "priority": 1,
                        "context_window": 372000,
                    },
                    {
                        "slug": "codex-auto-review",
                        "display_name": "Hidden",
                        "default_reasoning_level": "medium",
                        "supported_reasoning_levels": [{"effort": "medium", "description": "Medium"}],
                        "visibility": "hide",
                        "supported_in_api": True,
                        "priority": 0,
                    },
                ]
            }
        )

    options = {
        "credentials": {"accessToken": "token", "accountId": "acct_1"},
        "fetch_impl": fetch_impl,
        "now": _date_utc_ms(2026, 6, 10),
    }
    first = await discover_models("codex", options)
    assert first["source"] == "live"
    assert first["connected"] is True
    assert first["refreshedAt"] == "2026-07-10T00:00:00.000Z"
    assert len(first["models"]) == 1
    assert first["models"][0]["id"] == "gpt-5.6-sol"
    assert first["models"][0]["contextWindow"] == 372000
    assert first["models"][0]["maxOutputTokens"] == 128000
    assert [item["value"] for item in first["models"][0]["reasoningEfforts"]] == ["low", "xhigh", "max", "ultra"]
    assert first["models"][0]["reasoningEfforts"][3]["description"] == "Delegates"

    cached = await discover_models("codex", options)
    assert calls["n"] == 1
    assert cached == first

    await discover_models("codex", {**options, "refresh": True})
    assert calls["n"] == 2, "refresh bypasses the live cache"
    assert get_cached_model("codex", "gpt-5.6-sol")["source"] == "live"


async def test_metered_openai_discovery_merges_fallbacks_and_hides_ultra():
    async def fetch_impl(url, options=None):
        assert url.endswith("/models")
        return json_response(
            {"data": [{"id": "gpt-5.6-sol"}, {"id": "gpt-5.7"}, {"id": "text-embedding-3-large"}]}
        )

    discovered = await discover_models(
        "codex",
        {
            "backend": "api",
            "credentials": {"accessToken": "api-token"},
            "fetch_impl": fetch_impl,
            "now": _date_utc_ms(2026, 6, 10),
        },
    )

    assert discovered["source"] == "live"
    sol = next(m for m in discovered["models"] if m["id"] == "gpt-5.6-sol")
    assert sol["source"] == "live"
    assert sol["contextWindow"] == 1050000
    assert any(item["value"] == "none" for item in sol["reasoningEfforts"])
    assert all(item["value"] != "ultra" for m in discovered["models"] for item in m["reasoningEfforts"])
    unknown = next(m for m in discovered["models"] if m["id"] == "gpt-5.7")
    assert unknown["reasoningAdapter"] == "none", "unknown API models must not inherit invented effort values"
    assert [item["value"] for item in unknown["reasoningEfforts"]] == ["none"]
    assert not any(m["id"] == "text-embedding-3-large" for m in discovered["models"])


async def test_claude_discovery_maps_sdk_limits_and_effort_capabilities():
    received = {}

    class FakeModels:
        async def list(self, limit=None):
            class Page:
                data = [
                    {
                        "id": "claude-sonnet-5",
                        "display_name": "Claude Sonnet 5",
                        "max_input_tokens": 1000000,
                        "max_tokens": 128000,
                        "capabilities": {
                            "effort": {
                                "supported": True,
                                "low": {"supported": True},
                                "medium": {"supported": True},
                                "high": {"supported": True},
                                "xhigh": {"supported": True},
                                "max": {"supported": True},
                            }
                        },
                    },
                    {
                        "id": "claude-haiku-4-5-20251001",
                        "display_name": "Claude Haiku 4.5",
                        "max_input_tokens": 200000,
                        "max_tokens": 64000,
                        "capabilities": {"effort": {"supported": False}},
                    },
                    {
                        "id": "claude-opus-4-5-20251101",
                        "display_name": "Claude Opus 4.5",
                        "max_input_tokens": 200000,
                        "max_tokens": 64000,
                        "capabilities": {
                            "effort": {"supported": True, "low": {"supported": True}, "high": {"supported": True}},
                            "thinking": {"types": {"adaptive": {"supported": False}}},
                        },
                    },
                ]

            return Page()

    class FakeClient:
        def __init__(self):
            self.models = FakeModels()

    def create_anthropic_client(options):
        received.update(options)
        return FakeClient()

    discovered = await discover_models(
        "claude",
        {
            "credentials": {"accessToken": "claude-token"},
            "create_anthropic_client": create_anthropic_client,
            "now": _date_utc_ms(2026, 6, 10),
        },
    )

    assert received["api_key"] is None
    assert received["auth_token"] == "claude-token"
    assert received["default_headers"]["anthropic-beta"] == CONFIG.CLAUDE.betaHeader
    assert discovered["source"] == "live"
    sonnet = discovered["models"][0]
    assert sonnet["reasoningAdapter"] == "anthropic-adaptive"
    assert [item["value"] for item in sonnet["reasoningEfforts"]] == ["low", "medium", "high", "xhigh", "max"]
    assert sonnet["defaultReasoningEffort"] == "high"
    haiku = discovered["models"][1]
    assert haiku["reasoningAdapter"] == "none"
    assert [item["value"] for item in haiku["reasoningEfforts"]] == ["none"]
    manual = discovered["models"][2]
    assert manual["reasoningAdapter"] == "anthropic-effort"
    assert [item["value"] for item in manual["reasoningEfforts"]] == ["low", "high"]


async def test_live_discovery_failures_return_connected_static_fallback():
    async def fetch_impl(url, options=None):
        raise Exception("offline")

    codex = await discover_models(
        "codex",
        {"credentials": {"accessToken": "token", "accountId": "acct_1"}, "fetch_impl": fetch_impl, "refresh": True},
    )
    assert codex["connected"] is True
    assert codex["source"] == "fallback"
    assert codex["refreshedAt"] is None
    assert any(model["id"] == "gpt-5.6-sol" for model in codex["models"])


async def test_strict_discovery_surfaces_provider_failures():
    async def fetch_impl(url, options=None):
        return json_response({"error": "forbidden"}, 403)

    with pytest.raises(Exception, match="HTTP 403"):
        await discover_models(
            "codex",
            {
                "credentials": {"accessToken": "token", "accountId": "acct_1"},
                "fetch_impl": fetch_impl,
                "refresh": True,
                "strict": True,
            },
        )
