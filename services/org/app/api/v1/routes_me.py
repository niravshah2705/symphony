"""Self-service surface for any authenticated user (`/me`).

Reachable by every signed-in user, including those who belong to no organization
(JIT-provisioned Firebase users with ``org_id=None``). Two capabilities:

- **Personal projects** — single-owner projects scoped to the caller
  (``principal.user_id``); cross-user access is impossible (structural path
  isolation) and missing loads return 404.
- **Create organization** — the org-less caller creates an org and becomes its
  first ORG_ADMIN, unlocking the org tenant surface + member management.

At the gateway these are mounted at ``/api/org/me/*`` behind an
authentication-only gate (not the ``org`` role), because personal workspace is
available to everyone signed in; org authorization still applies to the tenant
routes. The service layer enforces owner-scoping regardless of the gateway.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status

from app.api.deps import page_params
from app.auth.dependencies import get_current_user, get_principal
from app.authz.principal import Principal
from app.core.database import Uow, get_session
from app.models.user import User
from app.schemas.common import Page, PageParams
from app.schemas.me import CreateOrgRequest, MeResponse, PersonalProjectResponse
from app.schemas.org import OrgResponse
from app.schemas.project import ProjectCreate, ProjectUpdate
from app.services import onboarding_service, personal_project_service

router = APIRouter(prefix="/me", tags=["me"])


@router.get("", response_model=MeResponse)
async def get_me(user: User = Depends(get_current_user)):
    return MeResponse(
        user_id=user.id,
        email=user.email,
        full_name=user.full_name,
        has_organization=user.org_id is not None,
        org_id=user.org_id,
        org_role=user.org_role.value if user.org_id is not None else None,
    )


@router.post("/organization", response_model=OrgResponse, status_code=status.HTTP_201_CREATED)
async def create_my_organization(
    body: CreateOrgRequest,
    user: User = Depends(get_current_user),
    session: Uow = Depends(get_session),
):
    return await onboarding_service.create_organization_for_user(session, user, body)


@router.get("/projects", response_model=Page[PersonalProjectResponse])
async def list_my_projects(
    principal: Principal = Depends(get_principal),
    params: PageParams = Depends(page_params),
    session: Uow = Depends(get_session),
):
    rows, total = await personal_project_service.list_personal_projects(session, principal, params)
    return Page(data=rows, meta={"total": total, "page": params.page, "limit": params.limit})


@router.post("/projects", response_model=PersonalProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_my_project(
    body: ProjectCreate,
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
):
    return await personal_project_service.create_personal_project(session, principal, body)


@router.get("/projects/{project_id}", response_model=PersonalProjectResponse)
async def get_my_project(
    project_id: uuid.UUID,
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
):
    return await personal_project_service.get_personal_project(session, principal, project_id)


@router.patch("/projects/{project_id}", response_model=PersonalProjectResponse)
async def update_my_project(
    project_id: uuid.UUID,
    body: ProjectUpdate,
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
):
    project = await personal_project_service.get_personal_project(session, principal, project_id)
    return await personal_project_service.update_personal_project(session, project, body)


@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_my_project(
    project_id: uuid.UUID,
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
) -> None:
    project = await personal_project_service.get_personal_project(session, principal, project_id)
    await personal_project_service.delete_personal_project(session, project)
