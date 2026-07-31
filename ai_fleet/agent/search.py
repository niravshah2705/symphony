"""Keyless web search via DuckDuckGo's HTML endpoint (port of agent/search.js).

Best-effort: returns [] on any failure so planning degrades gracefully. Results
are untrusted content — callers must fence them as data before sending to the
LLM (prompt-injection).
"""

from __future__ import annotations

import asyncio
import re
from urllib.parse import quote

import httpx

from ai_fleet import logger

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120 Safari/537.36"
)

_TIMEOUT_SECONDS = 8

# g/i/s flags in JS → IGNORECASE | DOTALL in Python.
_SNIPPET_RE = re.compile(r"result__snippet[^>]*>(.*?)</a>", re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _strip_html(s) -> str:
    text = str(s)
    text = _TAG_RE.sub("", text)
    text = text.replace("&amp;", "&")
    text = text.replace("&#x27;", "'")
    text = text.replace("&quot;", '"')
    text = text.replace("&lt;", "<")
    text = text.replace("&gt;", ">")
    text = text.replace("&nbsp;", " ")
    text = _WS_RE.sub(" ", text)
    return text.strip()


async def web_search(query, limit: int = 5) -> list[str]:
    """Run a web search and return up to ``limit`` snippet strings."""
    q = str(query or "").strip()
    if not q:
        return []
    try:
        url = f"https://html.duckduckgo.com/html/?q={quote(q, safe='')}"
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            resp = await client.get(url, headers={"User-Agent": UA})
        if not resp.is_success:
            logger.warn(f'web search failed ({resp.status_code}) for "{q[:60]}"')
            return []
        html = resp.text
        snippets = [_strip_html(m.group(1)) for m in _SNIPPET_RE.finditer(html)]
        snippets = [s for s in snippets if len(s) > 20][:limit]
        return snippets
    except Exception as err:  # best-effort: never propagate
        message = getattr(err, "message", None) or str(err) or repr(err)
        logger.warn(f'web search error for "{q[:60]}": {message}')
        return []


async def web_search_many(queries, limit: int = 5) -> list[dict]:
    """Run several searches concurrently. One entry per query (order preserved);
    blank queries are dropped; each search fails independently."""
    raw = queries if isinstance(queries, list) else [queries]
    query_list = [str(q or "").strip() for q in raw]
    query_list = [q for q in query_list if q]
    results = await asyncio.gather(*(web_search(q, limit) for q in query_list))
    return [{"query": q, "snippets": results[i]} for i, q in enumerate(query_list)]


def format_results(snippets) -> str:
    """Fenced, numbered text block of search results — safe to inline in a prompt."""
    if not snippets:
        return "(no web results)"
    return "\n".join(f"{i + 1}. {s}" for i, s in enumerate(snippets))
