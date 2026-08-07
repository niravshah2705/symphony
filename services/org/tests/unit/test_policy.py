"""Unit tests for the authorization capability predicates."""
from __future__ import annotations

import uuid

from app.authz.policy import (
    can_delete_task,
    can_manage_project_access,
    can_update_project,
    can_write_task,
    is_org_admin,
)
from app.authz.principal import Principal
from app.models.enums import OrgRole, ProjectRole


def _principal(org_role=OrgRole.MEMBER, org_id=uuid.uuid4()):
    return Principal(
        user_id=uuid.uuid4(),
        org_id=org_id,
        org_role=org_role,
        is_super_admin=False,
        email="u@example.com",
    )


def test_is_org_admin():
    assert is_org_admin(_principal(OrgRole.ORG_ADMIN)) is True
    assert is_org_admin(_principal(OrgRole.MEMBER)) is False
    assert is_org_admin(_principal(OrgRole.ORG_ADMIN, org_id=None)) is False


def test_team_lead_is_review_only():
    assert can_write_task(ProjectRole.TEAM_LEAD) is False
    assert can_delete_task(ProjectRole.TEAM_LEAD) is False
    assert can_manage_project_access(ProjectRole.TEAM_LEAD) is False


def test_developer_can_write_but_not_administer():
    assert can_write_task(ProjectRole.DEVELOPER) is True
    assert can_delete_task(ProjectRole.DEVELOPER) is False
    assert can_manage_project_access(ProjectRole.DEVELOPER) is False
    assert can_update_project(ProjectRole.DEVELOPER) is False


def test_project_admin_can_do_everything_project_scoped():
    for check in (can_write_task, can_delete_task, can_manage_project_access, can_update_project):
        assert check(ProjectRole.PROJECT_ADMIN) is True
