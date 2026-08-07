"""Project membership (access-control) endpoints."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from app.core.database import Uow

from app.authz.guards import ProjectContext, get_project_context, require_project
from app.authz.policy import can_manage_project_access
from app.authz.principal import Principal
from app.core.database import get_session
from app.authz.guards import require_org_member
from app.schemas.membership import (
    MemberCreate,
    MemberDetailResponse,
    MemberResponse,
    MemberUpdate,
)
from app.services import membership_service

router = APIRouter(prefix="/projects/{project_id}/members", tags=["members"])


@router.get("", response_model=list[MemberDetailResponse])
async def list_members(
    ctx: ProjectContext = Depends(get_project_context),
    session: Uow = Depends(get_session),
):
    rows = await membership_service.list_members(session, ctx.project)
    return [
        MemberDetailResponse(
            id=m.id,
            project_id=m.project_id,
            user_id=m.user_id,
            role=m.role,
            created_at=m.created_at,
            email=u.email,
            full_name=u.full_name,
        )
        for m, u in rows
    ]


@router.post("", response_model=MemberResponse, status_code=status.HTTP_201_CREATED)
async def add_member(
    body: MemberCreate,
    ctx: ProjectContext = Depends(require_project(can_manage_project_access)),
    principal: Principal = Depends(require_org_member),
    session: Uow = Depends(get_session),
):
    return await membership_service.add_member(session, principal, ctx.project, body)


@router.patch("/{user_id}", response_model=MemberResponse)
async def update_member(
    user_id: uuid.UUID,
    body: MemberUpdate,
    ctx: ProjectContext = Depends(require_project(can_manage_project_access)),
    session: Uow = Depends(get_session),
):
    return await membership_service.update_member(session, ctx.project, user_id, body)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    user_id: uuid.UUID,
    ctx: ProjectContext = Depends(require_project(can_manage_project_access)),
    session: Uow = Depends(get_session),
) -> None:
    await membership_service.remove_member(session, ctx.project, user_id)
