# Organization Management Service

A multi-tenant backend for managing **Organizations → Projects → Tasks** with
role-based access control, built with **FastAPI**, **async SQLAlchemy 2.0**,
**Alembic**, and **PostgreSQL**.

The defining constraint is **hard organization isolation**: a regular user can
never read or mutate another organization's data. Every endpoint is
authenticated (in middleware) and explicitly authorized, and all data-access
queries are scoped to the caller's organization.

---

## Roles & Authorization

| Scope | Role | Capabilities |
|-------|------|--------------|
| Platform | `SUPER_ADMIN` | The only cross-org identity. Create/list/read/update/delete any organization; provision an org's first admin. Bootstrapped from env — never self-registerable. |
| Organization | `ORG_ADMIN` | Full control within their org: users, org roles, tags, projects. Implicitly `PROJECT_ADMIN` on every project in the org. |
| Organization | `MEMBER` | Base role; capabilities come from project memberships. |
| Project | `PROJECT_ADMIN` | Manage project access control (members + roles), update/delete project, full task CRUD. |
| Project | `TEAM_LEAD` | **Review** (read) the project, its tasks and members across the projects they lead. No task writes. |
| Project | `DEVELOPER` | Task CRUD + tag attach within assigned projects; read project & members. |

A global user identity can belong to multiple organizations. Authoritative
memberships are dual-written under the organization and user; `User.org_id` /
`org_role` remain only as a backward-compatible default context. Developer↔project
is many-to-many (via `ProjectMembership`, carrying the role).

## Authentication (hybrid)

- **Local**: `POST /auth/register` (self-signup → creates an org + its
  `ORG_ADMIN`) and `POST /auth/login` issue a short-lived **access JWT** plus a
  **rotating refresh token** (reuse of a rotated token revokes the whole family).
- **External IdP**: bearer tokens whose `iss` matches the configured OIDC issuer
  are validated via **JWKS** (RS256) and mapped to a pre-provisioned user.

Authentication is enforced by a pure-ASGI middleware for every `/api/v1/*` route
except a small public allowlist (register/login/refresh/verify-email/health).
The principal is re-resolved from the database on every request, so role or
status changes (and deactivations) take effect immediately.

---

## Quick start (Docker)

```bash
cp .env.example .env            # then edit JWT_SECRET (openssl rand -hex 32)
docker compose up --build       # starts Postgres, runs migrations, serves on :8000
```

Open the interactive docs at http://localhost:8000/docs.

## Local development

```bash
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e ".[test]"

# Start Postgres (or use docker compose up -d postgres) and set DATABASE_URL:
export DATABASE_URL="postgresql+asyncpg://org:org@localhost:5432/orgdb"
export JWT_SECRET="$(openssl rand -hex 32)"

alembic upgrade head
uvicorn app.main:app --reload
```

### Seeding a platform super-admin

Set `SUPERADMIN_EMAIL` and `SUPERADMIN_PASSWORD` before startup; a super-admin is
seeded once (idempotently) during application startup.

---

## Migrations (Alembic)

```bash
alembic upgrade head                      # apply
alembic downgrade base                    # roll back
alembic revision --autogenerate -m "..."  # after model changes
```

`alembic/env.py` reads `DATABASE_URL` directly from the environment (independent
of the app's other settings).

## Tests

```bash
pytest --cov=app --cov-report=term-missing
```

Tests run against in-memory SQLite (no external services required) and cover
unit (policy, services, security), integration (per-resource CRUD + the
authorization matrix: 403 for insufficient role, 404 for cross-org access), and
an end-to-end lifecycle. Coverage gate: **80%+**.

---

## API surface (versioned under `/api/v1`)

- **Auth**: `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`,
  `POST /auth/logout`, `GET /auth/verify-email`, `GET /auth/me`
- **Organizations (self-service)**: `GET|PATCH|DELETE /organizations/current`,
  `GET|PUT /organizations/current/tags`, `DELETE /organizations/current/tags/{tag_id}`,
  `GET /me/context`, `POST /me/organizations` (`POST /me/organization` alias)
- **Invitations**: `POST|GET /invitations`, `POST /invitations/{id}/resend`,
  `DELETE /invitations/{id}`, authenticated `POST /invitations/{token}/accept`
- **Organizations (super-admin)**: `POST|GET /organizations`,
  `GET|PATCH|DELETE /organizations/{org_id}`
- **Users**: `GET|POST /users`, `GET|PATCH|DELETE /users/{user_id}`,
  `POST /users/{user_id}/change-password`
- **Projects**: `GET|POST /projects`, `GET|PATCH|DELETE /projects/{project_id}`,
  `GET|POST /projects/{project_id}/tags`, `DELETE /projects/{project_id}/tags/{tag_id}`
- **Members**: `GET|POST /projects/{project_id}/members`,
  `PATCH|DELETE /projects/{project_id}/members/{user_id}`
- **Tasks**: `GET|POST /projects/{project_id}/tasks`,
  `GET|PATCH|DELETE /projects/{project_id}/tasks/{task_id}`,
  `PUT /projects/{project_id}/tasks/{task_id}/tags`,
  `DELETE /projects/{project_id}/tasks/{task_id}/tags/{tag_id}`
- **Tags**: `GET|POST /tags`, `GET|PATCH|DELETE /tags/{tag_id}`
- **Health**: `GET /health`, `GET /health/ready`

---

## Security highlights

- **Org isolation**: every query is scoped to the middleware-validated selected
  membership. `X-AI-Fleet-Organization-Id` and `X-AI-Fleet-Project-Id` are
  independently revalidated; cross-org/no-access selection returns 404.
- **RBAC**: enforced server-side per endpoint via capability predicates
  (`app/authz/policy.py`) and guard dependencies (`app/authz/guards.py`).
- **JWT**: algorithm pinned; `exp`/`iat`/`iss`/`aud` required; secret from env;
  no `alg:none`. External tokens verified via JWKS with exact issuer matching.
- **Refresh tokens**: hashed at rest, rotated on use, reuse detected → family revoked.
- **Sessions invalidated** on logout, password change, and deactivation.
- **No mass assignment**: explicit request DTOs; self-service cannot change
  `org_role`/`is_super_admin`. Response DTOs never expose password hashes.
- **Injection-safe**: parameterized SQLAlchemy only; Pydantic type validation.
- **Rate limiting** on auth endpoints; pagination capped at 100 items.
- **CI** (`.github/workflows/ci.yml`): `contents: read`, no `pull_request_target`,
  no production secrets.

## Project layout

```
app/
  core/        config, database, security, logging, timeutils
  middleware/  auth (pure ASGI), rate_limit
  auth/        jwt_local, idp (JWKS), dependencies, bootstrap
  authz/       principal, policy (capabilities), guards
  models/      SQLAlchemy models + association tables
  schemas/     Pydantic request/response DTOs
  repositories/ org-scoped data access (repository pattern)
  services/    business logic
  api/v1/      routers (one per resource)
alembic/       migration environment + versions
tests/         unit / integration / e2e
```
