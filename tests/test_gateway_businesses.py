"""Tests for the gateway businesses router (port of businesses.test.js).

Ports the pure repository-normalization helper tests verbatim, then adds
TestClient coverage of the create/list/update/delete HTTP handlers with the
shared store/linear modules stubbed in memory.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ai_fleet.services.common import register_exception_handlers
from ai_fleet.services.gateway.routes import businesses


# --------------------------- Pure helper tests -------------------------- #


def test_business_repository_normalization_preserves_provider_specific_namespaces():
    assert businesses.normalize_repo("acme/widgets", "github") == "acme/widgets"
    assert (
        businesses.normalize_repo("https://gitlab.com/acme/platform/widgets.git", "gitlab")
        == "acme/platform/widgets"
    )
    assert (
        businesses.normalize_repo("git@gitlab.com:acme/platform/widgets.git", "gitlab")
        == "acme/platform/widgets"
    )


def test_business_repository_validation_rejects_provider_host_mismatches():
    assert "GitHub" in businesses.repository_fields(
        {"repoProvider": "github", "repo": "https://gitlab.com/acme/widgets.git"}
    )["error"]
    assert "GitHub" in businesses.repository_fields(
        {"repoProvider": "github", "repo": "acme/platform/widgets"}
    )["error"]
    assert "GitHub or GitLab" in businesses.repository_fields(
        {"repoProvider": "bitbucket", "repo": "acme/widgets"}
    )["error"]


def test_business_repository_updates_retain_their_stored_provider():
    assert businesses.repository_fields(
        {"repo": "acme/platform/new-widgets"},
        {"repo": "acme/platform/widgets", "repoProvider": "gitlab"},
    ) == {"repo": "acme/platform/new-widgets", "repoProvider": "gitlab"}
    assert businesses.repository_fields({"repo": "acme/widgets"}) == {
        "repo": "acme/widgets",
        "repoProvider": "github",
    }


# --------------------------- HTTP handler tests ------------------------- #


@pytest.fixture
def stubbed_store(monkeypatch):
    state = {"businesses": []}

    def fake_read_store():
        # Return a fresh shallow copy so handlers cannot mutate our backing state.
        return {"businesses": [dict(b) for b in state["businesses"]]}

    def fake_write_store(next_store):
        state["businesses"] = [dict(b) for b in next_store["businesses"]]
        return next_store

    monkeypatch.setattr(businesses.store, "read_store", fake_read_store)
    monkeypatch.setattr(businesses.store, "write_store", fake_write_store)
    monkeypatch.setattr(businesses.store, "get_api_key", lambda: "key")

    async def fake_get_projects(_key):
        return []

    monkeypatch.setattr(businesses.linear, "get_projects", fake_get_projects)
    return state


def _make_client():
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(businesses.router, prefix="/api/businesses")
    return TestClient(app, raise_server_exceptions=False)


def test_create_list_update_delete_business_roundtrip(stubbed_store):
    with _make_client() as client:
        created = client.post(
            "/api/businesses",
            json={"name": "Acme Widgets", "description": "d", "repo": "acme/widgets"},
        )
        assert created.status_code == 201
        business = created.json()["business"]
        assert business["id"] == "acme-widgets"
        assert business["repo"] == "acme/widgets"
        assert business["repoProvider"] == "github"
        assert business["project"] is None

        listed = client.get("/api/businesses")
        assert listed.status_code == 200
        assert [b["id"] for b in listed.json()["businesses"]] == ["acme-widgets"]

        updated = client.put(
            "/api/businesses/acme-widgets", json={"description": "updated"}
        )
        assert updated.status_code == 200
        assert updated.json()["business"]["description"] == "updated"

        deleted = client.delete("/api/businesses/acme-widgets")
        assert deleted.status_code == 200
        assert deleted.json() == {"ok": True}

        assert client.get("/api/businesses").json()["businesses"] == []


def test_create_business_requires_name(stubbed_store):
    with _make_client() as client:
        res = client.post("/api/businesses", json={"description": "no name"})
    assert res.status_code == 400
    assert res.json()["error"] == "Business name is required."


def test_create_duplicate_business_conflicts(stubbed_store):
    with _make_client() as client:
        first = client.post("/api/businesses", json={"name": "Acme Widgets"})
        second = client.post("/api/businesses", json={"name": "Acme Widgets"})
    assert first.status_code == 201
    assert second.status_code == 409
    assert "already exists" in second.json()["error"]


def test_update_missing_business_returns_404(stubbed_store):
    with _make_client() as client:
        res = client.put("/api/businesses/nope", json={"description": "x"})
    assert res.status_code == 404


def test_create_business_with_new_linear_project_auto_labels(monkeypatch, stubbed_store):
    async def fake_labels(_key, names):
        return [{"id": "label-ai"}]

    async def fake_create_project(_key, *, name, description, team_id, label_ids):
        assert label_ids == ["label-ai"]
        return {"id": "proj-1", "name": name}

    monkeypatch.setattr(businesses.store, "get_agent_config", lambda: {"autoLabelNewProjects": True, "enrichLabels": ["AI"]})
    monkeypatch.setattr(businesses.linear, "get_or_create_project_labels", fake_labels)
    monkeypatch.setattr(businesses.linear, "create_project", fake_create_project)

    with _make_client() as client:
        res = client.post(
            "/api/businesses",
            json={"name": "New Biz", "createNewProject": True, "teamId": "team-1"},
        )
    assert res.status_code == 201
    assert res.json()["business"]["projectId"] == "proj-1"


def test_create_business_new_project_requires_team(stubbed_store):
    with _make_client() as client:
        res = client.post(
            "/api/businesses", json={"name": "New Biz", "createNewProject": True}
        )
    assert res.status_code == 400
    assert "team is required" in res.json()["error"]
