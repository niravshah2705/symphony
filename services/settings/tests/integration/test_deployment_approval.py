"""Trusted, run-bound deployment approval integration tests."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.models.enums import OrgRole
from app.services import deployment_approval_service
from tests.helpers import auth, make_user

pytestmark = pytest.mark.asyncio
INTERNAL_TOKEN = "test-internal-token-0123456789"
COMMIT_SHA = "a" * 40
TREE_SHA = "b" * 40
PREFLIGHT_DIGEST = "c" * 64


def approval_body(project_id: uuid.UUID, run_id: str) -> dict:
    return {
        "projectId": str(project_id),
        "repository": "acme/fleet",
        "environment": "production",
        "testCommandId": f"{run_id}:test:1",
        "commitSha": COMMIT_SHA,
        "treeSha": TREE_SHA,
        "preflightDecisionDigest": PREFLIGHT_DIGEST,
        "expiresInMinutes": 60,
    }


async def test_org_admin_approval_is_post_test_and_atomically_replayable(
    client, monkeypatch
):
    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    _admin, token = await make_user(
        email="release@example.com", org_id=org_id, org_role=OrgRole.ORG_ADMIN
    )
    run_id = "run-deploy-1"
    approved = await client.put(
        f"/api/v1/operator/deployment-approvals/{run_id}",
        headers=auth(token),
        json=approval_body(project_id, run_id),
    )
    assert approved.status_code == 200
    record = approved.json()
    assert record["approved"] is True
    assert record["approvedBy"] == "release@example.com"
    approved_at = datetime.fromisoformat(record["approvedAt"])

    consume_body = {
        "projectId": str(project_id),
        "repository": "acme/fleet",
        "environment": "production",
        "testCompletedAt": (approved_at - timedelta(seconds=1)).isoformat(),
        "testCommandId": f"{run_id}:test:1",
        "commitSha": COMMIT_SHA,
        "treeSha": TREE_SHA,
        "preflightDecisionDigest": PREFLIGHT_DIGEST,
    }
    path = f"/api/v1/internal/s2s/orgs/{org_id}/deployment-approvals/{run_id}/consume"
    first = await client.post(
        path,
        headers={"X-Internal-Token": INTERNAL_TOKEN},
        json=consume_body,
    )
    assert first.status_code == 200
    assert first.json()["consumedAt"] is not None

    expired_now = datetime.fromisoformat(record["expiresAt"]) + timedelta(seconds=1)
    monkeypatch.setattr(deployment_approval_service, "utcnow", lambda: expired_now)
    replay = await client.post(
        path,
        headers={"X-Internal-Token": INTERNAL_TOKEN},
        json=consume_body,
    )
    assert replay.status_code == 200
    assert replay.json()["consumedAt"] == first.json()["consumedAt"]

    mismatched_replay = await client.post(
        path,
        headers={"X-Internal-Token": INTERNAL_TOKEN},
        json={
            **consume_body,
            "testCompletedAt": (approved_at - timedelta(seconds=2)).isoformat(),
        },
    )
    assert mismatched_replay.status_code == 404
    assert mismatched_replay.json()["error"]["code"] == "deployment_not_approved"


async def test_approval_scope_and_timing_fail_closed(client):
    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    _admin, token = await make_user(
        email="release@example.com", org_id=org_id, org_role=OrgRole.ORG_ADMIN
    )
    run_id = "run-deploy-2"
    approved = await client.put(
        f"/api/v1/operator/deployment-approvals/{run_id}",
        headers=auth(token),
        json=approval_body(project_id, run_id),
    )
    approved_at = datetime.fromisoformat(approved.json()["approvedAt"])
    path = f"/api/v1/internal/s2s/orgs/{org_id}/deployment-approvals/{run_id}/consume"

    too_early = await client.post(
        path,
        headers={"X-Internal-Token": INTERNAL_TOKEN},
        json={
            "projectId": str(project_id),
            "repository": "acme/fleet",
            "environment": "production",
            "testCompletedAt": (approved_at + timedelta(seconds=1)).isoformat(),
            "testCommandId": f"{run_id}:test:1",
            "commitSha": COMMIT_SHA,
            "treeSha": TREE_SHA,
            "preflightDecisionDigest": PREFLIGHT_DIGEST,
        },
    )
    assert too_early.status_code == 409
    assert too_early.json()["error"]["code"] == "deployment_not_approved"

    wrong_repo = await client.post(
        path,
        headers={"X-Internal-Token": INTERNAL_TOKEN},
        json={
            "projectId": str(project_id),
            "repository": "attacker/repo",
            "environment": "production",
            "testCompletedAt": datetime.now(timezone.utc).isoformat(),
            "testCommandId": f"{run_id}:test:1",
            "commitSha": COMMIT_SHA,
            "treeSha": TREE_SHA,
            "preflightDecisionDigest": PREFLIGHT_DIGEST,
        },
    )
    assert wrong_repo.status_code == 404
    assert wrong_repo.json()["error"]["code"] == "deployment_not_approved"

    no_token = await client.post(path, json={
        "projectId": str(project_id),
        "repository": "acme/fleet",
        "environment": "production",
        "testCompletedAt": approved_at.isoformat(),
        "testCommandId": f"{run_id}:test:1",
        "commitSha": COMMIT_SHA,
        "treeSha": TREE_SHA,
        "preflightDecisionDigest": PREFLIGHT_DIGEST,
    })
    assert no_token.status_code == 403

    wrong_lineage = await client.post(
        path,
        headers={"X-Internal-Token": INTERNAL_TOKEN},
        json={
            "projectId": str(project_id),
            "repository": "acme/fleet",
            "environment": "production",
            "testCompletedAt": approved_at.isoformat(),
            "testCommandId": f"{run_id}:test:1",
            "commitSha": "d" * 40,
            "treeSha": TREE_SHA,
            "preflightDecisionDigest": PREFLIGHT_DIGEST,
        },
    )
    assert wrong_lineage.status_code == 404
    assert wrong_lineage.json()["error"]["code"] == "deployment_not_approved"


async def test_non_admin_cannot_issue_approval(client):
    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    _member, token = await make_user(email="member@example.com", org_id=org_id)
    response = await client.put(
        "/api/v1/operator/deployment-approvals/run-deploy-3",
        headers=auth(token),
        json=approval_body(project_id, "run-deploy-3"),
    )
    assert response.status_code == 403
