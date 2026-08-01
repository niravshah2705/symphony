"""Shared FastAPI service helpers (replaces express.json / asyncHandler / sendError).

A single exception handler mirrors Express's central error handler: any exception
carrying an integer ``.status`` (util.AppError, LinearError, AgentError,
AgentRuntimeError, MemoryError, …) becomes ``JSONResponse(status, {"error": msg})``;
everything else becomes a 500 with a generic message.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

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


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError):
        return JSONResponse(status_code=exc.status, content={"error": exc.message})

    @app.exception_handler(Exception)
    async def _any_error(request: Request, exc: Exception):
        status = _status_of(exc)
        message = getattr(exc, "message", None) or (str(exc) if status != 500 else "Server error.")
        return JSONResponse(status_code=status, content={"error": message})


def require_assumed_role():
    """Dependency: reject with 403 unless a team member is assumed (planner role gate)."""
    role = store.get_assumed_role()
    if not role:
        raise AppError("Assume a team member first to run the agent.", 403)
    return role
