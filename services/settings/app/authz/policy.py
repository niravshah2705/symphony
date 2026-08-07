"""Capability functions — the single source of truth for what each role may do.

Expressed as explicit predicates over an *effective* ProjectRole (never a
fragile linear ordering). The org-level elevation (ORG_ADMIN acts as
PROJECT_ADMIN on every project in its org) is resolved in guards before these
are called.
"""
from __future__ import annotations

from app.authz.principal import Principal
from app.models.enums import OrgRole, ProjectRole

_PROJECT_ADMINS = {ProjectRole.PROJECT_ADMIN}


def is_org_admin(principal: Principal) -> bool:
    return principal.org_id is not None and principal.org_role == OrgRole.ORG_ADMIN


def can_manage_project_settings(role: ProjectRole) -> bool:
    """Read/write a project's settings policy. Project admins only (ORG_ADMINs
    are elevated to PROJECT_ADMIN in the guard)."""
    return role in _PROJECT_ADMINS
