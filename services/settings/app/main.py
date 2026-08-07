"""FastAPI application factory.

Wires configuration, logging, rate limiting, the authentication middleware,
routers and exception handlers. Unlike the org service there is no super-admin
bootstrap — this service owns no user lifecycle; it authenticates identities the
platform already provisioned (Firebase) and JIT-provisions org-less externals.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.api.v1 import api_router
from app.core.config import get_settings
from app.core.logging import configure_logging, get_logger
from app.errors import register_exception_handlers
from app.middleware.auth import AuthContextMiddleware
from app.middleware.rate_limit import limiter

logger = get_logger("app.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings.debug)
    logger.info("Settings service started (env=%s)", settings.app_env)
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.debug)

    app = FastAPI(
        title="Settings Policy Service",
        version="1.0.0",
        lifespan=lifespan,
    )

    # Rate limiting (global per-IP cap available via SlowAPI).
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)
    app.add_middleware(SlowAPIMiddleware)

    # Authentication runs for every /api/v1 route except the public allowlist.
    app.add_middleware(AuthContextMiddleware)

    register_exception_handlers(app)
    app.include_router(api_router)
    return app


def _rate_limit_handler(request, exc):  # type: ignore[no-untyped-def]
    from fastapi.responses import JSONResponse

    return JSONResponse(
        status_code=429,
        content={"error": {"code": "rate_limited", "message": "Too many requests, slow down"}},
    )


app = create_app()
