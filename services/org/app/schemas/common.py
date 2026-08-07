"""Shared schema primitives: pagination params and paginated envelope."""
from __future__ import annotations

from typing import Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")

MAX_PAGE_SIZE = 100
DEFAULT_PAGE_SIZE = 20


class PageParams(BaseModel):
    """Query params for paginated list endpoints (enforces a max page size)."""

    page: int = Field(default=1, ge=1)
    limit: int = Field(default=DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE)

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.limit


class PageMeta(BaseModel):
    total: int
    page: int
    limit: int


class Page(BaseModel, Generic[T]):
    data: list[T]
    meta: PageMeta
