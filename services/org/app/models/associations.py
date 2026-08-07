"""Many-to-many association tables for the unified tag system.

A Tag is owned by an org (Tag.org_id) and can be attached to the org itself,
to projects, and to tasks. Attachment always validates that the tag's org
matches the target entity's org (enforced in the service layer).
"""
from __future__ import annotations

from sqlalchemy import Column, ForeignKey, Table, Uuid

from app.models.base import Base

org_tag = Table(
    "org_tag",
    Base.metadata,
    Column("org_id", Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", Uuid, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)

project_tag = Table(
    "project_tag",
    Base.metadata,
    Column("project_id", Uuid, ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", Uuid, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)

task_tag = Table(
    "task_tag",
    Base.metadata,
    Column("task_id", Uuid, ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", Uuid, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)
