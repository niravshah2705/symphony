"""Project external-org grant request/response schemas."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.enums import ProjectRole


class ExternalGrantCreate(BaseModel):
    collaborator_org_id: uuid.UUID
    default_role: ProjectRole = ProjectRole.DEVELOPER


class ExternalGrantResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    owner_org_id: uuid.UUID
    collaborator_org_id: uuid.UUID
    default_role: ProjectRole
    granted_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
