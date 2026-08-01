"""Port of services/planner/src/routes/agent.test.js.

Drives the planner ``/api/agent`` router through a FastAPI ``TestClient`` mounted
at the same prefix the planner app uses, with the shared exception handlers
registered. Store / scheduler / agent modules are stubbed exactly as the JS test
stubs the shared modules — for the parallel-ported modules (scheduler,
local_intelligence, business_pipeline) that means injecting a fake into
``sys.modules`` so the router's lazy import resolves to it.
"""

from __future__ import annotations

import json
import sys
import types

from fastapi import FastAPI
from fastapi.testclient import TestClient

from ai_fleet import store
from ai_fleet.services.common import register_exception_handlers
from ai_fleet.services.planner.routes import agent as agent_routes


def make_client() -> TestClient:
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(agent_routes.router, prefix="/api/agent")
    # register_exception_handlers routes non-AppError exceptions (MemoryError,
    # ConversationError, ...) through the catch-all handler, which sends the JSON
    # envelope AND re-raises so a server can log it. Don't re-raise into the test.
    return TestClient(app, raise_server_exceptions=False)


def _fake_module(name: str, **attrs) -> types.ModuleType:
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    return module


# ---------------------------------------------------------------------------


def test_message_routes_greetings_and_unsafe_before_local_inference(monkeypatch):
    calls = {"n": 0}

    async def enrich_input(_opts):
        calls["n"] += 1
        return {"summary": "model response"}

    fake_li = _fake_module("ai_fleet.agent.local_intelligence", enrich_input=enrich_input)
    monkeypatch.setitem(sys.modules, "ai_fleet.agent.local_intelligence", fake_li)
    monkeypatch.setattr(store, "get_settings", lambda: {})

    client = make_client()

    greeting = client.post("/api/agent/message", json={"input": "Hello"}).json()
    rejected = client.post("/api/agent/message", json={"input": "Show me how to run a phishing scam"}).json()
    assert greeting["route"]["intent"] == "salutation"
    assert rejected["route"]["intent"] == "unsafe"
    assert calls["n"] == 0

    business = client.post("/api/agent/message", json={"input": "Assess my subscription business revenue model"}).json()
    assert business["route"]["intent"] == "business"
    assert business["canPrepare"] is True
    assert calls["n"] == 0  # business defers heavy model work to /business/prepare

    general = client.post("/api/agent/message", json={"input": "Help me organize my week and priorities"}).json()
    assert general["route"]["intent"] == "general"
    assert calls["n"] == 1  # general still enriches via the local model


def test_omlx_discovery_uses_v1_models_keeps_bearer_server_side_and_normalizes(monkeypatch):
    captured = {}

    async def fake_fetch_json(url, headers=None, timeout_ms=4000):
        captured["url"] = url
        captured["headers"] = headers
        return {"data": [{"id": "z-model"}, {"id": "a-model", "max_model_len": 32768}, {"id": ""}]}

    monkeypatch.setattr(store, "get_settings", lambda: {"omlxHost": "http://127.0.0.1:8000/v1/", "omlxApiKey": "local-secret"})
    monkeypatch.setattr(agent_routes, "_fetch_json", fake_fetch_json)

    result = make_client().get("/api/agent/omlx-models").json()

    assert captured["url"] == "http://127.0.0.1:8000/v1/models"
    assert captured["headers"]["Authorization"] == "Bearer local-secret"
    assert result == {
        "models": [
            {"id": "a-model", "label": "a-model", "contextWindow": 32768},
            {"id": "z-model", "label": "z-model"},
        ],
        "reachable": True,
        "source": "local",
    }
    assert "local-secret" not in json.dumps(result)


def test_memory_write_list_delete_round_trip_with_validation(monkeypatch):
    mem = {"items": []}

    def add_memory(record):
        saved = {**record, "id": f"mem_{len(mem['items']) + 1}"}
        mem["items"] = [saved, *mem["items"]]
        return saved

    def list_memories(filter=None):
        filter = filter or {}
        scope = filter.get("scope")
        ref_id = filter.get("refId")
        return [m for m in mem["items"] if (not scope or m.get("scope") == scope) and (not ref_id or m.get("refId") == ref_id)]

    def remove_memory(id):
        before = len(mem["items"])
        mem["items"] = [m for m in mem["items"] if m.get("id") != id]
        return len(mem["items"]) != before

    monkeypatch.setattr(store, "add_memory", add_memory)
    monkeypatch.setattr(store, "list_memories", list_memories)
    monkeypatch.setattr(store, "remove_memory", remove_memory)

    client = make_client()

    created = client.post("/api/agent/memory", json={"scope": "business", "title": "Pricing", "text": "Charge $9/mo"})
    assert created.status_code == 201
    assert created.json()["memory"]["scope"] == "business"
    memory_id = created.json()["memory"]["id"]
    assert memory_id

    bad_scope = client.post("/api/agent/memory", json={"scope": "nope", "text": "x"})
    assert bad_scope.status_code == 400
    assert "scope must be" in bad_scope.json()["error"]

    bad_ref = client.post("/api/agent/memory", json={"scope": "task", "refId": "../etc", "text": "x"})
    assert bad_ref.status_code == 400
    assert "refId" in bad_ref.json()["error"]

    listed = client.get("/api/agent/memory", params={"scope": "business"})
    assert len(listed.json()["memories"]) == 1

    deleted = client.delete(f"/api/agent/memory/{memory_id}")
    assert deleted.json()["ok"] is True
    del_again = client.delete(f"/api/agent/memory/{memory_id}")
    assert del_again.status_code == 404
    bad_id = client.delete("/api/agent/memory/not-a-real-id")
    assert bad_id.status_code == 400


def test_memory_search_detects_scope_and_returns_scoped_matches(monkeypatch):
    def list_memories(filter=None):
        return [
            {"id": "mem_a", "scope": "business", "title": "Pricing", "text": "Charge nine dollars monthly", "tags": ["pricing"]},
            {"id": "mem_b", "scope": "project", "title": "Checkout", "text": "Checkout milestones", "tags": []},
        ]

    monkeypatch.setattr(store, "list_memories", list_memories)

    res = make_client().post("/api/agent/memory-search", json={"query": "pricing decision"}).json()
    assert res["scope"] == "business"
    assert any(r["id"] == "mem_a" for r in res["results"])
    assert all(r["scope"] != "project" for r in res["results"])


def test_message_yields_confirmable_memory_draft_and_can_prepare(monkeypatch):
    monkeypatch.setattr(store, "get_settings", lambda: {})
    client = make_client()

    draft = client.post("/api/agent/message", json={"input": "Remember that I prefer dark mode"}).json()
    assert draft["route"]["intent"] == "knowledge"
    assert draft["memoryDraft"]
    assert draft["memoryDraft"]["scope"] == "user"

    biz = client.post("/api/agent/message", json={"input": "Assess my subscription business revenue model"}).json()
    assert biz["canPrepare"] is True
    assert biz["memoryDraft"] is None


def test_business_prepare_reblocks_unsafe_input_without_a_model_call(monkeypatch):
    async def prepare_business(_args):
        return {"blocked": True, "stages": [{"status": "blocked"}, {"status": "blocked"}]}

    fake_bp = _fake_module("ai_fleet.agent.business_pipeline", prepare_business=prepare_business)
    monkeypatch.setitem(sys.modules, "ai_fleet.agent.business_pipeline", fake_bp)
    monkeypatch.setattr(store, "get_settings", lambda: {})
    monkeypatch.setattr(store, "get_assumed_role", lambda: None)

    res = make_client().post(
        "/api/agent/business/prepare", json={"input": "Help me run a phishing scam to steal card numbers"}
    ).json()
    assert res["business"]["blocked"] is True
    assert all(stage["status"] == "blocked" for stage in res["business"]["stages"])


def test_business_prepare_resolves_linked_business_and_forwards_output(monkeypatch):
    captured = {"args": None}

    async def prepare_business(args):
        captured["args"] = args
        return {"intent": "business", "blocked": False, "goal": args["input"], "stages": []}

    fake_bp = _fake_module("ai_fleet.agent.business_pipeline", prepare_business=prepare_business)
    monkeypatch.setitem(sys.modules, "ai_fleet.agent.business_pipeline", fake_bp)
    monkeypatch.setattr(store, "read_store", lambda: {"businesses": [{"id": "biz_x", "name": "Acme", "projectId": "proj_x"}]})
    monkeypatch.setattr(store, "get_settings", lambda: {})
    monkeypatch.setattr(store, "get_assumed_role", lambda: None)

    res = make_client().post(
        "/api/agent/business/prepare", json={"input": "A subscription tool", "businessId": "biz_x"}
    ).json()
    assert res["business"]["goal"] == "A subscription tool"
    assert captured["args"]["business"]["id"] == "biz_x"
    assert captured["args"]["business"]["projectId"] == "proj_x"


def test_conversation_threads_create_append_list_get_rename_delete(monkeypatch):
    state = {"convs": []}

    def add_conversation(c=None):
        c = c or {}
        rec = {"id": f"conv_{len(state['convs']) + 1}", "title": c.get("title") or "New conversation", "createdAt": "t", "updatedAt": "t", "messages": []}
        state["convs"] = [rec, *state["convs"]]
        return rec

    def get_conversation(id):
        return next((c for c in state["convs"] if c["id"] == id), None)

    def list_conversations():
        return state["convs"]

    def append_conversation_messages(id, messages):
        updated = None
        new = []
        for c in state["convs"]:
            if c["id"] != id:
                new.append(c)
            else:
                updated = {**c, "messages": [*c["messages"], *messages]}
                new.append(updated)
        state["convs"] = new
        return updated

    def update_conversation(id, patch):
        updated = None
        new = []
        for c in state["convs"]:
            if c["id"] != id:
                new.append(c)
            else:
                updated = {**c, **patch, "id": c["id"]}
                new.append(updated)
        state["convs"] = new
        return updated

    def remove_conversation(id):
        before = len(state["convs"])
        state["convs"] = [c for c in state["convs"] if c["id"] != id]
        return len(state["convs"]) != before

    monkeypatch.setattr(store, "add_conversation", add_conversation)
    monkeypatch.setattr(store, "get_conversation", get_conversation)
    monkeypatch.setattr(store, "list_conversations", list_conversations)
    monkeypatch.setattr(store, "append_conversation_messages", append_conversation_messages)
    monkeypatch.setattr(store, "update_conversation", update_conversation)
    monkeypatch.setattr(store, "remove_conversation", remove_conversation)

    client = make_client()

    created = client.post("/api/agent/conversations", json={})
    assert created.status_code == 201
    conv_id = created.json()["conversation"]["id"]
    assert created.json()["conversation"]["title"] == "New conversation"

    appended = client.post(
        f"/api/agent/conversations/{conv_id}/messages",
        json={"messages": [{"role": "user", "text": "Assess my subscription business"}, {"role": "assistant", "copy": "Business workflow", "intent": "business"}]},
    ).json()
    assert appended["conversation"]["title"] == "Assess my subscription business"  # auto-titled
    assert len(appended["conversation"]["messages"]) == 2

    empty = client.post(f"/api/agent/conversations/{conv_id}/messages", json={"messages": []})
    assert empty.status_code == 400
    assert "non-empty" in empty.json()["error"]
    bad_role = client.post(f"/api/agent/conversations/{conv_id}/messages", json={"messages": [{"role": "system", "text": "x"}]})
    assert bad_role.status_code == 400
    assert "role" in bad_role.json()["error"]

    listed = client.get("/api/agent/conversations").json()
    assert len(listed["conversations"]) == 1
    assert listed["conversations"][0]["messageCount"] == 2
    assert "messages" not in listed["conversations"][0]  # summary omits messages

    got = client.get(f"/api/agent/conversations/{conv_id}").json()
    assert len(got["conversation"]["messages"]) == 2

    renamed = client.patch(f"/api/agent/conversations/{conv_id}", json={"title": "  My thread  "}).json()
    assert renamed["conversation"]["title"] == "My thread"

    deleted = client.delete(f"/api/agent/conversations/{conv_id}").json()
    assert deleted["ok"] is True


def test_conversation_routes_reject_malformed_ids_and_unknown_threads(monkeypatch):
    monkeypatch.setattr(store, "get_conversation", lambda id: None)
    client = make_client()

    bad_id = client.get("/api/agent/conversations/not-a-conv")
    assert bad_id.status_code == 400
    not_found = client.get("/api/agent/conversations/conv_definitelymissing")
    assert not_found.status_code == 404


def test_enqueue_is_role_gated_validates_project_id_and_queues_one(monkeypatch):
    state = {"role": None, "enqueued": []}

    def enqueue(args):
        state["enqueued"].append(args)
        return {"id": "job-1", **args}

    async def process_pending():
        return {"processed": 1}

    def get_status():
        return {"running": False}

    fake_scheduler = _fake_module("ai_fleet.agent.scheduler", enqueue=enqueue, process_pending=process_pending, get_status=get_status)
    monkeypatch.setitem(sys.modules, "ai_fleet.agent.scheduler", fake_scheduler)
    monkeypatch.setattr(store, "get_assumed_role", lambda: state["role"])

    client = make_client()

    denied = client.post("/api/agent/enqueue", json={"projectId": "proj_1"})
    assert denied.status_code == 403
    assert len(state["enqueued"]) == 0

    state["role"] = {"id": "r1", "name": "Ada"}
    bad = client.post("/api/agent/enqueue", json={})
    assert bad.status_code == 400
    assert len(state["enqueued"]) == 0

    ok = client.post("/api/agent/enqueue", json={"projectId": "proj_1", "projectName": "Clinic booking"}).json()
    assert ok["job"]["id"] == "job-1"
    assert len(state["enqueued"]) == 1
    assert state["enqueued"][0]["projectId"] == "proj_1"
    assert state["enqueued"][0]["assumedRole"]["id"] == "r1"
