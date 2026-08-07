"""Organization (tenant) model. Firestore: `organizations/{id}`."""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from app.models.base import new_uuid, to_uuid, utcnow, uuid_str

if True:  # type-only use; avoids an import cycle
    from app.models.tag import Tag


@dataclass
class Organization:
    name: str = ""
    description: str | None = None
    # Opaque, CSPRNG-derived slug (not derived from name) to avoid org enumeration.
    slug: str = ""
    id: uuid.UUID = field(default_factory=new_uuid)
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)
    # Tags applied to the org entity. This is the source of truth; the repository
    # hydrates it on load and to_doc persists it as an id array.
    applied_tags: list["Tag"] = field(default_factory=list, compare=False, repr=False)

    def to_doc(self) -> dict:
        return {
            "id": uuid_str(self.id),
            "name": self.name,
            "description": self.description,
            "slug": self.slug,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "applied_tag_ids": [uuid_str(t.id) for t in self.applied_tags],
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "Organization":
        # applied_tags is hydrated by the repository from doc["applied_tag_ids"].
        return cls(
            id=to_uuid(doc["id"]),
            name=doc.get("name", ""),
            description=doc.get("description"),
            slug=doc.get("slug", ""),
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
        )
