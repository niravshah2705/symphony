"""Settings-policy endpoints.

Tenant self-service operates on the caller's own org (derived from the token —
no {org_id} in the path, so no cross-org IDOR surface). Project settings are
scoped by the resolved ProjectContext (cross-org → 404). The effective endpoint
runs the cascade for the caller.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query

from app.auth.dependencies import get_principal
from app.authz.guards import ProjectContext, require_org_admin, require_project_admin
from app.authz.principal import Principal
from app.core.database import Uow, get_session
from app.schemas.policy import (
    EffectiveResponse,
    PolicyResponse,
    PolicyUpdate,
    UniverseResponse,
)
from app.services import policy_service

router = APIRouter(prefix="/settings", tags=["settings"])


# ---- org policy (org admin) -------------------------------------------------

@router.get("/org", response_model=PolicyResponse)
async def get_org_settings(
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
):
    return await policy_service.get_org_policy(session, principal)


@router.put("/org", response_model=PolicyResponse)
async def put_org_settings(
    body: PolicyUpdate,
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
):
    return await policy_service.set_org_policy(session, principal, body)


# ---- project policy (project admin, org-scoped, cross-org → 404) ------------

@router.get("/project/{project_id}", response_model=PolicyResponse)
async def get_project_settings(
    ctx: ProjectContext = Depends(require_project_admin),
    session: Uow = Depends(get_session),
):
    return await policy_service.get_project_policy(session, ctx)


@router.put("/project/{project_id}", response_model=PolicyResponse)
async def put_project_settings(
    body: PolicyUpdate,
    ctx: ProjectContext = Depends(require_project_admin),
    session: Uow = Depends(get_session),
):
    return await policy_service.set_project_policy(session, ctx, body)


# ---- effective cascade + item universe (any authenticated user) -------------

@router.get("/effective", response_model=EffectiveResponse)
async def get_effective_settings(
    project_id: uuid.UUID | None = Query(default=None),
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
):
    return await policy_service.resolve_for_caller(session, principal, project_id)


@router.get("/universe", response_model=UniverseResponse)
async def get_universe(_principal: Principal = Depends(get_principal)):
    return policy_service.get_universe()
