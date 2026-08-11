"""Organization invitation request/response contracts (never expose tokens)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field

from app.models.enums import InvitationStatus, MembershipStatus, OrgRole


class InvitationCreate(BaseModel):
    email: EmailStr
    org_role: OrgRole = OrgRole.MEMBER


class InvitationAccept(BaseModel):
    # Kept in the request body so reverse proxies and Cloud Run access logs do
    # not record the bearer-like invitation secret in the URL.
    token: str = Field(min_length=1, max_length=512)


class InvitationResponse(BaseModel):
    id: uuid.UUID
    organization_id: uuid.UUID
    email: EmailStr
    role: OrgRole
    status: InvitationStatus
    invited_by: uuid.UUID
    expires_at: datetime | None
    accepted_by: uuid.UUID | None = None
    accepted_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class InvitationDeliveryResponse(InvitationResponse):
    delivery_status: Literal["queued", "failed"]


class AcceptedOrganizationResponse(BaseModel):
    id: uuid.UUID
    name: str


class AcceptedMembershipResponse(BaseModel):
    id: uuid.UUID
    role: OrgRole
    status: MembershipStatus


class InvitationAcceptanceResponse(BaseModel):
    invitation_id: uuid.UUID
    invitation_status: InvitationStatus
    organization: AcceptedOrganizationResponse
    membership: AcceptedMembershipResponse
