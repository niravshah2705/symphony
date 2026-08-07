"""Personal project model — a single-owner project owned directly by a user who
belongs to no organization. Firestore: `users/{owner_id}/projects/{id}`.

Personal projects are private and cannot have other members; to collaborate the
owner must first create an organization (see docs/ACCESS_MODEL.md). Isolation is
structural: the owner id is the parent path segment and always derives from the
authenticated principal, never from the request path or body.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from app.models.base import new_uuid, to_uuid, utcnow, uuid_str


@dataclass
class PersonalProject:
    owner_id: uuid.UUID | None = None
    name: str = ""
    description: str | None = None
    id: uuid.UUID = field(default_factory=new_uuid)
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)

    def to_doc(self) -> dict:
        return {
            "id": uuid_str(self.id),
            "owner_id": uuid_str(self.owner_id),
            "name": self.name,
            "description": self.description,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "PersonalProject":
        return cls(
            id=to_uuid(doc["id"]),
            owner_id=to_uuid(doc.get("owner_id")),
            name=doc.get("name", ""),
            description=doc.get("description"),
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
        )
