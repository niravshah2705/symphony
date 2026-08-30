"""Schemas for the `/me` self-service surface (personal projects + create-org)."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import MembershipStatus, OrgRole, Persona, ProjectRole


class MeResponse(BaseModel):
    """The caller's identity plus whether they belong to an organization."""

    user_id: uuid.UUID
    email: str
    full_name: str | None = None
    persona: Persona | None = None
    has_organization: bool
    org_id: uuid.UUID | None = None
    org_role: str | None = None


class PersonaUpdate(BaseModel):
    """Self-declared actor persona, captured once at onboarding."""

    persona: Persona


class LinkIdentityRequest(BaseModel):
    """Link a second sign-in method, proven by a valid external-IdP token."""

    token: str = Field(min_length=1, max_length=4096)


class LinkedIdentityResponse(BaseModel):
    provider: str
    subject: str
    linked_at: datetime


class PendingInvitationResponse(BaseModel):
    """A pending org/project invitation surfaced by email at first login.
    Surfacing only — acceptance still consumes the single-use token."""

    kind: str  # "org" | "project"
    organization_id: uuid.UUID | None = None
    organization_name: str | None = None
    project_id: uuid.UUID | None = None
    project_name: str | None = None
    role: str | None = None
    expires_at: datetime | None = None


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


class ContextUserResponse(BaseModel):
    id: uuid.UUID
    email: str
    full_name: str | None = None
    persona: Persona | None = None
    is_super_admin: bool


class ContextProjectResponse(BaseModel):
    id: uuid.UUID
    name: str
    role: ProjectRole
    status: str = "ACTIVE"


class ContextOrganizationResponse(BaseModel):
    id: uuid.UUID
    name: str
    parent_org_id: uuid.UUID | None = None
    membership_id: uuid.UUID
    role: OrgRole
    status: MembershipStatus
    projects: list[ContextProjectResponse]


class SelectedContextResponse(BaseModel):
    organization_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None


class MeContextResponse(BaseModel):
    user: ContextUserResponse
    organizations: list[ContextOrganizationResponse]
    selected: SelectedContextResponse | None = None


class MeDeploymentResponse(BaseModel):
    """Which front-facing deployment the caller's workspace should use.

    ``status`` is the resolved deployment state:
      - ``shared``       — org-less or any un-provisioned org → use the
                           shared gateway (``gateway_url``).
      - ``provisioning`` — a dedicated per-tenant stack is being created; the SPA
                           polls until it flips to ``provisioned``.
      - ``provisioned``  — use the per-tenant ``gateway_url``.
      - ``failed``       — provisioning failed; the SPA falls back to shared.

    Only ``gateway_url`` is browser-facing; planner/coder/org/settings URLs are
    never returned to the client (they are S2S parameters of the deployment).
    """

    status: str = "shared"
    gateway_url: str = ""
    org_id: uuid.UUID | None = None
    org_name: str | None = None
