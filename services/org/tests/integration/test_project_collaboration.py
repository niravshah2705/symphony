"""End-to-end (HTTP) tests for cross-org project collaboration:

- ORG_WIDE access mode
- project invitations (cross-org accept)
- external-org grants (outsourcing)
- persona capture
- pending-invitation surfacing

Org isolation is asserted throughout: an unrelated org gets 404, never 403.
"""
from __future__ import annotations

import pytest

from app.services import (
    invitation_notifier,
    invitation_service,
    project_invitation_service,
)
from tests.helpers import (
    auth,
    create_project,
    create_user_and_login,
    register_org_admin,
)

pytestmark = pytest.mark.asyncio

ORG_HEADER = "X-AI-Fleet-Organization-Id"


async def _primary_org(client, token: str) -> str:
    ctx = await client.get("/api/v1/me/context", headers=auth(token))
    return ctx.json()["organizations"][0]["id"]


# ---- access mode ------------------------------------------------------------

async def test_org_wide_access_mode_grants_org_members(client):
    admin = await register_org_admin(client, org_name="Acme", email="admin@acme.com")
    project_id = await create_project(client, admin, "Shared")
    _, member = await create_user_and_login(client, admin, email="member@acme.com")

    # INVITE_ONLY (default): a non-member org user cannot see the project.
    denied = await client.get(f"/api/v1/projects/{project_id}", headers=auth(member))
    assert denied.status_code == 404

    flipped = await client.patch(
        f"/api/v1/projects/{project_id}/access-mode",
        headers=auth(admin),
        json={"access_mode": "ORG_WIDE"},
    )
    assert flipped.status_code == 200, flipped.text
    assert flipped.json()["access_mode"] == "ORG_WIDE"

    # ORG_WIDE: every org member now has access.
    allowed = await client.get(f"/api/v1/projects/{project_id}", headers=auth(member))
    assert allowed.status_code == 200
    # …as DEVELOPER, not project-admin — cannot delete.
    assert (
        await client.delete(f"/api/v1/projects/{project_id}", headers=auth(member))
    ).status_code == 403


# ---- external org grant (outsourcing) --------------------------------------

async def test_external_grant_gives_partner_org_access(client):
    owner_admin = await register_org_admin(client, org_name="Owner", email="owner@own.com")
    partner_admin = await register_org_admin(client, org_name="Partner", email="p@partner.com")
    outsider_admin = await register_org_admin(client, org_name="Outsider", email="o@outside.com")
    partner_org_id = await _primary_org(client, partner_admin)
    project_id = await create_project(client, owner_admin, "Outsourced")

    # Before the grant, the partner admin cannot see the project.
    assert (
        await client.get(f"/api/v1/projects/{project_id}", headers=auth(partner_admin))
    ).status_code == 404

    granted = await client.post(
        f"/api/v1/projects/{project_id}/external-grants",
        headers=auth(owner_admin),
        json={"collaborator_org_id": partner_org_id, "default_role": "DEVELOPER"},
    )
    assert granted.status_code == 201, granted.text

    # Every member of the partner org now has access…
    ok = await client.get(f"/api/v1/projects/{project_id}", headers=auth(partner_admin))
    assert ok.status_code == 200
    # …as DEVELOPER (grant role), not owner — cannot delete.
    assert (
        await client.delete(f"/api/v1/projects/{project_id}", headers=auth(partner_admin))
    ).status_code == 403
    # An unrelated org still gets 404 (isolation, no existence oracle).
    assert (
        await client.get(f"/api/v1/projects/{project_id}", headers=auth(outsider_admin))
    ).status_code == 404

    # Revoking the grant removes access again.
    revoked = await client.delete(
        f"/api/v1/projects/{project_id}/external-grants/{partner_org_id}",
        headers=auth(owner_admin),
    )
    assert revoked.status_code == 204
    assert (
        await client.get(f"/api/v1/projects/{project_id}", headers=auth(partner_admin))
    ).status_code == 404


# ---- project invitation (cross-org individual) -----------------------------

async def test_project_invitation_cross_org_accept(client, monkeypatch):
    owner_admin = await register_org_admin(client, org_name="Owner2", email="owner2@own.com")
    # Bob belongs to his own org; he'll be invited to the owner's project.
    bob = await register_org_admin(client, org_name="BobCo", email="bob@bobco.com")
    project_id = await create_project(client, owner_admin, "Collab")

    monkeypatch.setattr(
        project_invitation_service, "generate_invitation_token", lambda: "proj-secret"
    )
    payloads: list[dict] = []

    async def capture(payload: dict) -> bool:
        payloads.append(payload)
        return True

    monkeypatch.setattr(invitation_notifier, "publish_invitation", capture)

    created = await client.post(
        f"/api/v1/projects/{project_id}/invitations",
        headers=auth(owner_admin),
        json={"email": "BOB@bobco.com", "role": "DEVELOPER"},
    )
    assert created.status_code == 201, created.text
    assert created.json()["delivery_status"] == "queued"
    assert "proj-secret" not in created.text
    assert payloads[0]["template"] == "project-invitation"
    assert payloads[0]["variables"]["projectName"] == "Collab"

    # Before accepting, Bob cannot see the project.
    assert (
        await client.get(f"/api/v1/projects/{project_id}", headers=auth(bob))
    ).status_code == 404

    accepted = await client.post(
        "/api/v1/project-invitations/accept",
        headers=auth(bob),
        json={"token": "proj-secret"},
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["membership"]["role"] == "DEVELOPER"
    assert "proj-secret" not in accepted.text

    # Now Bob (from his own org) can access the project cross-org, as DEVELOPER.
    ok = await client.get(f"/api/v1/projects/{project_id}", headers=auth(bob))
    assert ok.status_code == 200
    assert (
        await client.delete(f"/api/v1/projects/{project_id}", headers=auth(bob))
    ).status_code == 403

    # The token is single-use.
    assert (
        await client.post(
            "/api/v1/project-invitations/accept",
            headers=auth(bob),
            json={"token": "proj-secret"},
        )
    ).status_code == 404


# ---- persona ----------------------------------------------------------------

async def test_persona_capture(client):
    admin = await register_org_admin(client, org_name="PersonaCo", email="pc@persona.com")
    assert (await client.get("/api/v1/me", headers=auth(admin))).json()["persona"] is None

    set_resp = await client.put(
        "/api/v1/me/persona", headers=auth(admin), json={"persona": "ENGINEER"}
    )
    assert set_resp.status_code == 200, set_resp.text
    assert set_resp.json()["persona"] == "ENGINEER"

    assert (await client.get("/api/v1/me", headers=auth(admin))).json()["persona"] == "ENGINEER"
    ctx = await client.get("/api/v1/me/context", headers=auth(admin))
    assert ctx.json()["user"]["persona"] == "ENGINEER"


# ---- pending-invitation surfacing ------------------------------------------

async def test_pending_invitations_surfaced_by_email(client, monkeypatch):
    inviter = await register_org_admin(client, org_name="Surfacer", email="surf@surf.com")
    target = await register_org_admin(client, org_name="TargetHome", email="target@surf.com")

    monkeypatch.setattr(invitation_service, "generate_invitation_token", lambda: "org-secret")

    async def capture(payload: dict) -> bool:
        return True

    monkeypatch.setattr(invitation_notifier, "publish_invitation", capture)

    created = await client.post(
        "/api/v1/invitations",
        headers=auth(inviter),
        json={"email": "target@surf.com", "org_role": "MEMBER"},
    )
    assert created.status_code == 201, created.text

    pending = await client.get("/api/v1/me/pending-invitations", headers=auth(target))
    assert pending.status_code == 200, pending.text
    entries = pending.json()
    assert len(entries) == 1
    assert entries[0]["kind"] == "org"
    assert entries[0]["organization_name"] == "Surfacer"

    # Accepting the invitation clears the surfaced entry.
    accepted = await client.post(
        "/api/v1/invitations/accept", headers=auth(target), json={"token": "org-secret"}
    )
    assert accepted.status_code == 200, accepted.text
    assert (
        await client.get("/api/v1/me/pending-invitations", headers=auth(target))
    ).json() == []
