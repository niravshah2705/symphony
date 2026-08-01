"""Projects routes (port of services/gateway/src/routes/projects.js).

Read-only Linear project surface: list projects, list teams (used when creating a
project for a business), and the milestone planning view for one project.
"""

from __future__ import annotations

from fastapi import APIRouter

from ai_fleet import store, linear

router = APIRouter()


# GET /api/projects — all Linear projects.
@router.get("")
@router.get("/")
async def list_projects():
    projects = await linear.get_projects(store.get_api_key())
    return {"projects": projects}


# GET /api/projects/teams — teams (used when creating a project for a business).
@router.get("/teams")
async def list_teams():
    teams = await linear.get_teams(store.get_api_key())
    return {"teams": teams}


# GET /api/projects/:id/milestones — the milestone planning view.
@router.get("/{id}/milestones")
async def project_milestones(id: str):
    result = await linear.get_project_milestones(store.get_api_key(), id)
    return {"project": result["project"], "milestones": result["milestones"]}
