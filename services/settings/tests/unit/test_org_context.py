from __future__ import annotations

import uuid

import pytest

from app.auth.org_context import OrgContextError, parse_context_payload
from app.models.enums import OrgRole


def payload():
    user_id = uuid.uuid4()
    org_a, org_b = uuid.uuid4(), uuid.uuid4()
    project_a, project_b = uuid.uuid4(), uuid.uuid4()
    return (
        {
            "user": {"id": str(user_id), "email": "member@example.com"},
            "organizations": [
                {
                    "id": str(org_a),
                    "name": "A",
                    "role": "MEMBER",
                    "projects": [{"id": str(project_a), "name": "A project"}],
                },
                {
                    "id": str(org_b),
                    "name": "B",
                    "role": "ORG_ADMIN",
                    "projects": [{"id": str(project_b), "name": "B project", "role": "PROJECT_ADMIN"}],
                },
            ],
        },
        user_id,
        org_a,
        org_b,
        project_a,
        project_b,
    )


def test_selected_org_and_project_are_resolved_from_authoritative_list():
    body, user_id, _org_a, org_b, _project_a, project_b = payload()
    context = parse_context_payload(
        body, requested_org_id=str(org_b), requested_project_id=str(project_b)
    )
    assert context.user_id == user_id
    assert context.org_id == org_b
    assert context.org_role == OrgRole.ORG_ADMIN
    assert context.project_id == project_b
    assert context.project_role.value == "PROJECT_ADMIN"


def test_missing_selection_falls_back_to_first_accessible_context():
    body, _user_id, org_a, _org_b, project_a, _project_b = payload()
    context = parse_context_payload(body)
    assert context.org_id == org_a
    assert context.project_id == project_a


def test_project_must_belong_to_selected_organization():
    body, _user_id, org_a, _org_b, _project_a, project_b = payload()
    with pytest.raises(OrgContextError) as exc:
        parse_context_payload(
            body, requested_org_id=str(org_a), requested_project_id=str(project_b)
        )
    assert exc.value.status_code == 404


def test_unknown_organization_is_rejected():
    body, *_ = payload()
    with pytest.raises(OrgContextError) as exc:
        parse_context_payload(body, requested_org_id=str(uuid.uuid4()))
    assert exc.value.status_code == 403
