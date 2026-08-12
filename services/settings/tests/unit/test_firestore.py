"""Unit coverage for the real Firestore adapter without GCP access."""
from __future__ import annotations

from google.cloud import firestore

from app.core.firestore import FirestoreDb


class _Snapshot:
    exists = True

    def to_dict(self) -> dict:
        return {"state": "pending"}


class _DocumentRef:
    def __init__(self, collection: str, doc_id: str) -> None:
        self.key = (collection, doc_id)
        self.get_transactions: list[object] = []

    async def get(self, *, transaction: object) -> _Snapshot:
        self.get_transactions.append(transaction)
        return _Snapshot()


class _NativeTransaction:
    def __init__(self) -> None:
        self.writes: list[tuple[_DocumentRef, dict]] = []
        self.deletes: list[_DocumentRef] = []

    def set(self, ref: _DocumentRef, data: dict) -> None:
        self.writes.append((ref, data))

    def delete(self, ref: _DocumentRef) -> None:
        self.deletes.append(ref)


class _AsyncClient:
    """Only the documented AsyncClient transaction-factory surface."""

    def __init__(self, transaction: _NativeTransaction) -> None:
        self._transaction = transaction
        self.transaction_calls = 0

    def transaction(self) -> _NativeTransaction:
        self.transaction_calls += 1
        return self._transaction


async def test_run_transaction_uses_module_decorator_and_wraps_native_transaction(monkeypatch):
    native_transaction = _NativeTransaction()
    client = _AsyncClient(native_transaction)
    refs: dict[tuple[str, str], _DocumentRef] = {}
    decorated_callbacks = []

    def fake_async_transactional(callback):
        decorated_callbacks.append(callback)

        async def invoke(transaction):
            return await callback(transaction)

        return invoke

    monkeypatch.setattr(firestore, "async_transactional", fake_async_transactional)

    # Bypass FirestoreDb.__init__: this test must not discover credentials or
    # create a network-capable AsyncClient.
    db = FirestoreDb.__new__(FirestoreDb)
    db._client = client
    db._ref = lambda collection, doc_id: refs.setdefault(  # type: ignore[method-assign]
        (collection, doc_id), _DocumentRef(collection, doc_id)
    )

    received_transaction = None

    async def update(wrapper):
        nonlocal received_transaction
        received_transaction = wrapper
        current = await wrapper.get("jobs", "job-1")
        wrapper.set("jobs", "job-1", {"state": "complete"})
        wrapper.delete("locks", "job-1")
        return current["state"]

    result = await db.run_transaction(update)

    assert result == "pending"
    assert received_transaction is not native_transaction
    assert client.transaction_calls == 1
    assert len(decorated_callbacks) == 1
    assert not hasattr(client, "transactional")
    assert refs[("jobs", "job-1")].get_transactions == [native_transaction]
    assert native_transaction.writes == [
        (refs[("jobs", "job-1")], {"state": "complete"})
    ]
    assert native_transaction.deletes == [refs[("locks", "job-1")]]
