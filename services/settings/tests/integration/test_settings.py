"""End-to-end settings CRUD + effective cascade over the HTTP surface."""
from __future__ import annotations

import uuid

import pytest

from app.models.enums import OrgRole
from tests.helpers import auth, make_user

pytestmark = pytest.mark.asyncio


async def test_universe_lists_all_domains(client):
    _u, token = await make_user(email="u@x.com", org_id=uuid.uuid4())
    resp = await client.get("/api/v1/settings/universe", headers=auth(token))
    assert resp.status_code == 200
    domains = resp.json()["domains"]
    assert set(domains) == {"harness", "tools", "skills", "plugins", "hooks", "models"}
    assert "deepagent" in domains["harness"]
    assert "docker" in domains["tools"]
    assert "linear" in domains["skills"]
    assert "pre-code" in domains["hooks"]
    assert "claude-opus-4-8" in domains["models"]


async def test_org_policy_round_trips(client):
    org = uuid.uuid4()
    _admin, token = await make_user(email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN)

    # Default (unset) policy reads back empty.
    empty = await client.get("/api/v1/settings/org", headers=auth(token))
    assert empty.status_code == 200
    assert empty.json()["scope_type"] == "org"

    put = await client.put(
        "/api/v1/settings/org",
        headers=auth(token),
        json={"domains": {"tools": {"include": [], "exclude": ["docker"]}}},
    )
    assert put.status_code == 200
    got = await client.get("/api/v1/settings/org", headers=auth(token))
    assert got.json()["domains"]["tools"]["exclude"] == ["docker"]


async def test_effective_reflects_org_exclusion(client):
    org = uuid.uuid4()
    _admin, token = await make_user(email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN)

    await client.put(
        "/api/v1/settings/org",
        headers=auth(token),
        json={"domains": {"harness": {"include": [], "exclude": ["codex-sdk"]}}},
    )
    resp = await client.get("/api/v1/settings/effective", headers=auth(token))
    assert resp.status_code == 200
    harness = resp.json()["domains"]["harness"]
    assert "codex-sdk" not in harness["effective"]
    assert "deepagent" in harness["effective"]


async def test_effective_cascade_org_exclude_beats_user_include(client):
    """The headline rule end-to-end: an org exclude cannot be re-included by the
    user's own policy."""
    org = uuid.uuid4()
    admin, admin_token = await make_user(email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN)

    # Org admin excludes codex-sdk for everyone in the org.
    await client.put(
        "/api/v1/settings/org",
        headers=auth(admin_token),
        json={"domains": {"harness": {"include": [], "exclude": ["codex-sdk"]}}},
    )
    # The same admin, acting as a user, tries to include codex-sdk in their user policy.
    await client.put(
        "/api/v1/me/settings",
        headers=auth(admin_token),
        json={"domains": {"harness": {"include": ["deepagent", "codex-sdk"], "exclude": []}}},
    )
    resp = await client.get("/api/v1/settings/effective", headers=auth(admin_token))
    harness = resp.json()["domains"]["harness"]
    # User include narrowed to deepagent; codex-sdk stays blocked (exclude wins downward).
    assert harness["effective"] == ["deepagent"]


async def test_effective_applies_project_layer(client):
    org = uuid.uuid4()
    project = uuid.uuid4()
    _admin, token = await make_user(email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN)

    # Project policy excludes claude-agent-sdk.
    await client.put(
        f"/api/v1/settings/project/{project}",
        headers=auth(token),
        json={"domains": {"harness": {"include": [], "exclude": ["claude-agent-sdk"]}}},
    )
    resp = await client.get(
        f"/api/v1/settings/effective?project_id={project}", headers=auth(token)
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["project_id"] == str(project)
    harness = body["domains"]["harness"]
    assert "claude-agent-sdk" not in harness["effective"]
    # Org level (no project layer) still contains it.
    assert "claude-agent-sdk" in harness["org"]


INTERNAL_TOKEN = "test-internal-token-0123456789"


async def test_s2s_org_effective_policy_reflects_org_denies(client):
    """The autonomous planner/coder resolves its org's effective policy over the
    token-gated S2S endpoint (no user scope). Mirrors the org-secrets S2S guard."""
    org_id = uuid.uuid4()
    _u, token = await make_user(
        email="admin@x.com", org_id=org_id, org_role=OrgRole.ORG_ADMIN
    )
    put = await client.put(
        "/api/v1/settings/org",
        headers=auth(token),
        json={
            "domains": {
                "models": {"include": [], "exclude": ["ollama-*"]},
                "harness": {"include": [], "exclude": ["codex-sdk"]},
            }
        },
    )
    assert put.status_code == 200

    url = f"/api/v1/internal/s2s/orgs/{org_id}/effective-policy"
    assert (await client.get(url)).status_code == 403  # missing token
    assert (
        await client.get(url, headers={"X-Internal-Token": "nope"})
    ).status_code == 403  # wrong token

    resp = await client.get(url, headers={"X-Internal-Token": INTERNAL_TOKEN})
    assert resp.status_code == 200
    domains = resp.json()["domains"]
    assert "ollama-gpt-oss-20b" not in domains["models"]["effective"]
    assert "codex-sdk" not in domains["harness"]["effective"]
    # No user scope in the S2S resolve → effective == the org-level allowed set.
    assert domains["models"]["effective"] == domains["models"]["org"]
