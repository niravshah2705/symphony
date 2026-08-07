"""Schemas for the `/me` self-service surface (personal projects + create-org)."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class MeResponse(BaseModel):
    """The caller's identity plus whether they belong to an organization."""

    user_id: uuid.UUID
    email: str
    full_name: str | None = None
    has_organization: bool
    org_id: uuid.UUID | None = None
    org_role: str | None = None


class PersonalProjectResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    owner_id: uuid.UUID
    name: str
    description: str | None
    created_at: datetime
    updated_at: datetime


class CreateOrgRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
