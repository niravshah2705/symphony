"""Per-org encrypted vault data access — one document per org.

Read-modify-write within a single request (like the policy repo): reads through
the Uow (autoflushing) and writes straight to the Db. The single doc id is
``SECRETS_DOC_ID``.
"""
from __future__ import annotations

from app.core.database import Uow
from app.models.secrets import SECRETS_DOC_ID, OrgSecrets


class SecretsRepository:
    def __init__(self, uow: Uow) -> None:
        self.uow = uow

    async def get(self, collection: str) -> OrgSecrets | None:
        doc = await self.uow.get(collection, SECRETS_DOC_ID)
        return OrgSecrets.from_doc(doc) if doc else None

    async def upsert(self, collection: str, secrets: OrgSecrets) -> OrgSecrets:
        await self.uow.db.set(collection, SECRETS_DOC_ID, secrets.to_doc())
        return secrets
