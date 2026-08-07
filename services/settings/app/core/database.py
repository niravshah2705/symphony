"""Unit of work over Firestore.

Just enough session semantics for the service layer:

- **Identity map**: loading the same document twice returns the *same* Python
  object, so a mutation is visible through every reference to it.
- **Dirty tracking + autoflush**: in-place field mutations are flushed to
  Firestore before any read (`get`/`query`/`count`) and on `commit()`.
- `add()` and repository writes are applied immediately.

Reads go through `Uow.get/query/count` (they autoflush first); writes go through
`Uow.db` directly. Policies are read-modify-write within a single request, so
the settings service mostly uses `Uow.db.set` directly for policy upserts.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from app.core.firestore import Db, get_db


class Uow:
    def __init__(self, db: Db) -> None:
        self.db = db
        self._tracked: dict[tuple[str, str], tuple[Any, dict]] = {}

    # -- identity map ---------------------------------------------------------
    def tracked(self, collection: str, doc_id: str) -> Any | None:
        entry = self._tracked.get((collection, doc_id))
        return entry[0] if entry else None

    def track(self, collection: str, obj: Any, doc_id: str | None = None) -> Any:
        did = doc_id or str(obj.id)
        self._tracked[(collection, did)] = (obj, obj.to_doc())
        return obj

    def track_all(self, collection: str, objs: list[Any]) -> list[Any]:
        for obj in objs:
            self.track(collection, obj)
        return objs

    async def add(self, collection: str, obj: Any, doc_id: str | None = None) -> Any:
        did = doc_id or str(obj.id)
        await self.db.set(collection, did, obj.to_doc())
        return self.track(collection, obj, did)

    def forget(self, collection: str, obj: Any, doc_id: str | None = None) -> None:
        self._tracked.pop((collection, doc_id or str(obj.id)), None)

    # -- dirty flush + autoflushing reads ------------------------------------
    async def flush(self) -> None:
        for (collection, doc_id), (obj, snapshot) in list(self._tracked.items()):
            current = obj.to_doc()
            if current != snapshot:
                await self.db.set(collection, doc_id, current)
                self._tracked[(collection, doc_id)] = (obj, current)

    async def get(self, collection: str, doc_id: str) -> dict | None:
        await self.flush()
        return await self.db.get(collection, doc_id)

    async def query(self, *args, **kwargs) -> list[dict]:
        await self.flush()
        return await self.db.query(*args, **kwargs)

    async def count(self, *args, **kwargs) -> int:
        await self.flush()
        return await self.db.count(*args, **kwargs)

    async def commit(self) -> None:
        await self.flush()


def new_uow() -> Uow:
    """A standalone unit of work (used outside the request lifecycle: the auth
    middleware). Callers must `await uow.commit()` to flush mutations."""
    return Uow(get_db())


async def get_session() -> AsyncIterator[Uow]:
    """FastAPI dependency yielding a request-scoped unit of work; flushes dirty
    objects on success."""
    uow = new_uow()
    yield uow
    await uow.commit()
