"""Global user identity.

``org_id/org_role`` are retained as a backward-compatible default context;
authoritative memberships are separate organization subcollection documents.
Firestore: ``users/{id}``.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from app.models.base import new_uuid, to_uuid, utcnow, uuid_str
from app.models.enums import AuthProvider, OrgRole, Persona


@dataclass
class LinkedIdentity:
    """An additional sign-in method linked to a `User`, persisted inline
    (embedded, not a separate collection) — see `Organization.applied_tags`
    for the same embedding pattern applied to a related-object list."""

    provider: str = ""
    subject: str = ""
    linked_at: datetime = field(default_factory=utcnow)

    def to_doc(self) -> dict:
        return {
            "provider": self.provider,
            "subject": self.subject,
            "linked_at": self.linked_at,
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "LinkedIdentity":
        return cls(
            provider=doc.get("provider", ""),
            subject=doc.get("subject", ""),
            linked_at=doc.get("linked_at") or utcnow(),
        )


@dataclass
class User:
    email: str = ""
    org_id: uuid.UUID | None = None
    full_name: str | None = None
    password_hash: str | None = None
    auth_provider: AuthProvider = AuthProvider.LOCAL
    external_subject: str | None = None
    # Legacy org-created local accounts may be disabled when their final
    # membership in the creating org is removed. Invited/self-registered users
    # remain global identities when a membership is removed.
    managed_by_org_id: uuid.UUID | None = None
    org_role: OrgRole = OrgRole.MEMBER
    is_super_admin: bool = False
    is_active: bool = True
    email_verified: bool = False
    password_changed_at: datetime | None = None
    email_verification_token_hash: str | None = None
    email_verification_expires_at: datetime | None = None
    # Self-declared actor persona (engineer / client / org-managing admin),
    # captured once at onboarding. Orthogonal to OrgRole/ProjectRole — "what
    # kind of person is this," not "what can they do." Null until asked.
    persona: Persona | None = None
    # Additional sign-in methods for this same person (e.g. a corporate SSO
    # identity added on top of the personal identity used at signup).
    # `external_subject` above remains the primary identity for backward
    # compatibility.
    linked_identities: list[LinkedIdentity] = field(default_factory=list)
    id: uuid.UUID = field(default_factory=new_uuid)
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)

    def to_doc(self) -> dict:
        return {
            "id": uuid_str(self.id),
            "org_id": uuid_str(self.org_id),
            "email": self.email,
            "full_name": self.full_name,
            "password_hash": self.password_hash,
            "auth_provider": self.auth_provider.value,
            "external_subject": self.external_subject,
            "managed_by_org_id": uuid_str(self.managed_by_org_id),
            "org_role": self.org_role.value,
            "is_super_admin": self.is_super_admin,
            "is_active": self.is_active,
            "email_verified": self.email_verified,
            "password_changed_at": self.password_changed_at,
            "email_verification_token_hash": self.email_verification_token_hash,
            "email_verification_expires_at": self.email_verification_expires_at,
            "persona": self.persona.value if self.persona is not None else None,
            "linked_identities": [i.to_doc() for i in self.linked_identities],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "User":
        persona = doc.get("persona")
        return cls(
            id=to_uuid(doc["id"]),
            org_id=to_uuid(doc.get("org_id")),
            email=doc.get("email", ""),
            full_name=doc.get("full_name"),
            password_hash=doc.get("password_hash"),
            auth_provider=AuthProvider(doc.get("auth_provider", AuthProvider.LOCAL.value)),
            external_subject=doc.get("external_subject"),
            managed_by_org_id=to_uuid(doc.get("managed_by_org_id")),
            org_role=OrgRole(doc.get("org_role", OrgRole.MEMBER.value)),
            is_super_admin=bool(doc.get("is_super_admin", False)),
            is_active=bool(doc.get("is_active", True)),
            email_verified=bool(doc.get("email_verified", False)),
            password_changed_at=doc.get("password_changed_at"),
            email_verification_token_hash=doc.get("email_verification_token_hash"),
            email_verification_expires_at=doc.get("email_verification_expires_at"),
            persona=Persona(persona) if persona else None,
            linked_identities=[
                LinkedIdentity.from_doc(i) for i in doc.get("linked_identities") or []
            ],
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
        )
