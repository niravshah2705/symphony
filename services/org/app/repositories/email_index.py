"""Maintenance of ``email_invitation_index`` — a by-email lookup of pending
org/project invitations.

The index is keyed by ``sha256(email)`` and holds a list of entries so first
login can answer *"does this email have any pending invitation anywhere?"*
without already knowing an ``org_id`` (which ``organization_pending_invitations``
requires). It is **surfacing only**: acceptance still consumes the single-use
``token_hash``, so a stale/duplicated entry can never grant access on its own.

Entries are written and removed inside the same transaction as the invitation
create/close, so the index stays consistent with the invitation state.

**Firestore read-before-write:** a Firestore transaction requires every read to
precede every write, so the index is a TWO-PHASE helper: call ``read_entries``
during a transaction's read phase (before any ``txn.set``/``txn.delete``), then
``write_add``/``write_remove`` during the write phase with the entries you read.
The single-phase ``get_entries``/``remove_direct`` helpers are for
non-transactional call sites (read surfacing, best-effort cascade cleanup).
"""
from __future__ import annotations

import hashlib
import uuid
from datetime import datetime

from app.repositories.base import EMAIL_INVITATION_INDEX


def email_index_id(email: str) -> str:
    return hashlib.sha256(email.encode("utf-8")).hexdigest()


def make_entry(
    *,
    kind: str,
    org_id: uuid.UUID,
    invitation_id: uuid.UUID,
    role: str,
    project_id: uuid.UUID | None = None,
    expires_at: datetime | None = None,
) -> dict:
    """Build a single index entry (all ids stringified for storage)."""
    return {
        "kind": kind,  # "org" | "project"
        "org_id": str(org_id),
        "project_id": str(project_id) if project_id is not None else None,
        "invitation_id": str(invitation_id),
        "role": role,
        "expires_at": expires_at,
    }


def _without(entries: list[dict], invitation_id) -> list[dict]:  # type: ignore[no-untyped-def]
    """Entries minus the one matching invitation_id (single matching rule)."""
    target = str(invitation_id)
    return [e for e in entries if e.get("invitation_id") != target]


async def read_entries(txn, email: str) -> list[dict]:  # type: ignore[no-untyped-def]
    """READ PHASE: current entries for an email (call before any txn writes)."""
    doc = await txn.get(EMAIL_INVITATION_INDEX, email_index_id(email))
    return list(doc.get("entries", [])) if isinstance(doc, dict) else []


def write_add(txn, email: str, entries: list[dict], entry: dict) -> None:  # type: ignore[no-untyped-def]
    """WRITE PHASE: upsert ``entry`` (replace-by-invitation_id) into ``entries``
    (as returned by ``read_entries``) and persist."""
    updated = _without(entries, entry["invitation_id"])
    updated.append(entry)
    txn.set(EMAIL_INVITATION_INDEX, email_index_id(email), {"email": email, "entries": updated})


def write_remove(txn, email: str, entries: list[dict], invitation_id) -> None:  # type: ignore[no-untyped-def]
    """WRITE PHASE: drop ``invitation_id`` from ``entries`` (delete the doc if it
    empties) and persist."""
    updated = _without(entries, invitation_id)
    if updated:
        txn.set(EMAIL_INVITATION_INDEX, email_index_id(email), {"email": email, "entries": updated})
    else:
        txn.delete(EMAIL_INVITATION_INDEX, email_index_id(email))


async def get_entries(db, email: str) -> list[dict]:  # type: ignore[no-untyped-def]
    """Read the raw entry list for an email (no expiry filtering — the caller
    decides how to present them)."""
    doc = await db.get(EMAIL_INVITATION_INDEX, email_index_id(email))
    return list(doc.get("entries", [])) if isinstance(doc, dict) else []


async def remove_direct(db, email: str, invitation_id) -> None:  # type: ignore[no-untyped-def]
    """Non-transactional entry removal for cascade cleanup (project/org delete),
    where the surrounding delete is already best-effort and non-atomic."""
    doc_id = email_index_id(email)
    doc = await db.get(EMAIL_INVITATION_INDEX, doc_id)
    if not isinstance(doc, dict):
        return
    entries = _without(doc.get("entries", []), invitation_id)
    if entries:
        await db.set(EMAIL_INVITATION_INDEX, doc_id, {"email": email, "entries": entries})
    else:
        await db.delete(EMAIL_INVITATION_INDEX, doc_id)
