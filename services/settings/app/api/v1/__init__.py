"""Aggregates all v1 routers under the /api/v1 prefix."""
from __future__ import annotations

from fastapi import APIRouter

from app.api.v1 import (
    routes_health,
    routes_internal,
    routes_me,
    routes_settings,
)

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(routes_health.router)
api_router.include_router(routes_me.router)
api_router.include_router(routes_settings.router)
api_router.include_router(routes_internal.router)

__all__ = ["api_router"]
