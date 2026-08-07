"""Shared API dependencies."""
from __future__ import annotations

from fastapi import Query

from app.schemas.common import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PageParams


def page_params(
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
) -> PageParams:
    return PageParams(page=page, limit=limit)
