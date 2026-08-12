from __future__ import annotations

from typing import Any

import pytest
from google.cloud import firestore

from app.core.firestore import FirestoreDb


class _FakeSnapshot:
    exists = True

    def to_dict(self) -> dict[str, str]:
        return {"state": "before"}


class _FakeDocumentRef:
    def __init__(self, path: str, reads: list[tuple[str, Any]]) -> None:
        self.path = path
        self._reads = reads

    async def get(self, *, transaction: Any) -> _FakeSnapshot:
        self._reads.append((self.path, transaction))
        return _FakeSnapshot()


class _FakeTransaction:
    def __init__(self) -> None:
        self.sets: list[tuple[str, dict[str, str]]] = []
        self.deletes: list[str] = []

    def set(self, ref: _FakeDocumentRef, data: dict[str, str]) -> None:
        self.sets.append((ref.path, data))

    def delete(self, ref: _FakeDocumentRef) -> None:
        self.deletes.append(ref.path)


class _FakeAsyncClient:
    """The real AsyncClient API has transaction(), but no transactional()."""

    def __init__(self, transaction: _FakeTransaction) -> None:
        self._transaction = transaction

    def transaction(self) -> _FakeTransaction:
        return self._transaction


@pytest.mark.asyncio
async def test_run_transaction_uses_async_transactional_and_wraps_callback(monkeypatch):
    transaction = _FakeTransaction()
    client = _FakeAsyncClient(transaction)
    assert not hasattr(client, "transactional")

    reads: list[tuple[str, Any]] = []
    decorated: list[Any] = []

    db = object.__new__(FirestoreDb)
    db._client = client
    db._ns = "test"
    monkeypatch.setattr(
        db,
        "_ref",
        lambda collection, doc_id: _FakeDocumentRef(f"{collection}/{doc_id}", reads),
    )

    def fake_async_transactional(fn):
        decorated.append(fn)

        async def invoke(txn):
            return await fn(txn)

        return invoke

    monkeypatch.setattr(firestore, "async_transactional", fake_async_transactional)

    async def callback(txn):
        existing = await txn.get("members", "member-1")
        txn.set("members", "member-1", {"state": "after"})
        txn.delete("members", "stale-member")
        return existing["state"]

    result = await db.run_transaction(callback)

    assert result == "before"
    assert len(decorated) == 1
    assert reads == [("members/member-1", transaction)]
    assert transaction.sets == [("members/member-1", {"state": "after"})]
    assert transaction.deletes == ["members/stale-member"]
