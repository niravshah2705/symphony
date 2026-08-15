# Firestore structure

This is a code-derived structural export of the Firestore Native database used
by AI Fleet. It documents collection paths, document identifiers, and persisted
field shapes; it does **not** contain live document values or credentials.

Firestore is schemaless, so the serializers and repository write paths linked
below are the source of truth. Fields marked optional may be absent or `null`.

## Naming conventions

- `{org_id}`, `{user_id}`, `{project_id}`, and similar placeholders are logical
  identifiers. Python service identifiers are normally UUID strings.
- `sha256(value)` is a lowercase, 64-character SHA-256 digest. Hashes keep raw
  tenant, run, checkpoint, and idempotency identifiers out of physical paths.
- The org and settings services prefix only the top-level collection with
  `<FIRESTORE_NAMESPACE>__`. Their production defaults are `org_service__` and
  `settings_service__`.
- JavaScript services use `STORE_NAMESPACE` as an optional `__<slug>` suffix.
  An empty namespace preserves the unsuffixed shared-stack collection names.
- Firestore permits subcollections below a missing parent document. Container
  documents such as settings-service organizations/projects and checkpoint
  threads/namespaces therefore may not have their own data.

## Physical collection tree

```text
(default)
├── org_service__organizations/{org_id}
│   ├── projects/{project_id}
│   │   └── tasks/{task_id}
│   ├── tags/{tag_id}
│   ├── memberships/{membership_id}
│   ├── members/{user_id}
│   └── invitations/{invitation_id}
├── org_service__users/{user_id}
│   ├── projects/{personal_project_id}
│   └── organizations/{org_id}
├── org_service__refresh_tokens/{token_hash}
├── org_service__unique_emails/{normalized_email}
├── org_service__unique_external_subjects/{external_subject}
├── org_service__organization_invitation_tokens/{token_hash}
├── org_service__organization_pending_invitations/{sha256(org_id + ":" + email)}
├── org_service__user_org_locks/{user_id}                 # legacy cleanup only
│
├── settings_service__organizations/{org_id}              # container may be absent
│   ├── settings/policy
│   ├── secrets/vault
│   ├── deployment_approvals/{run_id}
│   ├── projects/{project_id}/settings/policy
│   └── memberships/{project_id}:{user_id}
├── settings_service__users/{user_id}
│   └── settings/policy
├── settings_service__unique_emails/{email}
├── settings_service__unique_external_subjects/{external_subject}
│
├── {workspace_root}/store
│   ├── jobs/{id}
│   ├── memories/{id}
│   ├── conversations/{id}
│   ├── approvals/{id}
│   ├── stackLinks/{id}
│   ├── settingsHistory/{id}
│   ├── usageRecords/{id}
│   ├── ledgerEntries/{id}
│   └── billingAccounts/{id}
├── aifleet_events[__{store_namespace}]/{channel_id}/steps/{auto_id}
├── aifleet_pipeline_runs[__{store_namespace}]/{sha256(run_id)}
│   └── stages/{sha256(idempotency_key)}
├── aifleet_pipeline_checkpoints[__{store_namespace}]/{sha256(thread_id)}
│   └── namespaces/{sha256(checkpoint_namespace)}
│       └── checkpoints/{sha256(checkpoint_id)}
│           └── writes/{sha256(task_id + NUL + index)}
├── aifleet_pipeline_worker_results[__{store_namespace}]/{sha256(idempotency_key)}
└── email_service__deliveries/{sha256(delivery_key)}
```

`{workspace_root}` is one of:

- `aifleet` for the shared legacy/default workspace;
- `aifleet__{store_namespace}` for a dedicated deployment; or
- `aifleet_workspace_org_{sha256(org_id)}` for an organization selected on the
  shared stack.

## Organization service

All paths in this section are below the `org_service__` physical prefix by
default. Model timestamps are native Firestore timestamp values.

### Primary documents

| Logical path | Document ID | Persisted fields |
| --- | --- | --- |
| `organizations/{org_id}` | Organization UUID | `id`, `name`, `description?`, `slug`, `deployment_slug`, `deployments` (map), `created_at`, `updated_at`, `applied_tag_ids` (string[]) |
| `organizations/{org_id}/projects/{project_id}` | Project UUID | `id`, `org_id`, `name`, `description?`, `created_at`, `updated_at`, `tag_ids` (string[]) |
| `organizations/{org_id}/projects/{project_id}/tasks/{task_id}` | Task UUID | `id`, `project_id`, `title`, `description?`, `status`, `assignee_id?`, `created_at`, `updated_at`, `tag_ids` (string[]) |
| `organizations/{org_id}/tags/{tag_id}` | Tag UUID | `id`, `org_id`, `name`, `created_at`, `updated_at` |
| `organizations/{org_id}/memberships/{membership_id}` | Generated membership UUID | `id`, `project_id`, `user_id`, `role`, `created_at`, `updated_at` |
| `organizations/{org_id}/members/{user_id}` | User UUID | `id`, `org_id`, `user_id`, `role`, `status`, `created_at`, `updated_at` |
| `users/{user_id}/organizations/{org_id}` | Organization UUID | Mirror of the authoritative organization-membership document above |
| `organizations/{org_id}/invitations/{invitation_id}` | Invitation UUID | `id`, `org_id`, `email`, `role`, `status`, `token_hash`, `invited_by?`, `expires_at?`, `accepted_by?`, `accepted_at?`, `delivery_attempt`, `created_at`, `updated_at` |
| `users/{user_id}` | User UUID | `id`, `org_id?`, `email`, `full_name?`, `password_hash?`, `auth_provider`, `external_subject?`, `managed_by_org_id?`, `org_role`, `is_super_admin`, `is_active`, `email_verified`, `password_changed_at?`, `email_verification_token_hash?`, `email_verification_expires_at?`, `created_at`, `updated_at` |
| `users/{owner_id}/projects/{project_id}` | Project UUID | `id`, `owner_id`, `name`, `description?`, `created_at`, `updated_at` |
| `refresh_tokens/{token_hash}` | Hash of the raw refresh token | `id`, `user_id`, `token_hash`, `family_id`, `expires_at?`, `revoked`, `created_at`, `updated_at` |

Project membership IDs are generated UUIDs in the physical repository write
path. A model comment describing `{project_id}_{user_id}` is stale. Tag-name
uniqueness is checked by query; the running code does not create a `tag_names`
guard collection. A refresh-token model comment describing `refresh_tokens/{id}`
is also stale; auth-service writes key documents by `token_hash`.

Firestore does not cascade deletes. Organization/project removal explicitly
walks the known org-service subcollections, while refresh-token records are
revoked rather than deleted.

Enum values:

- organization roles: `ORG_ADMIN`, `MEMBER`;
- organization membership status: `ACTIVE`;
- project roles: `PROJECT_ADMIN`, `TEAM_LEAD`, `DEVELOPER`;
- task status: `TODO`, `IN_PROGRESS`, `IN_REVIEW`, `DONE`;
- invitation status: `PENDING`, `ACCEPTED`, `REVOKED`, `EXPIRED`;
- auth provider: `LOCAL`, `EXTERNAL`.

### Lookup and uniqueness documents

| Logical path | Fields | Lifecycle |
| --- | --- | --- |
| `unique_emails/{normalized_email}` | `user_id` | Created atomically with a user; email is immutable |
| `unique_external_subjects/{external_subject}` | `user_id` | Created atomically for an external identity |
| `organization_invitation_tokens/{token_hash}` | `org_id`, `invitation_id` | Rotated/deleted with the invitation token |
| `organization_pending_invitations/{sha256(org_id + ":" + email)}` | `org_id`, `invitation_id` | Exists only while an invitation is pending |
| `user_org_locks/{user_id}` | legacy document containing at least `org_id` | No longer written; read only during old-data cleanup |

Sources: [collection helpers](../services/org/app/repositories/base.py),
[models](../services/org/app/models/), and
[repository writes](../services/org/app/repositories/).

## Settings service

All paths in this section are below the `settings_service__` physical prefix by
default. Organization and project parent documents are structural containers;
the settings service need not write those parents.

### Policy documents

The following paths all store the same policy shape:

- `organizations/{org_id}/settings/policy` (`scope_type = "org"`)
- `organizations/{org_id}/projects/{project_id}/settings/policy`
  (`scope_type = "project"`)
- `users/{user_id}/settings/policy` (`scope_type = "user"`)

```text
scope_type: "org" | "project" | "user"
scope_id: string
domains: {
  harness|tools|skills|plugins|hooks|models: {
    include: string[]
    exclude: string[]
  }
}
values: { geminiApiKey?: string }                 # write-only secret value
prefs: {
  complexityTier?|llmProvider?|agentRuntime?|planHarness?|codeHarness?|
  testHarness?|deployHarness?|workflowPattern?|planningProvider?|
  langsmithTracing?: string
}
locks: (preference-key | domain-name)[]
created_at: Timestamp
updated_at: Timestamp
```

### Secret vault

`organizations/{org_id}/secrets/vault`:

```text
scope_type: "org"
scope_id: string
selection: {
  geminiApiKey?|githubToken?|linearApiKey?|anthropicApiKey?|openaiApiKey?|
  huggingfaceApiKey?|langsmithApiKey?|codexTokenBundle?: "managed" | "customer"
}
secrets: {
  <allow-listed key>: {
    ciphertext: base64 string
    iv: base64 string
    tag: base64 string
    wrapped_dek: base64 string
    key_version: string
    alg: "AES-256-GCM"
    created_at: Timestamp
  }
}
created_at: Timestamp
updated_at: Timestamp
```

Only encrypted customer secret material is stored in `secrets`; raw values must
not be written there. The `selection` map defaults to `managed` when a key is
absent.

### Deployment approvals

`organizations/{org_id}/deployment_approvals/{run_id}` uses the run ID as both
document ID and `approval_id`:

```text
approval_id: string
run_id: string
org_id: string
project_id: string
repository: "owner/name"
environment: string
test_command_id: string
commit_sha: 40-character hex string
tree_sha: 40-character hex string
preflight_decision_digest: 64-character hex string
approved_by: string
approved_at: Timestamp
expires_at: Timestamp
consumed_at: Timestamp | null
consumed_test_completed_at?: Timestamp
```

Expired or consumed approval documents have no configured TTL or delete path.

### Legacy local-auth documents

| Logical path | Document ID | Persisted fields |
| --- | --- | --- |
| `users/{user_id}` | User UUID | `id`, `org_id?`, `email`, `full_name?`, `auth_provider`, `external_subject?`, `org_role`, `is_super_admin`, `is_active`, `email_verified`, `password_changed_at?`, `created_at`, `updated_at` |
| `organizations/{org_id}/memberships/{project_id}:{user_id}` | Composite project/user ID | `id`, `org_id`, `project_id`, `user_id`, `role`, `created_at`, `updated_at` |
| `unique_emails/{email}` | Email string | `user_id` |
| `unique_external_subjects/{external_subject}` | External subject | `user_id` |

These records support standalone/local-JWT compatibility. For Firebase callers,
the organization service remains authoritative for membership context.

Sources: [collection helpers](../services/settings/app/repositories/base.py),
[policy model](../services/settings/app/models/policy.py),
[secret model](../services/settings/app/models/secrets.py),
[envelope record](../services/settings/app/crypto/envelope.py), and
[deployment approval writes](../services/settings/app/services/deployment_approval_service.py).

## Shared application state

The Firestore backend splits one logical store across a main document and
per-record subcollections to stay below Firestore's 1 MiB document limit.

### `{workspace_root}/store`

```text
settings: map
businesses: {
  id, name, description, projectId?, repo?, repoProvider, createdAt,
  orgId?, organizationId?, nativeProjectId?, ...
}[]
assumedRole: { id, name, email } | null
agentConfig: {
  parallelProcessing, maxConcurrentCoders, scheduleEnabled, autoAssignLead,
  autoLabelNewProjects, createIssues, addDependencies, maxProjectsPerRun,
  maxMilestones, maxIssuesPerMilestone, enrichLabels, intervalMinutes,
  evaluationApprovalWaitMinutes
}
eula: {
  users: { <user-key>: { status, version, via, at } }
  orgs: { <org-id>: { status, version, via, at } }
}
billing: { lastAggregatedAt: ISO string | null }
```

`settings` is a large operational configuration map. In local and non-proxied
gateway operation it can include provider tokens/API keys and OAuth bundles; it
must be treated as secret-bearing server-side data.

### Store subcollections

Every record is stored unchanged and uses its `id` field as the Firestore
document ID.

| Subcollection | Stable/common persisted shape |
| --- | --- |
| `jobs` | Open job record; common fields are `id`, `kind`, `orgId?`, `nativeProjectId?`, `status`, `createdAt`, `updatedAt`, `startedAt?`, `finishedAt?`, `error?`, `summary?`, and bounded `steps[]` |
| `memories` | `id`, `scope`, `refId?`, `title`, `text`, `tags[]`, `source`, `createdAt`, `updatedAt` |
| `conversations` | `id`, `title`, `orgId?`, `nativeProjectId?`, `createdAt`, `updatedAt`, bounded `messages[]`; messages include generated `id` and `ts` |
| `approvals` | `id`, `requirement`, `businessId?`, `conversationId?`, `evaluation?`, `signal`, `waitMinutes`, `status`, `deadline?`, `decidedAt?`, `decision?`, `proceededAt?`, `jobId?`, `attempts`, `orgId?`, `nativeProjectId?`, `createdAt`, `updatedAt` |
| `stackLinks` | `id`, `projectId?`, `provider`, `repoFullName?`, `dependentBranch`, `blockerBranch`, `blockerIdentifier?`, `defaultBase`, `dependentReviewId?`, `dependentReviewUrl?`, `orgId?`, `nativeProjectId?`, `createdAt`, `resolvedAt?` |
| `settingsHistory` | `id`, `ts`, `orgId`, `complexityTier`, `perRolePicks` (thinking/execution/testing/deployment provider, preset, and model), `estMonthlyCostUsd`, `harness`; non-secret selection history only |
| `usageRecords` | `id`, `orgId`, `projectId?`, `projectName?`, `userId?`, `userEmail?`, `taskId?`, `taskIdentifier?`, `source`, `provider?`, `model?`, `usage` (token counts), `costUsd`, `costPaise`, `createdAt` |
| `ledgerEntries` | `id`, `orgId`, `type`, signed integer `amountPaise`, `description`, `meta`, `createdAt` |
| `billingAccounts` | `id = orgId`, `orgId`, `currency`, `balancePaise`, `initialCreditPaise`, `alertThresholdsPaise[]`, `lastAlertedThresholdPaise?`, `notifyChannels`, `notifyEmails[]`, `autoRecharge`, `gateEnabled`, `createdAt`, `updatedAt` |

Sources: [store schema and partition](../packages/shared-core/src/store.js) and
[Firestore backend](../packages/shared-core/src/store/firestore-backend.js).

## Event relay

Path:
`aifleet_events[__{store_namespace}]/{channel_id}/steps/{auto_id}`.

The channel parent document is not written. A channel ID is either the raw
conversation/workspace channel or `<channel>--<32-hex-scope-digest>` when an
organization/project context is present. Each step contains the caller's event
payload plus an ISO `ts` string. Known workspace payloads use `type` values
`jobs`, `agent-status`, `coder`, `gate`, and `notification`; conversation events
commonly contain `level`, `message`, and optional execution metadata.

The subscriber orders steps by `ts`. No application cleanup or Firestore TTL is
configured for this collection.

Source: [event relay](../packages/shared-core/src/messaging/events.js).

## Pipeline orchestration

### Pipeline run

Path:
`aifleet_pipeline_runs[__{store_namespace}]/{sha256(run_id)}`.

```text
schemaVersion: 1
runId: string
organizationId: string
projectId: string
requestedStages: ("plan" | "code" | "test" | "deploy")[]
status: string
start: PipelineStartV1
preflight: PreflightSnapshotV1 | null
cancellation: map | null
pendingDeploymentApproval: map | null
deploymentApprovalClaim: map | null
failure: map | null
checkpoint: {
  revision: number
  nextStageIndex: number
  completedStages: string[]
  attempts: { <stage>: number }
  activeCommandId: string | null
  lastResultId: string | null
  updatedAt: ISO string
}
createdAt: ISO string
updatedAt: ISO string
```

### Stage run

Path: `<pipeline-run>/stages/{sha256(idempotency_key)}`.

```text
schemaVersion: 1
idempotencyKey: string
commandId: string
runId: string
stage: "plan" | "code" | "test" | "deploy"
attempt: integer
status: string
command: StageCommandV1
result: StageResultV1 | null
dispatch: { count, receipt, lastError, lastAttemptAt }
createdAt: ISO string
updatedAt: ISO string
```

The nested start/preflight/command/result contracts are bounded, secret-checked
JSON objects defined in [pipeline contracts](../packages/shared-core/src/pipeline/contracts.js).
The physical paths and hashes are defined in
[pipeline storage](../packages/shared-core/src/pipeline/storage.js).

### Worker execution result

Path:
`aifleet_pipeline_worker_results[__{store_namespace}]/{sha256(idempotency_key)}`.

```text
schemaVersion: 1
idempotencyKey: string
commandHash: 64-character hex string
runId: string
stage: "plan" | "code" | "test" | "deploy"
attempt: integer
status: "executing" | "completed"
claimId: UUID
startedAt: ISO string | null
leaseExpiresAtMs: integer
result: map | null
recoveredFromExpiredLease: boolean
updatedAt: ISO string
```

Source: [stage execution store](../packages/shared/src/agent/pipeline-stage-execution-store.js).

## LangGraph checkpoints

Thread and namespace documents are path-only containers. Checkpoint records live
at:

`aifleet_pipeline_checkpoints[__{store_namespace}]/{sha256(thread_id)}/namespaces/{sha256(checkpoint_namespace)}/checkpoints/{sha256(checkpoint_id)}`

```text
threadId: string
checkpointNs: string
checkpointId: string
parentCheckpointId: string | null
checkpoint: { type: string, data: base64 string }
metadata: { type: string, data: base64 string }
timestamp: ISO string
```

Pending writes live below each checkpoint at
`writes/{sha256(task_id + NUL + index)}`:

```text
threadId: string
checkpointNs: string
checkpointId: string
taskId: string
channel: string
index: integer
value: { type: string, data: base64 string }
```

Deleting a thread uses the Firestore client's recursive-delete operation so all
descendants are removed together.

Source: [orchestrator checkpointer](../services/orchestrator/src/checkpointer.js).

## Email delivery idempotency

Path: `email_service__deliveries/{sha256(delivery_key)}` by default. The top-level
collection can be overridden by `EMAIL_IDEMPOTENCY_COLLECTION`.

```text
status: "sending" | "sent"
claim_id: UUID
lease_expires_at_ms: integer
delete_after_ms: integer
updated_at: ISO string
```

`delete_after_ms` controls claim reuse in application logic. No Firestore TTL
policy is declared, so it does not itself delete the document.

Source: [email idempotency store](../services/email/src/idempotency.js).

## Indexes and access

- Firestore creates single-field indexes automatically.
- Terraform still declares one composite collection index on `org_id ASC,
  created_at DESC` for collection ID `users`. It describes an older query:
  current org membership listing reads `members` and then fetches users, while
  the physical user collection is `org_service__users` by default. Treat the
  declared index as stale until its Terraform definition is reconciled.
- The repository has no Firestore client rules file or emulator configuration.
  Production services use server SDKs and service-account IAM.
- The database is created in Native mode with deletion policy `ABANDON`.

Source: [Firestore Terraform](../deploy/gcp/terraform/firestore.tf).

## Sensitive-data boundaries

- Raw invitation, refresh, and verification tokens are not stored; only their
  hashes are persisted by the org service.
- Customer provider secrets belong in the encrypted settings vault. Managed
  provider secrets remain outside agent containers and are resolved through the
  proxy/settings path.
- The shared application's main `settings` map is secret-bearing for local and
  non-proxied gateway compatibility. Do not expose or bulk-export it to clients.
- Checkpoints, conversation steps, memories, and job traces can contain user or
  model-generated content and should be treated as tenant data even when their
  physical IDs are hashed.

Update this document when a repository path helper, model `to_doc()` serializer,
shared-store partition, or Firestore-backed durability adapter changes.
