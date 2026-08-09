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
    # Cloud-Run-safe per-tenant identifier ("t" + 12 hex of the org id). Distinct
    # from `slug` (which contains `_`/uppercase and is invalid as a Cloud Run
    # resource name). Derived from `id` once and then STORED — never re-derived on
    # load — so a future scheme change cannot orphan a tenant's provisioned
    # resources. Used by the runtime provisioner to name per-tenant services and
    # as the STORE_NAMESPACE of a per-tenant gateway.
    deployment_slug: str = ""
    # Per-tenant deployment registry. Empty for pseudo/org-less workspaces and any
    # org on the shared stack — the resolver then returns the shared gateway URL.
    # The runtime provisioner writes per-service URLs + a status machine here
    # (see docs plan): {status, error, gateway:{name,url,status}, planner:{…},
    # coder:{…}, worker:{name,status}, updated_at}. Kept a plain map (Firestore is
    # schemaless) so the provisioner can extend entries without a migration.
    deployments: dict = field(default_factory=dict)
    # Tags applied to the org entity. This is the source of truth; the repository
    # hydrates it on load and to_doc persists it as an id array.
    applied_tags: list["Tag"] = field(default_factory=list, compare=False, repr=False)

    def __post_init__(self) -> None:
        # Derive the deployment slug once from the org id when absent. from_doc
        # passes the stored value through so an existing slug is preserved verbatim
        # even if this derivation ever changes.
        if not self.deployment_slug:
            self.deployment_slug = "t" + self.id.hex[:12]

    def to_doc(self) -> dict:
        return {
            "id": uuid_str(self.id),
            "name": self.name,
            "description": self.description,
            "slug": self.slug,
            "deployment_slug": self.deployment_slug,
            "deployments": self.deployments,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "applied_tag_ids": [uuid_str(t.id) for t in self.applied_tags],
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "Organization":
        # applied_tags is hydrated by the repository from doc["applied_tag_ids"].
        deployments = doc.get("deployments")
        return cls(
            id=to_uuid(doc["id"]),
            name=doc.get("name", ""),
            description=doc.get("description"),
            slug=doc.get("slug", ""),
            deployment_slug=doc.get("deployment_slug", ""),
            deployments=deployments if isinstance(deployments, dict) else {},
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
        )
