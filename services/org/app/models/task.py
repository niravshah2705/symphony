"""Task model (project-scoped).
Firestore: `organizations/{org_id}/projects/{project_id}/tasks/{id}`.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from app.models.base import new_uuid, to_uuid, utcnow, uuid_str
from app.models.enums import TaskStatus

if True:
    from app.models.tag import Tag


@dataclass
class Task:
    project_id: uuid.UUID | None = None
    title: str = ""
    description: str | None = None
    status: TaskStatus = TaskStatus.TODO
    assignee_id: uuid.UUID | None = None
    id: uuid.UUID = field(default_factory=new_uuid)
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)
    # Source of truth for the task's tags; persisted as an id array.
    tags: list["Tag"] = field(default_factory=list, compare=False, repr=False)

    def to_doc(self) -> dict:
        return {
            "id": uuid_str(self.id),
            "project_id": uuid_str(self.project_id),
            "title": self.title,
            "description": self.description,
            "status": self.status.value,
            "assignee_id": uuid_str(self.assignee_id),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "tag_ids": [uuid_str(t.id) for t in self.tags],
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "Task":
        return cls(
            id=to_uuid(doc["id"]),
            project_id=to_uuid(doc.get("project_id")),
            title=doc.get("title", ""),
            description=doc.get("description"),
            status=TaskStatus(doc.get("status", TaskStatus.TODO.value)),
            assignee_id=to_uuid(doc.get("assignee_id")),
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
        )
