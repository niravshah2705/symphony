"""Application exception types and sanitized exception handlers.

Error responses never leak stack traces, SQL, or internal paths (api-security.md).
All handlers return a consistent envelope: {"error": {"code", "message"}}.
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.logging import get_logger

logger = get_logger("app.errors")

# Firestore raises FAILED_PRECONDITION when a query needs a composite index that
# does not exist yet (see deploy/gcp/terraform/firestore.tf). Import lazily so
# test/dev envs without the client library still load this module.
try:  # pragma: no cover - exercised only where google-cloud-firestore is present
    from google.api_core import exceptions as _gcloud_exceptions
except Exception:  # noqa: BLE001 - optional dependency
    _gcloud_exceptions = None


class AppError(Exception):
    """Base class for domain errors mapped to HTTP responses."""

    status_code = 500
    code = "internal_error"
    message = "Internal server error"

    def __init__(self, message: str | None = None, *, code: str | None = None) -> None:
        super().__init__(message or self.message)
        if message:
            self.message = message
        if code:
            self.code = code


class UnauthorizedError(AppError):
    status_code = 401
    code = "unauthorized"
    message = "Authentication required"


class ForbiddenError(AppError):
    status_code = 403
    code = "forbidden"
    message = "You do not have permission to perform this action"


class NotFoundError(AppError):
    status_code = 404
    code = "not_found"
    message = "Resource not found"


class ConflictError(AppError):
    status_code = 409
    code = "conflict"
    message = "Resource conflict"


class ValidationAppError(AppError):
    status_code = 422
    code = "validation_error"
    message = "Invalid request"


def _envelope(code: str, message: str) -> dict[str, dict[str, str]]:
    return {"error": {"code": code, "message": message}}


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code, content=_envelope(exc.code, exc.message)
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, str) else "Request failed"
        return JSONResponse(
            status_code=exc.status_code,
            content=_envelope("http_error", detail),
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Return field paths + messages, but not the raw input values.
        errors = [
            {"loc": ".".join(str(p) for p in e["loc"]), "msg": e["msg"]}
            for e in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={"error": {"code": "validation_error", "message": "Invalid request", "fields": errors}},
        )

    if _gcloud_exceptions is not None:
        @app.exception_handler(_gcloud_exceptions.FailedPrecondition)
        async def _missing_index(_: Request, exc: Exception) -> JSONResponse:
            # A composite index is missing or still building. Degrade to a clean,
            # diagnosable 503 instead of an opaque 500, and log loudly for ops so
            # the required index (firestore.tf) can be applied.
            logger.error(
                "Firestore FAILED_PRECONDITION (likely a missing/building composite "
                "index — see deploy/gcp/terraform/firestore.tf): %s",
                exc,
            )
            return JSONResponse(
                status_code=503,
                content=_envelope(
                    "index_unavailable",
                    "This list is temporarily unavailable while a database index finishes "
                    "building. Please try again shortly.",
                ),
            )

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled error: %s", exc)
        return JSONResponse(
            status_code=500, content=_envelope("internal_error", "Internal server error")
        )
