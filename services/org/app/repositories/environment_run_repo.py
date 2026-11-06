"""Environment-run data access (org-scoped).

The document id is derived, not generated (`run_id_for`), so `create_if_absent`
is the whole concurrency story: concurrent triggers for the same desired revision
resolve to one winner and every other caller reads back the run that exists.
"""
from __future__ import annotations

import uuid

from app.core.database import Uow
from app.models.environment_run import EnvironmentRun, run_id_for
from app.repositories.base import environment_runs_col


class EnvironmentRunRepository:
    def __init__(self, uow: Uow) -> None:
        self.uow = uow

    def _col(self, org_id: uuid.UUID) -> str:
        return environment_runs_col(org_id)

    def _hydrate(self, col: str, doc: dict) -> EnvironmentRun:
        """The object this unit of work already holds, if it holds one.

        `latest` reads a document that `get` may have handed back earlier in the
        same request; two Python objects for one run would let a retry mutate a
        copy while the status endpoint kept reporting the old one.
        """
        doc_id = str(doc["id"])
        return self.uow.tracked(col, doc_id) or self.uow.track(
            col, EnvironmentRun.from_doc(doc), doc_id)

    async def get(self, org_id: uuid.UUID, run_id: uuid.UUID) -> EnvironmentRun | None:
        col = self._col(org_id)
        existing = self.uow.tracked(col, str(run_id))
        if existing is not None:
            return existing
        doc = await self.uow.get(col, str(run_id))
        return self._hydrate(col, doc) if doc else None

    async def get_for_revision(self, org_id: uuid.UUID, desired_revision: str) -> EnvironmentRun | None:
        return await self.get(org_id, run_id_for(org_id, desired_revision))

    async def latest(self, org_id: uuid.UUID) -> EnvironmentRun | None:
        col = self._col(org_id)
        rows = await self.uow.query(col, None, order_by="created_at", desc=True, limit=1)
        return self._hydrate(col, rows[0]) if rows else None

    async def add(self, run: EnvironmentRun) -> EnvironmentRun:
        return await self.uow.add(self._col(run.org_id), run, doc_id=str(run.id))

    async def create_if_absent(self, run: EnvironmentRun) -> bool:
        """Atomic insert. False means a run for this revision already exists.

        On success the object joins the unit of work's identity map, so the
        handle the caller holds is the one a later `get` in the same request
        returns. Without it, a step answer would settle a copy and the run the
        caller is watching would report RUNNING forever.
        """
        created = await self.uow.db.create(self._col(run.org_id), str(run.id), run.to_doc())
        if created:
            self.uow.track(self._col(run.org_id), run)
        return created
