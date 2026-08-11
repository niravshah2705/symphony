"""Authoritative selected-context resolution through the organization service.

The settings Firestore namespace owns policies, not organization membership.
For external/Firebase identities the org service therefore validates the two
browser context headers and returns the caller's current membership/project.
"""
from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx

from app.core.config import get_settings
from app.models.enums import OrgRole, ProjectRole

ORGANIZATION_HEADER = "X-AI-Fleet-Organization-Id"
PROJECT_HEADER = "X-AI-Fleet-Project-Id"


class OrgContextError(Exception):
    def __init__(self, message: str, status_code: int = 403) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class AuthoritativeContext:
    user_id: uuid.UUID
    email: str
    org_id: uuid.UUID | None
    org_role: OrgRole
    project_id: uuid.UUID | None
    project_role: ProjectRole | None


def _id(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _uuid(value: Any, label: str, *, optional: bool = False) -> uuid.UUID | None:
    raw = _id(value)
    if not raw and optional:
        return None
    try:
        return uuid.UUID(raw)
    except (TypeError, ValueError) as exc:
        raise OrgContextError(f"Organization service returned an invalid {label}", 503) from exc


def _items(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def parse_context_payload(
    payload: dict[str, Any],
    *,
    requested_org_id: str = "",
    requested_project_id: str = "",
) -> AuthoritativeContext:
    """Parse the tolerant public `/me/context` contract and re-check selection."""
    user = payload.get("user") if isinstance(payload.get("user"), dict) else {}
    user_id = _uuid(user.get("id") or payload.get("user_id"), "user id")
    email = _id(user.get("email") or payload.get("email"))

    organizations = _items(payload.get("organizations") or payload.get("orgs"))
    requested_org_id = _id(requested_org_id)
    selected_org_hint = _id(
        payload.get("selected_organization_id")
        or payload.get("default_organization_id")
        or payload.get("org_id")
    )
    wanted_org = requested_org_id or selected_org_hint
    organization = next(
        (item for item in organizations if _id(item.get("id") or item.get("org_id")) == wanted_org),
        None,
    )
    if organization is None and not wanted_org and organizations:
        organization = organizations[0]
    if wanted_org and organization is None:
        raise OrgContextError("Selected organization is not accessible", 403)
    if organization is None:
        if requested_project_id:
            raise OrgContextError("A project cannot be selected without an organization", 403)
        return AuthoritativeContext(
            user_id=user_id,  # type: ignore[arg-type]
            email=email,
            org_id=None,
            org_role=OrgRole.MEMBER,
            project_id=None,
            project_role=None,
        )

    org_id = _uuid(organization.get("id") or organization.get("org_id"), "organization id")
    try:
        org_role = OrgRole(str(organization.get("role") or organization.get("org_role") or "MEMBER").upper())
    except ValueError as exc:
        raise OrgContextError("Organization service returned an invalid membership role", 503) from exc

    projects = _items(organization.get("projects"))
    requested_project_id = _id(requested_project_id)
    project_hint = _id(
        payload.get("selected_project_id")
        or payload.get("default_project_id")
        or organization.get("selected_project_id")
        or organization.get("default_project_id")
    )
    wanted_project = requested_project_id or project_hint
    project = next(
        (item for item in projects if _id(item.get("id") or item.get("project_id")) == wanted_project),
        None,
    )
    if project is None and not wanted_project and projects:
        project = projects[0]
    if wanted_project and project is None:
        raise OrgContextError("Selected project is not accessible in this organization", 404)

    project_role = None
    if project:
        raw_project_role = str(project.get("role") or project.get("project_role") or "DEVELOPER").upper()
        try:
            project_role = ProjectRole(raw_project_role)
        except ValueError as exc:
            raise OrgContextError("Organization service returned an invalid project role", 503) from exc

    return AuthoritativeContext(
        user_id=user_id,  # type: ignore[arg-type]
        email=email,
        org_id=org_id,
        org_role=org_role,
        project_id=_uuid(project.get("id") or project.get("project_id"), "project id") if project else None,
        project_role=project_role,
    )


def _audience(base_url: str) -> str:
    parsed = urlparse(base_url)
    return f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else base_url


async def _cloud_run_token(audience: str) -> str:
    def fetch() -> str:
        from google.auth.transport.requests import Request
        from google.oauth2.id_token import fetch_id_token

        return fetch_id_token(Request(), audience)

    return await asyncio.to_thread(fetch)


async def resolve_org_context(
    user_token: str,
    *,
    organization_id: str = "",
    project_id: str = "",
    client: httpx.AsyncClient | None = None,
) -> AuthoritativeContext:
    settings = get_settings()
    base_url = settings.org_url.rstrip("/")
    if not base_url:
        raise OrgContextError("Organization service is not configured", 503)

    headers = {
        "X-Forwarded-Authorization": f"Bearer {user_token}",
        **({ORGANIZATION_HEADER: organization_id} if organization_id else {}),
        **({PROJECT_HEADER: project_id} if project_id else {}),
    }
    if settings.app_env.lower() == "production":
        try:
            headers["Authorization"] = f"Bearer {await _cloud_run_token(_audience(base_url))}"
        except Exception as exc:
            raise OrgContextError("Unable to authenticate to organization service", 503) from exc
    else:
        headers["Authorization"] = f"Bearer {user_token}"

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=settings.org_context_timeout_seconds)
    try:
        response = await http.get(f"{base_url}/api/v1/me/context", headers=headers)
    except httpx.HTTPError as exc:
        raise OrgContextError("Organization service is unavailable", 503) from exc
    finally:
        if owns_client:
            await http.aclose()

    if response.status_code == 401:
        raise OrgContextError("Authentication required", 401)
    if response.status_code in {400, 403, 404}:
        raise OrgContextError("Selected organization/project context is not accessible", response.status_code)
    if response.status_code < 200 or response.status_code >= 300:
        raise OrgContextError("Organization service is unavailable", 503)
    try:
        payload = response.json()
    except ValueError as exc:
        raise OrgContextError("Organization service returned an invalid response", 503) from exc
    if not isinstance(payload, dict):
        raise OrgContextError("Organization service returned an invalid response", 503)
    return parse_context_payload(
        payload,
        requested_org_id=organization_id,
        requested_project_id=project_id,
    )
