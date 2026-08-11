"""The authenticated principal attached to each request.

Immutable snapshot of authorization-relevant identity, resolved from the DB on
every request (not merely decoded from the token) so role/status changes take
effect immediately.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from app.models.enums import OrgRole, ProjectRole


@dataclass(frozen=True)
class Principal:
    user_id: uuid.UUID
    org_id: uuid.UUID | None
    org_role: OrgRole
    project_id: uuid.UUID | None
    project_role: ProjectRole | None
    context_authoritative: bool
    is_super_admin: bool
    email: str
