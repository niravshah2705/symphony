"""User <-> organization membership.

The authoritative document lives at ``organizations/{org_id}/members/{user_id}``
and is mirrored at ``users/{user_id}/organizations/{org_id}`` for efficient
context discovery.  The document id is deliberately the opposite entity id on
each side, making membership uniqueness structural.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from app.models.base import new_uuid, to_uuid, utcnow, uuid_str
from app.models.enums import MembershipStatus, OrgRole


@dataclass
class OrganizationMembership:
    org_id: uuid.UUID | None = None
    user_id: uuid.UUID | None = None
    role: OrgRole = OrgRole.MEMBER
    status: MembershipStatus = MembershipStatus.ACTIVE
    id: uuid.UUID = field(default_factory=new_uuid)
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)

    def to_doc(self) -> dict:
        return {
            "id": uuid_str(self.id),
            "org_id": uuid_str(self.org_id),
            "user_id": uuid_str(self.user_id),
            "role": self.role.value,
            "status": self.status.value,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "OrganizationMembership":
        return cls(
            id=to_uuid(doc["id"]),
            org_id=to_uuid(doc.get("org_id")),
            user_id=to_uuid(doc.get("user_id")),
            role=OrgRole(doc.get("role", OrgRole.MEMBER.value)),
            status=MembershipStatus(doc.get("status", MembershipStatus.ACTIVE.value)),
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
        )
