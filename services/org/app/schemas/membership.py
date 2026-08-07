"""Project membership request/response schemas."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr

from app.models.enums import ProjectRole


class MemberCreate(BaseModel):
    user_id: uuid.UUID
    role: ProjectRole


class MemberUpdate(BaseModel):
    role: ProjectRole


class MemberResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    user_id: uuid.UUID
    role: ProjectRole
    created_at: datetime


class MemberDetailResponse(MemberResponse):
    """Membership plus a minimal view of the member (for access-control review)."""

    email: EmailStr | None = None
    full_name: str | None = None
