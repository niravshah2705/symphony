"""Unit of work over Firestore.

Replaces the SQLAlchemy async session. It keeps an identity map with a snapshot
of each loaded/added object so that the service layer's *mutate-then-commit*
pattern still persists: services load an object via a repository, mutate its
fields in place, and `get_session` flushes the dirty objects on request success.

- `add()` and repository `delete()` are applied IMMEDIATELY (Firestore writes
  are atomic per-document; there is no multi-doc rollback), so subsequent reads
  in the same request see them.
- In-place field mutations are detected by comparing `obj.to_doc()` to the
  snapshot and written on `commit()`.

Atomic multi-step operations (refresh-token rotation) use
`db.run_transaction(...)` directly, not this dirty-flush path.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from app.core.firestore import Db, get_db


class Uow:
    def __init__(self, db: Db) -> None:
        self.db = db
        # (collection, doc_id) -> (object, snapshot doc at track time)
        self._tracked: dict[tuple[str, str], tuple[Any, dict]] = {}

    def track(self, collection: str, obj: Any, doc_id: str | None = None) -> Any:
        """Register a loaded object so later in-place mutations are flushed.
        `doc_id` defaults to str(obj.id); pass it for composite-id docs."""
        did = doc_id or str(obj.id)
        self._tracked[(collection, did)] = (obj, obj.to_doc())
        return obj

    def track_all(self, collection: str, objs: list[Any]) -> list[Any]:
        for obj in objs:
            self.track(collection, obj)
        return objs

    async def add(self, collection: str, obj: Any, doc_id: str | None = None) -> Any:
        """Persist a new object immediately and track it for later mutations."""
        did = doc_id or str(obj.id)
        await self.db.set(collection, did, obj.to_doc())
        return self.track(collection, obj, did)

    def forget(self, collection: str, obj: Any, doc_id: str | None = None) -> None:
        self._tracked.pop((collection, doc_id or str(obj.id)), None)

    async def commit(self) -> None:
        """Flush every tracked object whose serialized form changed."""
        for (collection, doc_id), (obj, snapshot) in list(self._tracked.items()):
            current = obj.to_doc()
            if current != snapshot:
                await self.db.set(collection, doc_id, current)
                self._tracked[(collection, doc_id)] = (obj, current)


def new_uow() -> Uow:
    """A standalone unit of work (used outside the request lifecycle: bootstrap,
    the auth middleware). Callers must `await uow.commit()` themselves."""
    return Uow(get_db())


async def get_session() -> AsyncIterator[Uow]:
    """FastAPI dependency yielding a request-scoped unit of work; flushes dirty
    objects on success. Deletes/adds are already persisted immediately."""
    uow = new_uow()
    yield uow
    await uow.commit()
