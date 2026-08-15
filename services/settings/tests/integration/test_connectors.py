"""Organization connector metadata, readiness, and S2S egress config."""
from __future__ import annotations

import uuid

import pytest

from app.api.v1.routes_internal import derive_org_internal_token
from app.models.enums import OrgRole
from tests.helpers import auth, make_user

pytestmark = pytest.mark.asyncio


async def test_org_admin_round_trips_connector_config_with_merge_semantics(client):
    org = uuid.uuid4()
    _admin, token = await make_user(
        email="connectors@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN
    )
    saved = await client.put(
        "/api/v1/settings/org/connectors",
        headers=auth(token),
        json={
            "jira_origin": "https://ACME.atlassian.net/",
            "jira_email": "jira@example.com",
        },
    )
    assert saved.status_code == 200
    assert saved.json() == {
        "jira_origin": "https://acme.atlassian.net",
        "jira_email": "jira@example.com",
        "asana_workspace_id": "",
    }

    merged = await client.put(
        "/api/v1/settings/org/connectors",
        headers=auth(token),
        json={"asana_workspace_id": "1234567890"},
    )
    assert merged.status_code == 200
    assert merged.json() == {
        "jira_origin": "https://acme.atlassian.net",
        "jira_email": "jira@example.com",
        "asana_workspace_id": "1234567890",
    }


@pytest.mark.parametrize(
    "origin",
    [
        "http://acme.atlassian.net",
        "https://attacker.example",
        "https://evil.foo.atlassian.net",
        "https://tenant.atlassian.net.",
        "https://-tenant.atlassian.net",
        "https://tenant-.atlassian.net",
        "https://tenant.atlassian.net:443",
        "https://acme.atlassian.net/rest/api/3",
        "https://acme.atlassian.net?redirect=example.com",
        "https://acme.atlassian.net#fragment",
        "https://user@acme.atlassian.net",
    ],
)
async def test_jira_origin_accepts_only_a_jira_cloud_origin(client, origin):
    org = uuid.uuid4()
    _admin, token = await make_user(
        email=f"jira-{uuid.uuid4()}@a.com",
        org_id=org,
        org_role=OrgRole.ORG_ADMIN,
    )
    response = await client.put(
        "/api/v1/settings/org/connectors",
        headers=auth(token),
        json={"jira_origin": origin},
    )
    assert response.status_code == 422


async def test_jira_origin_accepts_hyphenated_single_tenant_and_normalizes_case(client):
    org = uuid.uuid4()
    _admin, token = await make_user(
        email="jira-valid@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN
    )
    response = await client.put(
        "/api/v1/settings/org/connectors",
        headers=auth(token),
        json={"jira_origin": "https://My-Tenant.ATLASSIAN.NET/"},
    )
    assert response.status_code == 200
    assert response.json()["jira_origin"] == "https://my-tenant.atlassian.net"


async def test_connector_config_requires_org_admin(client):
    org = uuid.uuid4()
    _member, token = await make_user(email="member@a.com", org_id=org)
    response = await client.get(
        "/api/v1/settings/org/connectors", headers=auth(token)
    )
    assert response.status_code == 403


async def test_internal_egress_config_is_org_token_bound(client):
    org_a = uuid.uuid4()
    org_b = uuid.uuid4()
    _admin, token = await make_user(
        email="egress@a.com", org_id=org_a, org_role=OrgRole.ORG_ADMIN
    )
    await client.put(
        "/api/v1/settings/org/connectors",
        headers=auth(token),
        json={
            "jira_origin": "https://tenant.atlassian.net",
            "jira_email": "egress@example.com",
            "asana_workspace_id": "987654321",
        },
    )

    url = f"/api/v1/internal/s2s/orgs/{org_a}/egress-config"
    denied = await client.get(
        url, headers={"X-Org-Internal-Token": derive_org_internal_token(org_b)}
    )
    assert denied.status_code == 403
    allowed = await client.get(
        url, headers={"X-Org-Internal-Token": derive_org_internal_token(org_a)}
    )
    assert allowed.status_code == 200
    assert allowed.json() == {
        "jira_origin": "https://tenant.atlassian.net",
        "jira_email": "egress@example.com",
        "asana_workspace_id": "987654321",
    }


async def test_readiness_is_secret_free_and_marks_unimplemented_trackers_unsupported(client):
    org = uuid.uuid4()
    _admin, token = await make_user(
        email="ready@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN
    )
    await client.put(
        "/api/v1/settings/org/connectors",
        headers=auth(token),
        json={
            "jira_origin": "https://ready.atlassian.net",
            "jira_email": "ready@example.com",
            "asana_workspace_id": "12345",
        },
    )
    await client.put(
        "/api/v1/settings/org/secrets",
        headers=auth(token),
        json={
            "values": {
                "linearApiKey": "lin_customer_secret",
                "jiraApiToken": "jira_customer_secret",
                "asanaAccessToken": "asana_customer_secret",
            }
        },
    )

    response = await client.get(
        "/api/v1/settings/org/connectors/readiness", headers=auth(token)
    )
    assert response.status_code == 200
    assert response.json() == {
        "connectors": {
            "linear": {
                "configured": True,
                "routable": True,
                "supported": True,
                "verified": False,
            },
            "jira": {
                "configured": True,
                "routable": False,
                "supported": False,
                "verified": False,
            },
            "asana": {
                "configured": True,
                "routable": False,
                "supported": False,
                "verified": False,
            },
        }
    }
    assert "customer_secret" not in response.text


async def test_readiness_uses_project_secret_override(client):
    org = uuid.uuid4()
    project = uuid.uuid4()
    _admin, token = await make_user(
        email="project-ready@a.com", org_id=org, org_role=OrgRole.ORG_ADMIN
    )
    await client.put(
        f"/api/v1/settings/project/{project}/secrets",
        headers=auth(token),
        json={"values": {"linearApiKey": "lin_project_only"}},
    )

    org_only = await client.get(
        "/api/v1/settings/org/connectors/readiness", headers=auth(token)
    )
    scoped = await client.get(
        f"/api/v1/settings/org/connectors/readiness?project_id={project}",
        headers=auth(token),
    )
    assert org_only.json()["connectors"]["linear"]["configured"] is False
    assert scoped.json()["connectors"]["linear"]["configured"] is True
