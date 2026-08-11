from __future__ import annotations

import pytest

from app.services import invitation_notifier, invitation_service
from tests.helpers import add_member, auth, create_project, register_org_admin

pytestmark = pytest.mark.asyncio

ORG_HEADER = "X-AI-Fleet-Organization-Id"


async def _primary_org(client, token: str) -> str:
    context = await client.get("/api/v1/me/context", headers=auth(token))
    return context.json()["organizations"][0]["id"]


async def test_invitation_delivery_resend_and_explicit_acceptance(client, monkeypatch):
    inviter = await register_org_admin(client, org_name="Inviting Org", email="owner@invite.example.com")
    target = await register_org_admin(client, org_name="Target Home", email="target@invite.example.com")
    inviting_org_id = await _primary_org(client, inviter)

    tokens = iter(["first-secret-token", "second-secret-token"])
    payloads: list[dict] = []
    monkeypatch.setattr(invitation_service, "generate_invitation_token", lambda: next(tokens))

    async def capture(payload: dict) -> bool:
        payloads.append(payload)
        return True

    monkeypatch.setattr(invitation_notifier, "publish_invitation", capture)

    created = await client.post(
        "/api/v1/invitations",
        headers=auth(inviter),
        json={"email": "TARGET@invite.example.com", "org_role": "MEMBER"},
    )
    assert created.status_code == 201, created.text
    invitation_id = created.json()["id"]
    assert created.json()["delivery_status"] == "queued"
    assert "first-secret-token" not in created.text
    assert "token" not in created.json()
    assert payloads[0]["template"] == "invitation"
    assert payloads[0]["to"] == "target@invite.example.com"
    assert payloads[0]["variables"]["organizationName"] == "Inviting Org"
    assert payloads[0]["variables"]["invitationToken"] == "first-secret-token"
    assert payloads[0]["idempotencyKey"].endswith(":1")

    resent = await client.post(
        f"/api/v1/invitations/{invitation_id}/resend", headers=auth(inviter)
    )
    assert resent.status_code == 200, resent.text
    assert "second-secret-token" not in resent.text
    assert payloads[1]["variables"]["invitationToken"] == "second-secret-token"
    assert payloads[1]["idempotencyKey"].endswith(":2")

    # Rotation invalidates the first token. The authenticated recipient must
    # explicitly accept the current one.
    assert (
        await client.post(
            "/api/v1/invitations/accept",
            headers=auth(target),
            json={"token": "first-secret-token"},
        )
    ).status_code == 404
    accepted = await client.post(
        "/api/v1/invitations/accept",
        headers=auth(target),
        json={"token": "second-secret-token"},
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["organization"]["id"] == inviting_org_id
    assert accepted.json()["membership"]["role"] == "MEMBER"
    assert "secret-token" not in accepted.text

    target_default_context = await client.get("/api/v1/me/context", headers=auth(target))
    target_user_id = target_default_context.json()["user"]["id"]
    accessible_project = await create_project(client, inviter, "Accessible")
    await create_project(client, inviter, "Admin only")
    granted = await add_member(
        client, inviter, accessible_project, target_user_id, "TEAM_LEAD"
    )
    assert granted.status_code == 201

    target_context = await client.get(
        "/api/v1/me/context", headers={**auth(target), ORG_HEADER: inviting_org_id}
    )
    assert target_context.status_code == 200
    selected = next(
        org for org in target_context.json()["organizations"] if org["id"] == inviting_org_id
    )
    assert selected["role"] == "MEMBER"
    assert selected["projects"] == [
        {
            "id": accessible_project,
            "name": "Accessible",
            "role": "TEAM_LEAD",
            "status": "ACTIVE",
        }
    ]

    listed = await client.get("/api/v1/invitations", headers=auth(inviter))
    assert listed.json()[0]["status"] == "ACCEPTED"
    assert "secret-token" not in listed.text

    # Removing this org membership does not deactivate the recipient's global
    # identity or disturb their original organization.
    removed = await client.delete(
        f"/api/v1/users/{target_user_id}", headers=auth(inviter)
    )
    assert removed.status_code == 204
    assert (await client.get("/api/v1/me/context", headers=auth(target))).status_code == 200
    assert (
        await client.get(
            "/api/v1/me/context", headers={**auth(target), ORG_HEADER: inviting_org_id}
        )
    ).status_code == 404


async def test_delivery_failure_preserves_invitation_for_resend(client, monkeypatch):
    inviter = await register_org_admin(client, email="owner@failure.example.com")
    await register_org_admin(client, org_name="Recipient", email="recipient@failure.example.com")
    tokens = iter(["failed-delivery-token", "retry-token"])
    monkeypatch.setattr(invitation_service, "generate_invitation_token", lambda: next(tokens))

    async def fail(_payload: dict) -> None:
        raise RuntimeError("adapter included a secret")

    monkeypatch.setattr(invitation_notifier, "publish_invitation", fail)
    created = await client.post(
        "/api/v1/invitations",
        headers=auth(inviter),
        json={"email": "recipient@failure.example.com", "org_role": "MEMBER"},
    )
    assert created.status_code == 201
    assert created.json()["delivery_status"] == "failed"
    assert "failed-delivery-token" not in created.text

    delivered: list[dict] = []

    async def capture(payload: dict) -> bool:
        delivered.append(payload)
        return True

    monkeypatch.setattr(invitation_notifier, "publish_invitation", capture)
    resent = await client.post(
        f"/api/v1/invitations/{created.json()['id']}/resend", headers=auth(inviter)
    )
    assert resent.status_code == 200
    assert resent.json()["delivery_status"] == "queued"
    assert delivered[0]["variables"]["invitationToken"] == "retry-token"


async def test_invitation_email_binding_and_revoke(client, monkeypatch):
    inviter = await register_org_admin(client, email="owner@binding.example.com")
    target = await register_org_admin(client, org_name="Target", email="right@binding.example.com")
    wrong = await register_org_admin(client, org_name="Wrong", email="wrong@binding.example.com")
    monkeypatch.setattr(invitation_service, "generate_invitation_token", lambda: "bound-token")

    created = await client.post(
        "/api/v1/invitations",
        headers=auth(inviter),
        json={"email": "right@binding.example.com", "org_role": "ORG_ADMIN"},
    )
    assert (
        await client.post(
            "/api/v1/invitations/accept",
            headers=auth(wrong),
            json={"token": "bound-token"},
        )
    ).status_code == 403
    revoked = await client.delete(
        f"/api/v1/invitations/{created.json()['id']}", headers=auth(inviter)
    )
    assert revoked.status_code == 204
    assert (
        await client.post(
            "/api/v1/invitations/accept",
            headers=auth(target),
            json={"token": "bound-token"},
        )
    ).status_code == 404
