"""Organization/project encrypted secret vault endpoints.

Operates on the caller's OWN org (org id derived from the token — no {org_id} in
the path, so no cross-org IDOR surface), identical to the org-policy routes.
Secrets are write-only: responses mask to ``{set, source}``. The UNMASKED
plaintext is served only by the internal S2S endpoint in routes_internal.py.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from app.authz.guards import ProjectContext, require_org_admin, require_project_admin
from app.authz.principal import Principal
from app.core.database import Uow, get_session
from app.schemas.secrets import SecretsResponse, SecretsUpdate, SelectionUpdate
from app.services import secrets_service

router = APIRouter(prefix="/settings/org/secrets", tags=["secrets"])
project_router = APIRouter(
    prefix="/settings/project/{project_id}/secrets", tags=["secrets"]
)


@router.get("", response_model=SecretsResponse)
async def get_org_secrets(
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
):
    return await secrets_service.get_org_secrets(session, principal)


@router.put("", response_model=SecretsResponse)
async def put_org_secrets(
    body: SecretsUpdate,
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
):
    return await secrets_service.set_org_secrets(session, principal, body)


@router.put("/selection", response_model=SecretsResponse)
async def put_org_secrets_selection(
    body: SelectionUpdate,
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
):
    return await secrets_service.set_selection(session, principal, body)


@project_router.get("", response_model=SecretsResponse)
async def get_project_secrets(
    ctx: ProjectContext = Depends(require_project_admin),
    session: Uow = Depends(get_session),
):
    return await secrets_service.get_project_secrets(session, ctx)


@project_router.put("", response_model=SecretsResponse)
async def put_project_secrets(
    body: SecretsUpdate,
    ctx: ProjectContext = Depends(require_project_admin),
    session: Uow = Depends(get_session),
):
    return await secrets_service.set_project_secrets(session, ctx, body)


@project_router.put("/selection", response_model=SecretsResponse)
async def put_project_secrets_selection(
    body: SelectionUpdate,
    ctx: ProjectContext = Depends(require_project_admin),
    session: Uow = Depends(get_session),
):
    return await secrets_service.set_project_selection(session, ctx, body)
