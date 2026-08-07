"""Tag model — an org-scoped, free-form label.
Firestore: `organizations/{org_id}/tags/{id}` (unique per-org name enforced by
a guard doc `organizations/{org_id}/tag_names/{name}` in the repository).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from app.models.base import new_uuid, to_uuid, utcnow, uuid_str


@dataclass
class Tag:
    org_id: uuid.UUID | None = None
    name: str = ""
    id: uuid.UUID = field(default_factory=new_uuid)
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)

    def to_doc(self) -> dict:
        return {
            "id": uuid_str(self.id),
            "org_id": uuid_str(self.org_id),
            "name": self.name,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "Tag":
        return cls(
            id=to_uuid(doc["id"]),
            org_id=to_uuid(doc.get("org_id")),
            name=doc.get("name", ""),
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
        )
