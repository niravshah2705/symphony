"""Project request/response schemas."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import ProjectAccessMode
from app.schemas.tag import TagResponse


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)


class ProjectAccessModeUpdate(BaseModel):
    access_mode: ProjectAccessMode


class ProjectResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    name: str
    description: str | None
    access_mode: ProjectAccessMode = ProjectAccessMode.INVITE_ONLY
    tags: list[TagResponse] = []
    created_at: datetime
    updated_at: datetime
