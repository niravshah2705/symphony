"""Durable approval gates for the requirement-evaluation step (port of
agent/approval-gate.js).

When ``evaluate_requirement`` returns amber/red, the caller creates a gate that
HOLDS the business pipeline until a human refines/approves the requirement. If no
human responds within the configured wait window, the planner's scheduler tick
auto-approves and proceeds — documenting the decision.

Durability comes from an ABSOLUTE persisted ``deadline`` (ISO), never an
in-memory timer: it survives a browser tab closing (state is server-side) and a
server restart (the next tick recomputes from the stored deadline). The gate is a
DETERMINISTIC, server-enforced guardrail — it does not rely on LLM judgement to
decide whether work may proceed.

The store, model steps, memory, and clock are injected via ``deps`` so the
lifecycle is unit-testable without the JSON store or a live model.

Port notes:
- ``deps`` keys mirror the JS injection contract (``store``, ``prepareBusiness``,
  ``evaluateRequirement``, ``saveMemory``, ``getSettings``, ``getAssumedRole``,
  ``resolveBusiness``, ``now``). Store record keys stay camelCase (``businessId``,
  ``createdAt`` … cross the store / SPA boundary).
- The default store is ``ai_fleet.store``; the business pipeline and memory
  modules are imported lazily inside functions (they are ported later, so this
  module must import cleanly now).
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

DEFAULT_WAIT_MINUTES = 120
DECIDED_STATUSES = ("approved", "auto-approved")


class GateError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.name = "GateError"
        self.message = message
        self.status = status


def _iso_ms(dt):
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _iso_from_ms(ms):
    return _iso_ms(datetime.fromtimestamp(ms / 1000, tz=timezone.utc))


def _parse_ms(value):
    """`Date.parse(value)` — epoch ms as an int, or None when unparseable."""
    if not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(round(dt.timestamp() * 1000))


def _finite_number(value, fallback):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number or number in (float("inf"), float("-inf")):
        return fallback
    return number


def resolve_deps(deps=None):
    deps = deps or {}
    store_impl = deps.get("store")
    if store_impl is None:
        from ai_fleet import store as store_impl  # default store dependency

    def _prepare_business(args):
        from ai_fleet.agent import business_pipeline  # lazy: ported later

        return business_pipeline.prepare_business(args)

    def _evaluate_requirement(args):
        from ai_fleet.agent import business_pipeline  # lazy: ported later

        return business_pipeline.evaluate_requirement(args)

    def _save_memory(record):
        from ai_fleet.agent import memory  # lazy: ported later

        return store_impl.add_memory(memory.normalize_memory(record))

    return {
        "store": store_impl,
        "prepareBusiness": deps.get("prepareBusiness") or _prepare_business,
        "evaluateRequirement": deps.get("evaluateRequirement") or _evaluate_requirement,
        "saveMemory": deps.get("saveMemory") or _save_memory,
        "getSettings": deps.get("getSettings") or (lambda: store_impl.get_settings()),
        "getAssumedRole": deps.get("getAssumedRole") or (lambda: store_impl.get_assumed_role()),
        "resolveBusiness": deps.get("resolveBusiness") or (lambda business_id: default_resolve_business(store_impl, business_id)),
        "now": deps.get("now") or (lambda: int(time.time() * 1000)),
    }


def default_resolve_business(store_impl, business_id):
    if not business_id or not hasattr(store_impl, "read_store"):
        return None
    try:
        businesses = store_impl.read_store().get("businesses") or []
        return next((b for b in businesses if b and b.get("id") == business_id), None)
    except Exception:
        return None


def compute_deadline(created_at_iso, wait_minutes):
    """Absolute deadline = createdAt + waitMinutes."""
    base = _parse_ms(created_at_iso)
    if base is None:
        base = 0
    minutes = _finite_number(wait_minutes, DEFAULT_WAIT_MINUTES)
    return _iso_from_ms(base + minutes * 60_000)


def create_gate(fields, deps=None):
    """Persist a new gate (amber/red only). The deadline is derived from the
    record's own createdAt so it is exactly ``waitMinutes`` after creation.
    """
    fields = fields or {}
    d = resolve_deps(deps)
    wait_minutes = _finite_number(fields.get("waitMinutes"), DEFAULT_WAIT_MINUTES)
    record = d["store"].add_approval_gate(
        {
            "requirement": str(fields.get("requirement") or ""),
            "businessId": fields.get("businessId") or None,
            "conversationId": fields.get("conversationId") or None,
            "evaluation": fields.get("evaluation") or None,
            "signal": fields.get("signal"),
            "waitMinutes": wait_minutes,
            "status": "awaiting-approval",
            "deadline": None,
            "decidedAt": None,
            "decision": None,
            "proceededAt": None,
            "jobId": None,
            "attempts": int(_finite_number(fields.get("attempts"), 0)),
        }
    )
    return d["store"].update_approval_gate(
        record["id"], {"deadline": compute_deadline(record["createdAt"], wait_minutes)}
    )


async def proceed_gate(input_gate, decision=None, deps=None):
    """Run the gated pipeline for a decided gate. Idempotent: a gate already
    ``proceeded`` short-circuits, and the status is latched to a decided value
    BEFORE running so a concurrent/retry caller cannot double-run. If
    ``prepareBusiness`` throws, the gate is left decided-but-not-proceeded and the
    sweep retries it later.
    """
    decision = decision or {}
    d = resolve_deps(deps)
    store = d["store"]
    gate = store.get_approval_gate(input_gate.get("id") if input_gate else None) or input_gate
    if not gate:
        raise GateError("Approval gate not found.", 404)
    if gate["status"] == "proceeded":
        return {"gate": gate, "business": None, "alreadyProceeded": True}

    by = "timeout" if decision.get("by") == "timeout" else "human"
    note = str(decision.get("note") or ("Auto-approved after timeout." if by == "timeout" else "Approved by operator."))

    # Latch to a decided status only from `awaiting-approval` (retry path keeps
    # its existing decided status/decision).
    if gate["status"] == "awaiting-approval":
        store.update_approval_gate(
            gate["id"],
            {
                "status": "auto-approved" if by == "timeout" else "approved",
                "decidedAt": _iso_from_ms(d["now"]()),
                "decision": {"by": by, "note": note},
            },
        )
    decided = store.get_approval_gate(gate["id"]) or gate
    effective = decided.get("decision") or {"by": by, "note": note}

    business = await _maybe_await(
        d["prepareBusiness"](
            {
                "input": gate["requirement"],
                "business": d["resolveBusiness"](gate.get("businessId")),
                "settings": d["getSettings"](),
                "assumedRole": d["getAssumedRole"](),
            }
        )
    )

    # Document the decision durably — outlives the gate record.
    try:
        d["saveMemory"](
            {
                "scope": "business",
                "refId": gate.get("businessId") or None,
                "title": "Requirement gate auto-approved (timeout)" if effective.get("by") == "timeout" else "Requirement gate approved",
                "text": f"{effective.get('note')} Requirement: {str(gate.get('requirement') or '')[:300]}",
                "source": "approval-gate",
            }
        )
    except Exception:
        # Best-effort documentation; never block proceeding on a memory-write failure.
        pass

    job_id = ((business or {}).get("scheduler") or {}).get("jobId") if isinstance(business, dict) else None
    finalized = store.update_approval_gate(
        gate["id"], {"status": "proceeded", "proceededAt": _iso_from_ms(d["now"]()), "jobId": job_id}
    )
    return {"gate": finalized or {**decided, "status": "proceeded"}, "business": business}


async def approve_gate(id, deps=None):
    """Human "approve & proceed now". Only valid from an awaiting gate."""
    d = resolve_deps(deps)
    gate = d["store"].get_approval_gate(id)
    if not gate:
        raise GateError("Approval gate not found.", 404)
    if gate["status"] != "awaiting-approval":
        raise GateError(f"Gate is already {gate['status']}.", 409)
    return await proceed_gate(gate, {"by": "human", "note": "Approved by operator."}, deps)


async def reevaluate_gate(id, input, deps=None):
    """Refine + re-score. Supersedes the current gate, re-evaluates the new input,
    and returns ``{evaluation, signal, gate}``. Green -> no gate (caller proceeds);
    amber/red -> a fresh gate (deadline clock restarts on human engagement).
    """
    d = resolve_deps(deps)
    gate = d["store"].get_approval_gate(id)
    if not gate:
        raise GateError("Approval gate not found.", 404)
    if gate["status"] != "awaiting-approval":
        raise GateError(f"Gate is already {gate['status']}.", 409)

    out = await _maybe_await(
        d["evaluateRequirement"]({"input": input, "settings": d["getSettings"](), "business": d["resolveBusiness"](gate.get("businessId"))})
    )
    d["store"].update_approval_gate(gate["id"], {"status": "superseded"})

    if out.get("blocked"):
        return {"evaluation": None, "signal": out.get("signal"), "gate": None, "blocked": True, "answer": out.get("answer")}
    if out.get("signal") == "green":
        return {"evaluation": out.get("evaluation"), "signal": "green", "gate": None}

    next_gate = create_gate(
        {
            "requirement": out.get("goal"),
            "businessId": gate.get("businessId"),
            "conversationId": gate.get("conversationId"),
            "evaluation": out.get("evaluation"),
            "signal": out.get("signal"),
            "waitMinutes": gate.get("waitMinutes"),
            "attempts": int(_finite_number(gate.get("attempts"), 0)) + 1,
        },
        deps,
    )
    return {"evaluation": out.get("evaluation"), "signal": out.get("signal"), "gate": next_gate}


async def sweep_expired_gates(now=None, deps=None):
    """Scheduler tick worker. (1) Auto-approve awaiting gates past their deadline.
    (2) Restart recovery: re-drive gates decided but not yet proceeded (a crash
    between the two writes). Each gate is isolated so one failure cannot stall the
    sweep. Returns per-gate results for logging.
    """
    if now is None:
        now = int(time.time() * 1000)
    d = resolve_deps(deps)
    store = d["store"]
    results = []

    for gate in store.list_approval_gates({"status": "awaiting-approval"}):
        deadline = _parse_ms(gate.get("deadline"))
        if deadline is not None and deadline <= now:
            try:
                results.append(
                    await proceed_gate(
                        gate,
                        {"by": "timeout", "note": f"No human response within {gate.get('waitMinutes')} minutes; auto-approved per policy."},
                        deps,
                    )
                )
            except Exception as err:
                results.append({"gate": gate.get("id"), "error": getattr(err, "message", None) or str(err)})

    for gate in store.list_approval_gates():
        if gate.get("status") in DECIDED_STATUSES and not gate.get("proceededAt"):
            try:
                results.append(
                    await proceed_gate(gate, gate.get("decision") or {"by": "timeout", "note": "Resumed after restart."}, deps)
                )
            except Exception as err:
                results.append({"gate": gate.get("id"), "error": getattr(err, "message", None) or str(err)})
    return results


async def _maybe_await(value):
    """Support both sync and async injected model steps (JS callbacks may be
    either); a coroutine is awaited, a plain value is returned as-is."""
    if hasattr(value, "__await__"):
        return await value
    return value
