"""Organization (tenant) model."""
from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.associations import org_tag
from app.models.base import Base, TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from app.models.project import Project
    from app.models.tag import Tag
    from app.models.user import User


class Organization(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "organizations"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    # Opaque, CSPRNG-derived slug (not derived from name) to avoid org enumeration.
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)

    users: Mapped[list["User"]] = relationship(back_populates="organization")
    projects: Mapped[list["Project"]] = relationship(
        back_populates="organization", cascade="all, delete-orphan"
    )
    # Tag vocabulary owned by this org.
    tags: Mapped[list["Tag"]] = relationship(
        back_populates="organization", cascade="all, delete-orphan"
    )
    # Tags applied directly to the org entity.
    applied_tags: Mapped[list["Tag"]] = relationship(secondary=org_tag, lazy="selectin")
