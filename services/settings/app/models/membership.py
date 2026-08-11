"""Project membership — the developer↔project link with an effective role.

Firestore: `organizations/{org_id}/memberships/{project_id}:{user_id}`. Storing
memberships under the org path makes tenant isolation structural: a membership
for another org is unreachable from the caller's org path.

The settings service does not create memberships itself. These records remain
only for legacy local-JWT installations. Firebase callers resolve the selected
project and role live from the org service (the source of truth), so no mirror
sync is needed. ORG_ADMINs are elevated to PROJECT_ADMIN without a membership.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from app.models.base import new_uuid, to_uuid, utcnow, uuid_str
from app.models.enums import ProjectRole


def membership_doc_id(project_id: uuid.UUID, user_id: uuid.UUID) -> str:
    return f"{project_id}:{user_id}"


@dataclass
class ProjectMembership:
    org_id: uuid.UUID
    project_id: uuid.UUID
    user_id: uuid.UUID
    role: ProjectRole = ProjectRole.DEVELOPER
    id: uuid.UUID = field(default_factory=new_uuid)
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)

    def to_doc(self) -> dict:
        return {
            "id": uuid_str(self.id),
            "org_id": uuid_str(self.org_id),
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
            org_id=to_uuid(doc["org_id"]),
            project_id=to_uuid(doc["project_id"]),
            user_id=to_uuid(doc["user_id"]),
            role=ProjectRole(doc.get("role", ProjectRole.DEVELOPER.value)),
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
        )
