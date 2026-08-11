"""Authorization matrix + cross-tenant isolation.

Scope is always derived from the authenticated Principal. Cross-org / no-access
resources return 404 (no existence oracle); insufficient role returns 403.
"""
from __future__ import annotations

import uuid

import pytest

from app.models.enums import OrgRole, ProjectRole
from tests.helpers import auth, make_user, seed_membership

pytestmark = pytest.mark.asyncio


async def test_org_settings_require_org_admin(client):
    org = uuid.uuid4()
    _admin, admin_token = await make_user(email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN)
    _member, member_token = await make_user(email="m@a.com", org_id=org, org_role=OrgRole.MEMBER)

    assert (await client.get("/api/v1/settings/org", headers=auth(admin_token))).status_code == 200
    # A plain member cannot read or write org policy.
    assert (await client.get("/api/v1/settings/org", headers=auth(member_token))).status_code == 403
    assert (
        await client.put("/api/v1/settings/org", headers=auth(member_token), json={"domains": {}})
    ).status_code == 403


async def test_org_less_user_cannot_touch_org_settings(client):
    _u, token = await make_user(email="solo@x.com", org_id=None)
    assert (await client.get("/api/v1/settings/org", headers=auth(token))).status_code == 403


# NOTE: feat-headers derives settings authority from the authenticated Principal
# and the SELECTED workspace context (resolved by this service), NOT from
# gateway-forwarded x-org-* headers. So a forwarded role can never GRANT access —
# it is ignored entirely. The negative cases below assert that (kept as
# defense-in-depth); main's "header grants org admin (200)" case was removed with
# that org-forwarding design.
async def test_gateway_org_headers_member_role_still_forbidden(client):
    # A forwarded MEMBER role must NOT grant org-admin access.
    org = uuid.uuid4()
    _u, token = await make_user(email="member@x.com", org_id=None)
    headers = {**auth(token), "X-Org-Id": str(org), "X-Org-Role": "MEMBER"}
    assert (await client.get("/api/v1/settings/org", headers=headers)).status_code == 403


async def test_invalid_org_headers_are_ignored(client):
    # A malformed org id yields no override, so the user stays org-less (403) —
    # a spoofed X-Org-Role can never escalate on its own.
    _u, token = await make_user(email="solo@x.com", org_id=None)
    headers = {**auth(token), "X-Org-Id": "not-a-uuid", "X-Org-Role": "ORG_ADMIN"}
    assert (await client.get("/api/v1/settings/org", headers=headers)).status_code == 403


async def test_me_settings_available_to_any_authenticated_user(client):
    # Even an org-less user may manage their own settings.
    _u, token = await make_user(email="solo@x.com", org_id=None)
    assert (await client.get("/api/v1/me/settings", headers=auth(token))).status_code == 200
    put = await client.put(
        "/api/v1/me/settings",
        headers=auth(token),
        json={"domains": {"harness": {"include": ["deepagent"], "exclude": []}}},
    )
    assert put.status_code == 200
    assert put.json()["domains"]["harness"]["include"] == ["deepagent"]


async def test_me_settings_rejects_unauthenticated(client):
    assert (await client.get("/api/v1/me/settings")).status_code == 401
    # A garbage bearer is also rejected.
    assert (
        await client.get("/api/v1/me/settings", headers={"Authorization": "Bearer nope"})
    ).status_code == 401


async def test_project_settings_org_admin_elevated(client):
    org = uuid.uuid4()
    project = uuid.uuid4()
    _admin, admin_token = await make_user(email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN)
    # ORG_ADMIN is elevated to PROJECT_ADMIN on any project in its org — no membership needed.
    assert (
        await client.get(f"/api/v1/settings/project/{project}", headers=auth(admin_token))
    ).status_code == 200


async def test_project_settings_cross_org_returns_404(client):
    org_a, org_b = uuid.uuid4(), uuid.uuid4()
    project = uuid.uuid4()
    # A member of org A is a project admin on the project.
    member_a, token_a = await make_user(email="a@a.com", org_id=org_a, org_role=OrgRole.MEMBER)
    await seed_membership(
        org_id=org_a, project_id=project, user_id=member_a.id, role=ProjectRole.PROJECT_ADMIN
    )
    assert (
        await client.get(f"/api/v1/settings/project/{project}", headers=auth(token_a))
    ).status_code == 200

    # A member of org B has no membership under org B's path -> 404 (no oracle).
    _member_b, token_b = await make_user(email="b@b.com", org_id=org_b, org_role=OrgRole.MEMBER)
    assert (
        await client.get(f"/api/v1/settings/project/{project}", headers=auth(token_b))
    ).status_code == 404
    assert (
        await client.put(
            f"/api/v1/settings/project/{project}", headers=auth(token_b), json={"domains": {}}
        )
    ).status_code == 404


async def test_project_member_without_admin_role_is_forbidden(client):
    org = uuid.uuid4()
    project = uuid.uuid4()
    dev, dev_token = await make_user(email="dev@a.com", org_id=org, org_role=OrgRole.MEMBER)
    await seed_membership(
        org_id=org, project_id=project, user_id=dev.id, role=ProjectRole.DEVELOPER
    )
    # Has access to the project (200 would be a read) but is not a project admin.
    assert (
        await client.get(f"/api/v1/settings/project/{project}", headers=auth(dev_token))
    ).status_code == 403


async def test_org_less_user_project_returns_404(client):
    _u, token = await make_user(email="solo@x.com", org_id=None)
    assert (
        await client.get(f"/api/v1/settings/project/{uuid.uuid4()}", headers=auth(token))
    ).status_code == 404


async def test_unknown_domain_is_rejected(client):
    org = uuid.uuid4()
    _admin, admin_token = await make_user(email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN)
    resp = await client.put(
        "/api/v1/settings/org",
        headers=auth(admin_token),
        json={"domains": {"bogus": {"include": [], "exclude": []}}},
    )
    assert resp.status_code == 422


async def test_invalid_pattern_is_rejected(client):
    org = uuid.uuid4()
    _admin, admin_token = await make_user(email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN)
    resp = await client.put(
        "/api/v1/settings/org",
        headers=auth(admin_token),
        json={"domains": {"harness": {"include": ["bad pattern with spaces"], "exclude": []}}},
    )
    assert resp.status_code == 422
