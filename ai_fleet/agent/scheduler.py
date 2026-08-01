"""Enrichment job queue + self-scheduling loop (port of agent/scheduler.js).

Jobs are processed on a configurable cadence (5/10/15 min, "to avoid fast
processing"), with configurable per-tick parallelism and a hard cap on projects
per tick. Ticks never overlap. The Linear/LLM/LangSmith keys are read fresh from
the store on every tick (no long-lived credential cache).

The JS module keeps a mutable ``runtime`` object and re-arms a ``setTimeout``.
This port keeps the same single mutable ``runtime`` dict but drives the cadence
with asyncio timers (``loop.call_later``), so it lives inside the planner
service's running event loop. ``process_pending`` / ``process_approval_deadlines``
stay directly callable (without starting the real loop) so they are test-friendly.

The LLM module (``ai_fleet.agent.llm``) is imported lazily where used — the heavy
LangChain provider stack stays off the import path (mirrors the JS ``lazy require``).
"""

from __future__ import annotations

import asyncio
import time
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

from ai_fleet import linear, logger, store
from ai_fleet.agent import apply, availability, plan
from ai_fleet.config import CONFIG

DEFAULT_INTERVAL_MINUTES = 5
RESTART_KICKOFF_MS = 4000


def _iso_now() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _iso_from_ms(ms: int) -> str:
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _err_message(err) -> str:
    msg = getattr(err, "message", None)
    return msg if msg else str(err)


def _resolve_interval_minutes(config) -> int:
    """Resolve the configured cadence, falling back to an allowed default."""
    raw = (config or {}).get("intervalMinutes")
    try:
        n = float(raw)
    except (TypeError, ValueError):
        n = None
    if n is not None and n in CONFIG.INTERVAL_OPTIONS:
        return int(n)
    return DEFAULT_INTERVAL_MINUTES


def interval_ms(config) -> int:
    return _resolve_interval_minutes(config) * 60 * 1000


# The single mutable scheduler state (mirrors the JS module-level `runtime`).
runtime = {
    "timer": None,
    "is_ticking": False,
    "last_run_at": None,
    "next_run_at": None,
    "last_error": None,
    "pause_reason": None,
}


def pause_for_model(error, settings, llm=None):
    if not runtime["pause_reason"]:
        provider = llm.get("provider") if isinstance(llm, dict) else None
        if not provider:
            from ai_fleet.agent import llm as llm_module

            provider = llm_module.provider_for_role(settings, "thinking")
        model = llm.get("model") if isinstance(llm, dict) else None
        runtime["pause_reason"] = availability.pause_reason_for(
            "model", error, {"provider": provider, "model": model, "role": "thinking"}
        )
    runtime["last_error"] = runtime["pause_reason"]["message"]
    return runtime["pause_reason"]


def clear_model_pause():
    cleared = bool(runtime["pause_reason"])
    runtime["pause_reason"] = None
    if cleared:
        logger.info("Planner model availability pause cleared.")


async def verify_model_readiness(settings, dependencies=None):
    dependencies = dependencies or {}
    resolve = dependencies.get("resolve_llm")
    probe = dependencies.get("probe_model_availability") or availability.probe_model_availability
    if resolve is None:
        from ai_fleet.agent import llm as llm_module

        resolve = llm_module.resolve_llm
    llm = None
    try:
        llm = await resolve(settings, "thinking")
        await probe(llm)
        clear_model_pause()
        runtime["last_error"] = None
        return llm
    except Exception as error:
        pause_for_model(error, settings, llm)
        raise


def enqueue(*, project_id, project_name=None, assumed_role=None):
    """Queue a project for enrichment, skipping duplicates already in flight."""
    active = any(
        j.get("projectId") == project_id and j.get("status") in ("pending", "running")
        for j in store.list_jobs("enrichment")
    )
    if active:
        return None

    job = {
        "id": str(uuid.uuid4()),
        "kind": "enrichment",
        "projectId": project_id,
        "projectName": project_name or project_id,
        "status": "pending",
        "assumedRole": {"id": assumed_role.get("id"), "name": assumed_role.get("name")} if assumed_role else None,
        "createdAt": _iso_now(),
        "updatedAt": _iso_now(),
        "startedAt": None,
        "finishedAt": None,
        "error": None,
        "traceUrl": None,
        "traced": False,
        "summary": None,
        "steps": [],
    }
    store.add_job(job)
    return job


async def run_job(job, params, dependencies=None):
    """Run one enrichment job end-to-end, recording a step trace on the job.

    ``params`` is a dict with ``apiKey`` / ``keys`` / ``llm`` / ``config``.
    """
    dependencies = dependencies or {}
    api_key = params.get("apiKey")
    keys = params.get("keys")
    llm = params.get("llm")
    config = params.get("config")

    job_store = dependencies.get("store") or store
    linear_client = dependencies.get("linear") or linear
    generate_plan_impl = dependencies.get("generate_plan") or plan.generate_plan
    generate_issues_impl = dependencies.get("generate_issues_for_milestones") or plan.generate_issues_for_milestones
    apply_plan_impl = dependencies.get("apply_plan") or apply.apply_plan
    apply_issues_impl = dependencies.get("apply_issues_for_milestones") or apply.apply_issues_for_milestones
    apply_aiplanned_impl = dependencies.get("apply_aiplanned") or apply.apply_aiplanned
    apply_aifail_impl = dependencies.get("apply_aifail") or apply.apply_aifail
    get_settings = dependencies.get("get_settings") or store.get_settings

    # Records a step both to the persistent log file and onto the job (for the UI).
    def step(message, level="info"):
        fn = getattr(logger, level, None)
        if fn:
            fn(f"[job {job['id'][:8]} · {job.get('projectName')}] {message}")
        else:
            logger.info(message)
        job_store.append_job_step(job["id"], {"ts": _iso_now(), "level": level, "message": message})

    def finish(patch):
        return job_store.update_job(job["id"], {"status": "done", "finishedAt": _iso_now(), "error": None, **patch})

    job_store.update_job(job["id"], {"status": "running", "startedAt": _iso_now(), "error": None, "pauseReason": None})
    step("Enrichment started.")
    phase = "planning-provider"
    try:
        # Inspect existing milestones to decide: NEW plan vs RESUME (create issues).
        data = await linear_client.get_milestones_with_issue_counts(api_key, job["projectId"])
        project = data.get("project")
        milestones = data.get("milestones") or []

        if len(milestones) > 0:
            # ---- RESUME: milestones already exist; ensure each has issues, then aidone.
            missing = [m for m in milestones if m.get("issueCount") == 0]
            step(f"Found {len(milestones)} existing milestone(s); {len(missing)} without issues.")
            summary = {"milestonesCreated": 0, "issuesCreated": 0, "dependenciesCreated": 0, "warnings": [], "resumed": True}
            if missing and config.get("createIssues"):
                phase = "model"
                gen = await generate_issues_impl(
                    project=project, milestones=missing, config=config, llm=llm, keys=keys, on_step=step
                )
                phase = "planning-provider"
                summary = await apply_issues_impl(
                    api_key, project=project, milestones=missing, generated=gen["milestones"], config=config, on_step=step
                )
                await apply_aiplanned_impl(api_key, project=project, on_step=step)
                step(f"Resumed: created {summary['issuesCreated']} task(s); marked aiplanned.")
                finish({"traceUrl": gen["traceUrl"], "traced": gen["traced"], "summary": summary})
            else:
                await apply_aiplanned_impl(api_key, project=project, on_step=step)
                step("All milestones already have issues; marked aiplanned.")
                finish({"summary": summary})
            return {"done": True}

        # ---- NEW: no milestones yet — viability + full software-design plan.
        phase = "model"
        result = await generate_plan_impl(
            project=project, assumed_role=job.get("assumedRole"), config=config, llm=llm, keys=keys, on_step=step
        )
        phase = "planning-provider"

        if not result.get("viable"):
            summary = await apply_aifail_impl(api_key, project=project, reason=result.get("reason"), on_step=step)
            step(f"Marked aifail: {str(result.get('reason'))[:160]}", "warn")
            finish({"traceUrl": result.get("traceUrl"), "traced": result.get("traced"), "summary": summary})
            return {"done": True}

        summary = await apply_plan_impl(
            api_key, project=project, plan=result.get("plan"), assumed_role=job.get("assumedRole"), config=config, on_step=step
        )
        # Mark aiplanned once issues exist (or when issue creation is disabled) — the
        # project is now planned and ready for the coding flow to work its tasks.
        if summary.get("issuesCreated", 0) > 0 or not config.get("createIssues"):
            await apply_aiplanned_impl(api_key, project=project, on_step=step)
        warn_note = f", {len(summary['warnings'])} warning(s)" if summary.get("warnings") else ""
        step(
            f"Done: {summary['milestonesCreated']} milestones, {summary['issuesCreated']} issues, "
            f"{summary['dependenciesCreated']} deps{warn_note}."
        )
        finish({"traceUrl": result.get("traceUrl"), "traced": result.get("traced"), "summary": summary})
        return {"done": True}
    except Exception as err:
        if phase == "model" and availability.is_model_availability_error(err):
            reason = pause_for_model(err, get_settings(), llm)
            step(f"Agent jobs paused: {reason['message']}", "warn")
            job_store.update_job(
                job["id"],
                {"status": "pending", "startedAt": None, "finishedAt": None, "error": reason["message"], "pauseReason": reason},
            )
            return {"paused": True, "pauseReason": reason}
        message = _err_message(err)
        step(f"Failed: {message}", "error")
        job_store.update_job(job["id"], {"status": "error", "finishedAt": _iso_now(), "error": message})
        return {"error": message}


async def discover(*, api_key, assumed_role, config):
    """Auto-discover projects that still carry an enrich label and enqueue any
    without an in-flight job. Returns the count of newly queued projects."""
    candidates = await linear.get_projects_with_labels(api_key, config.get("enrichLabels"))
    in_flight = {
        j.get("projectId") for j in store.list_jobs("enrichment") if j.get("status") in ("pending", "running")
    }
    queued = 0
    for project in candidates:
        if project.get("id") in in_flight:
            continue
        job = enqueue(project_id=project.get("id"), project_name=project.get("name"), assumed_role=assumed_role)
        if job:
            queued += 1
            logger.info(f'Queued "{project.get("name")}" for enrichment.')
    return queued


async def process_pending():
    """Process one tick: auto-discover by label, then enrich. Never overlaps."""
    if runtime["is_ticking"]:
        return {"skipped": "already-running"}
    runtime["is_ticking"] = True
    runtime["last_run_at"] = _iso_now()
    logger.info("Scheduler tick started.")
    try:
        api_key = store.get_api_key()
        settings = store.get_settings()
        config = store.get_agent_config()
        assumed_role = store.get_assumed_role()

        if not api_key:
            runtime["last_error"] = "Add your Linear API key in Settings."
            logger.warn(f"Tick skipped: {runtime['last_error']}")
            return {"skipped": "missing-keys", "reason": runtime["last_error"]}

        from ai_fleet.agent import llm as llm_module

        if not llm_module.llm_ready(settings, "thinking"):
            reason = pause_for_model(Exception(llm_module.not_ready_reason(settings, "thinking")), settings)
            logger.warn(f"Tick skipped: {reason['message']}")
            return {"skipped": "paused", "reason": reason["message"], "pauseReason": reason}
        if not assumed_role:
            runtime["last_error"] = "Assume a role in Settings to enable automatic enrichment."
            logger.warn(f"Tick skipped: {runtime['last_error']}")
            return {"skipped": "no-role", "reason": runtime["last_error"]}
        runtime["last_error"] = None

        # Resolve the active provider (refreshes the Codex OAuth token if needed).
        try:
            llm = await verify_model_readiness(settings)
        except Exception:
            reason = runtime["pause_reason"]
            logger.warn(f"Tick skipped: {reason['message']}")
            return {"skipped": "paused", "reason": reason["message"], "pauseReason": reason}
        keys = {
            "langsmithApiKey": settings.get("langsmithApiKey"),
            "langsmithProject": settings.get("langsmithProject"),
            "langsmithEndpoint": settings.get("langsmithEndpoint"),
            "langsmithTracing": settings.get("langsmithTracing"),
            "agentRuntime": settings.get("agentRuntime"),
            "workflowPattern": settings.get("workflowPattern"),
        }

        # 1. Discover projects to enrich automatically (by label).
        discovered = 0
        try:
            discovered = await discover(api_key=api_key, assumed_role=assumed_role, config=config)
        except Exception as err:
            runtime["last_error"] = f"Discovery failed: {_err_message(err)}"

        # 2. Process the pending queue, bounded by config.
        pending = [j for j in store.list_jobs("enrichment") if j.get("status") == "pending"]
        batch = pending[: max(1, config.get("maxProjectsPerRun") or 1)]
        concurrency = max(1, min(config.get("parallelProcessing") or 1, len(batch) or 1))

        logger.info(f"Tick: discovered {discovered}, processing {len(batch)} (parallel {concurrency}).")

        async def worker(job):
            if runtime["pause_reason"]:
                return {"skipped": "paused"}
            return await run_job(job, {"apiKey": api_key, "keys": keys, "llm": llm, "config": config})

        await run_with_concurrency(batch, concurrency, worker)
        store.prune_jobs()
        logger.info(f"Tick finished (processed {len(batch)}).")
        if runtime["pause_reason"]:
            return {"discovered": discovered, "processed": len(batch), "paused": True, "pauseReason": runtime["pause_reason"]}
        return {"discovered": discovered, "processed": len(batch)}
    except Exception as err:
        runtime["last_error"] = _err_message(err)
        logger.error(f"Tick error: {runtime['last_error']}")
        return {"error": runtime["last_error"]}
    finally:
        runtime["is_ticking"] = False


async def process_approval_deadlines(deps=None):
    """Auto-approve requirement-evaluation gates whose deadline has elapsed. Runs
    every cadence, INDEPENDENT of the Linear-key/role/LLM guards in
    ``process_pending`` — a missing Linear key must never stall auto-approval.
    Errors are swallowed (logged) so a bad gate cannot break the scheduling loop."""
    deps = deps or {}
    sweep = deps.get("sweep_expired_gates")
    if sweep is None:
        from ai_fleet.agent.approval_gate import sweep_expired_gates as sweep
    try:
        return await sweep(int(time.time() * 1000), deps.get("gate_deps") or {})
    except Exception as err:
        logger.warn(f"Approval-gate sweep failed: {_err_message(err)}")
        return {"error": True}


async def run_with_concurrency(items, limit, worker):
    """Simple bounded-concurrency pool (asyncio.Semaphore + gather)."""
    semaphore = asyncio.Semaphore(max(1, limit))

    async def run_one(item):
        async with semaphore:
            return await worker(item)

    return await asyncio.gather(*(run_one(item) for item in items))


# --------------------------------------------------------------------------- #
# self-scheduling loop
# --------------------------------------------------------------------------- #
def _loop():
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.get_event_loop()


def schedule_next():
    """Self-scheduling loop: reads the cadence from config each cycle so interval
    changes (5/10/15) take effect on the next tick. Never runs immediately — the
    cadence intentionally throttles processing."""
    ms = interval_ms(store.get_agent_config())
    runtime["next_run_at"] = _iso_from_ms(int(time.time() * 1000) + ms)
    runtime["timer"] = _loop().call_later(ms / 1000, lambda: asyncio.ensure_future(_tick()))


async def _tick():
    config = store.get_agent_config()
    if config.get("scheduleEnabled"):
        # Approval deadlines first, independent of process_pending's key/role guards.
        try:
            await process_approval_deadlines()
        except Exception:
            pass
        try:
            await process_pending()
        except Exception:
            pass
    schedule_next()


def start_scheduler():
    if runtime["timer"]:
        return
    interrupted = store.reconcile_running_jobs()
    if interrupted:
        logger.warn(f"Marked {interrupted} interrupted job(s) as error after restart.")
    minutes = interval_ms(store.get_agent_config()) // 60000
    logger.info(f"Scheduler started (every {minutes} min).")
    schedule_next()
    # On restart, promptly review existing milestones and resume issue creation.
    _loop().call_later(RESTART_KICKOFF_MS / 1000, lambda: asyncio.ensure_future(_restart_kickoff()))


async def _restart_kickoff():
    if store.get_agent_config().get("scheduleEnabled"):
        logger.info("Restart resume pass…")
        # Fire any approval deadlines that elapsed while the server was down.
        try:
            await process_approval_deadlines()
        except Exception:
            pass
        try:
            await process_pending()
        except Exception:
            pass


def get_status():
    config = store.get_agent_config()
    jobs = store.list_jobs("enrichment")
    return {
        "intervalMinutes": _resolve_interval_minutes(config),
        "scheduleEnabled": config.get("scheduleEnabled"),
        "isTicking": runtime["is_ticking"],
        "lastRunAt": runtime["last_run_at"],
        "nextRunAt": runtime["next_run_at"],
        "lastError": runtime["last_error"],
        "paused": bool(runtime["pause_reason"]),
        "pauseReason": runtime["pause_reason"],
        "counts": {
            "pending": sum(1 for j in jobs if j.get("status") == "pending"),
            "running": sum(1 for j in jobs if j.get("status") == "running"),
            "done": sum(1 for j in jobs if j.get("status") == "done"),
            "error": sum(1 for j in jobs if j.get("status") == "error"),
        },
    }


# Test seam mirroring the JS module's `_test` export.
_test = SimpleNamespace(
    clear_model_pause=clear_model_pause,
    pause_for_model=pause_for_model,
    run_job=run_job,
    verify_model_readiness=verify_model_readiness,
    process_approval_deadlines=process_approval_deadlines,
)
