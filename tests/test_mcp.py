"""Port of packages/shared/src/agent/mcp.test.js.

The two JS cases that assert against the coding.workflow module (that a broad
forge MCP is never attached, and that Playwright is attached) are NOT ported:
``agent/workflows/coding.workflow`` has not been ported to Python yet, and those
assertions belong to that module, not to mcp. Instead we cover mcp's own
contract per the port brief: repository_allows_mcp, is_configured, server_config,
and the fail-open behavior of load_mcp_tools (adapter absent, client injected,
and client error).
"""

from ai_fleet.config import CONFIG
from ai_fleet.agent import mcp


# --- repository_allows_mcp (ported from mcp.test.js case 1) ------------------

def test_github_mcp_disabled_for_gitlab_and_all_broker_runs():
    assert mcp.repository_allows_mcp("github", {"repositoryProvider": "gitlab"}) is False
    assert (
        mcp.repository_allows_mcp("github", {"repositoryProvider": "github", "repositoryBroker": True})
        is False
    )
    assert (
        mcp.repository_allows_mcp("github", {"repositoryProvider": "github", "repositoryBroker": False})
        is True
    )
    assert (
        mcp.repository_allows_mcp("linear", {"repositoryProvider": "gitlab", "repositoryBroker": True})
        is True
    )


def test_repository_allows_mcp_defaults_to_true_without_ctx():
    assert mcp.repository_allows_mcp("linear") is True
    assert mcp.repository_allows_mcp("github") is True
    assert mcp.repository_allows_mcp("playwright", {}) is True


# --- is_configured ----------------------------------------------------------

def test_is_configured_linear_requires_enabled_and_api_key(monkeypatch):
    monkeypatch.setattr(CONFIG.MCP.linear, "enabled", True)
    assert mcp.is_configured("linear", {"apiKey": "linear-key"}) is True
    assert mcp.is_configured("linear", {}) is False  # no Bearer key
    monkeypatch.setattr(CONFIG.MCP.linear, "enabled", False)
    assert mcp.is_configured("linear", {"apiKey": "linear-key"}) is False  # disabled


def test_is_configured_github_requires_token_and_respects_gate(monkeypatch):
    monkeypatch.setattr(CONFIG.MCP.github, "enabled", True)
    monkeypatch.setattr(CONFIG.MCP.github, "token", "gh-token")
    assert mcp.is_configured("github", {}) is True
    # repository gate wins regardless of credentials
    assert mcp.is_configured("github", {"repositoryBroker": True}) is False
    assert mcp.is_configured("github", {"repositoryProvider": "gitlab"}) is False
    monkeypatch.setattr(CONFIG.MCP.github, "token", "")
    assert mcp.is_configured("github", {}) is False  # no token


def test_is_configured_playwright_requires_command_only(monkeypatch):
    monkeypatch.setattr(CONFIG.MCP.playwright, "enabled", True)
    assert mcp.is_configured("playwright", {}) is True  # command defaults to "npx"
    monkeypatch.setattr(CONFIG.MCP.playwright, "command", "")
    assert mcp.is_configured("playwright", {}) is False


def test_is_configured_unknown_server_is_false():
    assert mcp.is_configured("unknown", {}) is False


# --- server_config ----------------------------------------------------------

def test_server_config_linear_uses_bearer_from_ctx():
    entry = mcp.server_config("linear", {"apiKey": "linear-key"})
    assert entry["url"] == CONFIG.MCP.linear.url
    assert entry["headers"]["Authorization"] == "Bearer linear-key"


def test_server_config_github_uses_conf_token(monkeypatch):
    monkeypatch.setattr(CONFIG.MCP.github, "token", "gh-token")
    entry = mcp.server_config("github", {})
    assert entry["headers"]["Authorization"] == "Bearer gh-token"


def test_server_config_playwright_is_local_stdio():
    entry = mcp.server_config("playwright", {})
    assert entry["transport"] == "stdio"
    assert entry["command"] == CONFIG.MCP.playwright.command
    assert isinstance(entry["args"], list)


def test_server_config_unknown_is_none():
    assert mcp.server_config("unknown", {}) is None


# --- load_mcp_tools fail-open behavior --------------------------------------

async def test_load_mcp_tools_empty_when_nothing_configured():
    assert await mcp.load_mcp_tools([], {}) == []
    # linear is disabled by default → not wanted
    assert await mcp.load_mcp_tools(["linear"], {"apiKey": "k"}) == []


async def test_load_mcp_tools_empty_when_names_not_a_list():
    assert await mcp.load_mcp_tools("linear", {"apiKey": "k"}) == []
    assert await mcp.load_mcp_tools(None, {}) == []


async def test_load_mcp_tools_empty_when_adapter_absent(monkeypatch):
    # langchain-mcp-adapters is not installed in this env; the default factory's
    # lazy import fails and we degrade to [] rather than raising.
    monkeypatch.setattr(CONFIG.MCP.linear, "enabled", True)
    assert await mcp.load_mcp_tools(["linear"], {"apiKey": "k"}) == []


async def test_load_mcp_tools_uses_injected_client(monkeypatch):
    monkeypatch.setattr(CONFIG.MCP.linear, "enabled", True)
    captured = {}

    class FakeClient:
        def __init__(self, servers):
            captured["servers"] = servers

        async def get_tools(self):
            return ["tool-a", "tool-b"]

    tools = await mcp.load_mcp_tools(["linear"], {"apiKey": "k"}, client_factory=FakeClient)
    assert tools == ["tool-a", "tool-b"]
    assert "linear" in captured["servers"]
    assert captured["servers"]["linear"]["headers"]["Authorization"] == "Bearer k"


async def test_load_mcp_tools_fails_open_when_factory_raises(monkeypatch):
    monkeypatch.setattr(CONFIG.MCP.linear, "enabled", True)

    def boom(_servers):
        raise RuntimeError("connection refused")

    assert await mcp.load_mcp_tools(["linear"], {"apiKey": "k"}, client_factory=boom) == []


async def test_load_mcp_tools_fails_open_when_get_tools_raises(monkeypatch):
    monkeypatch.setattr(CONFIG.MCP.linear, "enabled", True)

    class BadClient:
        def __init__(self, _servers):
            pass

        async def get_tools(self):
            raise RuntimeError("nope")

    assert await mcp.load_mcp_tools(["linear"], {"apiKey": "k"}, client_factory=BadClient) == []
