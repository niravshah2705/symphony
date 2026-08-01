"""Software-design planning agent (port of packages/shared/src/agent/plan.js).

Built on the workflow-driven agent framework. The drafting step is a framework
workflow (`workflows/planning.py`): a skill-loading deep agent (skills:
software-planning + web-research; tools: web_search) that produces a SOFTWARE
DESIGN plan — engineering milestones and buildable issues, NO go-to-market/
business tasks. The surrounding pipeline keeps the safety model:
  1. Feasibility — is this a software product we can design and build?
  2. Grounded research (web_search) per design phase.
  3. Framework draft (skills-driven software design).
  4. Structured extraction -> schema validation -> deterministic apply (the
     server disposes; the LLM never writes to Linear directly).
Each call is LangSmith-traced.

The LLM (``ai_fleet.agent.llm``) is imported lazily inside the functions that
call it — the heavy LangChain provider stack stays off the import path (mirrors
the JS ``lazy require``).
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone

from pydantic import ValidationError

from ai_fleet.agent import framework
from ai_fleet.agent.schema import PlanSchema, ResumeSchema, ViabilitySchema, normalize_plan
from ai_fleet.agent.search import format_results, web_search, web_search_many
from ai_fleet.agent.trace_annotations import with_annotations


class AgentError(Exception):
    """Planning-agent error carrying an HTTP status + machine code (JS AgentError)."""

    def __init__(self, message, status=400, code="agent_error", cause=None):
        super().__init__(message)
        self.name = "AgentError"
        self.message = message
        self.status = status
        self.code = code
        self.cause = cause


def configure_tracing(keys):
    """Toggle LangSmith/LangChain tracing env vars from the per-run keys. Returns
    True when tracing is enabled (a key + the tracing flag are both present)."""
    keys = keys or {}
    on = bool(keys.get("langsmithTracing") and keys.get("langsmithApiKey"))
    flag = "true" if on else "false"
    os_environ = _os_environ()
    os_environ["LANGSMITH_TRACING"] = flag
    os_environ["LANGCHAIN_TRACING_V2"] = flag
    if on:
        os_environ["LANGSMITH_API_KEY"] = keys.get("langsmithApiKey")
        os_environ["LANGCHAIN_API_KEY"] = keys.get("langsmithApiKey")
        os_environ["LANGSMITH_PROJECT"] = keys.get("langsmithProject") or "linear-manager"
        os_environ["LANGCHAIN_PROJECT"] = keys.get("langsmithProject") or "linear-manager"
        os_environ["LANGSMITH_ENDPOINT"] = keys.get("langsmithEndpoint") or "https://api.smith.langchain.com"
        os_environ["LANGCHAIN_ENDPOINT"] = keys.get("langsmithEndpoint") or "https://api.smith.langchain.com"
    return on


def _os_environ():
    import os

    return os.environ


def project_context_block(project):
    project = project or {}
    return "\n".join(
        [
            "<project_context>",
            f"name: {project.get('name') or ''}",
            f"current_state: {project.get('state') or 'unknown'}",
            f"existing_description: {project.get('description') or '(none)'}",
            f"start_date: {project.get('startDate') or '(none)'}",
            f"target_date: {project.get('targetDate') or '(none)'}",
            "</project_context>",
        ]
    )


def research_topic(project):
    # Keep it short — long queries return no web results.
    project = project or {}
    words = " ".join(str(project.get("description") or "").split()[:4])
    return f"{project.get('name') or ''} {words}".strip()


def build_feasibility_prompt(*, project, today, search_text):
    return "\n".join(
        [
            "As a pragmatic tech lead, decide whether this project is a software product/system",
            "that can realistically be DESIGNED AND BUILT (an app, service, API, or platform).",
            "",
            'Return ONLY JSON: {"viable": boolean, "reason": string}.',
            "- viable=true if it is buildable software with a clear feature set to engineer.",
            "- viable=false if it is not software, is mainly physical/manual operations, or is",
            "  too vague to design and build.",
            f"Today is {today}.",
            "",
            project_context_block(project),
            "",
            "<web_research>",
            search_text,
            "</web_research>",
        ]
    )


def build_draft_prompt(*, project, today, config):
    config = config or {}
    return "\n".join(
        [
            f"Today is {today}.",
            f"Produce at most {config.get('maxMilestones')} engineering milestones and at most",
            f"{config.get('maxIssuesPerMilestone')} issues per milestone.",
            "Follow your software-planning skill. Use web_search a FEW times (~5 total) to check",
            "sensible feature scope, data behavior, API/integration behavior, and quality concerns,",
            "then STOP calling tools and write the SOFTWARE DEVELOPMENT plan as text: feature-focused",
            "engineering milestones with buildable issues. Prefer milestones such as Data-backed",
            "Feature Foundations, Core User Features, APIs & Integrations, Admin/Internal Features,",
            "and Feature Quality & Hardening.",
            "",
            "Write each issue as a DETAILED, VERBOSE user story — not a one-liner. For every issue include:",
            "  • Context / why: what problem it solves and how it fits the design.",
            "  • What to build: the concrete behavior, data, and interfaces/components involved.",
            "  • How: implementation approach, key modules/files, and notable edge cases or failure modes.",
            "  • A relative T-shirt size (XS, S, or M) reflecting effort/complexity.",
            "  • Thorough, checkable acceptance criteria (definition of done).",
            "Strictly do NOT create architecture-only tasks, research spikes, system-design tasks,",
            "repo scaffolding tasks, or generic foundation/setup tasks. Every issue must implement,",
            "change, or test a concrete product feature, API/domain behavior, UI flow, data behavior,",
            "or integration behavior that can ship in one PR.",
            "Keep issues small: use XS/S/M only. If a candidate issue feels L or XL, split it into",
            "multiple XS/S/M feature slices instead of emitting a large task.",
            "Do NOT include go-to-market, marketing, branding, or business tasks,",
            "and do NOT include CI/CD, deployment, release, DevOps, or infrastructure/provisioning tasks.",
            "",
            project_context_block(project),
        ]
    )


def build_extract_prompt(*, project, today, config, draft, research):
    config = config or {}
    shape = "\n".join(
        [
            "{",
            '  "description": string (>=10 chars; the software-development feature overview),',
            '  "milestones": [',
            '    { "name": string, "description": string, "startDate": "YYYY-MM-DD",',
            '      "targetDate": "YYYY-MM-DD",',
            '      "evaluationCriteria": string (exit condition — how to verify this milestone is achieved),',
            '      "issues": [ { "title": string, "description": string (DETAILED/verbose — see below), "priority": 0-4,',
            '        "tshirtSize": "XS"|"S"|"M" (relative effort/complexity of this task; never L/XL),',
            '        "evaluationCriteria": string (acceptance criteria / definition of done for this engineering task) } ] }',
            "  ],",
            '  "dependencies": [ { "fromMilestone": int, "fromIssue": int, "toMilestone": int, "toIssue": int } ]',
            "}",
        ]
    )

    return "\n".join(
        [
            "Return ONLY one JSON object (no prose) with exactly this shape:",
            shape,
            "",
            "This is a SOFTWARE DEVELOPMENT plan (engineering work), NOT a business/go-to-market plan.",
            'Milestones must be feature-focused engineering phases (e.g. "Data-backed Feature',
            'Foundations", "Core User Features", "APIs & Integrations", "Admin/Internal Features",',
            '"Feature Quality & Hardening"). Every issue is a buildable engineering task with concrete acceptance criteria.',
            "NEVER include",
            "architecture-only tasks, research spikes, system-design tasks, repo scaffolding tasks,",
            "or generic foundation/setup tasks. Every issue must implement, change, or test a",
            "concrete product feature, API/domain behavior, UI flow, data behavior, or integration behavior.",
            "Also NEVER include marketing, branding, sales, pricing, growth, or business-metric",
            "tasks, and NEVER include CI/CD, deployment, release, DevOps, or infrastructure/provisioning tasks.",
            'Write each issue "description" as a DETAILED, VERBOSE user story (multiple paragraphs,',
            "aim for 120+ words): the context/why, exactly what to build (behavior, data, interfaces,",
            "components/files involved), the implementation approach, and edge cases / failure modes.",
            "Do NOT write terse one-line descriptions.",
            'Give every issue a "tshirtSize" of XS, S, or M only:',
            "XS = trivial/localized change; S = small; M = moderate. Do not emit L or XL.",
            "If a task feels L/XL, split it into multiple XS/S/M feature slices before returning JSON.",
            'Use "dependencies" to link an issue to any issue that must land before it (acyclic).',
            f"Constraints: at most {config.get('maxMilestones')} milestones and {config.get('maxIssuesPerMilestone')} issues each.",
            f"Dates valid YYYY-MM-DD, targetDate on/after startDate, start on/after {today}.",
            "",
            project_context_block(project),
            "",
            "<software_design_draft>",
            draft or "(no draft; derive the design from the project context and research)",
            "</software_design_draft>",
            "",
            "<web_research>",
            research,
            "</web_research>",
        ]
    )


def today_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def parse_json_loose(text):
    """Parse model JSON output, tolerating markdown fences and surrounding prose —
    some local models wrap ``format:'json'`` output in ```json ... ``` regardless."""
    s = str(text).strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", s, re.IGNORECASE)
    if fence:
        s = fence.group(1).strip()
    try:
        return json.loads(s)
    except Exception:
        block = re.search(r"[{\[][\s\S]*[}\]]", s)
        if block:
            return json.loads(block.group(0))
        raise ValueError("no JSON object found in model output")


def is_llm_usable(llm):
    """True when a provider descriptor has everything needed to run."""
    if not llm or not llm.get("model"):
        return False
    if llm.get("provider") == "codex":
        return bool(llm.get("accessToken") and llm.get("baseUrl"))
    if llm.get("provider") == "claude":
        return bool(llm.get("accessToken"))
    return bool(llm.get("host"))  # Local host-based providers.


def _meta_get(msg, key):
    if isinstance(msg, dict):
        return msg.get(key)
    return getattr(msg, key, None)


async def json_call(llm, prompt, run_name, run_id=None, business=None):
    """One constrained JSON call to the active provider; returns the parsed object
    (raises on bad JSON). ``run_id`` sets the LangSmith run id; ``business``
    ({project, taskId, session}) stamps the standard annotation onto the trace."""
    from ai_fleet.agent import llm as llm_module

    model = llm_module.create_chat_model(llm, json=True)
    config = {"runName": run_name[:60], "tags": ["enrich", "linear-manager"]}
    if run_id:
        config["runId"] = run_id
    config = with_annotations(config, business)
    try:
        msg = await model.ainvoke(prompt, config)
    except Exception as err:
        # Output hit the token budget (finish_reason: length) — the JSON is truncated.
        m = getattr(err, "message", None) or str(err)
        if re.search(r"length limit|max_tokens|finish_reason.*length", m, re.IGNORECASE):
            raise Exception(
                f'output was truncated at the {llm.get("numTokens")}-token budget — raise "Num tokens" in '
                "Settings → LLM (reasoning models need extra headroom)"
            )
        raise
    # Reasoning-model-aware: falls back to reasoning_content when content is empty.
    text = framework.message_text(msg)
    if not text or not text.strip():
        usage = (_meta_get(msg, "response_metadata") or {}).get("usage") or {}
        reasoning = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0
        detail = f" ({reasoning} reasoning tokens, no answer content)" if reasoning else ""
        raise Exception(
            f"model returned empty output{detail}"
            ' — if this is a reasoning model, set the local OpenAI-compatible JSON output mode to "Prompt-only text"'
        )
    return parse_json_loose(text)


def build_resume_prompt(*, project, milestones, config, research):
    config = config or {}
    list_text = "\n".join(
        f"{i + 1}. {m.get('name')}"
        + (f" — {str(m.get('description'))[:160]}" if m.get("description") else "")
        for i, m in enumerate(milestones)
    )
    shape = (
        '{ "milestones": [ { "name": string, "evaluationCriteria": string, "issues": '
        '[ { "title": string, "description": string, "priority": 0-4, "tshirtSize": "XS"|"S"|"M", '
        '"evaluationCriteria": string } ] } ] }'
    )
    return "\n".join(
        [
            "You are a TECH LEAD. For EACH existing milestone listed below, produce concrete",
            "SOFTWARE engineering tasks (issues) to accomplish it. Do NOT invent business/GTM tasks.",
            f"Return ONLY JSON: {shape}",
            "Give every milestone a measurable evaluationCriteria, and every issue an",
            "acceptance-criteria (evaluationCriteria = definition of done).",
            'Write each issue "description" as a DETAILED, VERBOSE user story (context/why, what to',
            "build, implementation approach, edge cases) — not a one-liner.",
            "Strictly do NOT create architecture-only tasks, research spikes, system-design tasks,",
            "repo scaffolding tasks, or generic foundation/setup tasks. Every issue must implement,",
            "change, or test concrete product behavior that can ship in one PR.",
            'Give every issue a "tshirtSize" of XS, S, or M only. Avoid L and XL entirely;',
            "split large work into multiple XS/S/M feature slices.",
            'Return one entry per milestone, in the SAME ORDER and with the same "name".',
            f"At most {config.get('maxIssuesPerMilestone')} tasks per milestone.",
            "",
            "Existing milestones:",
            list_text,
            "",
            project_context_block(project),
            "",
            "<web_research>",
            research,
            "</web_research>",
        ]
    )


async def generate_issues_for_milestones(*, project, milestones, config=None, llm=None, keys=None, on_step=None):
    """Resume path: given a project's EXISTING milestones, research and generate the
    tasks (issues) for them. Returns tasks per milestone (same order as input)."""
    step = on_step if callable(on_step) else (lambda message, level="info": None)
    if not is_llm_usable(llm):
        raise AgentError("Configure the deep-agent LLM in Settings → LLM.", 400)
    traced = configure_tracing(keys)
    run_id = str(uuid.uuid4())

    step(f"Reviewing {len(milestones)} existing milestone(s); researching tasks in parallel…")
    scoped = milestones[:6]
    resume_results = await web_search_many(
        [f"{project.get('name') or ''} {m.get('name')} implementation tasks checklist".strip() for m in scoped],
        3,
    )  # concurrent
    parts = []
    for i, r in enumerate(resume_results):
        step(f"🔎 web search: \"{r['query']}\" ({len(r['snippets'])} results)")
        parts.append(f"## {scoped[i].get('name')}\n{format_results(r['snippets'])}")
    research = "\n\n".join(parts)

    step("Requesting tasks for existing milestones (format=json)…")
    try:
        raw = await json_call(
            llm,
            build_resume_prompt(project=project, milestones=milestones, config=config, research=research),
            f"resume-json:{project.get('name')}",
            run_id=run_id,
            business={"project": project.get("name"), "session": run_id},
        )
    except Exception as err:
        raise AgentError(
            f"The model did not return valid tasks: {getattr(err, 'message', None) or err}",
            502,
            code="model_call_failed",
            cause=err,
        )
    try:
        parsed = ResumeSchema.model_validate(raw)
    except ValidationError as err:
        raise AgentError(f"Tasks failed validation: {_first_issue(err)}", 502, code="model_output_invalid")

    max_issues = max(0, (config or {}).get("maxIssuesPerMilestone") or 5)
    gen_milestones = [
        {"name": m.name, "issues": [i.model_dump() for i in m.issues[:max_issues]]} for m in parsed.milestones
    ]
    issue_count = sum(len(m["issues"]) for m in gen_milestones)
    step(f"Generated {issue_count} task(s) for {len(gen_milestones)} milestone(s).")

    trace_url = await _finish_trace(traced, run_id, keys)
    return {"milestones": gen_milestones, "traceUrl": trace_url, "traced": traced}


async def generate_plan(*, project, assumed_role=None, config=None, llm=None, keys=None, on_step=None):
    """Run the software-design planning agent. Returns a dict with viable/reason/
    plan/traceUrl/runId/traced."""
    step = on_step if callable(on_step) else (lambda message, level="info": None)
    if not is_llm_usable(llm):
        raise AgentError("Configure the deep-agent LLM in Settings → LLM.", 400)

    traced = configure_tracing(keys)
    host = f" @ {llm.get('host')}" if llm.get("host") else ""
    step(f"Tracing {'enabled' if traced else 'disabled'}; provider {llm.get('provider')}, model {llm.get('model')}{host}")

    today = today_iso()
    topic = research_topic(project)
    run_id = str(uuid.uuid4())
    trace_meta = with_annotations(
        {
            "runName": f"enrich:{project.get('name')}"[:60],
            "tags": ["enrich", "linear-manager"],
            "metadata": {"projectId": project.get("id"), "assumedRole": assumed_role.get("id") if assumed_role else None},
        },
        {"project": project.get("name"), "session": run_id},
    )

    # ---- Step 1: feasibility (web research + verdict) ----
    step("Assessing software feasibility (web research)…")
    feas_query = f"{topic} software architecture how to build feasibility"
    feas_results = await web_search(feas_query, 5)
    step(f'🔎 web search: "{feas_query}" ({len(feas_results)} results)')

    viable = True
    reason = "Feasibility check inconclusive; proceeding."
    try:
        raw = await json_call(
            llm,
            build_feasibility_prompt(project=project, today=today, search_text=format_results(feas_results)),
            f"feasibility:{project.get('name')}",
            business={"project": project.get("name"), "session": run_id},
        )
        try:
            parsed = ViabilitySchema.model_validate(raw)
            viable = parsed.viable
            reason = parsed.reason
        except ValidationError:
            step("Feasibility response invalid; proceeding by default.", "warn")
    except Exception as err:
        detail = (getattr(err, "message", None) or str(err))[:100]
        step(f"Feasibility check failed ({detail}); proceeding.", "warn")

    if not viable:
        step(f"Not buildable: {reason[:160]}", "warn")
        return {"viable": False, "reason": reason, "traceUrl": await _finish_trace(traced, run_id, keys), "runId": run_id, "traced": traced}
    step(f"Buildable: {reason[:160]}")

    # ---- Step 2: per-phase engineering research (grounds the design) ----
    step("Researching software design in parallel (architecture, features, testing)…")
    phase_queries = [
        {"label": "Architecture & stack", "q": f"{topic} recommended architecture tech stack"},
        {"label": "Core features", "q": f"{topic} core features to build MVP"},
        {"label": "Testing & quality", "q": f"{topic} testing strategy best practices"},
    ]
    phase_results = await web_search_many([p["q"] for p in phase_queries], 4)  # concurrent
    research_parts = []
    for i, r in enumerate(phase_results):
        step(f"🔎 web search: \"{r['query']}\" ({len(r['snippets'])} results)")
        research_parts.append(f"## {phase_queries[i]['label']}\n{format_results(r['snippets'])}")
    research = "\n\n".join(research_parts)

    # ---- Step 3: framework draft (software-design planner workflow) ----
    draft = ""
    step("Drafting software design (planning workflow: skills + web_search)…")
    try:
        workflow = framework.load_workflow("planning")
        result = await framework.run_workflow(
            workflow,
            llm,
            build_draft_prompt(project=project, today=today, config=config),
            ctx={"step": step},
            invoke_config={"runId": run_id, **trace_meta},
            runtime=(keys or {}).get("agentRuntime") or "deepagent",
            workflow_pattern=(keys or {}).get("workflowPattern") or "sequential",
        )
        draft = result.get("finalText") or ""
        step(f"Planning workflow draft ready ({len(draft)} chars).")
    except Exception as err:
        draft = ""
        detail = (getattr(err, "message", None) or str(err))[:120]
        step(f"Planning workflow skipped: {detail}", "warn")

    # ---- Step 4: structured software-design plan ----
    step("Requesting structured software-design plan (format=json)…")
    try:
        raw = await json_call(
            llm,
            build_extract_prompt(project=project, today=today, config=config, draft=draft, research=research),
            f"enrich-json:{project.get('name')}",
            business={"project": project.get("name"), "session": run_id},
        )
    except Exception as err:
        raise AgentError(
            f"The model did not return a valid plan: {getattr(err, 'message', None) or err}",
            502,
            code="model_call_failed",
            cause=err,
        )

    try:
        parsed = PlanSchema.model_validate(raw)
    except ValidationError as err:
        raise AgentError(f"Plan failed validation: {_first_issue(err)}", 502, code="model_output_invalid")

    plan = normalize_plan(
        parsed,
        {"maxMilestones": (config or {}).get("maxMilestones"), "maxIssuesPerMilestone": (config or {}).get("maxIssuesPerMilestone")},
    )
    issue_count = sum(len(m["issues"]) for m in plan["milestones"])
    step(f"Plan ready: {len(plan['milestones'])} milestones, {issue_count} issues, {len(plan['dependencies'])} dependencies.")

    return {"viable": True, "plan": plan, "traceUrl": await _finish_trace(traced, run_id, keys), "runId": run_id, "traced": traced}


def _first_issue(err: ValidationError) -> str:
    """First pydantic error message (mirrors JS ``error.issues[0].message``)."""
    errs = err.errors()
    return errs[0]["msg"] if errs else str(err)


async def _finish_trace(traced, run_id, keys):
    if not traced:
        return None
    try:
        return await resolve_trace_url(run_id, keys)
    except Exception:
        return None


async def resolve_trace_url(run_id, keys):
    """Best-effort LangSmith run URL. The Python SDK differs from the JS client
    (``get_run_url`` needs a RunBase, and there is no ``getProjectUrl``), so we
    read the run then build its URL; any failure yields None via ``_finish_trace``."""
    keys = keys or {}
    from langsmith import Client

    client = Client(api_key=keys.get("langsmithApiKey"), api_url=keys.get("langsmithEndpoint"))
    run = client.read_run(run_id)
    return client.get_run_url(run=run)
