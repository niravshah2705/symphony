"""Planner agent HTTP surface (port of services/planner/src/routes/agent.js).

Mounted by the planner app at prefix ``/api/agent``, so every handler path is
declared RELATIVE to that prefix (JS ``router.get('/config')`` -> ``@router.get("/config")``).

Groups: config/status/discovery, omnibox/knowledge/memory, the on-demand business
pipeline + approval gates, conversation threads, and jobs/scheduler.

The modules ``scheduler``, ``llm``, ``local_intelligence`` and ``business_pipeline``
are ported in parallel; they are imported lazily inside the handlers (via
``_agent``) so this module imports even before they land, and tests inject fakes
through ``sys.modules``.
"""

from __future__ import annotations

import asyncio
import importlib
import inspect
import math
import re

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from ai_fleet import store, linear
from ai_fleet.config import CONFIG
from ai_fleet.util import AppError
from ai_fleet.services.common import json_body
from ai_fleet.agent import (
    workspace_router,
    knowledge_search,
    memory,
    approval_gate,
    conversations,
    settings_patch,
)

# --------------------------- id-shape validation ------------------------ #

REF_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CONV_ID_PATTERN = re.compile(r"^conv_[A-Za-z0-9_-]{1,64}$")
GATE_ID_PATTERN = re.compile(r"^gate_[A-Za-z0-9_-]{1,64}$")
MEMORY_ID_PATTERN = re.compile(r"^mem_[A-Za-z0-9-]{1,80}$")
GATE_STATUSES = ("awaiting-approval", "approved", "auto-approved", "proceeded", "superseded")

router = APIRouter()


def _agent(name: str):
    """Resolve a (possibly parallel-ported) agent module at call time.

    Mirrors the JS ``lazy require`` seam: absent-at-import modules are picked up
    once present, and tests inject fakes via ``sys.modules``.
    """
    return importlib.import_module(f"ai_fleet.agent.{name}")


def require_assumed_role():
    """Server-side role gate (the UI's disabled state is not authorization).

    403s with the JS message unless a team member is assumed; returns the role so
    the handler can attribute the queued job to it.
    """
    role = store.get_assumed_role()
    if not role:
        raise AppError("Assume a role before enriching projects.", 403)
    return role


# --------------------------- small helpers ------------------------------ #


def _clamp_int(value, min_, max_, fallback):
    """JS clampInt: Number(value) -> round + clamp, else fallback for non-finite."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(n):
        return fallback
    return min(max_, max(min_, round(n)))


def _finite_positive(value):
    """Return a positive number for JS ``Number.isFinite(n) && n > 0``, else None."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(n) or n <= 0:
        return None
    return int(n) if n.is_integer() else n


def _active_model_for(provider, settings):
    """Configured model name for the active provider (for the dashboard LLM pill)."""
    if provider == "claude":
        return settings.get("claudeModel") or CONFIG.CLAUDE.defaultModel
    if provider == "codex":
        fallback = CONFIG.OAUTH.chatgptModel if CONFIG.OAUTH.backend == "chatgpt" else CONFIG.OAUTH.defaultModel
        return settings.get("codexModel") or fallback
    if provider == "lmstudio":
        return settings.get("lmstudioModel")
    if provider == "omlx":
        return settings.get("omlxModel")
    if provider == "huggingface":
        return settings.get("huggingfaceModel")
    return settings.get("ollamaModel")


def _sanitize_labels(value, fallback):
    if not isinstance(value, list):
        return fallback
    seen = []
    for label in value:
        cleaned = str(label or "").strip()
        if cleaned and cleaned not in seen:
            seen.append(cleaned)
    return seen


def _sanitize_config(body, current):
    """Whitelist + clamp the config patch — never persist arbitrary fields."""
    b = body or {}
    try:
        interval_candidate = float(b.get("intervalMinutes"))
    except (TypeError, ValueError):
        interval_candidate = None
    interval_minutes = (
        int(interval_candidate)
        if interval_candidate is not None and int(interval_candidate) in CONFIG.INTERVAL_OPTIONS
        else current["intervalMinutes"]
    )
    return {
        "parallelProcessing": _clamp_int(b.get("parallelProcessing"), 1, 8, current["parallelProcessing"]),
        "maxConcurrentCoders": _clamp_int(b.get("maxConcurrentCoders"), 1, 8, current["maxConcurrentCoders"]),
        "maxProjectsPerRun": _clamp_int(b.get("maxProjectsPerRun"), 1, 20, current["maxProjectsPerRun"]),
        "maxMilestones": _clamp_int(b.get("maxMilestones"), 1, 12, current["maxMilestones"]),
        "maxIssuesPerMilestone": _clamp_int(b.get("maxIssuesPerMilestone"), 0, 12, current["maxIssuesPerMilestone"]),
        "intervalMinutes": interval_minutes,
        "enrichLabels": _sanitize_labels(b.get("enrichLabels"), current["enrichLabels"])
        if b.get("enrichLabels") is not None
        else current["enrichLabels"],
        "scheduleEnabled": b["scheduleEnabled"] if isinstance(b.get("scheduleEnabled"), bool) else current["scheduleEnabled"],
        "autoAssignLead": b["autoAssignLead"] if isinstance(b.get("autoAssignLead"), bool) else current["autoAssignLead"],
        "autoLabelNewProjects": b["autoLabelNewProjects"]
        if isinstance(b.get("autoLabelNewProjects"), bool)
        else current["autoLabelNewProjects"],
        "createIssues": b["createIssues"] if isinstance(b.get("createIssues"), bool) else current["createIssues"],
        "addDependencies": b["addDependencies"] if isinstance(b.get("addDependencies"), bool) else current["addDependencies"],
        # Minutes to hold an amber/red requirement gate before auto-approving (1 min - 7 days).
        "evaluationApprovalWaitMinutes": _clamp_int(
            b.get("evaluationApprovalWaitMinutes"), 1, 10080, current["evaluationApprovalWaitMinutes"]
        ),
    }


async def _fetch_json(url, headers=None, timeout_ms=4000):
    """Best-effort GET returning parsed JSON, or None on non-2xx / any error.

    Replaces the JS ``fetch(url, { signal: AbortSignal.timeout(ms) })`` + ``resp.ok``
    guard; both a non-ok response and a thrown error collapse to the same
    ``{ models: [], reachable: false }`` outcome, so returning None captures both.
    Isolated so tests can inject a fake without a live host.
    """
    import httpx

    try:
        async with httpx.AsyncClient(timeout=timeout_ms / 1000) as client:
            resp = await client.get(url, headers=headers or {})
    except Exception:
        return None
    if not resp.is_success:
        return None
    try:
        return resp.json()
    except Exception:
        return None


def _fire_and_forget(fn):
    """Detached tick (JS ``Promise.resolve(fn()).catch(() => {})``)."""

    async def _run():
        try:
            result = fn()
            if inspect.isawaitable(result):
                await result
        except Exception:
            pass

    try:
        asyncio.create_task(_run())
    except RuntimeError:
        # No running loop (should not happen inside an async handler).
        pass


# =========================== config / discovery ========================== #


@router.get("/config")
async def get_config():
    return {"config": store.get_agent_config()}


@router.put("/config")
async def put_config(request: Request):
    body = await json_body(request)
    next_ = _sanitize_config(body, store.get_agent_config())
    store.set_agent_config(next_)
    return {"config": next_}


@router.get("/models")
async def list_models():
    """Scheduler interval choices (local)."""
    return {"intervals": CONFIG.INTERVAL_OPTIONS}


@router.get("/ollama-models")
async def ollama_models():
    """Models installed on the configured Ollama host (best-effort)."""
    host = store.get_settings().get("ollamaHost")
    data = await _fetch_json(f"{host}/api/tags")
    if data is None:
        return {"models": [], "reachable": False}
    models = sorted([m.get("name") for m in (data.get("models") or []) if m.get("name")])
    return {"models": models, "reachable": True}


@router.get("/lmstudio-models")
async def lmstudio_models():
    """Models available on the configured LM Studio host (OpenAI-compatible list)."""
    host = store.get_settings().get("lmstudioHost")
    data = await _fetch_json(f"{host}/v1/models")
    if data is None:
        return {"models": [], "reachable": False}
    models = sorted([m.get("id") for m in (data.get("data") or []) if m.get("id")])
    return {"models": models, "reachable": True}


@router.get("/omlx-models")
async def omlx_models():
    """Models advertised by the configured oMLX server. Optional API-key auth stays server-side."""
    settings = store.get_settings()
    host = re.sub(r"/$", "", re.sub(r"/v1/?$", "", str(settings.get("omlxHost") or CONFIG.OMLX.defaultHost), flags=re.IGNORECASE))
    headers = {"Accept": "application/json"}
    if settings.get("omlxApiKey"):
        headers["Authorization"] = f"Bearer {settings['omlxApiKey']}"
    data = await _fetch_json(f"{host}{CONFIG.OMLX.apiPath}/models", headers=headers)
    if data is None:
        return {"models": [], "reachable": False}
    models = []
    for model in (data.get("data") or []):
        model_id = str((model or {}).get("id") or "").strip()
        if not model_id:
            continue
        item = {"id": model_id, "label": model_id}
        context_window = _finite_positive((model or {}).get("max_model_len"))
        if context_window is not None:
            item["contextWindow"] = context_window
        models.append(item)
    models.sort(key=lambda m: m["id"])
    return {"models": models, "reachable": True, "source": "local"}


@router.get("/labels")
async def labels():
    """Distinct Linear project labels (for the dropdown)."""
    return {"labels": await linear.get_all_project_labels(store.get_api_key())}


@router.get("/status")
async def status():
    """Scheduler + readiness for the dashboard."""
    settings = store.get_settings()
    config = store.get_agent_config()
    codex_tokens = settings.get("codexTokens")
    llm = _agent("llm")
    scheduler = _agent("scheduler")
    # The planner runs on the `thinking` role, so the dashboard LLM pill reflects
    # that role's provider/model and readiness.
    provider = llm.provider_for_role(settings, "thinking")
    local_provider = settings.get("localLlmProvider") or settings.get("llmProvider") or "ollama"
    return {
        **scheduler.get_status(),
        "assumedRole": store.get_assumed_role(),
        "llmConfigured": llm.llm_ready(settings, "thinking"),
        "llmProvider": provider,
        "activeModel": _active_model_for(provider, settings),
        "localLlmProvider": local_provider,
        "localActiveModel": _active_model_for(local_provider, settings),
        "ollamaModel": settings.get("ollamaModel"),
        "lmstudioModel": settings.get("lmstudioModel"),
        "omlxModel": settings.get("omlxModel"),
        "huggingfaceModel": settings.get("huggingfaceModel"),
        "codexModel": settings.get("codexModel") or CONFIG.OAUTH.defaultModel,
        "codexConnected": bool(codex_tokens and (codex_tokens.get("accessToken") or codex_tokens.get("refreshToken"))),
        "tracingEnabled": bool(settings.get("langsmithApiKey") and settings.get("langsmithTracing")),
        "langsmithProject": settings.get("langsmithProject"),
        "enrichLabels": config.get("enrichLabels"),
        "intervalMinutes": config.get("intervalMinutes"),
    }


@router.get("/candidates")
async def candidates(role=Depends(require_assumed_role)):
    """Open projects auto-enrichment will pick up (no lead + configured label). Role required."""
    labels_ = store.get_agent_config()["enrichLabels"]
    projects = await linear.get_projects_with_labels(store.get_api_key(), labels_)
    return {
        "labels": labels_,
        "projects": [{"id": p.get("id"), "name": p.get("name"), "progress": p.get("progress")} for p in projects],
    }


# =========================== omnibox / knowledge / memory ================ #


@router.post("/message")
async def message(request: Request):
    """Deterministic intent + safety gate for the Agent omnibox."""
    body = await json_body(request)
    route = workspace_router.classify_intent(body.get("input"))
    enrichment = None
    warning = None
    memory_draft = None
    can_prepare = False

    if route["intent"] == "business":
        # Keep /message fast: the real 6-step pipeline runs on demand via /business/prepare.
        can_prepare = True
    elif route["intent"] == "general":
        try:
            local_intelligence = _agent("local_intelligence")
            enrichment = await local_intelligence.enrich_input(
                {
                    "input": route["input"],
                    "scenario": "planning",
                    "metadata": {"intent": route["intent"], "workflow": "thinker"},
                    "settings": store.get_settings(),
                }
            )
        except Exception as error:  # noqa: BLE001 — degrade to the deterministic route
            warning = (
                getattr(error, "message", None)
                or (str(error) if str(error) else None)
                or "The configured local model was unavailable; the deterministic route is still ready."
            )
    elif route["intent"] == "knowledge":
        # "Remember this" phrasing yields a confirmable draft only — the write is a separate POST.
        memory_draft = memory.detect_memory_write(route["input"])

    return {"route": route, "enrichment": enrichment, "warning": warning, "memoryDraft": memory_draft, "canPrepare": can_prepare}


@router.post("/knowledge-search")
async def knowledge_search_route(request: Request):
    """Bounded, read-only lexical retrieval over the workspace README/docs corpus."""
    body = await json_body(request)
    return knowledge_search.search_documents(body.get("query") or body.get("input"))


@router.post("/memory-search")
async def memory_search(request: Request):
    """Typed, read-only recall across the five memory scopes, blended with reviewed docs."""
    body = await json_body(request)
    query = body.get("query") if isinstance(body.get("query"), str) else (body.get("input") if isinstance(body.get("input"), str) else "")
    requested = body.get("scope").lower() if isinstance(body.get("scope"), str) else ""
    scope = requested if requested in memory.MEMORY_SCOPES else memory.detect_memory_scope(query)
    results = memory.search_memories(query, store.list_memories(), {"scope": scope})
    # Blend reviewed docs for the workspace scope (or when the scope is ambiguous).
    if (scope == "workspace" or scope == "all") and query.strip():
        try:
            docs = knowledge_search.search_documents(query)
            for doc in docs.get("results") or []:
                results.append(
                    {
                        "scope": "workspace",
                        "type": "Workspace document",
                        "title": doc.get("title"),
                        "summary": doc.get("snippet"),
                        "status": doc.get("path"),
                        "refId": None,
                    }
                )
        except Exception:  # noqa: BLE001 — a bad/empty doc query is non-fatal
            pass
    return {"query": query, "scope": scope, "results": results[:12]}


@router.post("/memory")
async def create_memory(request: Request):
    """Persist a confirmed memory (the write). normalize_memory raises MemoryError(400)."""
    body = await json_body(request)
    record = store.add_memory(memory.normalize_memory(body))
    return JSONResponse(status_code=201, content={"memory": record})


@router.get("/memory")
async def list_memory(request: Request):
    """List stored memories, optionally filtered by scope/refId."""
    requested = request.query_params.get("scope")
    requested = requested.lower() if isinstance(requested, str) else ""
    scope = requested if requested in memory.MEMORY_SCOPES else None
    ref_id_param = request.query_params.get("refId")
    ref_id = ref_id_param if (isinstance(ref_id_param, str) and REF_ID_PATTERN.match(ref_id_param)) else None
    return {"memories": store.list_memories({"scope": scope, "refId": ref_id})}


@router.delete("/memory/{memory_id}")
async def delete_memory(memory_id: str):
    """Remove one stored memory."""
    mid = str(memory_id or "")
    if not MEMORY_ID_PATTERN.match(mid):
        raise AppError("Invalid memory id.", 400)
    if not store.remove_memory(mid):
        raise AppError("Memory not found.", 404)
    return {"ok": True}


@router.post("/enrich-input")
async def enrich_input(request: Request):
    """Turn short user notes into a clearer brief via the configured LOCAL role only."""
    body = await json_body(request)
    local_intelligence = _agent("local_intelligence")
    normalized = local_intelligence.normalize_enrichment_request(body)
    enrichment = await local_intelligence.enrich_input({**normalized, "settings": store.get_settings()})
    return {"enrichment": enrichment}


def _trace_from_job(job):
    coding = job.get("kind") == "coding"
    if coding:
        title = f"{job.get('taskIdentifier') or 'Coding task'}"
        if job.get("taskTitle"):
            title += f" · {job['taskTitle']}"
    else:
        title = job.get("projectName") or "Enrichment job"
    return {
        "id": job.get("id"),
        "title": title,
        "status": job.get("status"),
        "startedAt": job.get("startedAt"),
        "finishedAt": job.get("finishedAt"),
        "summary": job.get("summary") or job.get("error") or None,
        "steps": job.get("steps") or [],
    }


def _trace_for_analysis(body):
    local_intelligence = _agent("local_intelligence")
    if not isinstance(body, dict):
        raise local_intelligence.LocalIntelligenceError("A JSON request body is required.")
    has_job_id = "jobId" in body
    has_trace = "trace" in body
    if has_job_id == has_trace:
        raise local_intelligence.LocalIntelligenceError("Provide exactly one of jobId or trace.")
    if has_trace:
        return local_intelligence.normalize_trace_request(body)

    if not isinstance(body.get("jobId"), str):
        raise local_intelligence.LocalIntelligenceError("jobId must be a string.")
    job_id = body["jobId"].strip()
    if not job_id or len(job_id) > 128 or not re.match(r"^[A-Za-z0-9_-]+$", job_id):
        raise local_intelligence.LocalIntelligenceError("jobId is not valid.")
    job = next((candidate for candidate in store.list_jobs() if candidate.get("id") == job_id), None)
    if not job:
        raise local_intelligence.LocalIntelligenceError("Job not found.", 404)
    return local_intelligence.normalize_trace(_trace_from_job(job))


@router.post("/analyze-trace")
async def analyze_trace(request: Request):
    """Analyze an existing job by id, or a bounded caller-supplied trace."""
    body = await json_body(request)
    trace = _trace_for_analysis(body)
    local_intelligence = _agent("local_intelligence")
    analysis = await local_intelligence.analyze_trace({"trace": trace, "settings": store.get_settings()})
    return {"analysis": analysis}


@router.post("/settings-command")
async def settings_command(request: Request):
    """Interpret a natural-language settings request with the LOCAL model, then apply the patch."""
    body = await json_body(request)
    instruction = (
        body.get("instruction")
        if isinstance(body.get("instruction"), str)
        else (body.get("input") if isinstance(body.get("input"), str) else "")
    )
    local_intelligence = _agent("local_intelligence")
    proposal = await local_intelligence.propose_settings({"instruction": instruction, "settings": store.get_settings()})
    preview = body.get("apply") is False
    outcome = settings_patch.sanitize_settings_patch(proposal["patch"]) if preview else settings_patch.apply_settings_patch(proposal["patch"])
    result = {
        "command": {
            "instruction": proposal["instruction"],
            "notes": proposal["notes"],
            "patch": proposal["patch"],
            "provenance": proposal["provenance"],
            "warnings": proposal["warnings"],
        },
        "applied": [] if preview else outcome["applied"],
        "rejected": outcome["rejected"],
        "ignored": outcome["ignored"],
    }
    if preview:
        result["preview"] = outcome["patch"]
    return result


# =========================== business pipeline / gates =================== #


def _resolve_business(body):
    business_id = body.get("businessId")
    if isinstance(business_id, str) and REF_ID_PATTERN.match(business_id):
        return next((b for b in store.read_store()["businesses"] if b.get("id") == business_id), None)
    return None


@router.post("/business/prepare")
async def business_prepare(request: Request):
    """Run the real, on-demand business pipeline."""
    body = await json_body(request)
    business = _resolve_business(body)
    business_pipeline = _agent("business_pipeline")
    payload = await business_pipeline.prepare_business(
        {
            "input": body.get("input") if isinstance(body.get("input"), str) else "",
            "business": business,
            "settings": store.get_settings(),
            "assumedRole": store.get_assumed_role(),
        }
    )
    return {"business": payload}


@router.post("/business/evaluate")
async def business_evaluate(request: Request):
    """Requirement-readiness preflight (step 0). Green proceeds; amber/red opens a gate."""
    body = await json_body(request)
    business = _resolve_business(body)
    conversation_id_raw = body.get("conversationId")
    conversation_id = conversation_id_raw if (isinstance(conversation_id_raw, str) and CONV_ID_PATTERN.match(conversation_id_raw)) else None

    business_pipeline = _agent("business_pipeline")
    result = await business_pipeline.evaluate_requirement(
        {"input": body.get("input") if isinstance(body.get("input"), str) else "", "settings": store.get_settings(), "business": business}
    )

    if result.get("blocked"):
        return {"blocked": True, "answer": result.get("answer"), "signal": result.get("signal")}
    if result.get("signal") == "green":
        return {"evaluation": result.get("evaluation"), "signal": "green", "gate": None}

    gate = approval_gate.create_gate(
        {
            "requirement": result.get("goal"),
            "businessId": business["id"] if business else None,
            "conversationId": conversation_id,
            "evaluation": result.get("evaluation"),
            "signal": result.get("signal"),
            "waitMinutes": store.get_agent_config()["evaluationApprovalWaitMinutes"],
        }
    )
    return {"evaluation": result.get("evaluation"), "signal": result.get("signal"), "gate": gate}


@router.get("/business/gates")
async def list_gates(request: Request):
    """List gates (optional ?businessId= &status=)."""
    filter_: dict = {}
    business_id = request.query_params.get("businessId")
    if isinstance(business_id, str) and REF_ID_PATTERN.match(business_id):
        filter_["businessId"] = business_id
    status_ = request.query_params.get("status")
    if isinstance(status_, str) and status_ in GATE_STATUSES:
        filter_["status"] = status_
    return {"gates": store.list_approval_gates(filter_)}


@router.get("/business/gates/{gate_id}")
async def get_gate(gate_id: str):
    """One gate (front-end polls for the countdown / auto-advance)."""
    if not GATE_ID_PATTERN.match(gate_id):
        raise AppError("Invalid gate id.", 400)
    gate = store.get_approval_gate(gate_id)
    if not gate:
        raise AppError("Approval gate not found.", 404)
    return {"gate": gate}


@router.post("/business/gates/{gate_id}/approve")
async def approve_gate(gate_id: str):
    """Human "approve & proceed now"."""
    if not GATE_ID_PATTERN.match(gate_id):
        raise AppError("Invalid gate id.", 400)
    out = await approval_gate.approve_gate(gate_id)
    return {"gate": out["gate"], "business": out["business"]}


@router.post("/business/gates/{gate_id}/reevaluate")
async def reevaluate_gate(gate_id: str, request: Request):
    """Refine the requirement + re-score."""
    if not GATE_ID_PATTERN.match(gate_id):
        raise AppError("Invalid gate id.", 400)
    body = await json_body(request)
    return await approval_gate.reevaluate_gate(gate_id, body.get("input") if isinstance(body.get("input"), str) else "")


# =========================== conversation threads ======================== #


@router.get("/conversations")
async def list_conversations():
    """Thread summaries (no messages), newest-first."""
    return {"conversations": [conversations.summarize_conversation(c) for c in store.list_conversations()]}


@router.post("/conversations")
async def create_conversation(request: Request):
    """Create an empty thread."""
    body = await json_body(request)
    title_raw = body.get("title")
    title = conversations.normalize_title(title_raw) if (isinstance(title_raw, str) and title_raw.strip()) else None
    return JSONResponse(status_code=201, content={"conversation": store.add_conversation({"title": title} if title else {})})


@router.get("/conversations/{conv_id}")
async def get_conversation(conv_id: str):
    """Full thread with messages."""
    if not CONV_ID_PATTERN.match(str(conv_id or "")):
        raise AppError("Invalid conversation id.", 400)
    conversation = store.get_conversation(conv_id)
    if not conversation:
        raise AppError("Conversation not found.", 404)
    return {"conversation": conversation}


@router.post("/conversations/{conv_id}/messages")
async def append_messages(conv_id: str, request: Request):
    """Append a turn; auto-titles an untitled thread from its first user message."""
    cid = str(conv_id or "")
    if not CONV_ID_PATTERN.match(cid):
        raise AppError("Invalid conversation id.", 400)
    existing = store.get_conversation(cid)
    if not existing:
        raise AppError("Conversation not found.", 404)
    body = await json_body(request)
    messages = conversations.normalize_messages(body.get("messages"))
    updated = store.append_conversation_messages(cid, messages)
    untitled = (not existing.get("title")) or existing.get("title") == "New conversation"
    had_user = any(m.get("role") == "user" for m in (existing.get("messages") or []))
    first_user = None if had_user else next((m for m in messages if m.get("role") == "user"), None)
    conversation = (
        store.update_conversation(cid, {"title": conversations.derive_title(first_user["text"])})
        if (untitled and first_user)
        else updated
    )
    return {"conversation": conversation}


@router.patch("/conversations/{conv_id}")
async def rename_conversation(conv_id: str, request: Request):
    """Rename a thread."""
    cid = str(conv_id or "")
    if not CONV_ID_PATTERN.match(cid):
        raise AppError("Invalid conversation id.", 400)
    body = await json_body(request)
    conversation = store.update_conversation(cid, {"title": conversations.normalize_title(body.get("title"))})
    if not conversation:
        raise AppError("Conversation not found.", 404)
    return {"conversation": conversation}


@router.delete("/conversations/{conv_id}")
async def delete_conversation(conv_id: str):
    """Remove a thread."""
    cid = str(conv_id or "")
    if not CONV_ID_PATTERN.match(cid):
        raise AppError("Invalid conversation id.", 400)
    if not store.remove_conversation(cid):
        raise AppError("Conversation not found.", 404)
    return {"ok": True}


# =========================== jobs / scheduler ============================ #


@router.get("/jobs")
async def list_jobs():
    """Enrichment job history."""
    return {"jobs": store.list_jobs()}


@router.delete("/jobs")
async def clear_jobs():
    """Clear all finished (done/error) jobs."""
    return {"jobs": store.clear_finished_jobs()}


@router.delete("/jobs/{job_id}")
async def delete_job(job_id: str):
    """Remove a single job."""
    if not store.remove_job(job_id):
        raise AppError("Job not found.", 404)
    return {"ok": True}


@router.post("/enqueue")
async def enqueue(request: Request, role=Depends(require_assumed_role)):
    """Queue ONE project for the planner, then kick a non-overlapping tick. Role-gated."""
    body = await json_body(request)
    project_id = body.get("projectId").strip() if isinstance(body.get("projectId"), str) else ""
    if not project_id or len(project_id) > 200:
        raise AppError("projectId is required.", 400)
    project_name = body.get("projectName")[:200] if isinstance(body.get("projectName"), str) else project_id
    scheduler = _agent("scheduler")
    job = scheduler.enqueue({"projectId": project_id, "projectName": project_name, "assumedRole": role})
    # Fire-and-forget tick; the queued job is processed on this (or the next) tick.
    _fire_and_forget(scheduler.process_pending)
    return {"job": job, "status": scheduler.get_status()}


@router.post("/run-now")
async def run_now(role=Depends(require_assumed_role)):
    """Manual scheduler tick (still bounded/non-overlapping). Role-gated."""
    scheduler = _agent("scheduler")
    result = await scheduler.process_pending()
    return {"result": result, "status": scheduler.get_status()}
