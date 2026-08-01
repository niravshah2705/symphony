"""Smoke tests for ai_fleet.services.coder.routes.coder.

There is no coder route test in the JS repo; these are minimal FastAPI TestClient
checks. ``coder_orchestrator`` is lazy-imported inside the handlers, so we patch
the real module's functions (isolation-safe regardless of import order) and assert
the router surfaces them (GET status, POST /monitor). The heavy ``coder``/``llm``
deps are never reached by these paths.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import ai_fleet.agent.coder_orchestrator as orchestrator


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(orchestrator, "status", lambda: {"running": True, "paused": False, "inFlight": []})
    monkeypatch.setattr(orchestrator, "start", lambda: {"running": True, "action": "start"})
    monkeypatch.setattr(orchestrator, "resume", lambda: {"running": True, "action": "resume"})
    monkeypatch.setattr(orchestrator, "stop", lambda: {"running": False, "action": "stop"})

    from ai_fleet.services.coder.routes import coder as coder_routes

    app = FastAPI()
    app.include_router(coder_routes.router, prefix="/api/coder")
    return TestClient(app)


def test_get_status_returns_orchestrator_status(client):
    # Arrange / Act
    res = client.get("/api/coder")

    # Assert
    assert res.status_code == 200
    assert res.json() == {"running": True, "paused": False, "inFlight": []}


def test_get_status_trailing_slash_also_matches(client):
    res = client.get("/api/coder/")
    assert res.status_code == 200
    assert res.json()["running"] is True


def test_monitor_start_delegates_to_orchestrator(client):
    res = client.post("/api/coder/monitor", json={"action": "start"})
    assert res.status_code == 200
    assert res.json() == {"running": True, "action": "start"}


def test_monitor_invalid_action_is_400(client):
    res = client.post("/api/coder/monitor", json={"action": "bogus"})
    assert res.status_code == 400
    assert "start" in res.json()["error"]


def test_run_without_issue_id_is_400(client):
    res = client.post("/api/coder/run", json={})
    assert res.status_code == 400
    assert res.json() == {"error": "issueId is required."}
