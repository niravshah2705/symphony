"""Organization (tenant) model. Firestore: `organizations/{id}`."""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from app.models.base import id_list, new_uuid, to_uuid, utcnow, uuid_str

if True:  # avoid a hard import cycle for type-only use
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
    # Ids of tags applied directly to the org entity (persisted).
    applied_tag_ids: list[uuid.UUID] = field(default_factory=list)
    # Transient: hydrated Tag objects (not serialized).
    applied_tags: list["Tag"] = field(default_factory=list, compare=False, repr=False)

    def to_doc(self) -> dict:
        return {
            "id": uuid_str(self.id),
            "name": self.name,
            "description": self.description,
            "slug": self.slug,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "applied_tag_ids": [uuid_str(t) for t in self.applied_tag_ids],
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "Organization":
        return cls(
            id=to_uuid(doc["id"]),
            name=doc.get("name", ""),
            description=doc.get("description"),
            slug=doc.get("slug", ""),
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
            applied_tag_ids=id_list(doc.get("applied_tag_ids")),
        )
