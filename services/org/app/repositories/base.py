"""Collection-path helpers and pagination for the Firestore repositories.

Tenant isolation is structural: org-owned entities live under
``organizations/{org_id}/...``. Top-level ``users`` carries an ``org_id`` field
(None only for super-admins). Uniqueness that matters for security (user email,
external subject) is enforced with atomic guard docs; tag-name uniqueness is a
best-effort query check (an admin-only action).
"""
from __future__ import annotations

import uuid
from typing import Any

from app.schemas.common import PageParams

# Top-level collections
ORGS = "organizations"
USERS = "users"
REFRESH_TOKENS = "refresh_tokens"
UNIQUE_EMAILS = "unique_emails"
UNIQUE_EXTERNAL_SUBJECTS = "unique_external_subjects"


def projects_col(org_id: uuid.UUID) -> str:
    return f"{ORGS}/{org_id}/projects"


def personal_projects_col(owner_id: uuid.UUID) -> str:
    """Personal (org-less) projects live under their owner: `users/{owner_id}/projects`.
    The owner id always derives from the authenticated principal, so a project in
    another user's subcollection is structurally unreachable."""
    return f"{USERS}/{owner_id}/projects"


def tasks_col(org_id: uuid.UUID, project_id: uuid.UUID) -> str:
    return f"{ORGS}/{org_id}/projects/{project_id}/tasks"


def tags_col(org_id: uuid.UUID) -> str:
    return f"{ORGS}/{org_id}/tags"


def memberships_col(org_id: uuid.UUID) -> str:
    return f"{ORGS}/{org_id}/memberships"


async def paginate(
    uow,  # app.core.database.Uow (untyped to avoid an import cycle)
    collection: str,
    params: PageParams,
    *,
    filters: list[tuple[str, Any]] | None = None,
    order_by: str = "created_at",
    desc: bool = True,
) -> tuple[list[dict], int]:
    """Return (page of raw docs, total count). Page size is bounded by PageParams."""
    total = await uow.count(collection, filters)
    rows = await uow.query(
        collection, filters, order_by=order_by, desc=desc, limit=params.limit, offset=params.offset
    )
    return rows, total
