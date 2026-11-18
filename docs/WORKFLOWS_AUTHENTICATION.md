# Workflows — Authentication and Authorization

Every workflow request travels the same chain, and each link answers a different
question. A browser that is signed in is not automatically allowed to save; a
member of an organization is not automatically allowed to run a category.

```
Firebase token ──> principal ──> organization membership ──> store scope
                                                              └─> persona ──> category grants ──> write / publish
```

## 1. The middleware stack, and what each link proves

Mounted at `services/gateway/src/index.js:269`:

```js
app.use('/api/workflows',
  requireAuthenticated(),          // who is this?
  requirePermission('workspace'),  // may they use a workspace at all?
  requireOrganizationContext(),    // has a tenant been selected?
  createWorkflowsRouter({ kagentAdapter, substrateAdapter }));
```

The store scope and the validated context come from two earlier global
middlewares, and they are the load-bearing part:

| Link | Source of truth | Failure |
|---|---|---|
| `requireAuthenticated()` | verified Firebase id token → `req.auth = { mode, role, user: { sub, email } }` | `401` |
| `requirePermission('workspace')` | `services/gateway/src/auth.js`: the level is implied by the HTTP method — `GET` needs `workspace` **read**, every mutation needs `workspace` **write**. `public/js/permissions.js` (`workflows: { domain: 'org', level: 'read' }`) is the browser's own minimum for showing the page | `401` unauthenticated, `403` signed in but not permitted |
| context validation (`context-validator.js`) | **the org service**: `GET /api/v1/me/context` called with the caller's bearer token and the requested headers; the response's validated pair is stored as `req.fleetContext` | `401` / `403 invalid_context` / `404` (pinned deployment) / `503 context_unavailable` |
| store scope (`store-context.js`) | `runWithWorkspaceContext(req.fleetContext)` selects `aifleet_workspace_<key>` | — |
| `requireOrganizationContext()` | a non-empty validated organization | `403 organization_context_required` |
| persona (`callerContext`) | `userProfiles[verified uid]` in the tenant store, default persona | — |
| grants (`graphPersonaViolations`) | tenant `personaGrants` merged over `DEFAULT_PERSONA_GRANTS` | `403 persona_denied` + `violations[]` |

**Request headers never select a backend.** `createStoreContextMiddleware`
reads only `req.fleetContext`, because the org header is attacker-controlled
until the org service has confirmed it. A forged `x-ai-fleet-organization-id`
resolves to a context the caller is not a member of, and the request stops
before any store is opened.

**The org is never taken from a body or a path.** Org scope comes from the
validated context only; a workflow id belonging to another organization does not
exist in this tenant, so the answer is `404`, not `403`. That is the cross-tenant
boundary, and it is structural rather than a check.

A pinned (per-tenant) deployment tightens this further: if the validated context
does not match the deployment's pinned organization, the request is `404` — an
org-less or removed user cannot fall through to the process's own namespace.

## 2. Persona: what it is and what it is not

`persona` is a per-user role inside one organization — `product-designer`,
`builder`, `sre`, `org-admin` — stored in the tenant's `userProfiles` keyed by
the verified uid and set either by the user (`PUT /me/persona`) or by an admin.
It is **not** the platform role (`req.auth.role`, `operator` / `admin`) and not
organization membership. Three consequences:

- A global admin (`req.auth.role === 'admin'`) bypasses persona gating and is the
  only caller that may write platform defaults. `canAdminDefaults` in the read
  payload is that same fact, used by the browser to show the controls — showing
  them is not what permits them.
- `auth.mode === 'disabled'` (local development with no Firebase) skips org
  validation and keeps the legacy root. That path exists for the local
  development profile only; a deployed gateway always authenticates.
- Persona is checked **server-side on every write**. The browser's
  persona-filtered palette is a convenience; the 403 is the boundary.

## 3. Grant table

`DEFAULT_PERSONA_GRANTS` (`packages/shared-core/src/workflow/model.js`), merged
per-tenant by `personaGrants()`:

| Persona | Allowed agent categories |
|---|---|
| `product-designer` | Requirements, Research, Source verification, Planning, Commercial strategy, Pricing, Ideation, Knowledge publishing |
| `builder` | Planning, Coding, Testing, Security, Data sanitation, Engineering, Quality |
| `sre` | DevOps / deployment, Observability, Incident triage, Compliance, Launch, Deployment, Monitoring, Support |
| `org-admin` | `null` — everything |

A tenant record `{ persona, allowedCategories }` replaces that persona's row;
`allowedCategories: null` means everything, and **no record at all means the
platform default**. Because the defaults are merged at read, an empty
`personaGrants` collection is a normal state rather than a locked-out one.

`graphPersonaViolations(graph, persona, grants)` collects every agent node whose
profile category is not granted. A graph with one forbidden node is refused in
full — a partially saved graph would let a persona persist a step it cannot run,
and the publish path would then have nothing to re-check.

## 4. Endpoint matrix

All under `/api/workflows`, all requiring an authenticated caller with a
validated organization. "Minimum standing" is the `workspace` permission level
the method implies (read for `GET`, write for anything else); "persona gate"
means `graphPersonaViolations` runs before the write.

| Method + path | Minimum standing | Additional gate | Refusals |
|---|---|---|---|
| `GET /` | read | — (lazy-seeds the tenant as a side effect) | `403 organization_context_required` |
| `GET /?migrate=1` | read | same, defers the example copy | — |
| `POST /` | write + **persona gate on the graph** | new graph must be runnable by the caller | `400` invalid, `409 already_exists`, `403 persona_denied` |
| `PUT /:id` | write, as above | `If-Match` revision | `409 revision_conflict` (+ server copy), `404` |
| `DELETE /:id` | write | — | `404` |
| `POST /:id/duplicate` | write | source graph must be persona-legal | `400`, `404` |
| `POST /reset` | write | re-copies platform defaults over tenant edits | — |
| `POST /import` | write | refuses while the tenant has graphs | `400` no valid input |
| `GET /agents` | read | — | — |
| `POST /agents`, `PUT /agents/:id` | write | profile fields validated | `400` |
| `DELETE /agents/:id` | write | a platform-default id cannot be deleted | `400`, `404` |
| `GET /gate-template` | read | — | — |
| `GET /me` | read | — | — |
| `PUT /me/persona` | write (method-implied) | the persona is applied to the caller's own uid | `400` unknown persona |
| `GET /kagent/capabilities` | read | read-only; answers when kagent is off | `502 kagent_capabilities_failed` |
| `POST /agents/:id/publish` | write + persona gate on that profile | adapter enabled | `403`, `404`, `503`, `502` |
| `POST /:id/nodes/:nodeId/publish` | write + persona gate on **that node** | adapter enabled | `400` non-agent node, `403`, `404`, `503 kagent_not_configured` / `substrate_not_configured`, `502 kagent_spec_invalid` |
| `GET /defaults` | read | — | — |
| `PUT /defaults/:section` | **global admin only** | writes the platform-global root | `403 access_denied`, `400` |

Writes that the browser must not attempt for a caller it knows is read-only:
`workflow-sync.mjs` takes `canWrite` from the caller's organization role in the
validated context — `views/workflows.js` sets it to `role === 'ORG_ADMIN'` — and
sends nothing at all when it is false: not even a migration import, not even
from a stale local draft. The server would refuse anyway; staying quiet is what
keeps a member's page from producing five graphs by opening it.

## 5. The browser never touches Firestore

There is no browser-held Firebase security rule set for these collections, and
no client SDK read of the store. The gateway is the only origin that can reach
the tenant root, and it does so inside the validated workspace. Consequences
worth stating plainly:

- the tenant store is not a public API surface and is not shaped for client
  access (its documents contain other products' records);
- `revision` / `If-Match` conflict handling lives server-side, so a second tab
  cannot win by being first to the network;
- a persona that should not exist in this organization cannot be forged, because
  the persona comes from `userProfiles[uid]` — a server-side record, not a claim
  in a header.

## 6. Secrets and the credential boundary

No workflow document, CR, or publish response carries a provider credential. The
rules that keep it that way:

- `kagentSpec.env` drops a `KEY|SECRET|TOKEN`-shaped row rather than storing it,
  and `public/js/secret-scan.mjs` warns in the editor before the save is even
  attempted.
- Model credentials live in `ModelConfig.apiKeySecret`; MCP header credentials in
  `RemoteMCPServer.headersFrom`. The workflow stores the **name** it points at.
- Harness env is *reported* (`harnessEnv`) for an operator to merge onto a
  Harness; it is never written onto a shared Harness implicitly.
- Agent containers hold the egress **sentinel only**, never a raw key —
  the platform-wide invariant in the repo's `CLAUDE.md`. The gateway is the only
  workload that receives `KAGENT_*`: it hosts the publish endpoint and runs no
  model-generated code, so planner / coder-control / coder-worker hold no
  cluster address, and a test fails if the env follows the substrate set there
  "by symmetry rather than by decision".
- `KAGENT_TOKEN_FILE` is a mounted path, not a token in an env value — the same
  reason `SUBSTRATE_TOKEN` stays out of plaintext maps: an agent `env` would
  print it.

## 7. Kubernetes RBAC for the adapter

The adapter writes `api.kagent.dev` resources in `KAGENT_NAMESPACE` (default
`kagent`) using in-cluster credentials, so the gateway's Kubernetes identity
needs a **namespaced** Role, not a cluster role:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: fleet-workflows-kagent, namespace: kagent }
rules:
  - apiGroups: ["api.kagent.dev"]
    resources: ["agents", "agenttemplates", "harnesses", "modelconfigs", "remotemcpservers"]
    verbs: ["get", "list", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "create", "update", "patch", "delete"]
```

Scope rules behind that shape: the adapter only ever addresses one namespace, so
a `ClusterRole` would buy it more than the feature needs; and the long-prompt
`ConfigMap` is written by the same call, so `configmaps` is required for
publishes past the inline limit. `get` is not optional decoration: applying an
existing Agent is a read-then-replace, because the replace has to name the
stored `resourceVersion`. `delete` covers the un-publish half, which removes the
Agent and its prompt ConfigMap together. Binding this Role to the gateway's
service account is an **operator decision and is not provisioned by this repo** —
`docs/GCP_DEPLOY.md` states the requirement. Until it exists, publishes against a
configured cluster answer `502` with the API server's refusal, and
`GET /kagent/capabilities` reports the same failure instead of looking
unconfigured.

## Related documents

- [`WORKFLOWS_DATABASE_DESIGN.md`](./WORKFLOWS_DATABASE_DESIGN.md) — where each of these facts is persisted
- [`WORKFLOWS_APPLICATION_FLOW.md`](./WORKFLOWS_APPLICATION_FLOW.md) — the request path they govern
- [`ACCESS_MODEL.md`](./ACCESS_MODEL.md) — the platform-wide role/permission model
- [`FIRESTORE_STRUCTURE.md`](./FIRESTORE_STRUCTURE.md) — store roots and backend routing
