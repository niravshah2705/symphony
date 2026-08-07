"""Task data access (scoped to a project)."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.enums import TaskStatus
from app.models.task import Task
from app.models.associations import task_tag
from app.repositories.base import paginate
from app.schemas.common import PageParams


class TaskRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_in_project(
        self, task_id: uuid.UUID, project_id: uuid.UUID
    ) -> Task | None:
        return await self.session.scalar(
            select(Task).where(Task.id == task_id, Task.project_id == project_id)
        )

    async def list_in_project(
        self,
        project_id: uuid.UUID,
        params: PageParams,
        *,
        status: TaskStatus | None = None,
        assignee_id: uuid.UUID | None = None,
        tag_id: uuid.UUID | None = None,
    ) -> tuple[list[Task], int]:
        stmt = select(Task).where(Task.project_id == project_id)
        if status is not None:
            stmt = stmt.where(Task.status == status)
        if assignee_id is not None:
            stmt = stmt.where(Task.assignee_id == assignee_id)
        if tag_id is not None:
            stmt = stmt.join(task_tag, task_tag.c.task_id == Task.id).where(
                task_tag.c.tag_id == tag_id
            )
        stmt = stmt.order_by(Task.created_at.desc())
        return await paginate(self.session, stmt, params)

    async def add(self, task: Task) -> Task:
        self.session.add(task)
        await self.session.flush()
        return task

    async def delete(self, task: Task) -> None:
        await self.session.delete(task)
