"""Single-use invitation granting one outside person access to a single
project (not the whole org) — mirrors `OrganizationInvitation` one level
down. Firestore: `organizations/{org_id}/projects/{project_id}/invitations/{id}`.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from app.models.base import new_uuid, to_uuid, utcnow, uuid_str
from app.models.enums import InvitationStatus, ProjectRole


@dataclass
class ProjectInvitation:
    project_id: uuid.UUID | None = None
    org_id: uuid.UUID | None = None  # the project's owning org
    email: str = ""
    role: ProjectRole = ProjectRole.DEVELOPER
    status: InvitationStatus = InvitationStatus.PENDING
    token_hash: str = ""
    invited_by: uuid.UUID | None = None
    expires_at: datetime | None = None
    accepted_by: uuid.UUID | None = None
    accepted_at: datetime | None = None
    id: uuid.UUID = field(default_factory=new_uuid)
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)

    def to_doc(self) -> dict:
        return {
            "id": uuid_str(self.id),
            "project_id": uuid_str(self.project_id),
            "org_id": uuid_str(self.org_id),
            "email": self.email,
            "role": self.role.value,
            "status": self.status.value,
            "token_hash": self.token_hash,
            "invited_by": uuid_str(self.invited_by),
            "expires_at": self.expires_at,
            "accepted_by": uuid_str(self.accepted_by),
            "accepted_at": self.accepted_at,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "ProjectInvitation":
        return cls(
            id=to_uuid(doc["id"]),
            project_id=to_uuid(doc.get("project_id")),
            org_id=to_uuid(doc.get("org_id")),
            email=doc.get("email", ""),
            role=ProjectRole(doc.get("role", ProjectRole.DEVELOPER.value)),
            status=InvitationStatus(doc.get("status", InvitationStatus.PENDING.value)),
            token_hash=doc.get("token_hash", ""),
            invited_by=to_uuid(doc.get("invited_by")),
            expires_at=doc.get("expires_at"),
            accepted_by=to_uuid(doc.get("accepted_by")),
            accepted_at=doc.get("accepted_at"),
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
        )
