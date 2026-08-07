"""Developer <-> Project membership, carrying the project-scoped role.
Firestore: `organizations/{org_id}/memberships/{project_id}_{user_id}` — the
composite doc id makes (project, user) uniqueness structural.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from app.models.base import new_uuid, to_uuid, utcnow, uuid_str
from app.models.enums import ProjectRole


@dataclass
class ProjectMembership:
    project_id: uuid.UUID | None = None
    user_id: uuid.UUID | None = None
    role: ProjectRole = ProjectRole.DEVELOPER
    id: uuid.UUID = field(default_factory=new_uuid)
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)

    @staticmethod
    def doc_id(project_id: uuid.UUID, user_id: uuid.UUID) -> str:
        return f"{project_id}_{user_id}"

    def to_doc(self) -> dict:
        return {
            "id": uuid_str(self.id),
            "project_id": uuid_str(self.project_id),
            "user_id": uuid_str(self.user_id),
            "role": self.role.value,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "ProjectMembership":
        return cls(
            id=to_uuid(doc["id"]),
            project_id=to_uuid(doc.get("project_id")),
            user_id=to_uuid(doc.get("user_id")),
            role=ProjectRole(doc.get("role", ProjectRole.DEVELOPER.value)),
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
        )
