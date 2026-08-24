# Firestore data model redesign: engineer / client / org-manager actors + org hierarchy + cross-domain project access

## Context

The product currently supports a clean 3-tier access model (anonymous / authenticated-org-less / org member) with `User`, `Organization`, `OrganizationMembership`, `Project`, `ProjectMembership`, `PersonalProject`, and `OrganizationInvitation` — all Firestore documents served by `services/org` (FastAPI + Firestore, **not** SQL — `services/org/CLAUDE.md` itself flags its SQLAlchemy/Alembic prose as stale; `services/settings` runs a parallel copy of the same shape for policy data).

You want to layer three new product concepts onto this **without breaking what exists**:

1. **Actor personas** — a person self-declares as *engineer*, *client*, or an org-managing *admin* the first time they sign in (asked by the onboarding chat). This is orthogonal to the existing authorization roles (`OrgRole`, `ProjectRole`) — it's "what kind of person is this," not "what can they do."
2. **Org hierarchy + multi-domain orgs** — organizations can optionally have a parent (sub-org), and an org can recognize more than one verified email domain (companies often own several).
3. **Cross-domain / cross-org project collaboration** — a project's access shouldn't be locked to "my own org's members only." A client (corporate domain) should be able to (a) flip a project to org-wide access for their own org, (b) invite individual outside-domain people (e.g. a freelance engineer's personal Gmail) to just that one project, or (c) hand the whole project to another company (outsourcing) so every member of that other org gets in.

Today none of (1)–(3) exist, and — critically — **project access is hard-scoped to the caller's own org** (`get_project_context` in `services/org/app/authz/guards.py:53-85` calls `MembershipRepository(session).get(principal.org_id, project_id, principal.user_id)`, always keyed by the caller's own org). There is currently no way for an outside-org or org-less person to access a project at all. Per your instruction, **this pass is database design only** — the schema below makes all three concepts representable, but wiring them into the auth guards/services/API/UI is explicitly deferred (see "Explicitly out of scope" at the end) so the change stays reviewable and low-risk.

Firestore is schemaless, so every change below is **additive**: new fields default via `.get(key, default)` in `from_doc`, so existing documents keep working unmodified — no migration script needed, matching the existing pattern (e.g. `Organization.from_doc`'s handling of `deployments`).

---

## 1. Persona — self-declared actor type (new)

**File:** `services/org/app/models/enums.py` — add:

```python
class Persona(str, enum.Enum):
    ENGINEER = "ENGINEER"
    CLIENT = "CLIENT"
    ORG_MANAGER = "ORG_MANAGER"   # deliberately not "ADMIN" — avoids reading next to OrgRole.ORG_ADMIN as if it were the same axis
```

**File:** `services/org/app/models/user.py` — add one field to `User`:

- `persona: Persona | None = None` — null until the onboarding chat asks and the user answers; global to the user (not per-org), matching how you described it being asked once at first login, before any org exists.

This is purely descriptive — it does not gate anything by itself. It exists so the product/UI layer can later render "brainstorm-only" UI for a client, default a solo project's implicit role to engineer, etc.

---

## 2. Organization: verified domains + optional hierarchy

**File:** `services/org/app/models/organization.py` — add two fields to `Organization`:

- `domains: list[str] = field(default_factory=list)` — verified corporate email domains for this org (an org can own more than one, e.g. `acme.com` and `acme.io`). Replaces the idea of relying on the single global `FIREBASE_ALLOWED_DOMAIN` env pin (`packages/shared-core/src/config.js:118-121`) for per-org domain awareness — that global gate is unrelated and untouched.
- `parent_org_id: uuid.UUID | None = None` — self-referential, nullable. `None` (the common case, per "most cases there is no sub-org") means a top-level org; a sub-org just sets this to its parent's id. `Project.org_id` already points at *any* `Organization` doc, so a project belonging to a sub-org works with zero further change — hierarchy composes for free through the existing FK.

No new collection needed — sub-orgs are ordinary `organizations/{id}` documents.

---

## 3. Project: org-wide vs invite-only access

**File:** `services/org/app/models/enums.py` — add:

```python
class ProjectAccessMode(str, enum.Enum):
    INVITE_ONLY = "INVITE_ONLY"   # default — matches today's actual behavior
    ORG_WIDE = "ORG_WIDE"         # every member of the project's own org has access
```

**File:** `services/org/app/models/project.py` — add one field to `Project`:

- `access_mode: ProjectAccessMode = ProjectAccessMode.INVITE_ONLY`

This is the field behind "he can choose whether the entire organization will have access to that particular project." Defaulting to `INVITE_ONLY` means every existing project keeps behaving exactly as it does today after this change ships — nothing regresses.

---

## 4. Cross-org / outside-domain project collaboration (new)

Three additive pieces cover the three scenarios you described — org-wide access (§3, above), one-off outside individuals, and whole outsourced companies:

### 4a. Inviting a single outside-domain person to one project

**New file:** `services/org/app/models/project_invitation.py` — `ProjectInvitation`, deliberately shaped like the existing `OrganizationInvitation` (`services/org/app/models/organization_invitation.py`) but scoped one level down:

```python
@dataclass
class ProjectInvitation:
    project_id: uuid.UUID | None = None
    org_id: uuid.UUID | None = None          # the project's owning org
    email: str = ""
    role: ProjectRole = ProjectRole.DEVELOPER
    status: InvitationStatus = InvitationStatus.PENDING   # reuse the existing enum — no new status vocabulary needed
    token_hash: str = ""
    invited_by: uuid.UUID | None = None
    expires_at: datetime | None = None
    accepted_by: uuid.UUID | None = None
    accepted_at: datetime | None = None
    id: uuid.UUID = field(default_factory=new_uuid)
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)
```

Storage: `organizations/{org_id}/projects/{project_id}/invitations/{id}` (add `project_invitations_col(org_id, project_id)` to `services/org/app/repositories/base.py`, mirroring `invitations_col`). Token/guard collections mirror the existing pattern in `invitation_repo.py`: add top-level `PROJECT_INVITATION_TOKENS = "project_invitation_tokens"` and `PROJECT_PENDING_INVITATIONS = "project_pending_invitations"` (guard doc id = `sha256(project_id:email)`, same technique as `pending_guard_id`).

This directly closes the gap the research surfaced: today there is **no way at all** to grant an outside-domain individual (e.g. a freelance engineer's personal Gmail) access to a single project without making them a full org member — `OrganizationInvitation` only invites into the *org*, and `get_project_context` only ever resolves membership within the caller's *own* org.

### 4b. Handing a whole project to another organization (outsourcing)

**New file:** `services/org/app/models/project_external_grant.py` — `ProjectExternalOrgGrant`:

```python
@dataclass
class ProjectExternalOrgGrant:
    project_id: uuid.UUID | None = None
    owner_org_id: uuid.UUID | None = None        # the project's own org
    collaborator_org_id: uuid.UUID | None = None # the outsourced/partner org — every member gets access
    default_role: ProjectRole = ProjectRole.DEVELOPER
    granted_by: uuid.UUID | None = None
    id: uuid.UUID = field(default_factory=new_uuid)
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)
```

Storage: `organizations/{owner_org_id}/projects/{project_id}/external_grants/{collaborator_org_id}` (doc id = collaborator org id, making "already granted" structural, same trick as `ProjectMembership.doc_id`). Add `project_external_grants_col(org_id, project_id)` to `repositories/base.py`.

This is the schema for "he can add a group of organization or a company itself... as a project" — a client outsourcing to an entire partner company, not just one engineer.

### 4c. Marking a project member as "not from this org"

**File:** `services/org/app/models/project_membership.py` — add one field to `ProjectMembership`:

- `member_org_id: uuid.UUID | None = None` — the member's own home org. `None` (the default) preserves today's implicit assumption that a project member belongs to the project's own org; set it only when the person is a cross-org collaborator or an org-less individual who accepted a `ProjectInvitation`. This is the data point a future authorization change needs to allow `get_project_context` to recognize a member whose `principal.org_id` differs from the project's `org_id` — see "explicitly out of scope" below.

---

## 5. Identity dedup: linking more than one sign-in method to one user

**File:** `services/org/app/models/user.py` — add:

- `linked_identities: list[LinkedIdentity] = field(default_factory=list)` where `LinkedIdentity` is a small new dataclass (`provider: str`, `subject: str`, `linked_at: datetime`), persisted inline (embedded, not a separate collection) the same way `Organization.applied_tags` embeds `Tag` objects.

The existing `external_subject` field (singular) stays exactly as-is for backward compatibility — it's the "primary" identity. `linked_identities` covers *additional* sign-in methods for the same person (e.g. a corporate Microsoft SSO identity added on top of the personal Google identity they first signed up with), which is what "support two ways of authentication" for the same human requires without creating a second `User` document.

**File:** `services/org/app/repositories/base.py` — add `UNIQUE_LINKED_IDENTITIES = "unique_linked_identities"`, a guard-doc collection keyed `{provider}:{subject}` → `{user_id}`, exactly mirroring the existing `unique_external_subjects` atomic-uniqueness pattern (`user_repo.py:84-94`).

---

## 6. Discoverable pending invitations at first login (reduces "floating" org-less duplicates)

Right now, `_provision_external_user` (`services/org/app/middleware/auth.py:232-264`) always creates a brand-new org-less user regardless of whether a pending `OrganizationInvitation` already exists for that email — the person has to separately find and click the emailed invitation link. `organization_pending_invitations` can't help here because its guard-doc id is `sha256(org_id:email)` — it requires already knowing the `org_id`, so it can't answer "does this email have any pending invitation anywhere?"

**New top-level collection:** `email_invitation_index/{sha256(email)}` → `{ entries: [ {kind: "org"|"project", org_id, project_id?, invitation_id, role, expires_at} ] }`, written/removed alongside the existing invitation create/close transactions in `invitation_repo.py` (and the new `ProjectInvitation` repository from §4a).

Per your (unconfirmed, defaulted) preference: this index is for **surfacing** ("you have a pending invite from Acme Corp — accept it here"), not auto-joining — accepting still goes through the existing single-use `token_hash` flow. This preserves the current security invariant that an invitation is consumed by its token, not by an email match alone.

---

## Files touched (schema layer only)

| File | Change |
|---|---|
| `services/org/app/models/enums.py` | add `Persona`, `ProjectAccessMode` |
| `services/org/app/models/user.py` | add `persona`, `linked_identities` (+ new `LinkedIdentity` dataclass) |
| `services/org/app/models/organization.py` | add `domains`, `parent_org_id` |
| `services/org/app/models/project.py` | add `access_mode` |
| `services/org/app/models/project_membership.py` | add `member_org_id` |
| `services/org/app/models/project_invitation.py` | **new** — `ProjectInvitation` |
| `services/org/app/models/project_external_grant.py` | **new** — `ProjectExternalOrgGrant` |
| `services/org/app/repositories/base.py` | add collection-path helpers + top-level guard collections (`project_invitations_col`, `project_external_grants_col`, `PROJECT_INVITATION_TOKENS`, `PROJECT_PENDING_INVITATIONS`, `UNIQUE_LINKED_IDENTITIES`, `EMAIL_INVITATION_INDEX`) |

Each `to_doc`/`from_doc` pair follows the exact style already used throughout `services/org/app/models/*` (UUID↔str via `uuid_str`/`to_uuid`, `.get(key, default)` on read).

**`services/settings`** deliberately gets **no changes** — its duplicated `OrgRole`/`ProjectRole` enums exist to keep policy/secrets RBAC aligned with the org service, and none of persona, access-mode, or the new invitation/grant models are used for that purpose.

---

## Explicitly out of scope for this pass (flagged, not silently dropped)

You asked for database design only, so these are named here as necessary **follow-ups** once the schema lands — none of the new fields do anything by themselves until this wiring exists:

- `get_project_context` / `require_project` / `MembershipRepository` (`services/org/app/authz/guards.py`, `services/org/app/authz/policy.py`) still resolve project access only within the caller's own `principal.org_id`. Cross-org access via `ProjectExternalOrgGrant` or a `member_org_id`-carrying `ProjectMembership` needs those guards updated to check the new records.
- No new API routes (`POST /projects/{id}/access-mode`, `POST /projects/{id}/invitations`, `POST /projects/{id}/external-grants`, onboarding-chat persona capture, etc.) — service/router layer is unbuilt.
- No UI changes (client "brainstorm-only" restricted view, engineer default-role project creation flow, org/sub-org picker).
- `_provision_external_user` does not yet consult `email_invitation_index` — the index will exist and be maintained, but nothing reads it yet.

## Verification

Since this is a pure schema change to Firestore-backed dataclasses, verify with the existing test harness (per `services/org/CLAUDE.md`'s testing conventions):

1. `cd services/org && pytest` — the in-memory Firestore fake (`tests/conftest.py`) exercises every model's `to_doc`/`from_doc` round-trip through the existing integration suite; confirm nothing regresses from the new optional fields defaulting correctly on old-shaped docs.
2. Add direct unit round-trip tests (`tests/unit/test_services.py` or a new `tests/unit/test_models.py`) for each changed/new dataclass: construct with defaults, `to_doc()`, `from_doc()`, assert equality — specifically test that a doc **missing** the new fields (simulating an old, pre-migration document) still loads with the documented defaults (`persona=None`, `domains=[]`, `parent_org_id=None`, `access_mode=INVITE_ONLY`, `member_org_id=None`, `linked_identities=[]`).
3. `pytest --cov=app --cov-report=term-missing` to confirm the new code paths are covered per the repo's 80% convention.
