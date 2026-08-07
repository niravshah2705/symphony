# CLAUDE.md — AI agent guide for the Organization Management Service

This file orients an AI coding agent working in this repo. Read it before making
changes. It encodes the invariants that keep the service correct and secure —
violating them is how bugs and vulnerabilities get introduced here.

## What this is

A multi-tenant FastAPI backend: **Organizations → Projects → Tasks** with RBAC.
Stack: FastAPI, async SQLAlchemy 2.0 + asyncpg (PostgreSQL), Alembic, Pydantic v2,
PyJWT, passlib[argon2], slowapi. Python 3.12+.

The product spec and rationale live in `README.md`. This file is the *how to work
in the code* companion.

## Commands

```bash
# Env: DATABASE_URL (async DSN) and JWT_SECRET (>=32 chars) are required.
alembic upgrade head                 # apply migrations
uvicorn app.main:app --reload        # serve (http://localhost:8000/docs)
pytest                               # full suite (uses in-memory SQLite; no DB needed)
pytest tests/integration/test_auth.py::test_login_success_and_generic_failure  # single test
pytest --cov=app --cov-report=term-missing   # coverage
docker compose up --build            # Postgres + migrations + API
```

## Architecture & request flow

Strict layering — keep dependencies pointing one direction:

```
HTTP → AuthContextMiddleware (authn) → router (api/v1/*) → guard deps (authz)
     → service (business logic) → repository (org-scoped queries) → model
```

- `app/middleware/auth.py` — **pure ASGI** auth middleware (not BaseHTTPMiddleware).
  Authenticates every `/api/v1/*` route except `PUBLIC_PATHS`; sets an immutable
  `Principal` on `request.state`. Default-deny: unknown/new paths require auth.
- `app/authz/` — `principal.py` (Principal), `policy.py` (capability predicates),
  `guards.py` (FastAPI dependencies: `require_super_admin`, `require_org_admin`,
  `require_org_member`, `get_project_context`, `require_project(predicate)`).
- `app/api/v1/` — one router per resource; register new routers in `__init__.py`.
- `app/services/` — business logic; the only place that composes repositories.
- `app/repositories/` — data access; **every read is org-scoped**.
- `app/schemas/` — Pydantic request/response DTOs (field allowlists).
- `app/models/` — SQLAlchemy models + `associations.py` (M2M tables).

## Invariants — DO NOT BREAK

1. **Org isolation.** Every query that touches org-owned data MUST filter by
   `principal.org_id`. Never trust an org/tenant/owner id from the path or body
   for authorization — derive scope from the token/principal. Cross-org or
   no-access resources return **404** (not 403) to avoid an existence oracle.
   See `cross-tenant-isolation` rules; `guards.get_project_context` is the model.
2. **Authorize every endpoint.** New routes are authenticated by the middleware,
   but you must add an explicit authorization dependency (`require_*` / a
   `policy.py` predicate). Adding a path to `PUBLIC_PATHS` bypasses authn — only
   do it for genuinely public endpoints.
3. **Capabilities live in `policy.py`.** Express new permissions as predicates
   over the effective `ProjectRole` — never as ad-hoc `if role == ...` in routes,
   and never as a linear role ordering. ORG_ADMIN is elevated to PROJECT_ADMIN in
   `get_project_context`; SUPER_ADMIN is the only cross-org identity.
4. **No mass assignment / no leakage.** Use explicit create/update schemas.
   Regular users must never set `is_super_admin` or `org_role` (enforced in
   `user_service.update_user`). Response DTOs must never include `password_hash`.
5. **Parameterized queries only.** Use SQLAlchemy expressions; never build SQL by
   string interpolation.
6. **Tokens & secrets.** JWT algorithm is pinned; `exp/iat/iss/aud` required;
   secret from env. Refresh tokens are stored hashed, rotated on use, and reuse
   revokes the family. Password change / deactivation must invalidate sessions
   (bump `password_changed_at` and/or revoke refresh tokens).
7. **Tag org-matching.** When attaching a tag to an org/project/task, validate the
   tag belongs to the same org (`tag_service.resolve_org_tags` / `get_in_org`).

## Data model (UUID PKs, timestamps on all)

`Organization(name, description, slug)` · `User(org_id?, email, org_role,
is_super_admin, auth_provider, external_subject, ...)` — one org per user, `org_id`
NULL only for super-admins · `Project(org_id, ...)` · `ProjectMembership(project,
user, role)` unique(project,user) — the developer↔project M2M with role ·
`Task(project_id, status, assignee_id?)` · `Tag(org_id, name)` unique(org,name) ·
`RefreshToken(user, token_hash, family_id, ...)`. M2M: `org_tag`, `project_tag`,
`task_tag`.

## Async/ORM gotchas (these caused real bugs — respect them)

- **Relationships `Project.tags`, `Task.tags`, `Organization.applied_tags` are
  `lazy="selectin"`.** They auto-load on a SELECT, but a *freshly constructed*
  object hasn't loaded them — assigning a list marks the collection loaded so
  response serialization won't trigger async lazy IO (`MissingGreenlet`).
  `project_service.create_project` sets `project.tags = []`; `create_task` assigns
  `task.tags`. `OrgRepository.get` eager-loads `applied_tags` via `selectinload`.
- **`autoflush=True`** on the sessionmaker: queries see pending changes. The
  `get_session` dependency commits on success / rolls back on exception. If you
  must persist a change *before* raising (e.g. refresh-token reuse revocation),
  `await session.commit()` explicitly first — see `auth_service.refresh`.
- Repositories `flush()` on `add`/`delete` so IDs/deletes are visible in-session.

## Adding a new resource (follow the existing pattern)

model → Alembic migration → schema(s) → repository (org-scoped) → service →
router → register in `app/api/v1/__init__.py` → tests (integration authz matrix +
direct service unit tests).

## Testing conventions

- `tests/conftest.py` provides `client` (httpx ASGI, in-memory SQLite) and
  `db_session` (direct service-layer tests). Helpers in `tests/helpers.py`.
- Use real-looking emails ending in `.com` — `.test`/`.example` are rejected by
  the email validator.
- **Coverage caveat:** `coverage.py` cannot trace async frames executed through
  the httpx ASGI transport in this Python 3.13 harness, so code exercised *only*
  via HTTP shows as uncovered even though it runs. Add **direct service-layer
  unit tests** (`tests/unit/test_services.py`) for accurate coverage of services.
  Integration tests still validate behavior end-to-end.

## Security reference

Changes touching auth, endpoints, tenant scoping, or CI should follow the
`security:tribal-knowledge` checklists (authentication-failures, api-security,
cross-tenant-isolation, injection-attacks, oauth-oidc, cicd-pipeline). The
`README.md` "Security highlights" section maps controls to those rules.
