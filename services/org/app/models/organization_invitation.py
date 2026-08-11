"""Single-use organization invitation; raw tokens are never persisted."""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from app.models.base import new_uuid, to_uuid, utcnow, uuid_str
from app.models.enums import InvitationStatus, OrgRole


@dataclass
class OrganizationInvitation:
    org_id: uuid.UUID | None = None
    email: str = ""
    role: OrgRole = OrgRole.MEMBER
    status: InvitationStatus = InvitationStatus.PENDING
    token_hash: str = ""
    invited_by: uuid.UUID | None = None
    expires_at: datetime | None = None
    accepted_by: uuid.UUID | None = None
    accepted_at: datetime | None = None
    delivery_attempt: int = 1
    id: uuid.UUID = field(default_factory=new_uuid)
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)

    def to_doc(self) -> dict:
        return {
            "id": uuid_str(self.id),
            "org_id": uuid_str(self.org_id),
            "email": self.email,
            "role": self.role.value,
            "status": self.status.value,
            "token_hash": self.token_hash,
            "invited_by": uuid_str(self.invited_by),
            "expires_at": self.expires_at,
            "accepted_by": uuid_str(self.accepted_by),
            "accepted_at": self.accepted_at,
            "delivery_attempt": self.delivery_attempt,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "OrganizationInvitation":
        return cls(
            id=to_uuid(doc["id"]),
            org_id=to_uuid(doc.get("org_id")),
            email=doc.get("email", ""),
            role=OrgRole(doc.get("role", OrgRole.MEMBER.value)),
            status=InvitationStatus(doc.get("status", InvitationStatus.PENDING.value)),
            token_hash=doc.get("token_hash", ""),
            invited_by=to_uuid(doc.get("invited_by")),
            expires_at=doc.get("expires_at"),
            accepted_by=to_uuid(doc.get("accepted_by")),
            accepted_at=doc.get("accepted_at"),
            delivery_attempt=int(doc.get("delivery_attempt", 1)),
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
        )
