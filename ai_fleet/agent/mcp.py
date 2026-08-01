"""Port of packages/shared/src/agent/mcp.js.

Optional MCP tool loader for the agent framework. A workflow may declare
``mcp: ['linear', 'github']``; this resolves those to LangChain tools via
``langchain-mcp-adapters`` when the servers are enabled/configured.

Everything here is best-effort and OFF by default:
  - unknown/disabled servers are skipped,
  - a missing ``langchain-mcp-adapters`` dependency degrades to no MCP tools,
  - a connection error yields no tools rather than failing the run.
So enabling MCP never breaks the standard (built-in tools) flow.
"""

from __future__ import annotations

from ai_fleet.config import CONFIG
from ai_fleet import logger


def _ctx_get(ctx, key):
    """Read a field from the run context (dict or object), JS ``ctx.field``."""
    if ctx is None:
        return None
    if isinstance(ctx, dict):
        return ctx.get(key)
    return getattr(ctx, key, None)


def repository_allows_mcp(name, ctx=None):
    """Repository-aware MCP gate. Broker-backed runs never expose a broad forge MCP."""
    if name != "github":
        return True
    if _ctx_get(ctx, "repositoryProvider") == "gitlab":
        return False
    if _ctx_get(ctx, "repositoryBroker"):
        return False
    return True


def is_configured(name, ctx=None):
    """Whether a named MCP server is enabled and has the credentials it needs."""
    if not repository_allows_mcp(name, ctx):
        return False
    conf = getattr(CONFIG.MCP, name, None)
    if not conf or not getattr(conf, "enabled", False):
        return False
    if name == "linear":
        return bool(_ctx_get(ctx, "apiKey"))  # Bearer = stored Linear key
    if name == "github":
        return bool(getattr(conf, "token", None))
    if name == "playwright":
        return bool(getattr(conf, "command", None))  # local stdio server, no credentials
    return False


def server_config(name, ctx=None):
    """MultiServerMCPClient server entry for a named server."""
    conf = getattr(CONFIG.MCP, name, None)
    if name == "linear":
        # transport is required by the Python adapter; the JS adapter infers HTTP.
        return {
            "url": conf.url,
            "headers": {"Authorization": f"Bearer {_ctx_get(ctx, 'apiKey')}"},
            "transport": "streamable_http",
        }
    if name == "github":
        return {
            "url": conf.url,
            "headers": {"Authorization": f"Bearer {conf.token}"},
            "transport": "streamable_http",
        }
    if name == "playwright":
        # Local stdio server launched as a child process (no network credentials).
        args = conf.args if isinstance(conf.args, list) else []
        return {"transport": "stdio", "command": conf.command, "args": args}
    return None


async def load_mcp_tools(names, ctx=None, *, client_factory=None):
    """Load MCP tools for the named servers.

    Returns ``[]`` when none are configured, the adapter dependency is absent, or
    the connection fails.

    ``client_factory`` is an injectable seam (defaults to the real, lazily
    imported ``MultiServerMCPClient``): a callable ``(mcp_servers: dict) -> client``
    whose ``client`` exposes an async ``get_tools()``. Tests pass a fake here.
    """
    ctx = ctx or {}
    wanted = [n for n in (names if isinstance(names, list) else []) if is_configured(n, ctx)]
    if not wanted:
        return []

    factory = client_factory
    if factory is None:
        try:
            from langchain_mcp_adapters.client import MultiServerMCPClient
        except Exception:
            logger.warn(
                "MCP tools requested but langchain-mcp-adapters is not installed; skipping."
            )
            return []
        factory = MultiServerMCPClient

    mcp_servers = {name: server_config(name, ctx) for name in wanted}

    try:
        client = factory(mcp_servers)
        tools = await client.get_tools()
        logger.info(f"MCP: loaded {len(tools)} tool(s) from {', '.join(wanted)}.")
        return tools
    except Exception as err:
        msg = getattr(err, "message", None) or str(err) or repr(err)
        logger.warn(f"MCP tool load failed ({', '.join(wanted)}): {msg}")
        return []
