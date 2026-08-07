"""Tag endpoints (org-scoped vocabulary)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from app.core.database import Uow

from app.api.deps import page_params
from app.authz.guards import require_org_admin, require_org_member
from app.authz.principal import Principal
from app.core.database import get_session
from app.schemas.common import Page, PageParams
from app.schemas.tag import TagCreate, TagResponse, TagUpdate
from app.services import tag_service

router = APIRouter(prefix="/tags", tags=["tags"])


@router.get("", response_model=Page[TagResponse])
async def list_tags(
    principal: Principal = Depends(require_org_member),
    params: PageParams = Depends(page_params),
    session: Uow = Depends(get_session),
):
    rows, total = await tag_service.list_tags(session, principal, params)
    return Page(data=rows, meta={"total": total, "page": params.page, "limit": params.limit})


@router.post("", response_model=TagResponse, status_code=status.HTTP_201_CREATED)
async def create_tag(
    body: TagCreate,
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
):
    return await tag_service.create_tag(session, principal, body)


@router.get("/{tag_id}", response_model=TagResponse)
async def get_tag(
    tag_id: uuid.UUID,
    principal: Principal = Depends(require_org_member),
    session: Uow = Depends(get_session),
):
    return await tag_service.get_tag(session, principal, tag_id)


@router.patch("/{tag_id}", response_model=TagResponse)
async def update_tag(
    tag_id: uuid.UUID,
    body: TagUpdate,
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
):
    return await tag_service.update_tag(session, principal, tag_id, body)


@router.delete("/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tag(
    tag_id: uuid.UUID,
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
) -> None:
    await tag_service.delete_tag(session, principal, tag_id)
