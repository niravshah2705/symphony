"""Task service (scoped to a project)."""
from __future__ import annotations

import uuid

from app.core.database import Uow

from app.authz.principal import Principal
from app.errors import NotFoundError, ValidationAppError
from app.models.enums import TaskStatus
from app.models.project import Project
from app.models.task import Task
from app.repositories.membership_repo import MembershipRepository
from app.repositories.task_repo import TaskRepository
from app.schemas.common import PageParams
from app.schemas.task import TaskCreate, TaskUpdate
from app.services import tag_service


async def _validate_assignee(
    session: Uow, project: Project, assignee_id: uuid.UUID | None
) -> None:
    if assignee_id is None:
        return
    # An assignee must be a member of the project.
    if await MembershipRepository(session).get(project.org_id, project.id, assignee_id) is None:
        raise ValidationAppError("Assignee must be a member of the project")


async def create_task(
    session: Uow, principal: Principal, project: Project, data: TaskCreate
) -> Task:
    await _validate_assignee(session, project, data.assignee_id)
    tags = await tag_service.resolve_org_tags(session, data.tag_ids, principal.org_id)
    task = Task(
        project_id=project.id,
        title=data.title,
        description=data.description,
        status=data.status,
        assignee_id=data.assignee_id,
    )
    task.tags = tags
    return await TaskRepository(session).add(project, task)


async def list_tasks(
    session: Uow,
    project: Project,
    params: PageParams,
    *,
    status: TaskStatus | None = None,
    assignee_id: uuid.UUID | None = None,
    tag_id: uuid.UUID | None = None,
) -> tuple[list[Task], int]:
    return await TaskRepository(session).list_in_project(
        project, params, status=status, assignee_id=assignee_id, tag_id=tag_id
    )


async def get_task(
    session: Uow, project: Project, task_id: uuid.UUID
) -> Task:
    task = await TaskRepository(session).get_in_project(project, task_id)
    if task is None:
        raise NotFoundError("Task not found")
    return task


async def update_task(
    session: Uow, project: Project, task: Task, data: TaskUpdate
) -> Task:
    if data.assignee_id is not None:
        await _validate_assignee(session, project, data.assignee_id)
        task.assignee_id = data.assignee_id
    if data.title is not None:
        task.title = data.title
    if data.description is not None:
        task.description = data.description
    if data.status is not None:
        task.status = data.status
    return task


async def delete_task(session: Uow, project: Project, task: Task) -> None:
    await TaskRepository(session).delete(project, task)


async def set_task_tags(
    session: Uow,
    principal: Principal,
    task: Task,
    tag_ids: list[uuid.UUID],
) -> Task:
    task.tags = await tag_service.resolve_org_tags(session, tag_ids, principal.org_id)
    return task


async def detach_task_tag(session: Uow, task: Task, tag_id: uuid.UUID) -> None:
    task.tags = [t for t in task.tags if t.id != tag_id]
