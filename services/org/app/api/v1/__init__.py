"""Aggregates all v1 routers under the /api/v1 prefix.

Routers are added here as each resource is implemented.
"""
from __future__ import annotations

from fastapi import APIRouter

from app.api.v1 import (
    routes_auth,
    routes_health,
    routes_internal,
    routes_invitations,
    routes_me,
    routes_members,
    routes_org,
    routes_projects,
    routes_tags,
    routes_tasks,
    routes_users,
)

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(routes_health.router)
api_router.include_router(routes_auth.router)
api_router.include_router(routes_internal.router)
api_router.include_router(routes_invitations.router)
api_router.include_router(routes_me.router)
api_router.include_router(routes_org.router)
api_router.include_router(routes_users.router)
api_router.include_router(routes_projects.router)
api_router.include_router(routes_members.router)
api_router.include_router(routes_tasks.router)
api_router.include_router(routes_tags.router)

__all__ = ["api_router"]
