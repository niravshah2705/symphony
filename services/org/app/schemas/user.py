"""User request/response schemas.

Response DTOs never expose `password_hash` (api-security.md). Create/update
schemas are explicit field allowlists (no mass assignment) — regular users
cannot set `is_super_admin`, and only admins may set `org_role`/`is_active`.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.models.enums import AuthProvider, OrgRole


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID | None
    email: EmailStr
    full_name: str | None
    org_role: OrgRole
    is_super_admin: bool
    is_active: bool
    email_verified: bool
    created_at: datetime


class UserCreate(BaseModel):
    """Org-admin creates a user within their own org."""

    email: EmailStr
    full_name: str | None = Field(default=None, max_length=200)
    # Required for LOCAL users; ignored for EXTERNAL users.
    password: str | None = Field(default=None, min_length=8, max_length=128)
    org_role: OrgRole = OrgRole.MEMBER
    auth_provider: AuthProvider = AuthProvider.LOCAL
    external_subject: str | None = Field(default=None, max_length=255)


class UserAdminUpdate(BaseModel):
    """Fields an org-admin may change on another user."""

    org_role: OrgRole | None = None
    is_active: bool | None = None
    full_name: str | None = Field(default=None, max_length=200)


class UserSelfUpdate(BaseModel):
    """Fields a user may change on their own profile."""

    full_name: str | None = Field(default=None, max_length=200)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)
