"""Config VALUES (provider secrets) over the HTTP surface.

Covers: the user > project > org override cascade, write-only secret MASKING in
every browser-facing response, plaintext ONLY on the internal S2S endpoint,
merge/preserve semantics, and cross-scope isolation (→ 404).
"""
from __future__ import annotations

import uuid

import pytest

from app.models.enums import OrgRole
from tests.helpers import auth, make_user, seed_user, token_for

pytestmark = pytest.mark.asyncio

SECRET = "AIzaSyExampleGeminiKey_0123456789abcdef"


async def test_user_can_set_gemini_key_and_read_it_back_masked(client):
    _u, token = await make_user(email="u@x.com", org_id=uuid.uuid4())

    put = await client.put(
        "/api/v1/me/settings",
        headers=auth(token),
        json={"values": {"geminiApiKey": SECRET}},
    )
    assert put.status_code == 200
    # Response masks the secret to a presence marker and NEVER echoes plaintext.
    assert put.json()["values"]["geminiApiKey"] == {"set": True}
    assert SECRET not in put.text

    got = await client.get("/api/v1/me/settings", headers=auth(token))
    assert got.json()["values"]["geminiApiKey"] == {"set": True}
    assert SECRET not in got.text


async def test_effective_masks_the_secret_but_internal_returns_plaintext(client):
    _u, token = await make_user(email="u@x.com", org_id=uuid.uuid4())
    await client.put(
        "/api/v1/me/settings", headers=auth(token), json={"values": {"geminiApiKey": SECRET}}
    )

    # Browser-facing effective endpoint: masked, no plaintext anywhere in body.
    eff = await client.get("/api/v1/settings/effective", headers=auth(token))
    assert eff.status_code == 200
    assert eff.json()["values"]["geminiApiKey"] == {"set": True}
    assert SECRET not in eff.text

    # Internal S2S endpoint: UNMASKED plaintext for the same caller.
    internal = await client.get("/api/v1/internal/effective-config", headers=auth(token))
    assert internal.status_code == 200
    assert internal.json()["values"]["geminiApiKey"] == SECRET


async def test_effective_value_cascade_user_over_project_over_org(client):
    org = uuid.uuid4()
    project = uuid.uuid4()
    _admin, token = await make_user(email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN)

    await client.put(
        "/api/v1/settings/org", headers=auth(token), json={"values": {"geminiApiKey": "org-key"}}
    )
    await client.put(
        f"/api/v1/settings/project/{project}",
        headers=auth(token),
        json={"values": {"geminiApiKey": "project-key"}},
    )
    await client.put(
        "/api/v1/me/settings", headers=auth(token), json={"values": {"geminiApiKey": "user-key"}}
    )

    internal = await client.get(
        f"/api/v1/internal/effective-config?project_id={project}", headers=auth(token)
    )
    assert internal.json()["values"]["geminiApiKey"] == "user-key"

    # Clear the user override -> the project value now wins.
    await client.put(
        "/api/v1/me/settings", headers=auth(token), json={"values": {"geminiApiKey": ""}}
    )
    internal = await client.get(
        f"/api/v1/internal/effective-config?project_id={project}", headers=auth(token)
    )
    assert internal.json()["values"]["geminiApiKey"] == "project-key"


async def test_domain_only_put_preserves_the_stored_secret(client):
    """The browser can never read the secret back to resend it, so a policy PUT
    that omits ``values`` must NOT wipe the stored key."""
    _u, token = await make_user(email="u@x.com", org_id=uuid.uuid4())
    await client.put(
        "/api/v1/me/settings", headers=auth(token), json={"values": {"geminiApiKey": SECRET}}
    )
    # Edit only the include/exclude domains — no `values` in the body.
    await client.put(
        "/api/v1/me/settings",
        headers=auth(token),
        json={"domains": {"tools": {"include": [], "exclude": ["docker"]}}},
    )
    internal = await client.get("/api/v1/internal/effective-config", headers=auth(token))
    assert internal.json()["values"]["geminiApiKey"] == SECRET


async def test_values_only_put_preserves_the_stored_domains(client):
    """The inverse of the domain-only case: setting the secret alone (no
    ``domains`` in the body) must NOT wipe the include/exclude policy."""
    _u, token = await make_user(email="u@x.com", org_id=uuid.uuid4())
    await client.put(
        "/api/v1/me/settings",
        headers=auth(token),
        json={"domains": {"tools": {"include": [], "exclude": ["docker"]}}},
    )
    # Now set only the secret — omit `domains` entirely.
    await client.put(
        "/api/v1/me/settings", headers=auth(token), json={"values": {"geminiApiKey": SECRET}}
    )
    got = await client.get("/api/v1/me/settings", headers=auth(token))
    body = got.json()
    assert body["domains"]["tools"]["exclude"] == ["docker"]
    assert body["values"]["geminiApiKey"] == {"set": True}


async def test_unknown_config_value_key_is_rejected(client):
    _u, token = await make_user(email="u@x.com", org_id=uuid.uuid4())
    resp = await client.put(
        "/api/v1/me/settings",
        headers=auth(token),
        json={"values": {"openaiApiKey": "nope"}},
    )
    assert resp.status_code == 422


async def test_control_characters_in_value_are_rejected(client):
    _u, token = await make_user(email="u@x.com", org_id=uuid.uuid4())
    resp = await client.put(
        "/api/v1/me/settings",
        headers=auth(token),
        json={"values": {"geminiApiKey": "line1\nline2"}},
    )
    assert resp.status_code == 422


async def test_effective_config_is_scoped_to_the_caller_not_a_foreign_project(client):
    """A member with no access to a project gets no project layer (cross-scope
    isolation): the foreign project's org-scoped secret must not leak."""
    org = uuid.uuid4()
    project = uuid.uuid4()
    admin, admin_token = await make_user(
        email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN
    )
    # Org admin stores a project-scoped secret.
    await client.put(
        f"/api/v1/settings/project/{project}",
        headers=auth(admin_token),
        json={"values": {"geminiApiKey": "project-secret"}},
    )

    # A member of a DIFFERENT org asks for that project id's effective config.
    other = await seed_user(email="member@b.com", org_id=uuid.uuid4(), org_role=OrgRole.MEMBER)
    other_token = token_for(other)
    internal = await client.get(
        f"/api/v1/internal/effective-config?project_id={project}", headers=auth(other_token)
    )
    assert internal.status_code == 200
    # The foreign project layer is treated as absent — no leak of its secret.
    assert internal.json()["values"] == {}
    assert "project-secret" not in internal.text


async def test_non_member_cannot_write_project_config(client):
    """Writing project config requires project-admin — a non-member is 404
    (no existence oracle), so cannot plant or read another project's secret."""
    org = uuid.uuid4()
    project = uuid.uuid4()
    member = await seed_user(email="m@a.com", org_id=org, org_role=OrgRole.MEMBER)
    token = token_for(member)
    resp = await client.put(
        f"/api/v1/settings/project/{project}",
        headers=auth(token),
        json={"values": {"geminiApiKey": SECRET}},
    )
    assert resp.status_code == 404
