"""Grants every member of another (partner/outsourced) org access to one
project, without making them members of the project's own org. Firestore:
`organizations/{owner_org_id}/projects/{project_id}/external_grants/{collaborator_org_id}`
— doc id is the collaborator org id, making "already granted" structural.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from app.models.base import new_uuid, to_uuid, utcnow, uuid_str
from app.models.enums import ProjectRole


@dataclass
class ProjectExternalOrgGrant:
    project_id: uuid.UUID | None = None
    owner_org_id: uuid.UUID | None = None  # the project's own org
    collaborator_org_id: uuid.UUID | None = None  # the outsourced/partner org
    default_role: ProjectRole = ProjectRole.DEVELOPER
    granted_by: uuid.UUID | None = None
    id: uuid.UUID = field(default_factory=new_uuid)
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)

    def to_doc(self) -> dict:
        return {
            "id": uuid_str(self.id),
            "project_id": uuid_str(self.project_id),
            "owner_org_id": uuid_str(self.owner_org_id),
            "collaborator_org_id": uuid_str(self.collaborator_org_id),
            "default_role": self.default_role.value,
            "granted_by": uuid_str(self.granted_by),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "ProjectExternalOrgGrant":
        return cls(
            id=to_uuid(doc["id"]),
            project_id=to_uuid(doc.get("project_id")),
            owner_org_id=to_uuid(doc.get("owner_org_id")),
            collaborator_org_id=to_uuid(doc.get("collaborator_org_id")),
            default_role=ProjectRole(doc.get("default_role", ProjectRole.DEVELOPER.value)),
            granted_by=to_uuid(doc.get("granted_by")),
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
        )
