"""Smoke tests for ai_fleet.services.coder.routes.coder.

There is no coder route test in the JS repo; these are minimal FastAPI TestClient
checks. ``coder_orchestrator`` is lazy-imported inside the handlers, so we stub it
in ``sys.modules`` and assert the router surfaces it (GET status, POST /monitor).
The heavy ``coder``/``llm`` deps are never imported by these paths.
"""

import sys
import types

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch):
    fake = types.ModuleType("ai_fleet.agent.coder_orchestrator")
    fake.status = lambda: {"running": True, "paused": False, "inFlight": []}
    fake.start = lambda: {"running": True, "action": "start"}
    fake.resume = lambda: {"running": True, "action": "resume"}
    fake.stop = lambda: {"running": False, "action": "stop"}
    monkeypatch.setitem(sys.modules, "ai_fleet.agent.coder_orchestrator", fake)

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
