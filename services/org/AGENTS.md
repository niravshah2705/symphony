# AGENTS.md

This repository's guidance for AI coding agents lives in **[CLAUDE.md](./CLAUDE.md)**.
It is tool-agnostic — read it before making changes.

Quick orientation:

- **Product & setup docs:** [README.md](./README.md)
- **Agent working guide (architecture, invariants, gotchas):** [CLAUDE.md](./CLAUDE.md)
- **Run:** `uvicorn app.main:app --reload` · **Test:** `pytest` · **Migrate:** `alembic upgrade head`

Non-negotiable invariants (full detail in CLAUDE.md):

1. Scope every org-owned query by `principal.org_id`; never trust org/tenant IDs
   from path or body; cross-org access returns 404.
2. Every endpoint needs an explicit authorization dependency; capabilities live
   in `app/authz/policy.py`.
3. No mass assignment; response DTOs never expose `password_hash`.
4. Parameterized SQLAlchemy only; JWTs alg-pinned; refresh tokens rotate with
   reuse detection.
5. Validate that a tag belongs to the same org before attaching it.
