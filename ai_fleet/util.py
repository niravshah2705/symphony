"""Small HTTP/formatting helpers (port of packages/shared/src/util.js).

The JS ``asyncHandler``/``sendError`` express helpers are replaced by FastAPI's
native async handlers and exception handlers (see services). ``AppError`` carries
an HTTP status the same way the JS errors set ``err.status``; ``error_response``
builds the consistent ``{ "error": message }`` envelope.
"""

from __future__ import annotations

from fastapi.responses import JSONResponse


class AppError(Exception):
    """An error carrying an HTTP status + optional code (mirrors JS ``err.status``)."""

    def __init__(self, message: str, status: int = 500, code: str | None = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


def error_response(err: Exception) -> JSONResponse:
    """Consistent JSON error responder (mirrors util.sendError)."""
    status = getattr(err, "status", None) or 500
    message = getattr(err, "message", None) or (str(err) if str(err) else "Server error.")
    return JSONResponse(status_code=status, content={"error": message})


def mask_key(key: str | None) -> str:
    """Mask a secret for display — never returns the raw value."""
    if not key:
        return ""
    if len(key) <= 8:
        return "••••"
    return f"{key[:4]}••••{key[-4:]}"
