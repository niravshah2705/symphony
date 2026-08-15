"""Per-org encrypted vault over the HTTP surface.

Covers: org-admin-only write, encrypt-on-write + write-only MASKING (never
plaintext to the browser), the managed/customer selection, the internal S2S
resolve (plaintext only, X-Internal-Token gated, fail-closed on missing key),
merge/clear semantics, and org-admin authorization.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest

from app.api.v1.routes_internal import derive_org_internal_token
from app.models.enums import OrgRole
from tests.helpers import auth, make_user

pytestmark = pytest.mark.asyncio

INTERNAL_TOKEN = "test-internal-token-0123456789"
GH = "ghp_exampleGitHubTokenValue0123456789abcd"
ANTHROPIC = "sk-ant-exampleAnthropicKeyValue0123456789"


def _s2s(org_id, token=INTERNAL_TOKEN):
    headers = {}
    if token is not None:
        headers["X-Org-Internal-Token"] = (
            derive_org_internal_token(org_id) if token == INTERNAL_TOKEN else token
        )
    return f"/api/v1/internal/s2s/orgs/{org_id}/secrets", headers


async def test_org_admin_sets_customer_key_and_reads_it_back_masked(client):
    org = uuid.uuid4()
    _u, token = await make_user(email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN)

    put = await client.put(
        "/api/v1/settings/org/secrets",
        headers=auth(token),
        json={"values": {"githubToken": GH}},
    )
    assert put.status_code == 200
    body = put.json()
    assert body["secrets"]["githubToken"] == {
        "set": True,
        "source": "managed",
        "allowed_sources": ["managed", "customer"],
    }
    assert GH not in put.text  # never echo plaintext

    got = await client.get("/api/v1/settings/org/secrets", headers=auth(token))
    assert got.json()["secrets"]["githubToken"]["set"] is True
    assert GH not in got.text


async def test_s2s_requires_internal_token(client):
    org = uuid.uuid4()
    url, _ = _s2s(org)

    missing = await client.get(url)  # no X-Org-Internal-Token
    assert missing.status_code == 403
    wrong = await client.get(url, headers={"X-Org-Internal-Token": "nope"})
    assert wrong.status_code == 403
    ok = await client.get(
        url, headers={"X-Org-Internal-Token": derive_org_internal_token(org)}
    )
    assert ok.status_code == 200


async def test_s2s_org_token_cannot_cross_organization_boundary(client):
    org_a = uuid.uuid4()
    org_b = uuid.uuid4()
    url_b, _ = _s2s(org_b)

    response = await client.get(
        url_b,
        headers={"X-Org-Internal-Token": derive_org_internal_token(org_a)},
    )

    assert response.status_code == 403


async def test_managed_resolves_the_platform_value_from_env(client, monkeypatch):
    # Managed keys resolve to the platform value from the settings service env
    # (the single managed-key source) — the SAME resolver path as customer keys.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-platform-managed")
    org = uuid.uuid4()
    _u, token = await make_user(email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN)
    url, headers = _s2s(org)
    resp = await client.get(url, headers=headers)
    entry = resp.json()["secrets"]["anthropicApiKey"]
    assert entry["source"] == "managed"
    assert entry["value"] == "sk-ant-platform-managed"


async def test_managed_with_no_env_returns_null(client):
    # No platform env configured -> managed value is null (proxy forwards
    # unauthenticated / applies its own last-resort fallback).
    org = uuid.uuid4()
    _u, token = await make_user(email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN)
    url, headers = _s2s(org)
    entry = (await client.get(url, headers=headers)).json()["secrets"]["anthropicApiKey"]
    assert entry["source"] == "managed"
    assert entry["value"] is None


async def test_managed_secrets_endpoint_no_org(client):
    # Linear is customer-only on the shared-stack path too.
    missing = await client.get("/api/v1/internal/s2s/managed-secrets")
    assert missing.status_code == 403
    resp = await client.get(
        "/api/v1/internal/s2s/managed-secrets", headers={"X-Internal-Token": INTERNAL_TOKEN}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["org_id"] is None
    assert body["secrets"]["linearApiKey"] == {
        "source": "customer",
        "value": None,
        "error": "missing",
    }


async def test_customer_selection_returns_plaintext_over_s2s(client):
    org = uuid.uuid4()
    _u, token = await make_user(email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN)
    await client.put(
        "/api/v1/settings/org/secrets",
        headers=auth(token),
        json={"values": {"anthropicApiKey": ANTHROPIC}},
    )
    await client.put(
        "/api/v1/settings/org/secrets/selection",
        headers=auth(token),
        json={"selection": {"anthropicApiKey": "customer"}},
    )
    url, headers = _s2s(org)
    resp = await client.get(url, headers=headers)
    entry = resp.json()["secrets"]["anthropicApiKey"]
    assert entry["source"] == "customer"
    assert entry["value"] == ANTHROPIC  # decrypted plaintext for the proxy


async def test_customer_selected_but_missing_key_fails_closed(client):
    org = uuid.uuid4()
    _u, token = await make_user(email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN)
    # Choose customer for a key we never set.
    await client.put(
        "/api/v1/settings/org/secrets/selection",
        headers=auth(token),
        json={"selection": {"openaiApiKey": "customer"}},
    )
    url, headers = _s2s(org)
    entry = (await client.get(url, headers=headers)).json()["secrets"]["openaiApiKey"]
    assert entry["source"] == "customer"
    assert entry["value"] is None
    assert entry["error"] == "missing"


async def test_merge_and_clear_semantics(client):
    org = uuid.uuid4()
    _u, token = await make_user(email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN)
    await client.put(
        "/api/v1/settings/org/secrets",
        headers=auth(token),
        json={"values": {"githubToken": GH, "linearApiKey": "lin_key_123"}},
    )
    # Setting only one key must not wipe the other (merge).
    await client.put(
        "/api/v1/settings/org/secrets",
        headers=auth(token),
        json={"values": {"githubToken": "ghp_rotated_value_0123456789abcdef"}},
    )
    got = (await client.get("/api/v1/settings/org/secrets", headers=auth(token))).json()
    assert got["secrets"]["githubToken"]["set"] is True
    assert got["secrets"]["linearApiKey"]["set"] is True
    # Empty string clears.
    await client.put(
        "/api/v1/settings/org/secrets",
        headers=auth(token),
        json={"values": {"linearApiKey": ""}},
    )
    got = (await client.get("/api/v1/settings/org/secrets", headers=auth(token))).json()
    assert got["secrets"]["linearApiKey"]["set"] is False


async def test_unknown_secret_key_rejected(client):
    org = uuid.uuid4()
    _u, token = await make_user(email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN)
    resp = await client.put(
        "/api/v1/settings/org/secrets",
        headers=auth(token),
        json={"values": {"totallyUnknownKey": "x"}},
    )
    assert resp.status_code == 422


async def test_slack_webhook_rejects_non_slack_targets(client):
    org = uuid.uuid4()
    _u, token = await make_user(
        email="slack@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN
    )
    rejected = await client.put(
        "/api/v1/settings/org/secrets",
        headers=auth(token),
        json={"values": {"slackWebhookUrl": "https://attacker.example/hook"}},
    )
    accepted = await client.put(
        "/api/v1/settings/org/secrets",
        headers=auth(token),
        json={
            "values": {
                "slackWebhookUrl": (
                    "https://hooks.slack.com/services/T00000000/"
                    "B00000000/abcdefABCDEF1234567890"
                )
            }
        },
    )
    assert rejected.status_code == 422
    assert accepted.status_code == 200
    assert accepted.json()["secrets"]["slackWebhookUrl"]["set"] is True


async def test_browser_secret_crud_rejects_operator_only_codex_bundle(client):
    org = uuid.uuid4()
    _u, token = await make_user(
        email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN
    )
    raw_bundle = '{"accessToken":"unvalidated","expiresAt":1,"obtainedAt":1}'

    write = await client.put(
        "/api/v1/settings/org/secrets",
        headers=auth(token),
        json={"values": {"codexTokenBundle": raw_bundle}},
    )
    select = await client.put(
        "/api/v1/settings/org/secrets/selection",
        headers=auth(token),
        json={"selection": {"codexTokenBundle": "customer"}},
    )

    assert write.status_code == 422
    assert select.status_code == 422


async def test_llm_gateway_key_is_managed_only(client, monkeypatch):
    # The LangSmith LLM Gateway workspace key resolves like any managed key over
    # S2S but is platform-billing material — never writable through browser CRUD.
    monkeypatch.setenv("LANGSMITH_GATEWAY_API_KEY", "lsv2_gateway_platform")
    org = uuid.uuid4()
    _u, token = await make_user(email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN)

    url, headers = _s2s(org)
    entry = (await client.get(url, headers=headers)).json()["secrets"]["langsmithGatewayApiKey"]
    assert entry == {"source": "managed", "value": "lsv2_gateway_platform", "error": None}

    write = await client.put(
        "/api/v1/settings/org/secrets",
        headers=auth(token),
        json={"values": {"langsmithGatewayApiKey": "lsv2_attacker"}},
    )
    select = await client.put(
        "/api/v1/settings/org/secrets/selection",
        headers=auth(token),
        json={"selection": {"langsmithGatewayApiKey": "customer"}},
    )
    assert write.status_code == 422
    assert select.status_code == 422


async def test_non_admin_cannot_access_org_secrets(client):
    org = uuid.uuid4()
    _member, token = await make_user(email="m@a.com", org_id=org, org_role=OrgRole.MEMBER)
    assert (await client.get("/api/v1/settings/org/secrets", headers=auth(token))).status_code == 403
    put = await client.put(
        "/api/v1/settings/org/secrets", headers=auth(token), json={"values": {"githubToken": GH}}
    )
    assert put.status_code == 403


async def test_selection_persists_in_masked_view(client):
    org = uuid.uuid4()
    _u, token = await make_user(email="admin@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN)
    await client.put(
        "/api/v1/settings/org/secrets/selection",
        headers=auth(token),
        json={"selection": {"githubToken": "customer"}},
    )
    got = (await client.get("/api/v1/settings/org/secrets", headers=auth(token))).json()
    assert got["secrets"]["githubToken"]["source"] == "customer"


@pytest.mark.parametrize(
    "key",
    [
        "linearApiKey",
        "gitlabToken",
        "jiraApiToken",
        "asanaAccessToken",
        "omlxApiKey",
        "slackWebhookUrl",
    ],
)
async def test_customer_only_keys_reject_managed_and_fail_closed_when_missing(
    client, key
):
    org = uuid.uuid4()
    _u, token = await make_user(
        email=f"{uuid.uuid4()}@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN
    )
    masked = await client.get(
        "/api/v1/settings/org/secrets", headers=auth(token)
    )
    assert masked.json()["secrets"][key] == {
        "set": False,
        "source": "customer",
        "allowed_sources": ["customer"],
    }
    rejected = await client.put(
        "/api/v1/settings/org/secrets/selection",
        headers=auth(token),
        json={"selection": {key: "managed"}},
    )
    assert rejected.status_code == 422

    url, headers = _s2s(org)
    resolved = await client.get(url, headers=headers)
    assert resolved.json()["secrets"][key] == {
        "source": "customer",
        "value": None,
        "error": "missing",
    }


async def test_value_and_source_can_be_saved_atomically(client):
    org = uuid.uuid4()
    _u, token = await make_user(
        email="atomic@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN
    )
    response = await client.put(
        "/api/v1/settings/org/secrets",
        headers=auth(token),
        json={
            "values": {"githubToken": GH},
            "selection": {"githubToken": "customer"},
        },
    )
    assert response.status_code == 200
    assert response.json()["secrets"]["githubToken"] == {
        "set": True,
        "source": "customer",
        "allowed_sources": ["managed", "customer"],
    }
    url, headers = _s2s(org)
    resolved = await client.get(url, headers=headers)
    assert resolved.json()["secrets"]["githubToken"]["value"] == GH


async def test_concurrent_vault_merges_do_not_lose_unrelated_keys(client):
    org = uuid.uuid4()
    _u, token = await make_user(
        email="concurrent@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN
    )
    first, second = await asyncio.gather(
        client.put(
            "/api/v1/settings/org/secrets",
            headers=auth(token),
            json={"values": {"linearApiKey": "lin_atomic"}},
        ),
        client.put(
            "/api/v1/settings/org/secrets",
            headers=auth(token),
            json={"values": {"jiraApiToken": "jira_atomic"}},
        ),
    )
    assert first.status_code == second.status_code == 200
    final = await client.get(
        "/api/v1/settings/org/secrets", headers=auth(token)
    )
    assert final.json()["secrets"]["linearApiKey"]["set"] is True
    assert final.json()["secrets"]["jiraApiToken"]["set"] is True


async def test_project_linear_secret_overrides_org_and_clear_restores_fallback(client):
    org = uuid.uuid4()
    project = uuid.uuid4()
    _u, token = await make_user(
        email="project-vault@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN
    )
    await client.put(
        "/api/v1/settings/org/secrets",
        headers=auth(token),
        json={"values": {"linearApiKey": "lin_org"}},
    )
    url = f"/api/v1/internal/s2s/orgs/{org}/secrets?project_id={project}"
    headers = {"X-Org-Internal-Token": derive_org_internal_token(org)}
    inherited = await client.get(url, headers=headers)
    assert inherited.status_code == 200
    assert inherited.json()["project_id"] == str(project)
    assert inherited.json()["secrets"]["linearApiKey"]["value"] == "lin_org"

    project_url = f"/api/v1/settings/project/{project}/secrets"
    saved = await client.put(
        project_url,
        headers=auth(token),
        # Mirrors the UI's atomic project write, which records customer source
        # alongside the project value.
        json={
            "values": {"linearApiKey": "lin_project"},
            "selection": {"linearApiKey": "customer"},
        },
    )
    assert saved.status_code == 200
    assert saved.json()["scope_id"] == str(project)
    overridden = await client.get(url, headers=headers)
    assert overridden.json()["secrets"]["linearApiKey"]["value"] == "lin_project"

    cleared = await client.put(
        project_url,
        headers=auth(token),
        json={"values": {"linearApiKey": ""}},
    )
    assert cleared.status_code == 200
    restored = await client.get(url, headers=headers)
    assert restored.json()["secrets"]["linearApiKey"]["value"] == "lin_org"
