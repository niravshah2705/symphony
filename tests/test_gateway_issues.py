"""Tests for the gateway issues router (port of services/gateway/src/routes/issues.test.js).

Covers project-task validation bounds and the confirmed-creation path that derives
the team once and replays a duplicate idempotency key rather than re-creating.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ai_fleet.services.common import register_exception_handlers
from ai_fleet.services.gateway.routes import issues


def _make_client():
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(issues.router, prefix="/api/issues")
    # raise_server_exceptions=False so the shared catch-all handler renders
    # status-bearing errors (ProjectTaskError) as it does in production, instead
    # of the test transport re-raising them.
    return TestClient(app, raise_server_exceptions=False)


def test_project_task_validation_bounds_tracker_inputs():
    assert issues.normalize_project_task(
        {
            "projectId": "project-1",
            "title": "Update checkout validation",
            "description": "Keep the existing payment flow.",
            "priority": 2,
            "idempotencyKey": "agent:request-1",
        }
    ) == {
        "projectId": "project-1",
        "title": "Update checkout validation",
        "description": "Keep the existing payment flow.",
        "priority": 2,
        "idempotencyKey": "agent:request-1",
    }

    with pytest.raises(issues.ProjectTaskError, match="idempotencyKey is required"):
        issues.normalize_project_task({})
    with pytest.raises(issues.ProjectTaskError, match="only letters"):
        issues.normalize_project_task({"idempotencyKey": "bad key"})
    with pytest.raises(issues.ProjectTaskError, match="0 to 4"):
        issues.normalize_project_task(
            {"idempotencyKey": "valid-key", "projectId": "p", "title": "t", "priority": 8}
        )


def test_confirmed_task_creation_derives_team_and_replays_duplicates_once(monkeypatch):
    issues.task_requests.clear()
    creates = {"n": 0}

    async def fake_get_project_team(_key, project_id):
        return {"project": {"id": project_id}, "team": {"id": "team-1"}}

    async def fake_create_issue(_key, *, team_id, project_id, title, description, priority):
        creates["n"] += 1
        return {
            "id": "issue-1",
            "identifier": "ENG-1",
            "title": title,
            "url": "https://linear.app/issue/ENG-1",
        }

    monkeypatch.setattr(issues.store, "get_api_key", lambda: "key")
    monkeypatch.setattr(issues.linear, "get_project_team", fake_get_project_team)
    monkeypatch.setattr(issues.linear, "create_issue", fake_create_issue)

    body = {
        "projectId": "project-1",
        "title": "Change checkout",
        "description": "Confirmed.",
        "priority": 2,
        "idempotencyKey": "agent:duplicate-1",
    }

    with _make_client() as client:
        first = client.post("/api/issues", json=body)
        second = client.post("/api/issues", json=body)

    assert first.status_code == 201
    assert second.status_code == 200
    assert second.json()["replayed"] is True
    assert creates["n"] == 1


def test_idempotency_key_reuse_with_different_content_conflicts(monkeypatch):
    issues.task_requests.clear()

    async def fake_get_project_team(_key, project_id):
        return {"project": {"id": project_id}, "team": {"id": "team-1"}}

    async def fake_create_issue(_key, *, team_id, project_id, title, description, priority):
        return {"id": "issue-1", "title": title}

    monkeypatch.setattr(issues.store, "get_api_key", lambda: "key")
    monkeypatch.setattr(issues.linear, "get_project_team", fake_get_project_team)
    monkeypatch.setattr(issues.linear, "create_issue", fake_create_issue)

    with _make_client() as client:
        first = client.post(
            "/api/issues",
            json={"projectId": "p1", "title": "A", "priority": 2, "idempotencyKey": "agent:key-1"},
        )
        second = client.post(
            "/api/issues",
            json={"projectId": "p1", "title": "B", "priority": 2, "idempotencyKey": "agent:key-1"},
        )

    assert first.status_code == 201
    assert second.status_code == 409
    assert "different task content" in second.json()["error"]


def test_board_groups_issues_into_ordered_columns(monkeypatch):
    async def fake_get_project_issues(_key, project_id):
        return {
            "id": project_id,
            "name": "Checkout",
            "issues": {
                "nodes": [
                    {"id": "i1", "state": {"id": "s-done", "type": "completed", "position": 1}},
                    {"id": "i2", "state": {"id": "s-todo", "type": "unstarted", "position": 0}},
                    {"id": "i3", "state": {"id": "s-todo", "type": "unstarted", "position": 0}},
                    {"id": "i4", "state": None},
                ]
            },
        }

    monkeypatch.setattr(issues.store, "get_api_key", lambda: "key")
    monkeypatch.setattr(issues.linear, "get_project_issues", fake_get_project_issues)

    with _make_client() as client:
        res = client.get("/api/issues/board/project-1")

    assert res.status_code == 200
    payload = res.json()
    assert payload["project"] == {"id": "project-1", "name": "Checkout"}
    columns = payload["columns"]
    # unstarted ranks before completed; the stateless issue is dropped.
    assert [c["id"] for c in columns] == ["s-todo", "s-done"]
    assert len(columns[0]["issues"]) == 2
    assert len(columns[1]["issues"]) == 1
