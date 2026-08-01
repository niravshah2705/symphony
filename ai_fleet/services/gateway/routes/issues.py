"""Issues routes (port of services/gateway/src/routes/issues.js).

Create a single confirmed implementation task in a selected project (the server
derives the team and owns the Linear mutation), render the project board grouped
into workflow-state columns, and move an issue between states (board drag).

Idempotency: a module-level ``task_requests`` dict dedupes create requests by
``projectId:idempotencyKey`` for the life of the process (single-process, matches
the JS ``taskRequests`` Map). A reused key with different content is a 409; a
reused key with the same content replays the original result once.
"""

from __future__ import annotations

import asyncio
import json
import math
import re

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ai_fleet import store, linear
from ai_fleet.services.common import json_body

router = APIRouter()

task_requests: dict = {}
MAX_TASK_REQUESTS = 500

# Order in which Linear workflow-state types appear as board columns.
STATE_TYPE_ORDER = ["triage", "backlog", "unstarted", "started", "completed", "canceled"]


def state_rank(type):
    try:
        return STATE_TYPE_ORDER.index(type)
    except ValueError:
        return len(STATE_TYPE_ORDER)


def build_columns(issues):
    """Build ordered board columns from the states actually present on the issues."""
    by_state: dict = {}
    for issue in issues:
        state = issue.get("state")
        if not state:
            continue
        if state["id"] not in by_state:
            by_state[state["id"]] = {**state, "issues": []}
        by_state[state["id"]]["issues"].append(issue)
    columns = list(by_state.values())
    columns.sort(key=lambda c: (state_rank(c.get("type")), c.get("position") or 0))
    return columns


class ProjectTaskError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.name = "ProjectTaskError"
        self.message = message
        self.status = status


def _js_number(value):
    """Approximate JS ``Number(value)`` coercion for the values a JSON body yields."""
    if isinstance(value, bool):
        return 1 if value else 0
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        s = value.strip()
        if s == "":
            return 0
        try:
            return int(s) if re.fullmatch(r"[+-]?\d+", s) else float(s)
        except ValueError:
            return math.nan
    return math.nan


def _is_integer(n):
    if isinstance(n, bool):
        return False
    if isinstance(n, int):
        return True
    if isinstance(n, float):
        return math.isfinite(n) and n.is_integer()
    return False


def bounded_text(value, label, max, required=True):
    text = value.strip() if isinstance(value, str) else ""
    if required and not text:
        raise ProjectTaskError(f"{label} is required.")
    if len(text) > max:
        raise ProjectTaskError(f"{label} must be {max:,} characters or fewer.")
    return text


def normalize_project_task(body):
    source = body if isinstance(body, dict) else {}
    priority = 2 if "priority" not in source else _js_number(source["priority"])
    if not _is_integer(priority) or priority < 0 or priority > 4:
        raise ProjectTaskError("priority must be an integer from 0 to 4.")
    idempotency_key = bounded_text(source.get("idempotencyKey"), "idempotencyKey", 160)
    if not re.fullmatch(r"[A-Za-z0-9:_-]{8,160}", idempotency_key):
        raise ProjectTaskError(
            "idempotencyKey must contain only letters, numbers, colons, underscores, or hyphens."
        )
    return {
        "projectId": bounded_text(source.get("projectId"), "projectId", 160),
        "title": bounded_text(source.get("title"), "title", 255),
        "description": bounded_text(source.get("description"), "description", 20_000, required=False),
        "priority": priority,
        "idempotencyKey": idempotency_key,
    }


def prune_task_requests():
    while len(task_requests) > MAX_TASK_REQUESTS:
        task_requests.pop(next(iter(task_requests)))


# POST /api/issues — create one confirmed implementation task in a selected
# project. The server derives the team and owns the Linear mutation; the model
# and browser never receive a raw GraphQL write capability.
@router.post("")
@router.post("/")
async def create_task(request: Request):
    body = await json_body(request)
    task = normalize_project_task(body)
    request_key = f"{task['projectId']}:{task['idempotencyKey']}"
    fingerprint = json.dumps([task["title"], task["description"], task["priority"]], separators=(",", ":"))
    existing = task_requests.get(request_key)
    if existing:
        if existing["fingerprint"] != fingerprint:
            raise ProjectTaskError("This idempotency key was already used for different task content.", 409)
        issue = await existing["task"]
        return {"issue": issue, "replayed": True}

    async def _create():
        result = await linear.get_project_team(store.get_api_key(), task["projectId"])
        team = result["team"]
        return await linear.create_issue(
            store.get_api_key(),
            team_id=team["id"],
            project_id=task["projectId"],
            title=task["title"],
            description=task["description"],
            priority=task["priority"],
        )

    pending = asyncio.ensure_future(_create())
    task_requests[request_key] = {"fingerprint": fingerprint, "task": pending}
    prune_task_requests()
    try:
        issue = await pending
    except Exception:
        task_requests.pop(request_key, None)
        raise
    return JSONResponse(status_code=201, content={"issue": issue, "replayed": False})


# GET /api/issues/board/:projectId — issues grouped into board columns.
@router.get("/board/{project_id}")
async def board(project_id: str):
    project = await linear.get_project_issues(store.get_api_key(), project_id)
    issues = project["issues"]["nodes"]
    return {
        "project": {"id": project["id"], "name": project["name"]},
        "columns": build_columns(issues),
    }


# PATCH /api/issues/:id/state — move an issue to another workflow state (board drag).
@router.patch("/{id}/state")
async def patch_state(id: str, request: Request):
    body = await json_body(request)
    state_id = str(body["stateId"]) if body.get("stateId") else ""
    if not state_id:
        return JSONResponse(status_code=400, content={"error": "stateId is required."})
    issue = await linear.update_issue_state(store.get_api_key(), id, state_id)
    return {"issue": issue}
