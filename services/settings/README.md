# Settings Policy Service

A multi-tenant FastAPI backend that stores hierarchical **org → project → user**
settings policies for four domains — **harness, tools, skills, plugins** — and
resolves them through an include/exclude **cascade**.

Stack mirrors `services/org`: FastAPI, Firestore (native mode) via a small `Db`
abstraction with an in-memory fake for tests, Pydantic v2, PyJWT (local JWT +
Firebase-OIDC hybrid auth). Python 3.11+.

## Cascade rule

Each policy holds, per domain, an `include` list and an `exclude` list of item
ids / glob patterns (e.g. `security:*`). The resolver walks org → project → user:

- `org` allowed = (universe filtered by org.include) − org.exclude
- `project` narrows the org-allowed set (its include intersects, its exclude removes)
- `user` narrows the project-allowed set

A lower scope can only **narrow**: it can never re-include what a higher scope
excluded. **Exclude always wins downward** — an exclude at org blocks project
AND user; an exclude at project blocks user.

## Config values (provider secrets)

Each scope's policy also carries a small allow-listed `values` map of provider
API keys (currently `geminiApiKey`; see `app/models/policy.py` `CONFIG_VALUE_KEYS`).
Unlike the narrowing cascade, config values are **overrides** resolved with
**user > project > org** precedence (the lowest scope that sets a value wins).

Values are **write-only secrets**:

- A `PUT` accepts plaintext (`{"values": {"geminiApiKey": "…"}}`); an empty
  string clears a key. `values` is merged (a PUT that omits it never touches the
  stored secret, and a PUT that omits `domains` never touches the policy lists).
- Every browser-facing response **masks** them to `{"set": true|false}` — the
  plaintext is never returned to a browser (not even a suffix).
- The plaintext is returned **only** by the internal S2S endpoint below.

## Commands

```bash
# JWT_SECRET (>=32 chars) is required; GCP_PROJECT_ID empty -> in-memory store.
python -m venv .venv && . .venv/bin/activate
pip install -e '.[test]'
uvicorn app.main:app --reload --port 8100   # http://localhost:8100/docs
pytest -q                                    # emulator-free (in-memory Firestore)
```

## API (`/api/v1`)

| Method | Path | Who |
|--------|------|-----|
| GET/PUT | `/settings/org` | org admin |
| GET/PUT | `/settings/project/{project_id}` | project admin (org-scoped, cross-org → 404) |
| GET/PUT | `/me/settings` | any authenticated user |
| GET | `/settings/effective?project_id=...` | any authenticated user (cascade applied; config values **masked**) |
| GET | `/settings/universe` | any authenticated user |
| GET | `/internal/effective-config?project_id=...` | **S2S only** — UNMASKED config values |

Behind the gateway the first group is reached at `/api/settings-policy/*` (the
gateway rewrites to `/api/v1/*` and forwards the caller's Firebase bearer). The
`/internal/*` surface returns provider secrets in plaintext and is **never**
browser-reachable: the gateway refuses to proxy any `internal` path, and the
service is IAM-gated. The gateway/planner call it server-side (see
`packages/shared/src/agent/settings-client.js`) to wire the resolved provider
key into the agent harness. Scope on `/internal/*` still derives from the
authenticated principal — never a caller-supplied org id.

## Security invariants

- Scope is always derived from the authenticated `Principal` — never from a
  path/body-supplied org id. Cross-org / no-access resources return **404**.
- Auth is IAM-gated behind the gateway; the end-user bearer arrives in
  `X-Forwarded-Authorization` (the `Authorization` header carries the gateway's
  S2S OIDC token). Org-less external users are JIT-provisioned (identity only).
