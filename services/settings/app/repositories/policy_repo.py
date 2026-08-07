"""Settings-policy data access — one document per scope.

Policies are read-modify-write within a single request, so this repository reads
through the Uow (autoflushing) and writes straight to the Db (no dirty tracking
needed). The single doc id per scope is ``POLICY_DOC_ID``.
"""
from __future__ import annotations

from app.core.database import Uow
from app.models.policy import POLICY_DOC_ID, SettingsPolicy


class PolicyRepository:
    def __init__(self, uow: Uow) -> None:
        self.uow = uow

    async def get(self, collection: str) -> SettingsPolicy | None:
        doc = await self.uow.get(collection, POLICY_DOC_ID)
        return SettingsPolicy.from_doc(doc) if doc else None

    async def upsert(self, collection: str, policy: SettingsPolicy) -> SettingsPolicy:
        await self.uow.db.set(collection, POLICY_DOC_ID, policy.to_doc())
        return policy
