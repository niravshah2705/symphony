# Workflows — Database Design

Where the workflow designer's data lives, what each document looks like, and the
rules that decide whether a write is accepted, dropped, or refused.

The designer used to persist only to `localStorage`. It is now server-first: the
browser's copy is a cache and a queue, and the tenant store is the source of
truth. See [`WORKFLOWS_APPLICATION_FLOW.md`](./WORKFLOWS_APPLICATION_FLOW.md) for
the request path and [`WORKFLOWS_AUTHENTICATION.md`](./WORKFLOWS_AUTHENTICATION.md)
for who may write.

## 1. Two roots, one model

| Root | Holds | Selected by |
|---|---|---|
| `aifleet_workspace_<key>` | one tenant's graphs, agent-profile overrides, persona grants, user personas, **and the seed marker** | the verified organization in the request (`runWithWorkspaceContext`) |
| legacy singleton (`aifleet` / `store.json`) | platform-global default **overrides** (`workflowDefaults`) | no workspace context |

`<key>` is a digest of the organization id — a raw org id never enters a path or
a Firestore collection name (`createBackendEntry` in
`packages/shared-core/src/store.js`). Under the file backend the same key maps
to `<DATA_DIR>/workspaces/<key>.json`.

Everything below describes the **tenant** root unless a section says otherwise.
Cross-tenant reads are structurally impossible: a workflow id from another
organization does not exist here, so the answer is `404`, never `403`.

## 2. Collection tree

```
aifleet_workspace_<key>
├── main/<ROOT>                    one document, STORE_MAIN_KEYS
│     settings, businesses, assumedRole, agentConfig, eula, billing,
│     userProfiles, workflowDefaults*, workflowGraphsSeededAt
│     (* read from the legacy root by the defaults API, never written here)
├── workflows/<workflowId>         one document per graph
├── agents/<profileId>             one document per tenant agent-profile override
├── personaGrants/<recordId>       one document per persona override
└── … (jobs, memories, conversations, approvals, billing …)
```

Sharding is deliberate: `STORE_COLLECTION_KEYS` (`workflows`, `agents`,
`personaGrants`) become per-record sub-collections so no single document
approaches Firestore's 1 MB limit, and a tenant that adds a hundred graphs never
grows one document. `STORE_MAIN_KEYS` stays in one document because those keys
are small, singleton, and read together on every request.

**A main key that is not listed is a key that silently never persists.** The
Firestore backend writes exactly `mainKeys` + `collectionKeys`
(`packages/shared-core/src/store/firestore-backend.js`), so adding a field to
the model without adding it to the list produces a value that reads back as its
default forever. `workflowGraphsSeededAt` is listed for that reason, and
`store.workflow.test.js` asserts it.

## 3. Document shapes

### 3.1 Workflow graph (schema v2)

Written by `normalizeWorkflowGraphV2` → `normalizeWorkflowV2`
(`packages/shared-core/src/workflow/model.js`).

```jsonc
{
  "id": "adlc-feature",              // SAFE_ID: ^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$
  "name": "ADLC feature build",      // required, ≤160 chars
  "description": "",                 // ≤1000
  "createdAt": "2026-11-01T09:00:00.000Z",
  "updatedAt": "2026-11-18T14:22:31.411Z",
  "revision": 7,                     // server-owned, see §5
  "updatedBy": "build@t.test",       // server-owned actor, or null for a seeded copy
  "viewport": { "x": 360, "y": 120, "zoom": 1 },   // zoom clamped to 0.2–3
  "nodes": [ /* §3.2 */ ],
  "edges": [ { "id": "e1", "source": "n1", "target": "n2", "outcome": "approved" } ],
  "exampleId": "default-adlc",       // only set on a copied platform example
  "isExample": true                  // only with exampleId
}
```

Caps: 500 nodes, 2000 edges. A node id that repeats is dropped, an edge whose
endpoint is not a stored node is dropped, and an edge that would close a cycle
is dropped (`pathExists` guard) — the graph is a DAG by construction, not by
politeness. `outcome` is kept only on an edge leaving an `approval` node.

### 3.2 Node

`kind` is one of `agent | approval | environment | gate`; anything else drops
the node. Common fields: `id` (SAFE_ID), `name` (≤120, defaults to
`Human approval` for an approval and `Untitled step` otherwise), `description`
(≤600), `x`, `y`. `refId` is nulled for `approval` and `gate` — those reference
nothing in the agent catalog. A name or description carrying unsafe text drops
the whole node rather than storing a sanitized surprise.

Per-kind extras:

| kind | fields |
|---|---|
| `approval` | `requiredRole` (≤120, default `Organization Admin`), `reviewCriteria[]`, `instructions` (≤1000), `rejectionHandling` (≤1000) |
| `gate` | `gateConfig` (§3.3) — **required**; a gate whose config normalizes to nothing removes the node. Optional `gateRef` records the template it came from |
| `agent` | `backend` (`substrate`\|`kagent`, default `substrate`), `harness` (one of `claude-code, codex, deepagent, opencode, openspec, github-actions, otel`, else `''`), `modelFamily` (`anthropic, openai, bedrock, vertexai, gemini, byok`, else `''`), `taskTier` (`complex`\|`medium`\|`easy`, default `medium`), `systemPrompt` (≤16000), `connectors[]` (≤20), `kagentSpec` (§3.4) |

The four binding fields live **on the node, not on the profile**: one curated
agent can run on either backend, and the publish path reads exactly those four
names. Switching backends deliberately leaves `kagentSpec` in place.

### 3.3 `gateConfig`

```jsonc
{
  "id": "gate-template-v1",
  "title": "Specs Gate",
  "cards": [{
    "id": "business-analysis",       // fallback: gate-card-<n>
    "title": "Business Analysis",    // required — see below
    "items": ["…", "…", "…"],        // ≤3 (GATE_ITEM_MAX), ≤300 chars each, blanks dropped
    "threshold": 85,                 // the bar this card must reach, 0–100
    "passRate": 90                   // what this card has reached; null = not assessed
  }]
}
```

At most 6 cards (`GATE_CARD_MAX`). **A card with no title is dropped, and a gate
whose cards all drop removes the gate node from the graph.** The review dialog
refuses to save that state rather than reporting success over a deleted node.
`passRate: null` is never a pass: the verdict requires every card to be assessed
*and* at or above its own threshold, so a strong average cannot carry a weak
card.

### 3.4 `kagentSpec`

Validated by `normalizeKagentSpec`. Shape errors are **warnings at save time**
(the graph is still savable) and hard errors at publish time, where the same
normalizer runs again.

```jsonc
{
  "modelConfig": { "name": "claude-sonnet", "namespace": "kagent" },  // DNS-subdomain name
  "skills":  [{ "name": "spec-author", "source": { "oci": "ghcr.io/…/spec-author:sha-abc123" },
                 "promptAppend": "…" }],                                // ≤50
  "plugins": [{ "source": { /* immutable */ }, "skills": ["spec-author"], "promptAppend": "…" }],
  "tools":   [{ "kind": "mcp", "server": "github-mcp", "tools": ["create_pr"], "requireApproval": true },
              { "kind": "subAgent", "name": "reviewer", "description": "…", "templateRef": "…" }],
  "env":     [{ "name": "PLUGIN_ROOT", "value": "/plugins/spec-author" }],   // ≤40 rows
  "egressPolicyRefs": ["allow-git"]                                          // ≤10, K8s names
}
```

Rules that are data-shape rules, not policy opinions:

- A skill or plugin `source` is **exactly one** of `oci` (image pinned by
  digest), `git` (https url + commit sha) or `bucket` (s3 bucket/key plus
  `versionId`), with an optional relative `path` — an absolute or `..` path is
  refused. An unpinned reference cannot be reproduced after the fact, so a
  floating tag fails validation rather than being stored.
- `oci` is the only source kind that currently becomes `Ready` in the runtime
  (a non-OCI source has no egress from the golden snapshot actor). git/bucket
  sources stay *valid stored config* and come back as **warnings**
  (`kagentSpecWarnings`) so the UI can flag them instead of forbidding a design
  made before the platform fix lands.
- `tools[]` entries are each either `mcp` (a `RemoteMCPServer` name, an optional
  tool allowlist, optional `requireApproval`) or `subAgent` (name +
  `templateRef` + description). One entry, one kind; the same server or the same
  sub-agent name twice is an error.
- A skill `name` may appear once and plugin sources must serialize uniquely;
  duplicates are an error rather than a silent last-write-wins.
- Distinct OCI images are capped at 29 (`KAGENT_OCI_VOLUME_MAX`) because each
  becomes a mounted volume.
- `env` rows are literal values only, and a `KEY|SECRET|TOKEN`-shaped value is
  **dropped**, not stored. Credentials reach a run through `ModelConfig
  apiKeySecret` or `RemoteMCPServer headersFrom`, both of which live in the
  cluster as secrets. This is the same egress boundary the rest of the platform
  holds; see §7 of [`WORKFLOWS_AUTHENTICATION.md`](./WORKFLOWS_AUTHENTICATION.md).

### 3.5 Agent profile override (`agents/<id>`)

Only **genuine tenant edits** create a document here. The read is a merge:
platform defaults first, tenant copy winning by `id` (`listAgentProfiles`). The
record carries `schemaVersion: 2`, `custom: true`, the curated prompt/tools/guard
fields, the same `backend`/`harness`/`modelFamily`/`taskTier` binding, `systemPrompt`
(≤16000), `kagent`, `updatedBy`, `updatedAt`. A platform-default id cannot be
deleted — only overridden — so `deleteAgentProfile` answers an error for it.

### 3.6 `personaGrants/<recordId>`

`{ persona, allowedCategories }`. `allowedCategories: null` means *everything*
(Org Admin); an absent record means *use the platform default*, which is exactly
what `personaGrants()` merges them over (`DEFAULT_PERSONA_GRANTS`). Because the
defaults are merged at read, an empty collection is not a dangerous state, and
this collection therefore has no seed marker of its own (§6).

### 3.7 `userProfiles` (main document)

`uid → { persona, displayName }`. Anything else in the map is dropped on
normalize. This is the only place a persona is decided, and it is keyed by the
verified Firebase uid — never by a header the browser chose.

## 4. Platform defaults vs tenant copies

`packages/shared-core/src/workflow-defaults.js` ships the catalog: example
workflows, agent profiles, role grants, and `DEFAULT_GATE_TEMPLATE`
(`gate-template-v1`, six cards). An operator can override the platform set
without redeploying through `workflowDefaults` in the **legacy root**, written
only by `PUT /api/workflows/defaults/:section` (global admin). `GET
/api/workflows` hands the effective gate template to the browser as
`gateTemplate` alongside the graphs, so a gate node is seeded from what the
platform actually ships today.

The tenant copy is what the graph stores; a later change to the platform
defaults never rewrites a saved gate.

## 5. Revisions and conflict handling

`revision` is owned by the server and incremented by every accepted `PUT`. A
client that knows a revision sends it as `If-Match`; a mismatch answers
`409 revision_conflict` **with the server copy in the body** so the browser can
rebase and show what moved. A `PUT` with no `If-Match` is an unconditional write
— that is the shape used by a first `POST` of a new graph (`expectedRevision: 0`).

Consequences worth knowing:

- two tabs editing one graph produce one visible conflict, not a silent loss;
- an interrupted save is recorded as a **debt** in the browser
  (`<orgKey>.pending`) and re-sent revision-checked on the next load, so the
  push resumes instead of being rolled back by the load that follows it;
- `POST /import` refuses while the tenant has any graphs, which is what makes a
  two-tab import duplicate-free without needing a cross-document transaction.

## 6. Seeding, migration, reset

Three states look identical to an empty `workflows` collection: never seeded,
deliberately emptied, mid-migration. They are not, so the decision is not made
from emptiness alone.

| State | Recorded as | Next `GET /api/workflows` |
|---|---|---|
| never initialized | `workflowGraphsSeededAt: null`, no graphs | copy the platform examples, **stamp the marker** |
| initialized, operator deleted every graph | marker set, no graphs | stay empty |
| installed before the marker existed | marker null, graphs present | keep the graphs, stamp the marker |
| migration read | marker unset, `?migrate=1` | report real emptiness, do **not** copy examples, do not stamp |

`importV1Workflows` and `resetTenantToDefaults` both stamp the marker: an import
*is* the initialization it replaced, and a reset is the initialization the
operator asked for by name. The client sends `migrate` only when it holds
localStorage graphs **and** is allowed to write, so a member's read and an empty
browser's read still get the normal lazy seed.

The marker lives in the tenant's own main document — the same document the
`workflows` collection belongs to — because the gateway never consults the org
service for workflows. An org-side `workflowSeedPending` flag would be written
by onboarding and read by nobody.

## 7. v1 → v2

Old browsers stored one `{ schemaVersion: 1, activeWorkflowId, workflows[],
customAgents[], customContexts[] }` blob under `ai-fleet.workflows.<orgKey>`.
`migrateV1ToV2` normalizes a stored graph and gives an agent node
`backend: 'substrate'` plus a `taskTier` derived from its `modelPreference`; it
is idempotent, so rehydrating a v1 draft into v2 in the browser and posting the
result is the same write as posting raw v1.

Migration is one `POST /api/workflows/import` for the whole set — not one
`POST` per graph — so a partially imported tenant cannot exist.

## 8. What is deliberately *not* stored

- **No credential material.** No API keys, tokens, kubeconfigs or header values
  in any of the documents above. Binding *names* (`modelConfig.name`,
  `server`) are stored; what they point at stays in the cluster.
- **No run history.** A graph is a design; executions live in `jobs` and the
  billing ledger, not here.
- **No per-user canvas state.** `viewport` is per graph and shared with the
  organization by design — the canvas is a team document, and the draft cache in
  the browser is the only private copy.

## Related documents

- [`WORKFLOWS_APPLICATION_FLOW.md`](./WORKFLOWS_APPLICATION_FLOW.md) — read/write/publish path, gate verdicts, kagent CR mapping
- [`WORKFLOWS_AUTHENTICATION.md`](./WORKFLOWS_AUTHENTICATION.md) — authz matrix, persona grants, cluster RBAC
- [`FIRESTORE_STRUCTURE.md`](./FIRESTORE_STRUCTURE.md) — the store's overall layout and backend routing
- [`SUBSTRATE_INTEGRATION.md`](./SUBSTRATE_INTEGRATION.md) — the other publish target
