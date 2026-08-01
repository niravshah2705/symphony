"""Businesses routes (port of services/gateway/src/routes/businesses.js).

A "business" is a local mapping of a name + repository + optional linked Linear
project. Creating one can optionally spin up a brand-new Linear project (with the
configured enrich labels auto-attached so the enrichment scheduler picks it up).
The canonical repository namespace is stored beside its explicit provider so a
later global connector switch cannot reinterpret the reference.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ai_fleet import store, linear
from ai_fleet.services.common import json_body
from ai_fleet.agent.workspace import repo_parts

router = APIRouter()

# Sentinel distinguishing "key absent" (JS undefined → use fallback) from an
# explicit null/empty value supplied by the client.
_UNDEFINED = object()


def _iso_now():
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def slugify(name):
    slug = str(name).lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = re.sub(r"^-+|-+$", "", slug)
    return slug or f"biz-{str(uuid.uuid4())[:8]}"


def normalize_repo(value, provider="github"):
    """Normalize an operator-supplied repository reference to its canonical namespace.

    Explicit provider identity is required so a bare namespace cannot change meaning
    when the global repository connector changes. GitLab may use nested groups.
    """
    raw = str(value or "").strip()
    if not raw:
        return ""
    parts = repo_parts(raw, provider)
    return parts["fullName"] if parts else ""


def normalize_repo_provider(value=_UNDEFINED, fallback="github"):
    raw = fallback if value is _UNDEFINED else value
    provider = str(raw).strip().lower()
    return provider if provider in ("github", "gitlab") else ""


def repository_fields(body, current=None):
    fallback_provider = current["repoProvider"] if current and current.get("repoProvider") else "github"
    repo_provider = normalize_repo_provider(body.get("repoProvider", _UNDEFINED), fallback_provider)
    if not repo_provider:
        return {"error": "Repository provider must be GitHub or GitLab."}

    if "repo" in body:
        raw_repo = str(body.get("repo") or "").strip()
    else:
        raw_repo = str((current.get("repo") if current else None) or "").strip()
    repo = normalize_repo(raw_repo, repo_provider)
    if raw_repo and not repo:
        format = (
            "group/project (nested groups are supported)"
            if repo_provider == "gitlab"
            else "owner/repository"
        )
        provider_label = "GitLab" if repo_provider == "gitlab" else "GitHub"
        return {"error": f"Repository must be a {provider_label} {format} or matching official-host Git URL."}
    return {"repo": repo, "repoProvider": repo_provider}


async def with_projects(businesses):
    """Attach the linked Linear project (name/state) to each business, if any."""
    linked_ids = [b["projectId"] for b in businesses if b.get("projectId")]
    if len(linked_ids) == 0:
        return [{**b, "project": None} for b in businesses]
    try:
        projects = await linear.get_projects(store.get_api_key())
    except Exception:
        # Without a valid key we still return businesses, just without project detail.
        return [{**b, "project": None} for b in businesses]
    by_id = {p["id"]: p for p in projects}
    return [{**b, "project": (by_id.get(b["projectId"]) if b.get("projectId") else None)} for b in businesses]


# GET /api/businesses — businesses with resolved Linear project detail.
@router.get("")
@router.get("/")
async def list_businesses():
    businesses = store.read_store()["businesses"]
    return {"businesses": await with_projects(businesses)}


# POST /api/businesses — create a business, optionally creating its Linear project.
@router.post("")
@router.post("/")
async def create_business(request: Request):
    body = await json_body(request)
    name = (str(body["name"]) if body.get("name") else "").strip()
    if not name:
        return JSONResponse(status_code=400, content={"error": "Business name is required."})

    description = str(body["description"]) if body.get("description") else ""
    repository = repository_fields(body)
    if repository.get("error"):
        return JSONResponse(status_code=400, content={"error": repository["error"]})
    project_id = str(body["projectId"]) if body.get("projectId") else None

    # Optionally create a brand-new Linear project for this business.
    if not project_id and body.get("createNewProject"):
        team_id = str(body["teamId"]) if body.get("teamId") else ""
        if not team_id:
            return JSONResponse(status_code=400, content={"error": "A team is required to create a new project."})
        # Auto-attach the configured enrich labels (default ["AI"]) so the new
        # project is immediately picked up by the enrichment scheduler. Gated by the
        # autoLabelNewProjects config toggle.
        config = store.get_agent_config()
        label_ids = []
        if config.get("autoLabelNewProjects"):
            labels = await linear.get_or_create_project_labels(store.get_api_key(), config.get("enrichLabels"))
            label_ids = [l["id"] for l in labels]
        project = await linear.create_project(
            store.get_api_key(),
            name=str(body["projectName"]) if body.get("projectName") else name,
            description=description,
            team_id=team_id,
            label_ids=label_ids,
        )
        project_id = project["id"]

    current = store.read_store()
    business = {
        "id": slugify(name),
        "name": name,
        "description": description,
        "projectId": project_id,
        # Provider is stored beside the canonical namespace so a later global
        # connector switch cannot reinterpret this project repository.
        "repo": repository["repo"],
        "repoProvider": repository["repoProvider"],
        "createdAt": _iso_now(),
    }
    if any(b.get("id") == business["id"] for b in current["businesses"]):
        return JSONResponse(status_code=409, content={"error": "A business with that name already exists."})

    next_store = {**current, "businesses": [*current["businesses"], business]}
    store.write_store(next_store)
    enriched = (await with_projects([business]))[0]
    return JSONResponse(status_code=201, content={"business": enriched})


# PUT /api/businesses/:id — update fields / link a Linear project.
@router.put("/{id}")
async def update_business(id: str, request: Request):
    current_store = store.read_store()
    index = next((i for i, b in enumerate(current_store["businesses"]) if b.get("id") == id), -1)
    if index == -1:
        return JSONResponse(status_code=404, content={"error": "Business not found."})

    body = await json_body(request)
    current = current_store["businesses"][index]
    repository = repository_fields(body, current)
    if repository.get("error"):
        return JSONResponse(status_code=400, content={"error": repository["error"]})
    updated = {
        **current,
        "name": (str(body["name"]).strip() or current["name"]) if "name" in body else current["name"],
        "description": str(body["description"]) if "description" in body else current["description"],
        "projectId": (
            (str(body["projectId"]) if body.get("projectId") else None)
            if "projectId" in body
            else current.get("projectId")
        ),
        "repo": repository["repo"],
        "repoProvider": repository["repoProvider"],
    }

    businesses = [updated if i == index else b for i, b in enumerate(current_store["businesses"])]
    store.write_store({**current_store, "businesses": businesses})
    enriched = (await with_projects([updated]))[0]
    return {"business": enriched}


# DELETE /api/businesses/:id — remove the local business mapping (leaves Linear untouched).
@router.delete("/{id}")
async def delete_business(id: str):
    current_store = store.read_store()
    businesses = [b for b in current_store["businesses"] if b.get("id") != id]
    if len(businesses) == len(current_store["businesses"]):
        return JSONResponse(status_code=404, content={"error": "Business not found."})
    store.write_store({**current_store, "businesses": businesses})
    return {"ok": True}
