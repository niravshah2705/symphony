# kagent-tenant

One Helm release per tenant: a ModelConfig, a Harness, an AgentTemplate and an
Agent — plus an EgressPolicy for any agent that dials outside the cluster — all
prefixed `<tenant>-<kind>-<name>` and labelled `kagent.dev/tenant=<tenant>`.

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

## Reaching a third-party endpoint

An override set is enough to leave LiteLLM: a model with its own `baseUrl` dials
that host, and `egress:` grants it. A model's key only reaches the wire at the
gateway — a destination's `authentication` replaces the named header (default
`authorization`, with an optional `prefix`) using `secretKeyRef`, so the runtime
sends a placeholder and the real credential never enters the Actor. Bind the
policy from `agents[].egress`; kagent reports `EgressPolicyNotFound` on the Agent
if the name is absent, which is why the render checks the reference.

`authentication` is per destination and requires an **exact** origin — kagent
rejects a wildcard with "authentication requires an exact HTTP(S) origin". So a
policy that authenticates `https://api.example.com` and also needs
`https://*.example.com` lists the wildcard as a destination with no
`authentication` block. Several exact origins may share one credential, and a host
whose `Authorization` the runtime derives from a signature must be granted
*without* `authentication`, or the rewrite invalidates the request it signs.

`ci/values-{kind,fleet}.yaml` are the render fixtures and `ci/values-invalid.yaml`
is the negative fixture: `helm template` must exit non-zero on it (see the header
for the four defects it carries).

`Harness.spec.env` remains the one place a secret must *not* appear, and an
`EgressPolicy` spec does not carry a value either: both reference the Secret by
name.

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
- A `byo` Harness may not put a credential name (`QODER_API_KEY`, `QODER_PAT`,
  `QODER_REFRESH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`,
  `LITELLM_API_KEY`) in `env`: `spec.env` has no `valueFrom`, so the value would be
  plaintext in the release, visible to `helm get values` and every Actor snapshot.
  Reference the Secret from `models[].apiKeySecret` / `apiKeySecretKey` instead;
  `allowLiteralKey: true` acknowledges the plaintext deliberately. A
  `QODER_JOB_TOKEN` that carries a live `jt-`/`jrt-`/`pt-` value is refused even
  with that acknowledgement — the CLI must be handed the inert envelope, because a
  real token is frozen into the ActorTemplate snapshot and cannot be rotated.
- Every entry needs a `name`, and names must be unique within a list — two
  entries sharing one would render one object and silently drop the other.
- `egress[]` entries need at least one `destinations[].origin`, and any
  destination with `authentication` needs a `secretRef` with both `name` and
  `key` on an exact origin: a policy that grants nothing applies cleanly and then
  never turns `EgressPoliciesApplied` True on the Agent.
- Within one policy an origin appears once (two entries would leave "which
  authentication wins" undefined), and `authentication.secretRef.key` must not be
  `key` — that is the tenant's LiteLLM virtual key, so a third-party origin would
  be handed the platform's billing credential.
- Every `egress[]` entry is referenced by at least one agent. A policy nothing
  binds reports Ready while sitting in the namespace as an unexamined grant.
- `templates[].modelConfig`, `agents[].template`, `agents[].harness` and every
  `agents[].egress` name must refer to entries in this same release.

`memory` and `compaction` pass through verbatim, so their CEL rules stay the
CRD's job rather than a second copy that can drift. Because the passthrough is
unprefixed, a `modelConfigRef` inside it must carry the full
`<tenant>-model-<name>`.
