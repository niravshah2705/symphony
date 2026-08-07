"""Task data access (project-scoped). Methods take the parent `project` so the
Firestore path `organizations/{org}/projects/{project}/tasks` can be built."""
from __future__ import annotations

import uuid

from app.core.database import Uow
from app.models.base import id_list
from app.models.enums import TaskStatus
from app.models.project import Project
from app.models.task import Task
from app.repositories.base import tasks_col
from app.repositories.tag_repo import load_tags
from app.schemas.common import PageParams


class TaskRepository:
    def __init__(self, uow: Uow) -> None:
        self.uow = uow

    def _col(self, project: Project) -> str:
        return tasks_col(project.org_id, project.id)

    async def _hydrate(self, project: Project, task: Task, doc: dict) -> Task:
        task.tags = await load_tags(self.uow, project.org_id, id_list(doc.get("tag_ids")))
        return self.uow.track(self._col(project), task)

    async def get_in_project(self, project: Project, task_id: uuid.UUID) -> Task | None:
        existing = self.uow.tracked(self._col(project), str(task_id))
        if existing is not None:
            return existing
        doc = await self.uow.get(self._col(project), str(task_id))
        return await self._hydrate(project, Task.from_doc(doc), doc) if doc else None

    async def list_in_project(
        self,
        project: Project,
        params: PageParams,
        *,
        status: TaskStatus | None = None,
        assignee_id: uuid.UUID | None = None,
        tag_id: uuid.UUID | None = None,
    ) -> tuple[list[Task], int]:
        filters: list[tuple[str, object]] = []
        if status is not None:
            filters.append(("status", status.value))
        if assignee_id is not None:
            filters.append(("assignee_id", str(assignee_id)))
        rows = await self.uow.query(
            self._col(project), filters or None, order_by="created_at", desc=True
        )
        if tag_id is not None:  # array membership — filtered in memory
            rows = [r for r in rows if str(tag_id) in (r.get("tag_ids") or [])]
        total = len(rows)
        page = rows[params.offset : params.offset + params.limit]
        return [await self._hydrate(project, Task.from_doc(d), d) for d in page], total

    async def add(self, project: Project, task: Task) -> Task:
        return await self.uow.add(self._col(project), task)

    async def delete(self, project: Project, task: Task) -> None:
        self.uow.forget(self._col(project), task)
        await self.uow.db.delete(self._col(project), str(task.id))
