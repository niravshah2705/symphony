# Access & Tenancy Model

How AI Fleet decides **who can do what** across three access tiers, and how a
user moves from a private personal workspace to a shared organization. This is
the product contract; the server is always the enforcement boundary (the SPA
only mirrors it to hide UI).

## Three tiers

| Tier | How you get here | What you can do |
|---|---|---|
| **Anonymous** | Just open the app — no sign-in | Read-only Agent workspace + **basic RAG** (lexical doc/memory search) |
| **Authenticated (no org)** | Sign in with Google (One Tap) | Everything anonymous can do **plus** create/manage **personal projects** |
| **Organization member** | Create or be added to an organization | Org projects, members, tasks, tags, org RBAC (ORG_ADMIN / MEMBER) |

The tiers are additive: signing in never removes the anonymous surface, and
creating an org never removes your personal projects.

## 1. Anonymous — basic RAG, read-only

An unauthenticated visitor lands directly in the Agent workspace (no login
gate). They hold exactly `{ workspace: 'read' }` (`packages/shared/src/authz.js`
`PUBLIC_PERMISSIONS`).

"Basic RAG operation" = the **bounded, read-only lexical retrieval** that already
backs the omnibox:

- `POST /api/agent/knowledge-search` — lexical search over the workspace
  README/docs corpus (bounded; returns relative paths + snippets, never secrets
  or absolute paths).
- `POST /api/agent/memory-search` — typed memory recall blended with reviewed
  docs.

Both are **side-effect-free reads**, so the gateway authorizes them at
`workspace:read` even though they are `POST` (a per-path carve-out mounted ahead
of the catch-all `/api/agent` proxy, which otherwise maps `POST → write`).

**Not** opened to anonymous: `POST /api/agent/message` (can trigger LLM
enrichment), `POST /api/agent/memory` (write), `POST /api/agent/enqueue`,
`/api/coder/*`, and every planning/insights/settings/org route. For anonymous
users the SPA classifies omnibox intent **client-side** (`omnibox-router.mjs`) and
calls the two read endpoints directly, so it never depends on the write-gated
`/message` route.

> There is no semantic/vector RAG in the repo — retrieval is lexical. Embeddings
> RAG would be net-new and tenant-scoped per the cross-tenant-isolation rules.

## 2. Sign-in — Google One Tap via Firebase

Sign-in is a **compact, dismissible card** (not a full-page gate — anonymous use
stays available), driven by **Google Identity Services One Tap**:

1. The SPA fetches its public config from `GET /api/auth/config`, which now
   includes the **Google OAuth Web client ID** (`googleClientId`). Like the
   Firebase `apiKey`, this is **public, not a secret**.
2. GIS renders the native One Tap prompt. On credential return, the SPA calls
   Firebase `signInWithCredential(GoogleAuthProvider.credential(idToken, nonce))`.
3. A **nonce** is generated per prompt (`google.accounts.id.initialize({ nonce })`
   with the SHA-256 of the raw nonce; the raw nonce is passed to Firebase) to
   bind the credential and prevent replay.
4. The `signInWithPopup(GoogleAuthProvider)` flow remains as a fallback button
   (One Tap can be suppressed by the browser / FedCM / cool-down).

**Trust boundary is unchanged.** Regardless of how the browser obtains the
session, every `/api` call still carries the resulting **Firebase ID token**,
which the gateway verifies with `firebase-admin` (RS256, `iss =
securetoken.google.com/<project>`, `aud = <project>`, `exp`, `email_verified`).
One Tap only changes how the browser acquires that token.

**Console prerequisites** (one-time): the Google OAuth **Web client id** must
list the SPA origin under *Authorized JavaScript origins*, and the SPA + gateway
domains must be in Firebase Auth *Authorized domains*. The gateway sets no CSP
today, so the GIS script loads without change — **if a CSP is later added**, it
must allow `https://accounts.google.com/gsi/` for `script-src`/`connect-src`/
`frame-src` (and its styles).

## 3. Personal projects (authenticated, org-less)

A signed-in user who belongs to **no organization** can still create projects.
These are **personal projects**: single-owner, private, and **cannot have other
members**.

- Storage: `users/{uid}/projects/{id}` — owner-scoped subcollection. `uid` is the
  authenticated `principal.user_id`, **never** taken from the path or body.
- Cross-user access returns **404** (no existence oracle), same rule as org data.
- API (org service, reached via the gateway at `/api/org/me/*`):
  - `GET /api/org/me` — my identity + whether I have an org.
  - `POST /api/org/me/projects` — create a personal project.
  - `GET /api/org/me/projects` — list my personal projects.
  - `GET|PATCH|DELETE /api/org/me/projects/{id}` — manage one.
- **JIT provisioning:** on first authenticated call, the org service creates an
  **org-less** user record (`org_id = None`, `auth_provider = EXTERNAL`,
  `external_subject = <firebase uid>`) from the verified token claims. Org-less
  users are rejected by every tenant guard (`require_org_member` etc.), so JIT
  grants identity only — never tenant data access. (This deliberately relaxes the
  service's prior "no JIT / pre-provision only" rule; it is safe because org-less
  == no tenant reach.)

### Gateway authorization for `/me/*`

The tenant surface `/api/org/*` requires the `org` permission domain (a default
`viewer` has `org:read`, so a plain sign-in cannot write org data). Personal
workspace is different: **any authenticated user** may use it. So `/api/org/me/*`
is mounted with `requireAuthenticated` (identity only, no role) **ahead of** the
role-gated `/api/org` mount. The org service independently enforces owner-scoping,
so the gateway gate is only the coarse outer check.

## 4. Adding a person → create an organization first

Personal projects are single-owner by design. To collaborate you must **create an
organization** (requirement #5):

1. `POST /api/org/me/organization` — an org-less authenticated user creates an
   org and becomes its first **ORG_ADMIN**. (Self-service; distinct from the
   super-admin-only `POST /organizations`. Fails `409` if you already have an org.)
2. Now the org tenant surface is available: `POST /organizations/current`-scoped
   projects, `POST /projects`, and member management
   `POST /projects/{id}/members` (adds an **existing org user** by id; there is no
   email-invite of strangers — new people join via org-admin user creation).

Personal projects are **not** auto-migrated into the new org (kept simple and
predictable); a future "promote personal project to org" action can copy one in.

## Security notes (tribal-knowledge)

- **cross-tenant-isolation** — personal-project owner id derives from the verified
  principal only; every read/write is owner-scoped; cross-user → 404. Org
  projects keep deriving `org_id` from the principal (never body/path).
- **oauth-oidc / authentication-failures** — the gateway keeps verifying the
  Firebase ID token (signature/iss/aud/exp/email_verified); One Tap adds a nonce.
  Only the **public** OAuth client id reaches the browser — no client secret.
- **api-security** — the anonymous carve-out is limited to two proven
  side-effect-free read endpoints; writes, enqueue, coder, and all higher domains
  stay gated.
- **client-side-enforcement** — the compact sign-in card and menu gating are UI
  only; the gateway `requirePermission` / `requireAuthenticated` guards and the
  org service's own authz are the boundary.
- **cryptography-secrets** — Firebase web config and the Google client id are
  public by design; `org-jwt-secret` stays in Secret Manager.
