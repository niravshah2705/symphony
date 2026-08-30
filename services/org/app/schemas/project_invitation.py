"""Project-invitation request/response contracts (never expose tokens)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field

from app.models.enums import InvitationStatus, ProjectRole


class ProjectInvitationCreate(BaseModel):
    email: EmailStr
    role: ProjectRole = ProjectRole.DEVELOPER


class ProjectInvitationAccept(BaseModel):
    # In the body (not the URL) so proxies/access logs never record the secret.
    token: str = Field(min_length=1, max_length=512)


class ProjectInvitationResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    organization_id: uuid.UUID
    email: EmailStr
    role: ProjectRole
    status: InvitationStatus
    invited_by: uuid.UUID
    expires_at: datetime | None
    accepted_by: uuid.UUID | None = None
    accepted_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class ProjectInvitationDeliveryResponse(ProjectInvitationResponse):
    delivery_status: Literal["queued", "failed"]


class AcceptedProjectMembershipResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    user_id: uuid.UUID
    role: ProjectRole
    member_org_id: uuid.UUID | None = None


class ProjectInvitationAcceptanceResponse(BaseModel):
    invitation_id: uuid.UUID
    invitation_status: InvitationStatus
    project_id: uuid.UUID
    organization_id: uuid.UUID
    membership: AcceptedProjectMembershipResponse
