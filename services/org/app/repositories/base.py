"""Shared repository helpers."""
from __future__ import annotations

from typing import Any

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.common import PageParams


async def paginate(
    session: AsyncSession, stmt: Select, params: PageParams
) -> tuple[list[Any], int]:
    """Return (rows, total) for a SELECT with LIMIT/OFFSET applied.

    A max page size is enforced by PageParams, so lists are always bounded.
    """
    total = await session.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (await session.scalars(stmt.limit(params.limit).offset(params.offset))).all()
    return list(rows), int(total or 0)
