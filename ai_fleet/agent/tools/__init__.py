"""Tool registry for the agent framework (port of packages/shared/src/agent/tools.js).

Workflow files reference tools by name (e.g. ``tools: ['web_search']``); the
framework resolves each name to a LangChain tool instance via ``build(name, ctx)``.
Keeping tool construction here (rather than inline in each agent) lets planning
and coding workflows share the same tools and avoids re-implementing them per agent.

``ctx`` carries per-run collaborators: ``{ step, apiKey }``.
  - step(message, level?)  progress callback (optional)
  - apiKey                 Linear server-side key (for linear_graphql)
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from ai_fleet import linear
from ai_fleet.agent.search import format_results, web_search_many


def _step_fn(ctx):
    step = ctx.get("step") if ctx else None
    return step if callable(step) else (lambda *a, **k: None)


class _WebSearchInput(BaseModel):
    queries: List[str] = Field(..., min_length=1, description="one or more search queries to run in parallel")


def web_search_tool(ctx=None):
    """web_search: batch web search grounding tool (queries run in parallel)."""
    ctx = ctx or {}
    from langchain_core.tools import StructuredTool

    step = _step_fn(ctx)

    async def _run(queries):
        raw = queries if isinstance(queries, list) else [queries]
        list_ = [q for q in raw if q][:6]
        word = "y" if len(list_) == 1 else "ies"
        step(f"🔎 agent web search ({len(list_)} quer{word} in parallel)")
        batch = await web_search_many(list_, 5)  # concurrent
        return "\n\n".join(f"## {r['query']}\n{format_results(r['snippets'])}" for r in batch)

    return StructuredTool(
        name="web_search",
        description=(
            "Search the web for current, real-world information. Pass an ARRAY of queries in `queries` "
            "to run several searches IN PARALLEL and get all their snippets back at once."
        ),
        args_schema=_WebSearchInput,
        coroutine=_run,
    )


class _LinearGraphqlInput(BaseModel):
    query: str = Field(description="A single GraphQL query or mutation")
    variables: Optional[Dict[str, Any]] = Field(default=None, description="GraphQL variables object")


def linear_graphql_tool(ctx=None):
    """linear_graphql: run ONE Linear GraphQL op with the server-side key (token never leaves the server)."""
    ctx = ctx or {}
    from langchain_core.tools import StructuredTool

    step = _step_fn(ctx)
    api_key = ctx.get("apiKey")

    async def _run(query, variables=None):
        op = re.sub(r"\s+", " ", str(query or "")).strip()[:60]
        step(f"🔗 linear_graphql: {op}…")
        try:
            data = await linear.linear_request(api_key, query, variables or {})
            return json.dumps(data)
        except Exception as err:
            return json.dumps({"error": getattr(err, "message", None) or str(err)})

    return StructuredTool(
        name="linear_graphql",
        description=(
            "Run ONE Linear GraphQL operation (query or mutation) against the Linear API using the "
            "server-side key. Pass `query` (GraphQL string) and optional `variables` (object). "
            "Returns the JSON `data` (or `{error}`). Use for reading the issue, managing the Workpad "
            "comment (commentCreate/commentUpdate), and transitioning state (issueUpdate)."
        ),
        args_schema=_LinearGraphqlInput,
        coroutine=_run,
    )


# Developer-tool folder (docker, environments, build, android, security,
# quality, codegen, playwright). Each is a factory ``(ctx) -> LangChainTool``
# that DELEGATES to a pre-installed standard CLI/MCP rather than re-implementing
# its behaviour. See tools/index.py to add more.
from ai_fleet.agent.tools.index import TOOL_FACTORIES  # noqa: E402

FACTORIES = {
    "web_search": web_search_tool,
    "linear_graphql": linear_graphql_tool,
    **TOOL_FACTORIES,
}


def build(name, ctx=None):
    """Build a single tool by registry name (returns None for unknown names)."""
    factory = FACTORIES.get(name)
    return factory(ctx) if factory else None


def build_many(names, ctx=None):
    """Build all tools named in ``names``, dropping unknown names."""
    if not isinstance(names, list):
        return []
    built = [build(n, ctx) for n in names]
    return [t for t in built if t]
