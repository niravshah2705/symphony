"""User model. A regular user belongs to exactly one org; a platform
super-admin has no org (org_id is NULL) and is the only cross-org identity.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDMixin
from app.models.enums import AuthProvider, OrgRole

if TYPE_CHECKING:
    from app.models.organization import Organization
    from app.models.project_membership import ProjectMembership


class User(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "users"

    org_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True
    )
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    full_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    auth_provider: Mapped[AuthProvider] = mapped_column(
        Enum(AuthProvider, name="auth_provider"), default=AuthProvider.LOCAL, nullable=False
    )
    external_subject: Mapped[str | None] = mapped_column(
        String(255), unique=True, nullable=True, index=True
    )
    org_role: Mapped[OrgRole] = mapped_column(
        Enum(OrgRole, name="org_role"), default=OrgRole.MEMBER, nullable=False
    )
    is_super_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Any password change bumps this; tokens issued before it are rejected.
    password_changed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Single-use email verification (hash stored, never the raw token).
    email_verification_token_hash: Mapped[str | None] = mapped_column(
        String(128), nullable=True
    )
    email_verification_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    organization: Mapped["Organization | None"] = relationship(back_populates="users")
    memberships: Mapped[list["ProjectMembership"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
