"""Capability functions — the single source of truth for what each role may do.

Expressed as explicit predicates over an *effective* ProjectRole (never a
fragile linear ordering). The org-level elevation (ORG_ADMIN acts as
PROJECT_ADMIN on every project in its org) is resolved in guards before these
are called.
"""
from __future__ import annotations

from app.authz.principal import Principal
from app.models.enums import OrgRole, ProjectRole

_READERS = {ProjectRole.PROJECT_ADMIN, ProjectRole.TEAM_LEAD, ProjectRole.DEVELOPER}
_TASK_WRITERS = {ProjectRole.PROJECT_ADMIN, ProjectRole.DEVELOPER}
_PROJECT_ADMINS = {ProjectRole.PROJECT_ADMIN}


def is_org_admin(principal: Principal) -> bool:
    return principal.org_id is not None and principal.org_role == OrgRole.ORG_ADMIN


def can_read_project(role: ProjectRole) -> bool:
    return role in _READERS


def can_write_task(role: ProjectRole) -> bool:
    """Create/update tasks. TEAM_LEAD is review-only, so excluded."""
    return role in _TASK_WRITERS


def can_delete_task(role: ProjectRole) -> bool:
    return role in _PROJECT_ADMINS


def can_manage_project_access(role: ProjectRole) -> bool:
    """Add/remove members and change their roles."""
    return role in _PROJECT_ADMINS


def can_update_project(role: ProjectRole) -> bool:
    return role in _PROJECT_ADMINS


def can_manage_project_tags(role: ProjectRole) -> bool:
    return role in _PROJECT_ADMINS
