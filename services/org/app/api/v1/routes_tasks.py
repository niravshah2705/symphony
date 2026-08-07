"""Task endpoints (scoped to a project) including task-tag set/detach."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from app.core.database import Uow

from app.api.deps import page_params
from app.auth.dependencies import get_principal
from app.authz.guards import ProjectContext, get_project_context, require_project
from app.authz.policy import can_write_task
from app.authz.principal import Principal
from app.authz.guards import require_org_member
from app.core.database import get_session
from app.errors import ForbiddenError
from app.models.enums import TaskStatus
from app.schemas.common import Page, PageParams
from app.schemas.task import TaskCreate, TaskResponse, TaskTagsSet, TaskUpdate
from app.services import task_service

router = APIRouter(prefix="/projects/{project_id}/tasks", tags=["tasks"])


@router.get("", response_model=Page[TaskResponse])
async def list_tasks(
    ctx: ProjectContext = Depends(get_project_context),
    params: PageParams = Depends(page_params),
    status_filter: TaskStatus | None = None,
    assignee_id: uuid.UUID | None = None,
    tag_id: uuid.UUID | None = None,
    session: Uow = Depends(get_session),
):
    rows, total = await task_service.list_tasks(
        session,
        ctx.project,
        params,
        status=status_filter,
        assignee_id=assignee_id,
        tag_id=tag_id,
    )
    return Page(data=rows, meta={"total": total, "page": params.page, "limit": params.limit})


@router.post("", response_model=TaskResponse, status_code=status.HTTP_201_CREATED)
async def create_task(
    body: TaskCreate,
    ctx: ProjectContext = Depends(require_project(can_write_task)),
    principal: Principal = Depends(require_org_member),
    session: Uow = Depends(get_session),
):
    return await task_service.create_task(session, principal, ctx.project, body)


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(
    task_id: uuid.UUID,
    ctx: ProjectContext = Depends(get_project_context),
    session: Uow = Depends(get_session),
):
    return await task_service.get_task(session, ctx.project, task_id)


@router.patch("/{task_id}", response_model=TaskResponse)
async def update_task(
    task_id: uuid.UUID,
    body: TaskUpdate,
    ctx: ProjectContext = Depends(require_project(can_write_task)),
    session: Uow = Depends(get_session),
):
    task = await task_service.get_task(session, ctx.project, task_id)
    return await task_service.update_task(session, ctx.project, task, body)


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_task(
    task_id: uuid.UUID,
    ctx: ProjectContext = Depends(get_project_context),
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
) -> None:
    # A project admin (or org admin, elevated to PROJECT_ADMIN) may delete any
    # task; a task's own assignee may delete it too.
    from app.authz.policy import can_delete_task

    task = await task_service.get_task(session, ctx.project, task_id)
    if not (can_delete_task(ctx.role) or task.assignee_id == principal.user_id):
        raise ForbiddenError("Insufficient permission to delete this task")
    await task_service.delete_task(session, ctx.project, task)


@router.put("/{task_id}/tags", response_model=TaskResponse)
async def set_task_tags(
    task_id: uuid.UUID,
    body: TaskTagsSet,
    ctx: ProjectContext = Depends(require_project(can_write_task)),
    principal: Principal = Depends(require_org_member),
    session: Uow = Depends(get_session),
):
    task = await task_service.get_task(session, ctx.project, task_id)
    return await task_service.set_task_tags(session, principal, task, body.tag_ids)


@router.delete("/{task_id}/tags/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def detach_task_tag(
    task_id: uuid.UUID,
    tag_id: uuid.UUID,
    ctx: ProjectContext = Depends(require_project(can_write_task)),
    session: Uow = Depends(get_session),
) -> None:
    task = await task_service.get_task(session, ctx.project, task_id)
    await task_service.detach_task_tag(session, task, tag_id)
