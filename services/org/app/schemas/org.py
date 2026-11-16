"""Organization request/response schemas."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.schemas.tag import TagResponse


class OrgResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None
    slug: str
    # Never settable: absent from OrgCreate/OrgUpdate, written only by onboarding.
    is_default: bool = False
    tags: list[TagResponse] = []
    created_at: datetime
    updated_at: datetime


class BillingAdmin(BaseModel):
    """An active ORG_ADMIN, the only audience for billing alerts.

    ``email`` stays a plain ``str`` rather than ``EmailStr``: a malformed or
    legacy address must not turn a read-only billing lookup into a 500.
    """

    user_id: uuid.UUID
    email: str


class BillingContextResponse(BaseModel):
    """What the billing job needs to charge and notify one org.

    ``admins`` is empty for an org whose administrators are all deactivated: the
    caller must then skip it rather than notify nobody silently.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    slug: str
    deployment_slug: str
    # The free-tier marker, read by the billing side from here rather than from
    # the name: a money decision cannot rest on a field the customer edits.
    is_default: bool = False
    admins: list[BillingAdmin] = []


class OrgUpdate(BaseModel):
    """`is_default` is deliberately absent: onboarding owns it, a caller does not."""

    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)


class OrgCreate(BaseModel):
    """Super-admin creates an org, optionally provisioning the first ORG_ADMIN."""

    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    admin_email: EmailStr | None = None
    admin_password: str | None = Field(default=None, min_length=8, max_length=128)
