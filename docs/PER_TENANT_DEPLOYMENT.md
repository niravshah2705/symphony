# Per-Tenant Deployment Distribution

How AI Fleet gives an organization its **own** agent stack, on demand, while
keeping org-less users on the shared deployment. Built in four phases (#72–#75)
plus deployment wiring; **disabled by default** so the shared stack is unaffected
until you opt in.

## Two tiers

| Tenant | What runs it | When |
|--------|--------------|------|
| **Pseudo-workspace (shared)** | the SHARED gateway/planner/coder | a signed-in user with no org — auto-given a `"<Name>'s Workspace"` org that points at the shared stack. **No provisioning.** |
| **Provisioned org (dedicated)** | a per-tenant `gateway + planner + coder-control + coder-worker` (reusing the existing images, no rebuild) | a user **explicitly** creates a named organization |

`org-service`, `settings-service`, and Firestore stay **shared** — they are the
tenant registry. Only the agent stack is per-tenant. The per-tenant **gateway**
is the front-facing URL; planner/coder/org/settings URLs are S2S parameters of it.

## How the browser finds its stack

```
SPA (bootstrap base = SHARED gateway, baked in public/config.js)
  1. sign in (Firebase)
  2. GET /api/config  ──►  SHARED gateway  ──S2S(user bearer)──►  ORG  GET /api/v1/me/deployment
        ◄─ { status: "shared",       gatewayUrl: "" }        → stay on the shared gateway
        ◄─ { status: "provisioning" }                        → poll until ready
        ◄─ { status: "provisioned",  gatewayUrl: "https://gw-<slug>-…run.app" }
  3. on "provisioned": setApiBase(gatewayUrl) + reload → the app re-boots against the tenant gateway
```

Server-authoritative: the org is derived from the caller's token; **no
client-supplied org id** is ever accepted, so a caller only learns their own
org's deployment. Only the browser-facing gateway URL is returned.

## Components

- **`packages/shared/src/provisioning/`** — pure core: deterministic Run-safe
  `naming`, the per-tenant resource `plan` (encodes the isolation invariants),
  the client-injectable `provisioner` (executor + teardown), and the lazy
  `@google-cloud` adapter (`index.js`).
- **`services/provisioner/`** — internal, IAM-gated Node service. Consumes
  `tenant-provision-requests` (OIDC push), runs the executor, writes the resolved
  URLs back to the org service.
- **org service** — `provisioning_service.trigger_provisioning/teardown` (publish),
  `GET /api/v1/me/deployment` (resolver), `PATCH /api/v1/internal/orgs/{id}/deployments`
  (S2S write-back, `X-Internal-Token`-guarded), `Organization.deployment_slug` +
  `deployments` registry.
- **gateway** — `GET /api/config` resolver + `service-client.js` (S2S `callJson`).
- **SPA** — `api.setApiBase/getRuntimeConfig`, `deployment.pollUntilResolved`,
  `auth.js` re-point.
- **Terraform** — `provisioner.tf` (gated), org `INTERNAL_API_TOKEN` wiring, and
  the shared coder's peer-URL env.

## Isolation

Per-tenant stacks share one Firestore DB, so the Node runtime store + SSE events
are namespaced by **`STORE_NAMESPACE=<deployment_slug>`** (empty = the shared
`aifleet`/`aifleet_events` collections, unchanged). **This is the load-bearing
isolation control** — without it, per-tenant gateways would commingle every
tenant's store/conversations/events. Per-tenant Pub/Sub topics
(`planner-<slug>`/`coder-<slug>`) prevent cross-tenant message fan-out. Per-tenant
planner/coder are internal + IAM-gated (never `allUsers`); only the tenant gateway
is public (app-auth guarded).

## Resource labels (attribution)

Every per-tenant resource the provisioner creates — Cloud Run services, the
coder-worker Job, and the Pub/Sub topics + subscriptions — is stamped with GCP
labels so an org's stack is filterable in the console and in the billing export:

| Label | Value | Meaning |
|-------|-------|---------|
| `organization` | the org id (UUID, sanitized) | which org owns it |
| `tenant` | the deployment slug (`t<hex>`) | opaque per-tenant id (also in the name) |
| `tenancy` | `dedicated` | a provisioned per-tenant resource |
| `component` | `gateway`/`planner`/`coder-control`/`coder-worker` | which service |
| `managed-by` | `ai-fleet-provisioner` | created at runtime, not by Terraform |

Shared-stack resources (Terraform) carry `tenancy = "shared"` (+ `environment` and
`component`), so `tenancy` cleanly separates dedicated from shared in any
label filter or cost query. (Cloud Scheduler jobs don't support labels; the
per-tenant ticks are identified by their `<name>-<slug>` instead.)

## Enabling (production)

Disabled by default (`provisioning_enabled=false` / `PROVISIONING_ENABLED=false`).
To turn it on:

1. **Build the provisioner image.** A `services/provisioner/**` or `packages/shared/**`
   change builds it automatically; otherwise run the deploy workflow with
   `deploy_all=true` (or a full `cloudbuild.yaml` run).
2. **Set an internal token.** Terraform var `internal_api_token` (a strong random
   string). This creates the `internal-api-token` secret and grants both the
   provisioner and the org service accessor.
3. **Flip the flag.** Terraform var `provisioning_enabled=true`, then apply
   (a `deploy_all=true` run applies it). This creates `provisioner-sa` (+ its
   least-privilege roles), the `tenant-provision-requests` topic + push
   subscription + DLQ, and the internal provisioner service; it also injects
   `PROVISIONING_ENABLED=true` + `INTERNAL_API_TOKEN` into the org service.
4. **Verify in a scratch project first** — create an org, watch
   `deployments.status` go `provisioning → provisioned`, confirm `gw-<slug>`
   serves and `pl-/cc-<slug>` reject unauthenticated calls, then delete the org
   and confirm teardown.

## Caveats

- **Runtime-created, imperative.** Per-tenant resources live **outside** Terraform
  state (only the provisioner service itself is in TF). Do not `terraform destroy`
  expecting tenant stacks to be cleaned up — org deletion tears them down.
- **Shared SAs + shared secrets.** Per-tenant services reuse the 4 shared service
  accounts and shared Secret Manager secrets (Linear key, stream-token secret).
  This adds no IAM-level tenant isolation and is safe only under the shared-Firestore
  trust boundary + `STORE_NAMESPACE`. Per-tenant SAs/secrets is the hardening path.
- **Privileged provisioner SA** (`run.admin`/`pubsub.admin`/`cloudscheduler.admin`,
  per-SA `serviceAccountUser`) lives **only** on the internal provisioner — never
  the public gateway — and its actions should be audit-logged.
- **Deterministic URLs.** Names/URLs derive from `<slug>-<project_number>.<region>.run.app`.
  If the project gets legacy hash-style Run URLs, the write-back's `svc.uri` is the
  authoritative value.

See also: [`GCP_DEPLOY.md`](./GCP_DEPLOY.md), [`GCP_CICD.md`](./GCP_CICD.md),
[`ACCESS_MODEL.md`](./ACCESS_MODEL.md).
