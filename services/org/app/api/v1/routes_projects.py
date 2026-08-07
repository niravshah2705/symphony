"""Project endpoints (org-scoped) including project-tag attach/detach."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Body, Depends, status
from app.core.database import Uow

from app.api.deps import page_params
from app.authz.guards import (
    ProjectContext,
    get_project_context,
    require_org_admin,
    require_org_member,
    require_project,
)
from app.authz.policy import can_manage_project_tags, can_update_project
from app.authz.principal import Principal
from app.core.database import get_session
from app.schemas.common import Page, PageParams
from app.schemas.project import ProjectCreate, ProjectResponse, ProjectUpdate
from app.schemas.tag import TagResponse
from app.services import project_service, tag_service

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("", response_model=Page[ProjectResponse])
async def list_projects(
    principal: Principal = Depends(require_org_member),
    params: PageParams = Depends(page_params),
    session: Uow = Depends(get_session),
):
    rows, total = await project_service.list_projects(session, principal, params)
    return Page(data=rows, meta={"total": total, "page": params.page, "limit": params.limit})


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreate,
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
):
    return await project_service.create_project(session, principal, body)


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(ctx: ProjectContext = Depends(get_project_context)):
    return ctx.project


@router.patch("/{project_id}", response_model=ProjectResponse)
async def update_project(
    body: ProjectUpdate,
    ctx: ProjectContext = Depends(require_project(can_update_project)),
    session: Uow = Depends(get_session),
):
    return await project_service.update_project(session, ctx.project, body)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    ctx: ProjectContext = Depends(require_project(can_update_project)),
    session: Uow = Depends(get_session),
) -> None:
    await project_service.delete_project(session, ctx.project)


@router.get("/{project_id}/tags", response_model=list[TagResponse])
async def list_project_tags(ctx: ProjectContext = Depends(get_project_context)):
    return ctx.project.tags


@router.post("/{project_id}/tags", response_model=list[TagResponse])
async def attach_project_tag(
    tag_id: uuid.UUID = Body(embed=True),
    ctx: ProjectContext = Depends(require_project(can_manage_project_tags)),
    principal: Principal = Depends(require_org_member),
    session: Uow = Depends(get_session),
):
    return await tag_service.attach_project_tag(session, principal, ctx.project, tag_id)


@router.delete("/{project_id}/tags/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def detach_project_tag(
    tag_id: uuid.UUID,
    ctx: ProjectContext = Depends(require_project(can_manage_project_tags)),
    session: Uow = Depends(get_session),
) -> None:
    await tag_service.detach_project_tag(session, ctx.project, tag_id)
