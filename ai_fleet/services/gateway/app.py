"""Gateway service — the single browser-facing origin (port of services/gateway).

Serves the SPA, owns the user-facing REST API and the OAuth flows (Codex/Claude),
and reverse-proxies the two agent surfaces to their isolated services:
  /api/agent/*  → planner service (CONFIG.SERVICES.plannerUrl)
  /api/coder/*  → coder service   (CONFIG.SERVICES.coderUrl)
The frontend keeps calling same-origin /api/* paths and is unaware of the split.
"""

from __future__ import annotations

import os

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from ai_fleet import logger
from ai_fleet.config import CONFIG
from ai_fleet.services.common import register_exception_handlers
from .auth import create_authentication_middleware, public_auth_config
from .proxy import create_proxy
from .routes import (
    businesses,
    claude,
    codex,
    issues,
    localization,
    observability,
    projects,
    roles,
    settings,
)

app = FastAPI(title="AI Fleet gateway")
register_exception_handlers(app)

# Authentication boundary: a no-op in local dev; fails closed in AUTH_MODE=istio
# unless Envoy supplied a verified Auth0 payload for every /api call.
app.add_middleware(BaseHTTPMiddleware, dispatch=create_authentication_middleware())


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/api/auth/config")
async def auth_config():
    return JSONResponse(content=public_auth_config(), headers={"Cache-Control": "no-store"})


@app.get("/vendor/auth0-spa-js.js")
async def auth0_sdk():
    # The frontend vendors the pinned Auth0 SDK into public/vendor/ (kept in the
    # JS/frontend surface). Served from this origin rather than a third-party CDN.
    path = os.path.join(CONFIG.PUBLIC_DIR, "vendor", "auth0-spa-js.js")
    if os.path.exists(path):
        return FileResponse(path, media_type="text/javascript")
    return JSONResponse(status_code=404, content={"error": "Auth0 SDK asset not found."})


@app.get("/api/auth/me")
async def auth_me(request: Request):
    return JSONResponse(content=getattr(request.state, "auth", None), headers={"Cache-Control": "no-store"})


# User-facing API routes (owned by the gateway).
app.include_router(settings.router, prefix="/api/settings")
app.include_router(codex.router, prefix="/api/settings/codex")
app.include_router(claude.router, prefix="/api/settings/claude")
app.include_router(projects.router, prefix="/api/projects")
app.include_router(issues.router, prefix="/api/issues")
app.include_router(businesses.router, prefix="/api/businesses")
app.include_router(roles.router, prefix="/api/roles")
app.include_router(observability.router, prefix="/api/observability")
app.include_router(localization.router, prefix="/api/locale")

# Agent surfaces are proxied to their isolated services.
_planner_proxy = create_proxy(CONFIG.SERVICES.plannerUrl)
_coder_proxy = create_proxy(CONFIG.SERVICES.coderUrl)
_PROXY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]


@app.api_route("/api/agent", methods=_PROXY_METHODS)
@app.api_route("/api/agent/{path:path}", methods=_PROXY_METHODS)
async def agent_proxy(request: Request, path: str = ""):
    return await _planner_proxy(request)


@app.api_route("/api/coder", methods=_PROXY_METHODS)
@app.api_route("/api/coder/{path:path}", methods=_PROXY_METHODS)
async def coder_proxy(request: Request, path: str = ""):
    return await _coder_proxy(request)


# Codex OAuth redirect target — registered before the SPA fallback.
@app.get("/auth/callback")
async def auth_callback(request: Request):
    return await codex.callback(request)


# Static frontend + SPA fallback for any non-API GET request.
@app.get("/{full_path:path}")
async def spa(full_path: str):
    if full_path.startswith("api/"):
        return JSONResponse(status_code=404, content={"error": "Not found."})
    candidate = os.path.normpath(os.path.join(CONFIG.PUBLIC_DIR, full_path))
    if full_path and candidate.startswith(os.path.realpath(CONFIG.PUBLIC_DIR)) and os.path.isfile(candidate):
        return FileResponse(candidate)
    return FileResponse(os.path.join(CONFIG.PUBLIC_DIR, "index.html"))


def main():
    import uvicorn

    port = CONFIG.SERVICES.gatewayPort
    logger.info(f"AI Fleet gateway running at http://localhost:{port}")
    logger.info(f"  → proxying /api/agent to {CONFIG.SERVICES.plannerUrl}")
    logger.info(f"  → proxying /api/coder to {CONFIG.SERVICES.coderUrl}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    main()
