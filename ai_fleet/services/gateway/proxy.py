"""Minimal reverse proxy from the gateway to an isolated agent service
(port of services/gateway/src/proxy.js).

The gateway is the only browser-facing origin; agent endpoints (/api/agent,
/api/coder) are served by separate service processes. This forwards the request
verbatim (method, path + query, JSON body) to the target service and streams the
response status/body back. A network failure surfaces as 502 with a clear
message instead of a hung request.
"""

from __future__ import annotations

import httpx
from starlette.requests import Request
from starlette.responses import Response

from ai_fleet import logger


def create_proxy(base_url: str):
    async def proxy(request: Request) -> Response:
        # request.url includes path + query; forward it verbatim onto the target base.
        target = f"{base_url}{request.url.path}"
        if request.url.query:
            target = f"{target}?{request.url.query}"
        headers = {}
        body = None
        if request.method not in ("GET", "HEAD"):
            raw = await request.body()
            if raw:
                body = raw
                headers["content-type"] = "application/json"
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                resp = await client.request(request.method, target, headers=headers, content=body)
            content_type = resp.headers.get("content-type")
            return Response(
                content=resp.content,
                status_code=resp.status_code,
                media_type=content_type,
            )
        except httpx.HTTPError as err:
            message = str(err) or repr(err)
            logger.error(f"gateway proxy {request.method} {target} failed: {message}")
            return Response(
                content=f'{{"error": "Agent service unavailable: {message}"}}',
                status_code=502,
                media_type="application/json",
            )

    return proxy
