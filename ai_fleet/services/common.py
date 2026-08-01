"""Shared FastAPI service helpers (replaces express.json / asyncHandler / sendError).

A single exception handler mirrors Express's central error handler: any exception
carrying an integer ``.status`` (util.AppError, LinearError, AgentError,
AgentRuntimeError, MemoryError, …) becomes ``JSONResponse(status, {"error": msg})``;
everything else becomes a 500 with a generic message.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from ai_fleet import store
from ai_fleet.util import AppError


async def json_body(request: Request) -> dict:
    """Parsed JSON body, or {} for an empty/invalid body (matches express.json())."""
    try:
        raw = await request.body()
        if not raw:
            return {}
        import json

        data = json.loads(raw)
        return data if isinstance(data, dict) else {"_": data}
    except Exception:
        return {}


def _status_of(exc: Exception) -> int:
    status = getattr(exc, "status", None)
    if isinstance(status, int) and 100 <= status <= 599:
        return status
    return 500


def _error_envelope(exc: Exception) -> JSONResponse:
    status = _status_of(exc)
    message = getattr(exc, "message", None) or (str(exc) if status != 500 else "Server error.")
    return JSONResponse(status_code=status, content={"error": message})


def register_exception_handlers(app: FastAPI) -> None:
    """Register the central error handling (mirrors Express's central error handler).

    A catch-all middleware renders any exception carrying an integer ``.status``
    (util.AppError, LinearError, AgentError, AgentRuntimeError, ProjectTaskError, …)
    as ``{"error": message}`` with that status, and everything else as a 500. A
    middleware (rather than only ``@app.exception_handler``) is used so the
    rendering is deterministic under Starlette's TestClient, which otherwise
    re-raises through the special base-``Exception`` handler.
    """

    async def _catch_all(request: Request, call_next):
        try:
            return await call_next(request)
        except Exception as exc:  # noqa: BLE001 — central boundary, like sendError
            return _error_envelope(exc)

    app.add_middleware(BaseHTTPMiddleware, dispatch=_catch_all)

    # Keep an explicit AppError handler too (covers paths a middleware might miss,
    # e.g. exceptions raised in dependencies before the route runs).
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError):
        return JSONResponse(status_code=exc.status, content={"error": exc.message})


def require_assumed_role():
    """Dependency: reject with 403 unless a team member is assumed (planner role gate)."""
    role = store.get_assumed_role()
    if not role:
        raise AppError("Assume a team member first to run the agent.", 403)
    return role
