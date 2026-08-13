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
    assert "billing" in domains["tools"]
    assert "linear" in domains["skills"]
    assert "pre-code" in domains["hooks"]
    assert "claude-opus-4-8" in domains["models"]
    catalog = resp.json()["harnesses"]
    assert resp.json()["schemaVersion"] == 1
    assert next(item for item in catalog if item["id"] == "deepagent")["availability"] == "available"
    # Experimental adapters are discoverable but cannot be selected by policy.
    assert next(item for item in catalog if item["id"] == "opencode")["availability"] == "experimental"
    assert "opencode" not in domains["harness"]


async def test_preflight_resolves_request_stage_global_precedence_and_broker_guard(client):
    org = uuid.uuid4()
    _admin, token = await make_user(
        email="preflight@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN
    )
    put = await client.put(
        "/api/v1/settings/org",
        headers=auth(token),
        json={
            "prefs": {
                "agentRuntime": "deepagent",
                "planHarness": "antigravity-sdk",
                "codeHarness": "codex-sdk",
                "llmProvider": "ollama",
            }
        },
    )
    assert put.status_code == 200

    response = await client.post(
        "/api/v1/settings/preflight",
        headers=auth(token),
        json={
            "stages": ["plan", "code"],
            "harnesses": {"plan": "deepagent"},
            "providers": {"plan": "ollama", "code": "codex"},
            "models": {
                "plan": "ollama-gpt-oss-20b",
                "code": "codex-gpt-5-6-sol",
            },
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body["decision_id"]) == 24
    assert body["stages"][0]["harness"] == "deepagent"  # request wins
    assert body["stages"][0]["provider"] == "ollama"
    assert body["stages"][0]["model"] == "ollama-gpt-oss-20b"
    assert body["stages"][1]["harness"] == "codex-sdk"  # per-stage pref
    assert "brokered_stage_unsupported" in body["stages"][1]["errors"]
    assert body["domains"]["models"]
    assert body["ready"] is False


async def test_preflight_snapshots_initiating_user_model_policy(client):
    org = uuid.uuid4()
    _user, token = await make_user(email="preflight-user@a.com", org_id=org)
    narrowed = await client.put(
        "/api/v1/me/settings",
        headers=auth(token),
        json={
            "domains": {
                "models": {
                    "include": ["ollama-gpt-oss-20b"],
                    "exclude": [],
                }
            }
        },
    )
    assert narrowed.status_code == 200

    response = await client.post(
        "/api/v1/settings/preflight",
        headers=auth(token),
        json={
            "stages": ["plan"],
            "providers": {"plan": "codex"},
            "models": {"plan": "codex-gpt-5-6-sol"},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["domains"]["models"] == ["ollama-gpt-oss-20b"]
    assert "model_denied" in body["stages"][0]["errors"]
    assert body["ready"] is False


async def test_preflight_identifies_the_managed_static_llm_credential_kind(
    client, monkeypatch
):
    org = uuid.uuid4()
    _user, token = await make_user(email="credential-kind@a.com", org_id=org)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-managed")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-managed")

    codex = await client.post(
        "/api/v1/settings/preflight",
        headers=auth(token),
        json={
            "stages": ["plan"],
            "providers": {"plan": "codex"},
            "models": {"plan": "codex-gpt-5-6-sol"},
        },
    )
    assert codex.status_code == 200
    assert codex.json()["stages"][0]["credential"] == {
        "ready": True,
        "source": "managed",
        "kind": "openaiApiKey",
    }

    claude = await client.post(
        "/api/v1/settings/preflight",
        headers=auth(token),
        json={
            "stages": ["plan"],
            "providers": {"plan": "claude"},
            "models": {"plan": "claude-opus-4-8"},
        },
    )
    assert claude.status_code == 200
    assert claude.json()["stages"][0]["credential"] == {
        "ready": True,
        "source": "managed",
        "kind": "anthropicApiKey",
    }


@pytest.mark.parametrize(
    "stages",
    [
        ["plan", "deploy"],
        ["test", "deploy"],
        ["plan", "test", "deploy"],
        ["code", "test", "deploy"],
    ],
)
async def test_preflight_rejects_deploy_without_exact_full_pipeline(client, stages):
    org = uuid.uuid4()
    _admin, token = await make_user(
        email="invalid-run@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN
    )
    response = await client.post(
        "/api/v1/settings/preflight",
        headers=auth(token),
        json={"stages": stages},
    )
    assert response.status_code == 422


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


async def test_org_prefs_are_readable_and_resolve_into_effective(client):
    """Operational prefs are per-scope, READABLE (unlike secret values), and are
    resolved into the effective response (user > project > org)."""
    org_id = uuid.uuid4()
    _admin, token = await make_user(
        email="prefs@x.com", org_id=org_id, org_role=OrgRole.ORG_ADMIN
    )
    put = await client.put(
        "/api/v1/settings/org",
        headers=auth(token),
        json={"prefs": {"complexityTier": "balanced", "agentRuntime": "codex-sdk"}},
    )
    assert put.status_code == 200
    # Prefs read back verbatim (secret values would mask to {set: bool}).
    assert put.json()["prefs"] == {"complexityTier": "balanced", "agentRuntime": "codex-sdk"}
    # An unknown pref key is rejected by the allow-list.
    bad = await client.put(
        "/api/v1/settings/org", headers=auth(token), json={"prefs": {"nope": "x"}}
    )
    assert bad.status_code == 422
    # Effective resolves the org prefs (this admin has no user override).
    eff = await client.get("/api/v1/settings/effective", headers=auth(token))
    assert eff.status_code == 200
    assert eff.json()["prefs"]["complexityTier"] == "balanced"


async def test_org_lock_pins_a_pref_against_user_override(client):
    """A pref LOCKED at org wins over a lower scope, and the effective response
    tells the user which keys they cannot override."""
    org_id = uuid.uuid4()
    _admin, token = await make_user(
        email="lock@x.com", org_id=org_id, org_role=OrgRole.ORG_ADMIN
    )
    org = await client.put(
        "/api/v1/settings/org",
        headers=auth(token),
        json={"prefs": {"agentRuntime": "deepagent"}, "locks": ["agentRuntime"]},
    )
    assert org.status_code == 200
    assert org.json()["locks"] == ["agentRuntime"]
    # The same admin, as a user, tries to override the locked pref.
    me = await client.put(
        "/api/v1/me/settings",
        headers=auth(token),
        json={"prefs": {"agentRuntime": "codex-sdk"}},
    )
    assert me.status_code == 200
    eff = (await client.get("/api/v1/settings/effective", headers=auth(token))).json()
    assert eff["prefs"]["agentRuntime"] == "deepagent"  # org lock wins
    assert "agentRuntime" in eff["locks"]  # surfaced as un-overridable
    # An unknown lock key is rejected by the allow-list.
    bad = await client.put(
        "/api/v1/settings/org", headers=auth(token), json={"locks": ["nope"]}
    )
    assert bad.status_code == 422


async def test_org_domain_lock_freezes_models_against_user(client):
    """Locking the `models` domain at org freezes it: a lower scope's narrowing
    (shortlist / extra deny) is ignored, and the effective response reports it."""
    org_id = uuid.uuid4()
    _admin, token = await make_user(
        email="dlock@x.com", org_id=org_id, org_role=OrgRole.ORG_ADMIN
    )
    org = await client.put(
        "/api/v1/settings/org",
        headers=auth(token),
        json={
            "domains": {"models": {"include": [], "exclude": ["ollama-gpt-oss-20b"]}},
            "locks": ["models"],
        },
    )
    assert org.status_code == 200
    assert "models" in org.json()["locks"]
    # User tries to shortlist a single model (would normally narrow to just it).
    me = await client.put(
        "/api/v1/me/settings",
        headers=auth(token),
        json={"domains": {"models": {"include": ["claude-opus-4-8"], "exclude": []}}},
    )
    assert me.status_code == 200
    eff = (await client.get("/api/v1/settings/effective", headers=auth(token))).json()
    models = eff["domains"]["models"]["effective"]
    assert "claude-opus-4-8" in models  # frozen at org — user shortlist ignored
    assert "claude-sonnet-5" in models  # still allowed despite the user's shortlist
    assert "ollama-gpt-oss-20b" not in models  # org's deny holds
    assert "models" in eff["locks"]
