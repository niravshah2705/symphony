"""The authenticated principal attached to each request.

Immutable snapshot of authorization-relevant identity, resolved from the DB on
every request (not merely decoded from the token) so role/status changes take
effect immediately.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from app.models.enums import OrgRole


@dataclass(frozen=True)
class Principal:
    user_id: uuid.UUID
    org_id: uuid.UUID | None
    org_role: OrgRole
    is_super_admin: bool
    email: str
    # Server-validated request context. ``org_id`` is the selected membership
    # (or a backward-compatible default); ``project_id`` is only populated when
    # the exact project-selection header was supplied and authorized.
    project_id: uuid.UUID | None = None
