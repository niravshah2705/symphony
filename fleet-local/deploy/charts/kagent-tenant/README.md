# kagent-tenant

One Helm release per tenant: a ModelConfig, a Harness, an AgentTemplate and an
Agent, all prefixed `<tenant>-<kind>-<name>` and labelled
`kagent.dev/tenant=<tenant>`.

Application code installs it directly — nothing here depends on Terraform:

```sh
helm upgrade --install northwind ./charts/kagent-tenant \
  --namespace kagent \
  --set tenant.id=northwind \
  --set tenant.snapshotRoot=gs://symphony-snapshots-prod/northwind
```

## What a tenant is here

A tenant is a **name prefix, a credential reference and a snapshot root** — not
a Kubernetes namespace. Everything lands in `namespace:` (default `kagent`).

That is forced by kagent, not chosen for convenience:
`Harness.spec.substrate.workerPoolRef` is a `LocalObjectReference` resolved in
the Harness's own namespace (`compiler.go:169` in kagent's translator), so every
Harness must sit in the namespace that holds its WorkerPool. This deployment
runs one shared pool.

### Isolation you get

**Data isolation is enforced.** Substrate mints a per-actor storage grant scoped
to that actor's prefix under the snapshot root, and rejects any prefix that is
not the backend's own scheme. Tenant A's actor cannot read tenant B's snapshots
even from the same namespace, because the credential it is handed does not
extend to B's prefix.

### Isolation you do not get

**There is no API isolation.** Kubernetes RBAC has no way to scope a verb to a
resource *name*, so anyone with `get` on `agents.api.kagent.dev` in the tenant
namespace can list every tenant's Agent, Harness, ModelConfig and Secret
*names* (never their values — those live in Secrets this chart only references).

For most agent fleets that is acceptable: the objects describe behaviour, and
credentials stay out of them. If a deployment needs tenants that cannot see each
other at all, set `namespace:` per tenant **and** create a WorkerPool in each of
those namespaces (the platform module renders `substrateWorkerPool`, so it is a
values change on both sides). `NOTES.txt` prints the pool check for exactly that
case.

## Model defaults

`litellm:` supplies the defaults every model inherits, so a tenant never holds a
provider key — the ModelConfig references a Secret **by name**, and the platform
creates it. Any model may override `baseUrl`, `apiKeySecret`, `apiKeySecretKey`,
`stream` and `defaultHeaders`.

`apiFormat` is the CRD enum verbatim: `responses` or `chatCompletions`. Note the
camelCase — `chat_completions` is rejected by the API.

## Validation at render time, not apply time

`templates/_helpers.tpl` fails the render for the mistakes that otherwise apply
cleanly and then never reconcile:

- `tenant.id` must be an RFC1123 label. It is also a snapshot path segment, so
  the rules are taken from their intersection and `atespaces` is refused.
- `tenant.snapshotRoot` must be `s3://…` or `gs://…`, with every segment matching
  Substrate's own `^[A-Za-z0-9_-]+$` check.
- `harnesses[].type` must be one of `kagent|codex|claude|byo` (the CRD enforces
  `ExactlyOneOf`), `byo` requires both a digest-pinned `image` and a `command`,
  and `codex`/`claude` reject `command`/`args`.
- Every entry needs a `name`, and names must be unique within a list — two
  entries sharing one would render one object and silently drop the other.
- `templates[].modelConfig`, `agents[].template` and `agents[].harness` must name
  entries in this same release.

`memory` and `compaction` pass through verbatim, so their CEL rules stay the
CRD's job rather than a second copy that can drift. Because the passthrough is
unprefixed, a `modelConfigRef` inside it must carry the full
`<tenant>-model-<name>`.
