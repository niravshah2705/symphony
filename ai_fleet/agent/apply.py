"""Deterministic server-side application of enrichment plans to Linear.

Port of ``packages/shared/src/agent/apply.js``. The LLM proposes, the server
disposes: every Linear write here is performed by our own code (not an
autonomous tool call), a hard guardrail per the ai-prompt-injection checklist.

Resilient by design: a single milestone/issue/dependency failure is recorded as
a warning and does not abort the rest of the plan.
"""

from __future__ import annotations

import inspect

from ai_fleet import linear
from ai_fleet.config import CONFIG
from ai_fleet.agent.schema import normalize_tshirt_size


def _err_msg(err) -> str:
    """JS ``err && err.message ? err.message : String(err)``."""
    msg = getattr(err, "message", None)
    return msg if msg else str(err)


def _cfg(config, key):
    """Read a config field, tolerating either a dict (store contract, camelCase
    keys) or an attribute-style object."""
    if config is None:
        return None
    if isinstance(config, dict):
        return config.get(key)
    return getattr(config, key, None)


def _make_step(on_step):
    """Wrap the optional ``on_step`` callback into a ``step(message, level=None)``
    function. Mirrors the JS ``const step = typeof onStep === 'function' ? onStep
    : () => {}`` — a no-op when no callback is provided.

    The JS callback is called with either ``(message)`` or ``(message, 'warn')``
    and extra args are ignored. Python is stricter about arity, so we only pass
    the level when the callback can accept a second positional argument.
    """
    if not callable(on_step):
        return lambda message, level=None: None

    accepts_level = True
    try:
        params = list(inspect.signature(on_step).parameters.values())
        positional = [
            p for p in params
            if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)
        ]
        has_var_positional = any(p.kind == p.VAR_POSITIONAL for p in params)
        accepts_level = has_var_positional or len(positional) >= 2
    except (ValueError, TypeError):
        accepts_level = True

    def step(message, level=None):
        if level is not None and accepts_level:
            on_step(message, level)
        else:
            on_step(message)

    return step


async def _resolve_task_label_id(api_key, step):
    """Resolve the AI task-label id once per apply run so every created issue can
    be stamped with it (Step 2). Best-effort: on failure returns None and issues
    are created unlabeled rather than aborting the plan."""
    try:
        label = await linear.get_or_create_issue_label(api_key, CONFIG.CODER.taskLabel)
        return label["id"]
    except Exception as err:
        step(f'Could not resolve "{CONFIG.CODER.taskLabel}" issue label: {_err_msg(err)}', "warn")
        return None


def _with_criteria(base, label, criteria):
    """Append a labelled criteria block to a description (no-op if empty)."""
    b = base or ""
    if not criteria:
        return b
    prefix = f"{b}\n\n" if b else ""
    return f"{prefix}**{label}:** {criteria}"


def _model_label_for_size(size):
    """The model-routing label for a T-shirt size: XS → local, larger → hosted."""
    if size == str(CONFIG.CODER.localSize).upper():
        return CONFIG.CODER.localModelLabel
    return CONFIG.CODER.hostedModelLabel


def _make_label_resolver(api_key, step):
    """Memoized issue-label resolver: getOrCreate each distinct label name once
    per apply run and cache its id. Best-effort — a failure caches None so the
    issue is created without that label rather than aborting the whole plan."""
    cache: dict = {}

    async def resolve(name):
        if not name:
            return None
        if name in cache:
            return cache[name]
        try:
            label = await linear.get_or_create_issue_label(api_key, name)
            cache[name] = label["id"]
            return label["id"]
        except Exception as err:
            step(f'Could not resolve "{name}" issue label: {_err_msg(err)}', "warn")
            cache[name] = None
            return None

    return resolve


def _make_model_label_resolver(api_key, step):
    """Memoized resolver for the model-routing label (local/hosted), resolved as
    a member of the "Models" label group so Linear shows it as a single-select
    dropdown. Best-effort: on failure it falls back to an ungrouped label, then
    to None, so a labelling hiccup never aborts issue creation."""
    cache: dict = {}
    group_name = CONFIG.CODER.modelLabelGroup

    async def resolve(name):
        if not name:
            return None
        if name in cache:
            return cache[name]
        label_id = None
        try:
            label_id = (await linear.get_or_create_grouped_issue_label(api_key, group_name, name))["id"]
        except Exception as err:
            step(f'Could not group "{name}" under "{group_name}": {_err_msg(err)}', "warn")
            try:
                label_id = (await linear.get_or_create_issue_label(api_key, name))["id"]
            except Exception as err2:
                step(f'Could not resolve "{name}" issue label: {_err_msg(err2)}', "warn")
        cache[name] = label_id
        return label_id

    return resolve


async def _issue_label_ids(resolve_label, resolve_model_label, task_label_id, size):
    """Label ids to stamp on an issue: task label + T-shirt size + model label."""
    size_name = normalize_tshirt_size(size)  # always a valid XS|S|M|L|XL
    size_id = await resolve_label(size_name)
    model_id = await resolve_model_label(_model_label_for_size(size_name))
    return [label_id for label_id in (task_label_id, size_id, model_id) if label_id]


async def apply_plan(api_key, *, project, plan, assumed_role, config, on_step=None):
    """Apply a validated, normalized enrichment plan to a Linear project using the
    stored Linear token. Writes are deterministic (not performed by the LLM)."""
    step = _make_step(on_step)
    warnings: list = []
    summary = {"milestonesCreated": 0, "issuesCreated": 0, "dependenciesCreated": 0, "warnings": warnings}

    team = (await linear.get_project_team(api_key, project["id"]))["team"]
    step(f"Applying plan to Linear (team {team.get('key') or team.get('name')}).")
    task_label_id = await _resolve_task_label_id(api_key, step) if _cfg(config, "createIssues") else None
    resolve_label = _make_label_resolver(api_key, step)
    resolve_model_label = _make_model_label_resolver(api_key, step)

    # 1. Assign the assumed role as project lead (claims the open project).
    if _cfg(config, "autoAssignLead") and assumed_role and assumed_role.get("id"):
        try:
            await linear.set_project_lead(api_key, project["id"], assumed_role["id"])
            step(f"Assigned lead: {assumed_role.get('name')}.")
        except Exception as err:
            warnings.append(f"Lead assignment failed: {_err_msg(err)}")
            step(f"Lead assignment failed: {_err_msg(err)}", "warn")

    # 2. Enrich the project description.
    try:
        await linear.update_project_description(api_key, project["id"], plan["description"])
        step("Updated project description.")
    except Exception as err:
        warnings.append(f"Description update failed: {_err_msg(err)}")
        step(f"Description update failed: {_err_msg(err)}", "warn")

    # 3. Create milestones. Linear milestones only carry a targetDate, so the
    #    start date is preserved in the description as an explicit timeline line.
    issue_id_matrix: list = []  # [milestoneIndex][issueIndex] -> issueId
    for milestone in plan["milestones"]:
        name = milestone.get("name")
        start_date = milestone.get("startDate")
        target_date = milestone.get("targetDate")
        timeline_note = f"**Timeline:** {start_date} → {target_date}"
        description = f"{timeline_note}\n\n{milestone['description']}" if milestone.get("description") else timeline_note
        description = _with_criteria(description, "Evaluation criteria", milestone.get("evaluationCriteria"))

        try:
            created_milestone = await linear.create_milestone(
                api_key,
                project["id"],
                name,
                description=description,
                target_date=target_date or "",
            )
            summary["milestonesCreated"] += 1
            step(f"Created milestone: {name} ({start_date} → {target_date}).")
        except Exception as err:
            warnings.append(f'Milestone "{name}" failed: {_err_msg(err)}')
            step(f'Milestone "{name}" failed: {_err_msg(err)}', "warn")
            issue_id_matrix.append([])
            continue

        # 4. Create issues for this milestone.
        issue_ids: list = []
        if _cfg(config, "createIssues"):
            for issue in milestone.get("issues") or []:
                title = issue.get("title")
                try:
                    label_ids = await _issue_label_ids(resolve_label, resolve_model_label, task_label_id, issue.get("tshirtSize"))
                    created = await linear.create_issue(
                        api_key,
                        team["id"],
                        project["id"],
                        title,
                        project_milestone_id=created_milestone["id"],
                        description=_with_criteria(issue.get("description"), "Acceptance criteria", issue.get("evaluationCriteria")),
                        priority=issue.get("priority"),
                        label_ids=label_ids if label_ids else None,
                    )
                    issue_ids.append(created["id"])
                    summary["issuesCreated"] += 1
                except Exception as err:
                    issue_ids.append(None)
                    warnings.append(f'Issue "{title}" failed: {_err_msg(err)}')
                    step(f'Issue "{title}" failed: {_err_msg(err)}', "warn")
            ok = len([x for x in issue_ids if x])
            if ok:
                step(f'Created {ok} issue(s) under "{name}".')
        issue_id_matrix.append(issue_ids)

    # 5. Create dependencies (from blocks to). Indices were already validated in
    #    normalize_plan; we re-check the resolved IDs before writing.
    if _cfg(config, "addDependencies") and _cfg(config, "createIssues"):
        for dep in plan.get("dependencies") or []:
            from_id = _safe_at(issue_id_matrix, dep["fromMilestone"], dep["fromIssue"])
            to_id = _safe_at(issue_id_matrix, dep["toMilestone"], dep["toIssue"])
            if not from_id or not to_id or from_id == to_id:
                continue
            try:
                await linear.create_issue_relation(api_key, from_id, to_id, type_="blocks")
                summary["dependenciesCreated"] += 1
            except Exception as err:
                warnings.append(f"Dependency failed: {_err_msg(err)}")
                step(f"Dependency failed: {_err_msg(err)}", "warn")
        if summary["dependenciesCreated"]:
            step(f"Created {summary['dependenciesCreated']} dependency link(s).")

    return summary


async def apply_issues_for_milestones(api_key, *, project, milestones, generated, config, on_step=None):
    """Resume path: create issues for EXISTING milestones that currently have
    none. ``generated`` holds tasks per milestone (same order as ``milestones``);
    matched by index, then by name as a fallback."""
    step = _make_step(on_step)
    warnings: list = []
    summary = {"milestonesCreated": 0, "issuesCreated": 0, "dependenciesCreated": 0, "warnings": warnings, "resumed": True}
    if not _cfg(config, "createIssues"):
        return summary

    team = (await linear.get_project_team(api_key, project["id"]))["team"]
    step(f"Creating tasks for {len(milestones)} milestone(s) (team {team.get('key') or team.get('name')}).")
    task_label_id = await _resolve_task_label_id(api_key, step)
    resolve_label = _make_label_resolver(api_key, step)
    resolve_model_label = _make_model_label_resolver(api_key, step)

    for i in range(len(milestones)):
        milestone = milestones[i]
        m_name = milestone.get("name")
        match = generated[i] if i < len(generated) else None
        if not match:
            wanted = (m_name or "").lower()
            match = next((g for g in generated if (g.get("name") or "").lower() == wanted), None)
        issues = (match.get("issues") if match else None) or []

        # Add the milestone's evaluation criteria to its description (if any).
        if match and match.get("evaluationCriteria"):
            try:
                await linear.update_milestone(
                    api_key,
                    milestone["id"],
                    _with_criteria(milestone.get("description"), "Evaluation criteria", match.get("evaluationCriteria")),
                )
                step(f'Added evaluation criteria to "{m_name}".')
            except Exception as err:
                warnings.append(f"Milestone criteria update failed: {_err_msg(err)}")

        created = 0
        for issue in issues:
            title = issue.get("title")
            try:
                label_ids = await _issue_label_ids(resolve_label, resolve_model_label, task_label_id, issue.get("tshirtSize"))
                await linear.create_issue(
                    api_key,
                    team["id"],
                    project["id"],
                    title,
                    project_milestone_id=milestone["id"],
                    description=_with_criteria(issue.get("description"), "Acceptance criteria", issue.get("evaluationCriteria")),
                    priority=issue.get("priority"),
                    label_ids=label_ids if label_ids else None,
                )
                created += 1
                summary["issuesCreated"] += 1
            except Exception as err:
                warnings.append(f'Issue "{title}" failed: {_err_msg(err)}')
                step(f'Issue "{title}" failed: {_err_msg(err)}', "warn")
        if created:
            step(f'Created {created} task(s) under "{m_name}".')
    return summary


async def apply_aidone(api_key, *, project, on_step=None):
    """Mark a project complete: switch its label to ``aidone`` (replacing others)."""
    step = _make_step(on_step)
    try:
        label = await linear.get_or_create_project_label(api_key, "aidone")
        await linear.set_project_labels(api_key, project["id"], [label["id"]])
        step('Set project label to "aidone".')
    except Exception as err:
        step(f"aidone label failed: {_err_msg(err)}", "warn")


async def apply_aiplanned(api_key, *, project, on_step=None):
    """Mark a project as PLANNED: switch its label to ``aiplanned`` (replacing the
    enrich label). Drops the project out of the planning set and signals the
    coding flow to start working its tasks in dependency order."""
    step = _make_step(on_step)
    try:
        label = await linear.get_or_create_project_label(api_key, "aiplanned")
        await linear.set_project_labels(api_key, project["id"], [label["id"]])
        step('Set project label to "aiplanned".')
    except Exception as err:
        step(f"aiplanned label failed: {_err_msg(err)}", "warn")


async def apply_aifail(api_key, *, project, reason, on_step=None):
    """Handle a project judged NOT viable: append a note to the project
    description and switch its label to ``aifail`` (replacing existing labels so
    it leaves the enrichment set and is not retried)."""
    step = _make_step(on_step)
    note = f"\n\n---\n**AI viability check — not a fit for a software-driven solution.**\nReason: {reason}"
    next_description = f"{project.get('description') or ''}{note}".strip()

    try:
        await linear.update_project_description(api_key, project["id"], next_description)
        step("Added viability note to project description.")
    except Exception as err:
        step(f"Description note failed: {_err_msg(err)}", "warn")

    try:
        label = await linear.get_or_create_project_label(api_key, "aifail")
        await linear.set_project_labels(api_key, project["id"], [label["id"]])
        step('Set project label to "aifail".')
    except Exception as err:
        step(f"Label update failed: {_err_msg(err)}", "warn")

    return {"aifail": True, "reason": reason, "milestonesCreated": 0, "issuesCreated": 0, "dependenciesCreated": 0, "warnings": []}


# --------------------- Coder issue state transitions -------------------- #


async def start_issue(api_key, *, issue_id, on_step=None):
    """Move a coder task to "In Progress" (a ``started`` state) before the agent
    runs. Idempotent: an issue already started/completed is left as-is. Returns
    the resulting state (or None if the team has no started state)."""
    step = _make_step(on_step)
    detail = await linear.get_issue_detail(api_key, issue_id)
    state = detail.get("state")
    type_ = state.get("type") if state else None
    if type_ in ("started", "completed", "canceled"):
        return state or None  # already in/after progress — nothing to do
    target = linear.pick_state_by_type(
        await linear.get_team_states(api_key, detail["team"]["id"]),
        "started",
        "In Progress",
    )
    if not target:
        step('No "In Progress" workflow state on this team; leaving state unchanged.', "warn")
        return state or None
    await linear.update_issue(api_key, issue_id, {"stateId": target["id"]})
    step(f'Moved issue to "{target["name"]}".')
    return target


async def finish_issue(api_key, *, issue_id, outcome, reason=None, on_step=None):
    """Finish a coder task per the agent's verdict: move it to Done (a
    ``completed`` state) and stamp the outcome label on the ISSUE — ``aidone``
    when completed, ``aifail`` when insufficient — creating the label if missing
    and appending it to the issue's existing labels. An insufficient reason is
    posted as a comment."""
    step = _make_step(on_step)
    label_name = "aidone" if outcome == "completed" else "aifail"
    detail = await linear.get_issue_detail(api_key, issue_id)

    # Resolve (create-if-missing) the outcome label, appended to existing labels.
    label_ids = None
    try:
        label = await linear.get_or_create_issue_label(api_key, label_name)
        nodes = (detail.get("labels") or {}).get("nodes") or []
        current = [l["id"] for l in nodes]
        label_ids = list(dict.fromkeys([*current, label["id"]]))
    except Exception as err:
        step(f'Could not resolve "{label_name}" issue label: {_err_msg(err)}', "warn")

    done = linear.pick_state_by_type(
        await linear.get_team_states(api_key, detail["team"]["id"]),
        "completed",
        "Done",
    )
    update_input: dict = {}
    if done:
        update_input["stateId"] = done["id"]
    if label_ids:
        update_input["labelIds"] = label_ids
    if update_input:
        await linear.update_issue(api_key, issue_id, update_input)
    done_label = f'"{done["name"]}"' if done else "(no Done state found)"
    step(f'Marked issue {done_label} + label "{label_name}".')

    # Record the reason a task was judged insufficient (for the human triaging).
    if outcome != "completed" and reason:
        try:
            await linear.create_comment(api_key, issue_id, f"**AI coder — insufficient to complete.**\n\n{reason}")
            step("Posted insufficiency reason as a comment.")
        except Exception as err:
            step(f"Comment failed: {_err_msg(err)}", "warn")
    return {"labelName": label_name, "done": bool(done)}


def _safe_at(matrix, i, j):
    """JS ``matrix[i] && matrix[i][j] ? matrix[i][j] : null`` (indices >= 0)."""
    row = matrix[i] if 0 <= i < len(matrix) else None
    if not row:
        return None
    value = row[j] if 0 <= j < len(row) else None
    return value or None
