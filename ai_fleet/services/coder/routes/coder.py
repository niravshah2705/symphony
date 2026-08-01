"""Coder agent HTTP routes (port of services/coder/src/routes/coder.js).

Code-writer deep-agent endpoints. The coder app mounts this router at the
``/api/coder`` prefix, so paths are defined relative to it:
  GET  /api/coder          — monitor status + in-flight tickets
  POST /api/coder/run      — run the code-writer on one ticket {issueId} (detached, 202)
  POST /api/coder/monitor  — start/resume/stop the board monitor {action}

``coder``, ``coder_orchestrator`` and ``llm`` are imported lazily inside the
handlers: they pull in heavy LLM deps (and are being ported in parallel), so the
route module must import even if those modules land slightly later.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ai_fleet import store, linear, logger
from ai_fleet.services.common import json_body

router = APIRouter()

ISSUE_QUERY = """
  query CoderIssue($id: String!) {
    issue(id: $id) {
      id identifier title description url
      state { name }
      labels { nodes { name } }
    }
  }"""


def _get(obj, key, default=None):
    """Read ``key`` from a dict or object (port targets may return either)."""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def to_issue(node):
    labels = _get(_get(node, "labels") or {}, "nodes") or []
    return {
        "id": _get(node, "id"),
        "identifier": _get(node, "identifier"),
        "title": _get(node, "title"),
        "description": _get(node, "description"),
        "url": _get(node, "url"),
        "state": _get(_get(node, "state") or {}, "name"),
        "labels": [_get(l, "name") for l in labels],
    }


def build_keys(s):
    return {
        "linearApiKey": s.get("linearApiKey"),
        "langsmithApiKey": s.get("langsmithApiKey"),
        "langsmithTracing": s.get("langsmithTracing"),
        "langsmithProject": s.get("langsmithProject"),
        "langsmithEndpoint": s.get("langsmithEndpoint"),
        "agentRuntime": s.get("agentRuntime"),
        "workflowPattern": s.get("workflowPattern"),
    }


def _reason_message(reason):
    """``pauseReason.message`` for a dict-or-object reason (may be None)."""
    if not reason:
        return None
    return _get(reason, "message")


# GET /api/coder — monitor status.
@router.get("")
@router.get("/")
async def get_status():
    from ai_fleet.agent import coder_orchestrator as orchestrator

    return orchestrator.status()


# POST /api/coder/run — dispatch a single ticket (async; watch server logs / Linear Workpad).
@router.post("/run")
async def run(request: Request):
    body = await json_body(request)
    issue_id = str(body.get("issueId") or "").strip()
    if not issue_id:
        return JSONResponse(status_code=400, content={"error": "issueId is required."})

    settings = store.get_settings()
    if not settings.get("linearApiKey"):
        return JSONResponse(status_code=400, content={"error": "Add a Linear API key in Settings."})

    from ai_fleet.agent import coder_orchestrator as orchestrator
    from ai_fleet.agent import llm as llm_module

    data = await linear.linear_request(settings["linearApiKey"], ISSUE_QUERY, {"id": issue_id})
    if not data or not data.get("issue"):
        return JSONResponse(status_code=404, content={"error": f"Issue {issue_id} not found."})
    issue = to_issue(data["issue"])

    async def resolve_role(role):
        return await llm_module.resolve_llm(settings, role)

    try:
        readiness = await orchestrator.preflight_and_pause(issue, resolve_role)
    except Exception as error:
        reason = _get(error, "pause_reason") or _get(error, "pauseReason")
        return JSONResponse(
            status_code=503,
            content={
                "error": _reason_message(reason) or "Agent jobs are paused until the workspace is ready.",
                "paused": True,
                "pauseReason": reason or None,
            },
        )

    llm = _get(readiness, "llm")
    role = _get(readiness, "role")
    provider = _get(_get(readiness, "selection") or {}, "provider")

    # Long-running; dispatch detached and return accepted. Progress goes to the logs + Linear Workpad.
    def step(m):
        logger.info(f"[coder {issue['identifier']}] {m}")

    async def _dispatch():
        from ai_fleet.agent import coder

        try:
            result = await coder.run_coder(
                issue=issue,
                llm=llm,
                api_key=settings["linearApiKey"],
                keys=build_keys(settings),
                on_step=step,
            )
            final_text = str(_get(result, "finalText") or "")[:160]
            logger.info(f"[coder {issue['identifier']}] done: {final_text}")
        except Exception as err:
            reason = orchestrator.pause_for_runtime_error(
                err,
                {
                    "task": issue,
                    "role": role,
                    "repositoryProvider": provider,
                    "llm": llm,
                },
            )
            if reason:
                logger.warn(f"[coder {issue['identifier']}] Agent jobs paused: {_reason_message(reason)}")
                return
            message = _get(err, "message") or str(err)
            logger.error(f"[coder {issue['identifier']}] failed: {message}")

    asyncio.create_task(_dispatch())

    return JSONResponse(
        status_code=202,
        content={
            "accepted": True,
            "issue": {"id": issue["id"], "identifier": issue["identifier"], "state": issue["state"]},
            "provider": _get(llm, "provider"),
            "model": _get(llm, "model"),
        },
    )


# POST /api/coder/monitor — start/resume/stop the board monitor.
@router.post("/monitor")
async def monitor(request: Request):
    from ai_fleet.agent import coder_orchestrator as orchestrator

    body = await json_body(request)
    action = str(body.get("action") or "").strip()
    if action == "start":
        return orchestrator.start()
    if action == "resume":
        return orchestrator.resume()
    if action == "stop":
        return orchestrator.stop()
    return JSONResponse(status_code=400, content={"error": 'action must be "start", "resume", or "stop".'})
