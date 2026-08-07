"""Task model (scoped to a project)."""
from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Enum, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.associations import task_tag
from app.models.base import Base, TimestampMixin, UUIDMixin
from app.models.enums import TaskStatus

if TYPE_CHECKING:
    from app.models.project import Project
    from app.models.tag import Tag


class Task(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "tasks"

    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str | None] = mapped_column(String(5000), nullable=True)
    status: Mapped[TaskStatus] = mapped_column(
        Enum(TaskStatus, name="task_status"), default=TaskStatus.TODO, nullable=False
    )
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )

    project: Mapped["Project"] = relationship(back_populates="tasks")
    tags: Mapped[list["Tag"]] = relationship(secondary=task_tag, lazy="selectin")
