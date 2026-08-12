"""Firestore data access abstraction.

Repositories talk to a small, backend-agnostic `Db` interface (flat
collection-path CRUD + equality queries + atomic create + a transaction
callback). Two implementations:

- `FirestoreDb` — Google Cloud Firestore (native mode), used in production.
- `InMemoryDb` — a dependency-free in-process fake used by the test suite so the
  authz/tenant-isolation matrix runs without the emulator.

Collection paths are strings like ``"organizations"`` or
``f"organizations/{org_id}/projects"``. Tenant isolation is structural: every
org-owned entity lives under ``organizations/{org_id}/...`` so a query cannot
cross tenants. Uniqueness (email, org slug, external subject, tag-per-org,
membership) is enforced with `create()`, which is atomic create-if-absent.
"""
from __future__ import annotations

import asyncio
import copy
from typing import Any, Awaitable, Callable, Protocol

from app.core.config import get_settings


class Txn(Protocol):
    async def get(self, collection: str, doc_id: str) -> dict | None: ...
    def set(self, collection: str, doc_id: str, data: dict) -> None: ...
    def delete(self, collection: str, doc_id: str) -> None: ...


class Db(Protocol):
    async def get(self, collection: str, doc_id: str) -> dict | None: ...
    async def set(self, collection: str, doc_id: str, data: dict) -> None: ...
    async def create(self, collection: str, doc_id: str, data: dict) -> bool:
        """Create only if absent. Returns False if the doc already exists."""
        ...
    async def delete(self, collection: str, doc_id: str) -> None: ...
    async def query(
        self,
        collection: str,
        filters: list[tuple[str, Any]] | None = None,
        *,
        order_by: str | None = None,
        desc: bool = False,
        limit: int | None = None,
        offset: int = 0,
    ) -> list[dict]: ...
    async def count(self, collection: str, filters: list[tuple[str, Any]] | None = None) -> int: ...
    async def run_transaction(self, fn: Callable[[Txn], Awaitable[Any]]) -> Any: ...


# ---------------------------------------------------------------------------
# In-memory fake (tests / local dev without a Firestore)
# ---------------------------------------------------------------------------
def _matches(doc: dict, filters: list[tuple[str, Any]] | None) -> bool:
    return all(doc.get(field) == value for field, value in (filters or []))


class _InMemoryTxn:
    def __init__(self, db: "InMemoryDb") -> None:
        self._db = db

    async def get(self, collection: str, doc_id: str) -> dict | None:
        doc = self._db._store.get(collection, {}).get(doc_id)
        return copy.deepcopy(doc) if doc is not None else None

    def set(self, collection: str, doc_id: str, data: dict) -> None:
        self._db._store.setdefault(collection, {})[doc_id] = copy.deepcopy(data)

    def delete(self, collection: str, doc_id: str) -> None:
        self._db._store.get(collection, {}).pop(doc_id, None)


class InMemoryDb:
    def __init__(self) -> None:
        self._store: dict[str, dict[str, dict]] = {}
        self._lock = asyncio.Lock()

    async def get(self, collection: str, doc_id: str) -> dict | None:
        doc = self._store.get(collection, {}).get(doc_id)
        return copy.deepcopy(doc) if doc is not None else None

    async def set(self, collection: str, doc_id: str, data: dict) -> None:
        self._store.setdefault(collection, {})[doc_id] = copy.deepcopy(data)

    async def create(self, collection: str, doc_id: str, data: dict) -> bool:
        async with self._lock:
            bucket = self._store.setdefault(collection, {})
            if doc_id in bucket:
                return False
            bucket[doc_id] = copy.deepcopy(data)
            return True

    async def delete(self, collection: str, doc_id: str) -> None:
        self._store.get(collection, {}).pop(doc_id, None)

    async def query(
        self,
        collection: str,
        filters: list[tuple[str, Any]] | None = None,
        *,
        order_by: str | None = None,
        desc: bool = False,
        limit: int | None = None,
        offset: int = 0,
    ) -> list[dict]:
        rows = [copy.deepcopy(d) for d in self._store.get(collection, {}).values() if _matches(d, filters)]
        if order_by is not None:
            rows.sort(key=lambda d: (d.get(order_by) is None, d.get(order_by)), reverse=desc)
        if offset:
            rows = rows[offset:]
        if limit is not None:
            rows = rows[:limit]
        return rows

    async def count(self, collection: str, filters: list[tuple[str, Any]] | None = None) -> int:
        return sum(1 for d in self._store.get(collection, {}).values() if _matches(d, filters))

    async def run_transaction(self, fn: Callable[[Txn], Awaitable[Any]]) -> Any:
        # Single-process fake: a global lock gives serializable transactions.
        async with self._lock:
            return await fn(_InMemoryTxn(self))


# ---------------------------------------------------------------------------
# Real Firestore
# ---------------------------------------------------------------------------
class _FirestoreTxn:
    def __init__(self, db: "FirestoreDb", txn) -> None:  # type: ignore[no-untyped-def]
        self._db = db
        self._txn = txn

    async def get(self, collection: str, doc_id: str) -> dict | None:
        snap = await self._db._ref(collection, doc_id).get(transaction=self._txn)
        return snap.to_dict() if snap.exists else None

    def set(self, collection: str, doc_id: str, data: dict) -> None:
        self._txn.set(self._db._ref(collection, doc_id), data)

    def delete(self, collection: str, doc_id: str) -> None:
        self._txn.delete(self._db._ref(collection, doc_id))


class FirestoreDb:
    def __init__(self) -> None:
        from google.cloud import firestore  # imported lazily so tests need no GCP libs

        settings = get_settings()
        self._ns = settings.firestore_namespace
        self._client = firestore.AsyncClient(
            project=settings.gcp_project_id or None, database=settings.firestore_database
        )

    def _ref(self, collection: str, doc_id: str):  # type: ignore[no-untyped-def]
        # Namespace only the top-level collection; walk subcollections after.
        segments = collection.split("/")
        segments[0] = f"{self._ns}__{segments[0]}"
        ref = self._client.collection(segments[0])
        i = 1
        while i < len(segments):
            ref = ref.document(segments[i]).collection(segments[i + 1])
            i += 2
        return ref.document(doc_id)

    def _col(self, collection: str):  # type: ignore[no-untyped-def]
        segments = collection.split("/")
        segments[0] = f"{self._ns}__{segments[0]}"
        ref = self._client.collection(segments[0])
        i = 1
        while i < len(segments):
            ref = ref.document(segments[i]).collection(segments[i + 1])
            i += 2
        return ref

    async def get(self, collection: str, doc_id: str) -> dict | None:
        snap = await self._ref(collection, doc_id).get()
        return snap.to_dict() if snap.exists else None

    async def set(self, collection: str, doc_id: str, data: dict) -> None:
        await self._ref(collection, doc_id).set(data)

    async def create(self, collection: str, doc_id: str, data: dict) -> bool:
        from google.cloud.exceptions import Conflict

        try:
            await self._ref(collection, doc_id).create(data)
            return True
        except Conflict:
            return False

    async def delete(self, collection: str, doc_id: str) -> None:
        await self._ref(collection, doc_id).delete()

    async def query(
        self,
        collection: str,
        filters: list[tuple[str, Any]] | None = None,
        *,
        order_by: str | None = None,
        desc: bool = False,
        limit: int | None = None,
        offset: int = 0,
    ) -> list[dict]:
        from google.cloud.firestore import Query

        q = self._col(collection)
        for field, value in filters or []:
            q = q.where(field, "==", value)
        if order_by is not None:
            q = q.order_by(order_by, direction=Query.DESCENDING if desc else Query.ASCENDING)
        if offset:
            q = q.offset(offset)
        if limit is not None:
            q = q.limit(limit)
        return [snap.to_dict() async for snap in q.stream()]

    async def count(self, collection: str, filters: list[tuple[str, Any]] | None = None) -> int:
        # Small, org-scoped collections — a bounded stream count is fine.
        # NB: the builtin sum() cannot consume an async generator
        # ('async_generator' object is not iterable), so accumulate explicitly.
        q = self._col(collection)
        for field, value in filters or []:
            q = q.where(field, "==", value)
        total = 0
        async for _ in q.stream():
            total += 1
        return total

    async def run_transaction(self, fn: Callable[[Txn], Awaitable[Any]]) -> Any:
        from google.cloud import firestore

        transaction = self._client.transaction()

        @firestore.async_transactional
        async def _run(txn):  # type: ignore[no-untyped-def]
            return await fn(_FirestoreTxn(self, txn))

        return await _run(transaction)


_db: Db | None = None


def get_db() -> Db:
    """Process-wide Db. InMemory when GCP project is unset (tests/local)."""
    global _db
    if _db is None:
        settings = get_settings()
        _db = FirestoreDb() if settings.gcp_project_id else InMemoryDb()
    return _db


def set_db(db: Db | None) -> None:
    """Override the process-wide Db (tests)."""
    global _db
    _db = db
