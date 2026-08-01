"""Port of packages/shared/src/agent/approval-gate.test.js."""

from datetime import datetime, timezone

import pytest

from ai_fleet.agent import approval_gate as gate


def _iso_now():
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _parse_ms(value):
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(round(dt.timestamp() * 1000))


# In-memory store double mirroring the real store's approval-gate contract:
# generated id, stamped createdAt/updatedAt, immutable patch preserving
# id/createdAt.
def make_store():
    gates = []
    counter = {"n": 0}

    class Store:
        _gates = gates

        def add_approval_gate(self, record):
            counter["n"] += 1
            now = _iso_now()
            rec = {**record, "id": f"gate_test-{counter['n']}", "createdAt": now, "updatedAt": now}
            gates.insert(0, rec)
            return rec

        def get_approval_gate(self, id):
            return next((g for g in gates if g["id"] == id), None)

        def update_approval_gate(self, id, patch):
            for i, g in enumerate(gates):
                if g["id"] == id:
                    gates[i] = {**g, **patch, "id": g["id"], "createdAt": g["createdAt"], "updatedAt": _iso_now()}
                    return gates[i]
            return None

        def list_approval_gates(self, filter=None):
            filter = filter or {}
            return [
                g
                for g in gates
                if (not filter.get("status") or g["status"] == filter["status"])
                and (not filter.get("businessId") or g.get("businessId") == filter.get("businessId"))
            ]

    return Store()


# Common deps: a fake store plus spy-able prepare/memory/settings seams.
def make_deps(store, overrides=None):
    calls = {"prepare": [], "memory": []}

    async def prepare_business(args):
        calls["prepare"].append(args)
        return {"scheduler": {"jobId": "job-x"}}

    def save_memory(record):
        calls["memory"].append(record)
        return {**record, "id": f"mem-{len(calls['memory'])}"}

    deps = {
        "store": store,
        "prepareBusiness": prepare_business,
        "saveMemory": save_memory,
        "getSettings": lambda: {},
        "getAssumedRole": lambda: None,
        "resolveBusiness": lambda _business_id=None: None,
        **(overrides or {}),
    }
    return calls, deps


def test_create_gate_sets_deadline_exactly_and_starts_awaiting():
    store = make_store()
    g = gate.create_gate({"requirement": "x", "businessId": "biz_z", "signal": "amber", "waitMinutes": 120}, {"store": store})
    assert g["status"] == "awaiting-approval"
    assert _parse_ms(g["deadline"]) - _parse_ms(g["createdAt"]) == 120 * 60 * 1000
    assert g["attempts"] == 0


def _iso_from_seconds_ago(seconds):
    moment = datetime.fromtimestamp(datetime.now(timezone.utc).timestamp() - seconds, tz=timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


async def test_sweep_auto_approves_past_deadline_once_and_documents_decision():
    store = make_store()
    calls, deps = make_deps(store)
    g = gate.create_gate({"requirement": "ship it", "businessId": "biz_z", "signal": "amber", "waitMinutes": 1}, {"store": store})
    store.update_approval_gate(g["id"], {"deadline": _iso_from_seconds_ago(1)})  # force past

    await gate.sweep_expired_gates(int(datetime.now(timezone.utc).timestamp() * 1000), deps)

    after = store.get_approval_gate(g["id"])
    assert after["status"] == "proceeded"
    assert after["decision"]["by"] == "timeout"
    assert after["jobId"] == "job-x"
    assert len(calls["prepare"]) == 1
    assert len(calls["memory"]) == 1
    assert calls["memory"][0]["source"] == "approval-gate"
    assert calls["memory"][0]["scope"] == "business"


async def test_sweep_leaves_gate_whose_deadline_is_future():
    store = make_store()
    calls, deps = make_deps(store)
    g = gate.create_gate({"requirement": "later", "signal": "amber", "waitMinutes": 120}, {"store": store})
    await gate.sweep_expired_gates(int(datetime.now(timezone.utc).timestamp() * 1000), deps)
    assert store.get_approval_gate(g["id"])["status"] == "awaiting-approval"
    assert len(calls["prepare"]) == 0


async def test_proceed_gate_is_idempotent_prepare_runs_once():
    store = make_store()
    calls, deps = make_deps(store)
    g = gate.create_gate({"requirement": "once", "signal": "amber", "waitMinutes": 1}, {"store": store})
    first = await gate.proceed_gate(g, {"by": "human", "note": "ok"}, deps)
    second = await gate.proceed_gate(g, {"by": "human", "note": "ok"}, deps)
    assert len(calls["prepare"]) == 1
    assert first.get("alreadyProceeded") is None
    assert second.get("alreadyProceeded") is True
    assert store.get_approval_gate(g["id"])["status"] == "proceeded"


async def test_approve_gate_proceeds_human_decision_and_guards_state():
    store = make_store()
    _calls, deps = make_deps(store)
    g = gate.create_gate({"requirement": "a", "signal": "red", "waitMinutes": 1}, {"store": store})
    res = await gate.approve_gate(g["id"], deps)
    assert res["gate"]["status"] == "proceeded"
    assert res["gate"]["decision"]["by"] == "human"

    with pytest.raises(gate.GateError) as exc_info:
        await gate.approve_gate(g["id"], deps)
    assert exc_info.value.name == "GateError" and exc_info.value.status == 409

    with pytest.raises(gate.GateError) as missing_info:
        await gate.approve_gate("gate_missing", deps)
    assert missing_info.value.status == 404


async def test_sweep_recovers_gates_decided_but_not_yet_proceeded():
    store = make_store()
    calls, deps = make_deps(store)
    g = gate.create_gate({"requirement": "crash", "signal": "amber", "waitMinutes": 120}, {"store": store})  # future deadline
    store.update_approval_gate(
        g["id"],
        {"status": "auto-approved", "decidedAt": _iso_now(), "decision": {"by": "timeout", "note": "x"}, "proceededAt": None},
    )

    await gate.sweep_expired_gates(int(datetime.now(timezone.utc).timestamp() * 1000), deps)

    after = store.get_approval_gate(g["id"])
    assert after["status"] == "proceeded"  # re-driven despite future deadline
    assert len(calls["prepare"]) == 1


async def test_reevaluate_supersedes_old_gate_green_returns_none_amber_creates_fresh():
    store = make_store()
    g1 = gate.create_gate({"requirement": "vague", "businessId": "biz_z", "signal": "red", "waitMinutes": 60}, {"store": store})

    async def evaluate_green(_args):
        return {"blocked": False, "goal": "clear", "signal": "green", "evaluation": {"signal": "green"}}

    green = await gate.reevaluate_gate(
        g1["id"], "a very clear requirement",
        {"store": store, "evaluateRequirement": evaluate_green, "getSettings": lambda: {}},
    )
    assert green["signal"] == "green"
    assert green["gate"] is None
    assert store.get_approval_gate(g1["id"])["status"] == "superseded"

    g2 = gate.create_gate({"requirement": "still vague", "businessId": "biz_z", "signal": "red", "waitMinutes": 60}, {"store": store})

    async def evaluate_amber(_args):
        return {"blocked": False, "goal": "clearer", "signal": "amber", "evaluation": {"signal": "amber"}}

    amber = await gate.reevaluate_gate(
        g2["id"], "somewhat clearer",
        {"store": store, "evaluateRequirement": evaluate_amber, "getSettings": lambda: {}},
    )
    assert amber["signal"] == "amber"
    assert amber["gate"]
    assert amber["gate"]["attempts"] == 1
    assert amber["gate"]["waitMinutes"] == 60  # inherits the wait from the superseded gate
    assert store.get_approval_gate(g2["id"])["status"] == "superseded"
