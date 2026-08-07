"""Organization endpoints.

Tenant self-service operates on the caller's own org only (derived from the
token — no {org_id} in the path, so no cross-org IDOR surface). Cross-org
management is restricted to platform super-admins.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import page_params
from app.auth.dependencies import get_principal
from app.authz.guards import require_org_admin, require_org_member, require_super_admin
from app.authz.principal import Principal
from app.core.database import get_session
from app.schemas.common import Page, PageParams
from app.schemas.org import OrgCreate, OrgResponse, OrgUpdate
from app.schemas.tag import TagResponse
from app.services import org_service, tag_service

router = APIRouter(prefix="/organizations", tags=["organizations"])


# ---- Tenant self-service ----------------------------------------------------

@router.get("/current", response_model=OrgResponse)
async def get_current(
    principal: Principal = Depends(require_org_member),
    session: AsyncSession = Depends(get_session),
):
    return await org_service.get_current_org(session, principal)


@router.patch("/current", response_model=OrgResponse)
async def update_current(
    body: OrgUpdate,
    principal: Principal = Depends(require_org_admin),
    session: AsyncSession = Depends(get_session),
):
    return await org_service.update_current_org(session, principal, body)


@router.delete("/current", status_code=status.HTTP_204_NO_CONTENT)
async def delete_current(
    principal: Principal = Depends(require_org_admin),
    session: AsyncSession = Depends(get_session),
) -> None:
    await org_service.delete_current_org(session, principal)


@router.get("/current/tags", response_model=list[TagResponse])
async def list_current_org_tags(
    principal: Principal = Depends(require_org_member),
    session: AsyncSession = Depends(get_session),
):
    org = await org_service.get_current_org(session, principal)
    return org.applied_tags


@router.put("/current/tags", response_model=list[TagResponse])
async def set_current_org_tags(
    tag_ids: list[uuid.UUID],
    principal: Principal = Depends(require_org_admin),
    session: AsyncSession = Depends(get_session),
):
    org = await org_service.get_current_org(session, principal)
    return await tag_service.set_org_tags(session, principal, org, tag_ids)


@router.delete("/current/tags/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def detach_current_org_tag(
    tag_id: uuid.UUID,
    principal: Principal = Depends(require_org_admin),
    session: AsyncSession = Depends(get_session),
) -> None:
    org = await org_service.get_current_org(session, principal)
    await tag_service.detach_org_tag(session, org, tag_id)


# ---- Super-admin cross-org management ---------------------------------------

@router.post("", response_model=OrgResponse, status_code=status.HTTP_201_CREATED)
async def create_org(
    body: OrgCreate,
    _admin: Principal = Depends(require_super_admin),
    session: AsyncSession = Depends(get_session),
):
    return await org_service.create_org(session, body)


@router.get("", response_model=Page[OrgResponse])
async def list_orgs(
    _admin: Principal = Depends(require_super_admin),
    params: PageParams = Depends(page_params),
    session: AsyncSession = Depends(get_session),
):
    rows, total = await org_service.list_orgs(session, params)
    return Page(data=rows, meta={"total": total, "page": params.page, "limit": params.limit})


@router.get("/{org_id}", response_model=OrgResponse)
async def get_org(
    org_id: uuid.UUID,
    _admin: Principal = Depends(require_super_admin),
    session: AsyncSession = Depends(get_session),
):
    return await org_service.get_org(session, org_id)


@router.patch("/{org_id}", response_model=OrgResponse)
async def update_org(
    org_id: uuid.UUID,
    body: OrgUpdate,
    _admin: Principal = Depends(require_super_admin),
    session: AsyncSession = Depends(get_session),
):
    return await org_service.update_org(session, org_id, body)


@router.delete("/{org_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_org(
    org_id: uuid.UUID,
    _admin: Principal = Depends(require_super_admin),
    session: AsyncSession = Depends(get_session),
) -> None:
    await org_service.delete_org(session, org_id)
