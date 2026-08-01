"""Board monitor for the code-writer — the AIPLANNED flow (port of coder-orchestrator.js).

On a fixed cadence it finds projects labelled ``aiplanned`` (set by the planner)
and works their tasks (issues) in CREATION ORDER, honoring dependencies:
  - a task blocked by a not-yet-Done issue is skipped until the blocker lands,
  - independent tasks run concurrently — within AND across projects — each in its
    own isolated per-task workspace on its own branch,
  - up to ``maxConcurrentCoders`` (UI-configurable, env ``CODER_MAX_CONCURRENT`` as
    the default) run in parallel across all projects,
  - when a project has no open tasks left, it is marked ``aidone``.

Single-writer model: ``running`` is only mutated from the serialized poll tick +
run callbacks, so a task is never dispatched twice. State is in-memory only.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import math
import re
import time
import types
import uuid
from datetime import datetime, timezone

from ai_fleet.config import CONFIG
from ai_fleet import store
from ai_fleet import logger as log
from ai_fleet import linear
from ai_fleet.agent.coder import run_planned_coder, resolve_planned_repository
from ai_fleet.agent.apply import apply_aidone, start_issue, finish_issue
from ai_fleet.agent.availability import (
    AgentAvailabilityError,
    is_model_availability_error,
    is_repository_availability_error,
    pause_reason_for,
    probe_model_availability,
    probe_repository_availability,
    public_availability_message,
)

# --------------------------------------------------------------------------- #
# module-level mutable state (single-writer, in-memory only)
# --------------------------------------------------------------------------- #
running: dict = {}  # issueId -> { identifier, projectId, startedAt }
timer = None
started = False
pause_reason = None
pause_context = None

# Readiness checks are intentionally much cheaper than a failed agent run.
# Deduplicate only simultaneous checks: every later dispatch probes again so a
# credential revoked moments ago cannot slip through a stale success cache.
RECOVERY_PROBE_MS = 60 * 1000
readiness_cache: dict = {}

PLANNED_PROJECTS_QUERY = """
  query PlannedProjects($label: String!, $first: Int!) {
    projects(first: $first, filter: { labels: { name: { eq: $label } } }) {
      nodes { id name }
    }
  }"""

# Open (non-terminal) issues for aiplanned projects, with their blockers.
PLANNED_TASKS_QUERY = """
  query PlannedTasks($label: String!, $first: Int!) {
    issues(first: $first, filter: {
      project: { labels: { name: { eq: $label } } },
      state: { type: { nin: ["completed", "canceled"] } }
    }) {
      nodes {
        id identifier title description url createdAt
        state { name type }
        labels(first: 20) { nodes { name } }
        project { id name }
        inverseRelations(first: 25) { nodes { type issue { id identifier state { type } } } }
      }
    }
  }"""


def _now_ms():
    return int(time.time() * 1000)


def _iso_now():
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _msg(err):
    return getattr(err, "message", None) or str(err)


def is_done_state(state):
    t = (state or {}).get("type") if isinstance(state, dict) else getattr(state, "type", None)
    return t == "completed" or t == "canceled"


def model_role_for_task(task):
    """The deep-agent role every coder task routes to. Model selection is
    purpose-based ("models as tasks"): the coder always uses the configured
    ``execution`` model regardless of a task's size or model-routing label."""
    _ = task
    return "execution"


def blockers(node):
    """Identifiers of not-yet-Done issues that block this task."""
    inv = ((node.get("inverseRelations") or {}).get("nodes")) or []
    out = []
    for r in inv:
        issue = r.get("issue")
        if r.get("type") == "blocks" and issue and not is_done_state(issue.get("state")):
            out.append(issue.get("identifier") or issue.get("id"))
    return out


async def fetch_planned_projects(api_key):
    data = await linear.linear_request(
        api_key, PLANNED_PROJECTS_QUERY, {"label": CONFIG.CODER.plannedLabel, "first": CONFIG.PAGE_SIZE}
    )
    return ((data or {}).get("projects") or {}).get("nodes") or []


async def fetch_planned_tasks(api_key):
    """Open tasks across aiplanned projects, grouped by project, each sorted by createdAt asc."""
    data = await linear.linear_request(
        api_key, PLANNED_TASKS_QUERY, {"label": CONFIG.CODER.plannedLabel, "first": 250}
    )
    nodes = ((data or {}).get("issues") or {}).get("nodes") or []
    by_project: dict = {}
    for n in nodes:
        pid = (n.get("project") or {}).get("id")
        if not pid:
            continue
        task = {
            "id": n.get("id"),
            "identifier": n.get("identifier"),
            "title": n.get("title"),
            "description": n.get("description"),
            "url": n.get("url"),
            "createdAt": n.get("createdAt"),
            "state": (n.get("state") or {}).get("name"),
            "labels": [l.get("name") for l in (((n.get("labels") or {}).get("nodes")) or [])],
            "project": {"id": pid, "name": (n.get("project") or {}).get("name")},
            "blockers": blockers(n),
        }
        by_project.setdefault(pid, []).append(task)
    # Creation order within each project.
    for tasks in by_project.values():
        tasks.sort(key=lambda a: str(a.get("createdAt")))
    return by_project


def build_keys(settings):
    return {
        "linearApiKey": settings.get("linearApiKey"),
        "langsmithApiKey": settings.get("langsmithApiKey"),
        "langsmithTracing": settings.get("langsmithTracing"),
        "langsmithProject": settings.get("langsmithProject"),
        "langsmithEndpoint": settings.get("langsmithEndpoint"),
        "agentRuntime": settings.get("agentRuntime"),
        "workflowPattern": settings.get("workflowPattern"),
    }


def readiness_fingerprint():
    data = store.read_store()
    settings = data.get("settings") or {}
    relevant = {
        "repositoryProvider": settings.get("repositoryProvider"),
        "repositoryUrl": settings.get("repositoryUrl"),
        "githubToken": settings.get("githubToken"),
        "gitlabToken": settings.get("gitlabToken"),
        "llmProvider": settings.get("llmProvider"),
        "localLlmProvider": settings.get("localLlmProvider"),
        "ollamaHost": settings.get("ollamaHost"),
        "ollamaModel": settings.get("ollamaModel"),
        "lmstudioHost": settings.get("lmstudioHost"),
        "lmstudioModel": settings.get("lmstudioModel"),
        "omlxHost": settings.get("omlxHost"),
        "omlxModel": settings.get("omlxModel"),
        "omlxApiKey": settings.get("omlxApiKey"),
        "huggingfaceHost": settings.get("huggingfaceHost"),
        "huggingfaceModel": settings.get("huggingfaceModel"),
        "huggingfaceApiKey": settings.get("huggingfaceApiKey"),
        "codexModel": settings.get("codexModel"),
        "codexTokens": settings.get("codexTokens"),
        "claudeModel": settings.get("claudeModel"),
        "claudeTokens": settings.get("claudeTokens"),
        "businesses": [
            {
                "projectId": b.get("projectId"),
                "repo": b.get("repo"),
                "repoProvider": b.get("repoProvider"),
            }
            for b in (data.get("businesses") or [])
        ],
    }
    # The digest is process-private and never returned by status(); credentials
    # are therefore useful for change detection without entering logs or the UI.
    return hashlib.sha256(json.dumps(relevant, sort_keys=True).encode("utf-8")).hexdigest()


def repository_selection_for_task(task):
    business = store.get_business_by_project_id((task.get("project") or {}).get("id"))
    repository = store.get_repository_config()
    return resolve_planned_repository(
        business=business,
        global_repository=repository,
        configured_repo_url=CONFIG.CODER.repoUrl,
        token_for_provider=store.get_repository_token,
    )


def probe_key(resource, value):
    return hashlib.sha256(f"{resource}:{json.dumps(value, sort_keys=True)}".encode("utf-8")).hexdigest()


async def cached_readiness_probe(key, probe):
    cached = readiness_cache.get(key)
    if cached is not None:
        return await cached

    async def _run():
        return await probe()

    task = asyncio.ensure_future(_run())
    readiness_cache[key] = task
    try:
        return await task
    finally:
        if readiness_cache.get(key) is task:
            readiness_cache.pop(key, None)


async def preflight_task(task, resolve_role, dependencies=None):
    """Resolve and verify every external dependency before dispatch creates a job
    or moves the task to In Progress. The repository check runs FIRST: a 403 from
    GitHub/GitLab therefore has no task or job side effects."""
    dependencies = dependencies or {}
    role = model_role_for_task(task)
    selection_for_task = dependencies.get("repository_selection_for_task") or repository_selection_for_task
    repository_probe = dependencies.get("probe_repository_availability") or probe_repository_availability
    model_probe = dependencies.get("probe_model_availability") or probe_model_availability
    run_probe = dependencies.get("cached_readiness_probe") or cached_readiness_probe
    try:
        selection = selection_for_task(task)
    except Exception as error:
        provider = store.get_repository_config()["provider"]
        status_val = getattr(error, "status", None) or getattr(error, "statusCode", None)
        try:
            status_num = int(status_val)
        except (TypeError, ValueError):
            status_num = 0
        raise AgentAvailabilityError(
            "git",
            public_availability_message("git", {"provider": provider}),
            status_num or 400,
            getattr(error, "code", None) or "git_not_configured",
        )
    git_key = probe_key(
        "git",
        {"provider": selection["provider"], "repoRef": selection["repoRef"], "token": selection["token"]},
    )
    await run_probe(git_key, lambda: repository_probe(selection))

    llm = await resolve_role(role)
    model_key = probe_key(
        "model",
        {
            "provider": llm.get("provider"),
            "backend": llm.get("backend"),
            "host": llm.get("host"),
            "baseUrl": llm.get("baseUrl"),
            "model": llm.get("model"),
            "accessToken": llm.get("accessToken"),
            "accountId": llm.get("accountId"),
        },
    )
    await run_probe(model_key, lambda: model_probe(llm))
    return {"role": role, "selection": selection, "llm": llm}


async def dispatch_ready_task(task, resolve_role, ctx, dependencies=None):
    dependencies = dependencies or {}
    readiness = await preflight_task(task, resolve_role, dependencies)
    before = dependencies.get("before_dispatch")
    if callable(before):
        before(readiness)
    dispatch_impl = dependencies.get("dispatch") or dispatch
    completion = dispatch_impl(
        task,
        {
            **ctx,
            "llm": readiness["llm"],
            "role": readiness["role"],
            "repositoryProvider": readiness["selection"]["provider"],
            "repositoryToken": readiness["selection"]["token"],
            "repositoryUrl": readiness["selection"]["repoRef"],
        },
        dependencies.get("dispatch_dependencies"),
    )
    # Fire-and-forget: schedule the coder run in the background (its slot is
    # already reserved synchronously by dispatch()).
    if inspect.isawaitable(completion):
        completion = asyncio.ensure_future(completion)
    return {**readiness, "completion": completion}


async def preflight_and_pause(task, resolve_role, dependencies=None):
    """Readiness guard for direct/manual coder requests. Unlike the board poll it
    has no dispatch lifecycle to catch the error, so establish the same global
    pause here and re-raise with only the sanitized pause reason attached."""
    dependencies = dependencies or {}
    role = model_role_for_task(task or {})
    try:
        return await preflight_task(task or {}, resolve_role, dependencies)
    except Exception as error:
        resource = "git" if (is_repository_availability_error(error) or getattr(error, "resource", None) == "git") else "model"
        repository = store.get_repository_config()
        reason = pause(
            resource,
            error,
            {
                "task": task or None,
                "taskIdentifier": (task or {}).get("identifier"),
                "role": role,
                "provider": repository["provider"] if resource == "git" else None,
            },
        )
        try:
            error.pause_reason = reason
        except Exception:
            availability_error = AgentAvailabilityError(resource, reason["message"])
            availability_error.pause_reason = reason
            raise availability_error from error
        raise error


def pause(resource, error, context=None):
    global pause_reason, pause_context
    context = context or {}
    if not pause_reason or pause_reason.get("resource") != resource:
        pause_reason = pause_reason_for(resource, error, context)
    pause_context = {
        "resource": resource,
        "task": context.get("task") or None,
        "role": context.get("role") or None,
        "fingerprint": readiness_fingerprint(),
        "nextProbeAt": _now_ms() + RECOVERY_PROBE_MS,
    }
    log.warn(f"Code-writer paused: {pause_reason['message']}")
    return pause_reason


def clear_pause(source="manual resume"):
    global pause_reason, pause_context
    if not pause_reason:
        return False
    log.info(f"Code-writer availability pause cleared ({source}).")
    pause_reason = None
    pause_context = None
    readiness_cache.clear()
    return True


def pause_for_runtime_error(error, context=None):
    """Convert only a genuine runtime Git/model outage into monitor pause state."""
    context = context or {}
    repository_unavailable = is_repository_availability_error(error)
    model_unavailable = (not repository_unavailable) and is_model_availability_error(error)
    if not repository_unavailable and not model_unavailable:
        return None
    resource = "git" if repository_unavailable else "model"
    llm = context.get("llm") or {}
    return pause(
        resource,
        error,
        {
            "task": context.get("task") or None,
            "taskIdentifier": context.get("taskIdentifier") or (context.get("task") or {}).get("identifier"),
            "role": context.get("role"),
            "provider": context.get("repositoryProvider") if resource == "git" else llm.get("provider"),
            "model": llm.get("model") if (resource == "model" and context.get("llm")) else None,
        },
    )


def _resolve_llm(settings, role="global"):
    from ai_fleet.agent.llm import resolve_llm  # lazy: llm module ported separately

    return resolve_llm(settings, role)


async def recover_pause(settings, dependencies=None):
    dependencies = dependencies or {}
    if not pause_reason or not pause_context:
        return True
    fingerprint = dependencies.get("readiness_fingerprint") or readiness_fingerprint
    now = dependencies.get("now") or _now_ms
    resolve = dependencies.get("resolve_llm") or _resolve_llm
    model_probe = dependencies.get("probe_model_availability") or probe_model_availability
    selection_for_task = dependencies.get("repository_selection_for_task") or repository_selection_for_task
    repository_probe = dependencies.get("probe_repository_availability") or probe_repository_availability
    changed = fingerprint() != pause_context["fingerprint"]
    if not changed and now() < pause_context["nextProbeAt"]:
        return False

    try:
        if pause_context["resource"] == "model":
            llm = await resolve(settings, pause_context.get("role") or "global")
            await model_probe(llm)
        else:
            selection = selection_for_task(pause_context.get("task") or {})
            await repository_probe(selection)
        clear_pause("settings changed and readiness passed" if changed else "periodic readiness probe passed")
        return True
    except Exception:
        pause_context["fingerprint"] = fingerprint()
        pause_context["nextProbeAt"] = now() + RECOVERY_PROBE_MS
        return False


def create_coding_job(task, job_store=None):
    """Persist a coding-run job (kind 'coding') so it shows in the UI job list."""
    job_store = job_store or store
    now = _iso_now()
    job = {
        "id": str(uuid.uuid4()),
        "kind": "coding",
        "projectId": task["project"]["id"],
        "projectName": task["project"].get("name"),
        "taskIdentifier": task.get("identifier"),
        "taskTitle": task.get("title"),
        "taskUrl": task.get("url"),
        "status": "running",
        "createdAt": now,
        "updatedAt": now,
        "startedAt": now,
        "finishedAt": None,
        "error": None,
        "summary": None,
        "steps": [],
    }
    job_store.add_job(job)
    return job


def parse_verdict(final_text):
    """Parse the agent's end-of-run verdict. A ```verdict {json}``` block is
    preferred; a plain ``VERDICT: <status> — <reason>`` line is also accepted.
    Defaults to 'insufficient' so an unclear run always leaves the queue."""
    text = str(final_text or "")
    m = re.search(r'\{[^{}]*"status"\s*:\s*"(completed|insufficient)"[^{}]*\}', text, re.IGNORECASE)
    if m:
        try:
            obj = json.loads(m.group(0))
            status = "completed" if str(obj.get("status") or "").lower() == "completed" else "insufficient"
            return {
                "status": status,
                "reason": str(obj.get("reason") or "").strip(),
                "pr": (str(obj.get("pr") or "").strip() or None),
            }
        except Exception:
            pass  # fall through to the line form
    line = re.search(r"VERDICT\s*[:=]\s*(completed|insufficient)\b[\s\-–—:]*(.*)", text, re.IGNORECASE)
    if line:
        status = "completed" if line.group(1).lower() == "completed" else "insufficient"
        return {"status": status, "reason": (line.group(2) or "").strip(), "pr": None}
    return {"status": "insufficient", "reason": "The agent did not emit a clear completion verdict.", "pr": None}


def dispatch(task, ctx, dependencies=None):
    """Dispatch one planned task (fire-and-forget; releases its slot on completion).

    The synchronous prologue reserves the slot in ``running`` and creates the job
    exactly as the JS ``dispatch`` does before its first ``await``; the returned
    coroutine performs start → coder → finalize and always frees the slot."""
    dependencies = dependencies or {}
    job_store = dependencies.get("store") or store
    start_issue_impl = dependencies.get("start_issue") or start_issue
    finish_issue_impl = dependencies.get("finish_issue") or finish_issue
    run_planned_coder_impl = dependencies.get("run_planned_coder") or run_planned_coder

    running[task["id"]] = {
        "identifier": task.get("identifier"),
        "projectId": task["project"]["id"],
        "startedAt": _now_ms(),
    }

    # Track this coding run as a job so it is visible in the UI with a live step
    # trace, not just in the server log.
    job = create_coding_job(task, job_store)
    phase = {"value": "linear-start"}

    def step(message, level="info"):
        fn = getattr(log, level, None)
        if not callable(fn):
            fn = log.info
        fn(f"[coder {task.get('identifier')}] {message}")
        job_store.append_job_step(job["id"], {"ts": _iso_now(), "level": level, "message": message})

    async def _run():
        try:
            # 1. Take ownership of the task's state: move it to "In Progress".
            state = await start_issue_impl(ctx["apiKey"], issue_id=task["id"], on_step=step)
            # 2. Run the coder and derive a verdict.
            phase["value"] = "agent"
            issue = {**task, "state": (state or {}).get("name") or task.get("state")}
            try:
                r = await run_planned_coder_impl(
                    issue=issue,
                    project=task["project"],
                    llm=ctx.get("llm"),
                    api_key=ctx.get("apiKey"),
                    keys=ctx.get("keys"),
                    repository_provider=ctx.get("repositoryProvider"),
                    repository_token=ctx.get("repositoryToken"),
                    repository_url=ctx.get("repositoryUrl"),
                    on_step=step,
                )
                verdict = parse_verdict((r or {}).get("finalText"))
            except Exception as err:
                # Availability failures are not task outcomes — bubble them to the
                # outer handler so the monitor pauses and leaves the issue in progress.
                if is_repository_availability_error(err) or is_model_availability_error(err):
                    raise
                message = _msg(err)
                step(f"Coder run did not complete: {message}", "error")
                r = None
                verdict = {"status": "insufficient", "reason": f"Coder run did not complete: {message}", "pr": None}

            # 3. Finalize: Done + aidone (completed) | aifail (insufficient).
            phase["value"] = "linear-finish"
            pr = verdict.get("pr")
            reason_txt = verdict.get("reason")
            step(
                f"Verdict: {verdict['status']}"
                f"{f' (PR {pr})' if pr else ''}"
                f"{f' — {reason_txt}' if reason_txt else ''}"
            )
            await finish_issue_impl(
                ctx["apiKey"], issue_id=task["id"], outcome=verdict["status"], reason=reason_txt, on_step=step
            )
            job_store.update_job(
                job["id"],
                {
                    "status": "done",
                    "finishedAt": _iso_now(),
                    "error": None,
                    "summary": {
                        "coding": True,
                        "outcome": verdict["status"],
                        "reason": reason_txt or None,
                        "pr": pr or None,
                        "branch": ((r or {}).get("branch") if r else None),
                        "finalText": str((r or {}).get("finalText") or "")[:2000] if r else "",
                    },
                },
            )
        except Exception as err:
            reason = (
                pause_for_runtime_error(
                    err,
                    {
                        "task": task,
                        "role": ctx.get("role"),
                        "repositoryProvider": ctx.get("repositoryProvider"),
                        "llm": ctx.get("llm"),
                    },
                )
                if phase["value"] == "agent"
                else None
            )
            if reason:
                step(f"Agent jobs paused: {reason['message']}", "warn")
                job_store.update_job(
                    job["id"],
                    {
                        # Keep the persisted job lifecycle on its established four
                        # states; the monitor-level pause is exposed by status().
                        "status": "error",
                        "finishedAt": _iso_now(),
                        "error": reason["message"],
                        "summary": {"coding": True, "paused": True, "pauseReason": reason},
                    },
                )
                return
            # Linear-side failure — leave it for the next poll to retry.
            message = _msg(err)
            step(f"Failed: {message}", "error")
            job_store.update_job(job["id"], {"status": "error", "finishedAt": _iso_now(), "error": message})
        finally:
            running.pop(task["id"], None)

    return _run()


def project_busy(project_id):
    """True when this project still has any task in flight (guards the aidone stamp)."""
    return any(r.get("projectId") == project_id for r in running.values())


def resolve_max_concurrent():
    """Effective concurrent-coder cap. Prefers the UI-editable agent-config value
    (``maxConcurrentCoders``), falling back to the ``CODER_MAX_CONCURRENT`` env default."""
    try:
        cfg = store.get_agent_config()
        n = float(cfg.get("maxConcurrentCoders")) if isinstance(cfg, dict) else float("nan")
        if math.isfinite(n) and n >= 1:
            return math.floor(n)
    except Exception:
        pass  # fall through to the env-backed default
    return CONFIG.CODER.maxConcurrent


async def poll_once():
    """One poll+dispatch cycle. Serialized (never overlaps itself)."""
    settings = store.get_settings()
    if not settings.get("linearApiKey"):
        log.warn("Coder poll skipped: add a Linear API key in Settings.")
        return {"skipped": "missing-linear-key"}
    if pause_reason and not (await recover_pause(settings)):
        return {"skipped": "paused", "pauseReason": pause_reason}
    try:
        projects = await fetch_planned_projects(settings["linearApiKey"])
        tasks_by_project = await fetch_planned_tasks(settings["linearApiKey"])
    except Exception as err:
        log.warn(f"Coder poll: fetch failed: {_msg(err)}")
        return {"skipped": "planning-provider-unavailable"}

    repository = store.get_repository_config()
    ctx = {
        "apiKey": settings["linearApiKey"],
        "keys": build_keys(settings),
        "repositoryProvider": repository["provider"],
        "repositoryToken": repository["token"],
        "repositoryUrl": repository["url"],
    }
    # Resolve each role's provider at most once per tick, on demand. Resolution can
    # throw; we cache the awaitable and skip only the tasks that need an unavailable
    # role rather than failing the whole poll.
    role_llm: dict = {}

    def resolve_role(role):
        if role not in role_llm:
            role_llm[role] = asyncio.ensure_future(_resolve_awaitable(settings, role))
        return role_llm[role]

    cap = resolve_max_concurrent()
    for project in projects:
        tasks = tasks_by_project.get(project["id"]) or []
        # No open tasks left → the project is fully coded; mark it aidone (once),
        # but only when nothing for it is still in flight.
        if not tasks:
            if not project_busy(project["id"]):
                asyncio.ensure_future(_apply_aidone_safe(settings["linearApiKey"], project))
            continue
        if len(running) >= cap:
            break  # global cap

        dispatched_for_project = 0
        for nxt in tasks:
            if len(running) >= cap:
                break
            if nxt["id"] in running or (nxt.get("blockers") and len(nxt["blockers"])):
                continue
            role = model_role_for_task(nxt)
            try:
                await dispatch_ready_task(
                    nxt,
                    resolve_role,
                    ctx,
                    {
                        "before_dispatch": (
                            lambda readiness, _n=nxt, _p=project, _role=role: log.info(
                                f"Dispatching {_n['identifier']} (\"{_p['name']}\", created {_n['createdAt']}, "
                                f"{_role} agent → {readiness['llm'].get('provider')}) via {CONFIG.CODER.backend} backend."
                            )
                        )
                    },
                )
                dispatched_for_project += 1
            except Exception as err:
                resource = "git" if (is_repository_availability_error(err) or getattr(err, "resource", None) == "git") else "model"
                reason = pause(
                    resource,
                    err,
                    {
                        "task": nxt,
                        "taskIdentifier": nxt.get("identifier"),
                        "role": role,
                        "provider": store.get_repository_config()["provider"] if resource == "git" else None,
                    },
                )
                return {"skipped": "paused", "pauseReason": reason}
        # Nothing dispatched despite free capacity → the remaining tasks are blocked.
        if not dispatched_for_project and len(running) < cap:
            head = next((t for t in tasks if t.get("blockers") and len(t["blockers"]) and t["id"] not in running), None)
            if head:
                log.info(f"Project \"{project['name']}\": next task {head['identifier']} blocked by {', '.join(head['blockers'])}.")
        if len(running) >= cap:
            break  # cap reached; stop scanning further projects
    return {"dispatched": True}


async def _resolve_awaitable(settings, role):
    result = _resolve_llm(settings, role)
    if inspect.isawaitable(result):
        return await result
    return result


async def _apply_aidone_safe(api_key, project):
    try:
        await apply_aidone(api_key, project=project, on_step=lambda m, *a: log.info(f"[coder {project['name']}] {m}"))
        log.info(f'Project "{project["name"]}" fully coded → aidone.')
    except Exception as err:
        log.warn(f'aidone for "{project["name"]}" failed: {_msg(err)}')


def start():
    """Start the board monitor (idempotent). Serializes ticks so they never overlap."""
    global started, timer
    resumed = clear_pause("monitor start requested")
    if started:
        return {"started": True, "already": True, "resumed": resumed}
    started = True

    async def _loop():
        while started:
            try:
                await poll_once()
            except Exception as err:
                log.warn(f"Coder poll tick failed: {_msg(err)}")
            if not started:
                break
            await asyncio.sleep(CONFIG.CODER.pollIntervalMs / 1000)

    timer = asyncio.ensure_future(_loop())
    log.info(
        f"Code-writer monitor started (aiplanned flow, every {CONFIG.CODER.pollIntervalMs} ms, "
        f"max {resolve_max_concurrent()} concurrent)."
    )
    return {"started": True, "resumed": resumed}


def resume():
    resumed = clear_pause("manual resume")
    if not started:
        start()
    return {**status(), "resumed": resumed}


def stop():
    global started, timer
    started = False
    if timer is not None:
        timer.cancel()
    timer = None
    log.info("Code-writer monitor stopped.")
    return {"started": False}


def status():
    """Snapshot for status endpoints."""
    return {
        "running": started,
        "paused": bool(pause_reason),
        "pauseReason": pause_reason,
        "plannedLabel": CONFIG.CODER.plannedLabel,
        "backend": CONFIG.CODER.backend,
        "maxConcurrent": resolve_max_concurrent(),
        "inFlight": [{"identifier": r.get("identifier"), "startedAt": r.get("startedAt")} for r in running.values()],
    }


_test = types.SimpleNamespace(
    clear_pause=clear_pause,
    pause=pause,
    recover_pause=recover_pause,
    readiness_fingerprint=readiness_fingerprint,
    resolve_max_concurrent=resolve_max_concurrent,
)
