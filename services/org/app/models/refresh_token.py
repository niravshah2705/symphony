"""Refresh token records for local JWT auth. Firestore: `refresh_tokens/{id}`.

Only a hash of the token is stored (never the raw value). Rotation issues a new
token in the same family; reuse of a rotated/revoked token revokes the family
(handled atomically in auth_service via a Firestore transaction).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from app.models.base import new_uuid, to_uuid, utcnow, uuid_str


@dataclass
class RefreshToken:
    user_id: uuid.UUID | None = None
    token_hash: str = ""
    family_id: uuid.UUID = field(default_factory=new_uuid)
    expires_at: datetime | None = None
    revoked: bool = False
    id: uuid.UUID = field(default_factory=new_uuid)
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)

    def to_doc(self) -> dict:
        return {
            "id": uuid_str(self.id),
            "user_id": uuid_str(self.user_id),
            "token_hash": self.token_hash,
            "family_id": uuid_str(self.family_id),
            "expires_at": self.expires_at,
            "revoked": self.revoked,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "RefreshToken":
        return cls(
            id=to_uuid(doc["id"]),
            user_id=to_uuid(doc.get("user_id")),
            token_hash=doc.get("token_hash", ""),
            family_id=to_uuid(doc.get("family_id")),
            expires_at=doc.get("expires_at"),
            revoked=bool(doc.get("revoked", False)),
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
        )
