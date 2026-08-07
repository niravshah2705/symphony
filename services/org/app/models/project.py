"""Project model (org-scoped). Firestore: `organizations/{org_id}/projects/{id}`."""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from app.models.base import new_uuid, to_uuid, utcnow, uuid_str

if True:
    from app.models.tag import Tag


@dataclass
class Project:
    org_id: uuid.UUID | None = None
    name: str = ""
    description: str | None = None
    id: uuid.UUID = field(default_factory=new_uuid)
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)
    # Source of truth for the project's tags; persisted as an id array.
    tags: list["Tag"] = field(default_factory=list, compare=False, repr=False)

    def to_doc(self) -> dict:
        return {
            "id": uuid_str(self.id),
            "org_id": uuid_str(self.org_id),
            "name": self.name,
            "description": self.description,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "tag_ids": [uuid_str(t.id) for t in self.tags],
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "Project":
        return cls(
            id=to_uuid(doc["id"]),
            org_id=to_uuid(doc.get("org_id")),
            name=doc.get("name", ""),
            description=doc.get("description"),
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
        )
