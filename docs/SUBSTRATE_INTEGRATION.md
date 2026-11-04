# Agent Substrate Integration (parallel execution substrate)

This document covers how [Agent Substrate](https://github.com/agent-substrate/substrate)
is wired in as a **third, user-selectable execution substrate** alongside Cloud Run
and OpenShell, how authentication stays managed (raw credentials never enter the
actor), and how the **one shared guardrail spec** drives both OpenShell and
Substrate. It is the substrate sibling of
[`OPENSHELL_INTEGRATION.md`](./OPENSHELL_INTEGRATION.md).

## 1. Three orthogonal "how the agent runs" concepts

Do not confuse these — each is a separate persisted key:

| Concept | Key | Values | Where enforced |
|---|---|---|---|
| Harness / SDK | `agentRuntime` | deepagent, claude-agent-sdk, codex-sdk, … | `packages/shared/src/agent/harnesses/registry.js`, admission in `services/gateway/src/pipeline-admission.js` |
| Reasoning pattern | `workflowPattern` | plan/act/reflect, … | `packages/shared/src/agent/harnesses/contract.js` |
| **Execution substrate** | **`agentPattern`** | **`cloudrun` \| `openshell` \| `substrate`** | `packages/shared/src/agent/pattern-router.js` (planning stage only) |

`agentPattern` defaults to `cloudrun`, so **every existing install is byte-for-byte
unchanged** unless an operator opts in. Only the **planning stage** diverts to
Substrate; every other stage falls through to `executeAgentRuntime`.

## 2. What runs where

- **Backend** drives Substrate over a **gRPC client to `ateapi`**
  (`packages/shared-core/src/agent/substrate.js`) — no `kubectl-ate` /
  `ate-setup` at runtime. Protobuf framing is shared with OpenShell via
  `packages/shared-core/src/agent/grpc-wire.js`.
- **Sandbox = gVisor (runsc)** on a dedicated, tainted node pool. The `SandboxConfig`
  gvisor runtime class is installed by the platform, so this module does **not**
  define its own RuntimeClass.
- **Per-run ephemeral actor**: each planning run creates an actor from an
  `ActorTemplate`, dispatches the prompt, then `finally` suspends + deletes it
  (honoring `substrateActorTtlMs`).
- **Data plane**: the prompt is POSTed to `substrateIngressUrl` with header
  `ate-target-actor: <atespace>/<actor>` + `authorization: Bearer <actorJwt>`;
  the atenet-router forwards to the planner image's actor-mode route
  `POST /internal/plan/run` (`services/planner/src/routes/substrate-actor.js`),
  which verifies the actor JWT against the ate-idp-server JWKS and runs
  planning in-process via `executeAgentRuntime`. Mounted only when
  `SUBSTRATE_ACTOR_MODE=true` + `SUBSTRATE_JWKS_URL` are set, so a normal
  planner pod 404s on this path.

## 3. Managed authentication / credential injection

The invariant from [`CLAUDE.md`](../CLAUDE.md) holds: **no raw third-party
credential ever enters the actor env.** The flow is:

```
settings vault (KMS envelope)  ──S2S──▶  substrate Secrets (substrate-credentials ns)
        └─ packages/shared-core/src/secrets/s2s-resolver.js (single secret source)
                                          │
                    credential provider {"name":"k8s.io"} reads them ──▶ egress gateway
                                          │  (injects on the outbound call, outside the sandbox)
                                     actor process  ──  sees only the sentinel, never the key
```

Before **any** credential is injected, the bundled `k8s.io` provider ships an
**empty default-deny namespace policy** — the atespace must be granted read of
the credentials namespace. Two pieces do this:

1. **Terraform** (`substrate.tf`): a `Role` (`secrets get/list/watch`) +
   `RoleBinding` whose subject is the `atenet-egress` service account in
   `ate-system`, scoped to the `substrate-credentials` namespace only.
2. **Backend** (`syncSubstrateSecrets` in
   `packages/shared-core/src/agent/substrate-runner.js`): writes the per-org
   Secrets and the read grant, **fingerprint-only** (`***REDACTED***`, sha256
   prefix) — the return value never contains a raw value. It throws if no
   `applyManifest` seam is injected (so a misconfigured deploy fails closed).

Actor identity: `mintActorJwt` (audience-scoped, expiring), verified against the
`ate-idp-server` JWKS in `verifyActorJwt` (malformed / expired /
audience_mismatch / trust_domain_mismatch).

## 4. Shared unified guardrail spec

One structured object (`packages/shared-core/src/guardrails/spec.js`) persisted
in `settings.guardrailSpec`, rendered per pattern by
`packages/shared-core/src/guardrails/consumers.js`:

- `buildAtenetEgressPolicy(spec)` → Substrate actor `EgressPolicy` rules
  (+ `denyByDefault`, `denyCidrs` — `169.254.169.254/32` is always denied).
- `buildNamespaceNetworkPolicy(spec)` → per-atespace `NetworkPolicy`.
- `buildCredentialProviderPolicy(spec)` → which Secrets the atespace may read
  (`spec.credentials.scopes`: `github` → `ghcr-pull-and-clone`,
  `openrouter` → `openrouter-api-key`, `image-registry` → `image-registry-creds`).
- `buildOpenShellGuardrail(spec)` → the OpenShell NetworkPolicy YAML.

`GET /api/agent/guardrail` returns the normalized spec plus a `preview`
`{openshellYaml, substrateEgress, credentialProviderPolicy}`; `POST` normalizes +
validates + persists. `tools.allowlist` / `denyAll` also feed pipeline admission.

## 5. Enabling it (operator steps)

The **`ate-system` control plane is NOT installed by Terraform** — its images are
ko-built (no static manifests). Install it with the upstream installer once the
pool exists, then apply the module's stable infra pieces.

1. Set the substrate repo variables and enable the flag so the pool + namespaces
   get created:
   ```bash
   gh variable set SUBSTRATE_ENABLED          --body "true"
   gh variable set SUBSTRATE_NODE_POOL        --body "substrate-worker-pool"
   gh variable set SUBSTRATE_INGRESS_HOSTNAME --body "substrate.<your-domain>"   # optional
   ```
2. Run **Deploy to GCP** with `gke_reconcile` (see §7 for the first-apply note).
3. Install the control plane onto the cluster (run from a workstation with
   kubectl context + a checkout of the substrate repo):
   ```bash
   go run ./cmd/ate-setup deploy ate-system \
     --credential-provider='{"name":"k8s.io"}' \
     --ingress-allowed-spiffe-ids=spiffe://cluster.local/ns/ate-system/sa/atenet-client
   ```
   GKE-specific setup (PD/Filestore CSI already on, snapshot class) is provided by
   this module; see the upstream GKE guide.
4. In **Settings → Runtime**, pick the `substrate` pattern, set `substrateUrl`
   (ateapi gRPC endpoint) and `substrateIngressUrl`, and edit the shared guardrails.

## 6. Key files

- `packages/shared-core/src/agent/substrate.js` — ateapi gRPC client (control plane).
- `packages/shared-core/src/agent/substrate-runner.js` — credential bridge + per-run
  actor lifecycle (`runPlanningOnSubstrate`) + `verifyActorJwt`.
- `packages/shared-core/src/agent/grpc-wire.js` — protobuf primitives shared with OpenShell.
- `packages/shared-core/src/secrets/s2s-resolver.js` — single managed secret source.
- `packages/shared-core/src/guardrails/{spec,consumers}.js` — unified spec + per-pattern renderers.
- `packages/shared/src/agent/pattern-router.js` — `dispatchPlanning` branch (substrate|openshell|cloudrun).
- `services/planner/src/routes/agent.js` — `/agent/substrate/*` and `/agent/guardrail` routes.
- `services/planner/src/routes/substrate-actor.js` — actor-side `POST /internal/plan/run` (only mounted when `SUBSTRATE_ACTOR_MODE=true`).
- `services/planner/src/jwks.js` — cached JWKS fetcher used by the actor route.
- `deploy/gcp/terraform-openshell-gke/substrate.tf` — pool, namespaces, snapshots, ingress.
- `public/js/views/settings.js` — pattern selector + guardrails panel.

### Actor-mode env vars (set on the substrate ActorTemplate's container)

| Var | Purpose |
|---|---|
| `SUBSTRATE_ACTOR_MODE=true` | Mounts the `/internal/plan/run` route; a normal planner pod does not register it. |
| `SUBSTRATE_JWKS_URL=https://<ate-idp-server>/jwks.json` | Required. Without it the route returns 503 and refuses every request. |
| `SUBSTRATE_ACTOR_JWT_AUDIENCE` | Defaults to `substrate-router`; must match the `aud` the runner mints. |
| `SUBSTRATE_TRUST_DOMAIN` | Defaults to `cluster.local`; the SPIFFE trust domain the router forwards under. |

## 7. CI

`.github/workflows/deploy.yml` `gke_reconcile` passes substrate vars only when the
corresponding repo variable is set (unset leaves the module default = disabled).
It **reads the live substrate node-pool bounds back** and feeds them as
`substrate_min/max_nodes`, so a reconcile cannot silently start a pool the power
workflow parked. `openshell-cluster-power.yml` parks/wakes the substrate pool in
lockstep when `SUBSTRATE_NODE_POOL` is set.

The **first apply with `substrate_enabled = true` shows the new resources as
`create`** (pool, namespaces, snapshot class, ingress) — this is expected and does
**not** destroy anything, so it passes the destroy gate. Do not set
`gke_allow_destroy` for it.

## 8. Verification

- Unit (`npm test`): protobuf golden frames, `normalizeGuardrailSpec` /
  `validateGuardrailSpec`, `resolveSubstrateAtespace`, `syncSubstrateSecrets` leaks
  no raw token, `pattern-router` branch table, `verifyActorJwt` vs fixture JWKS.
  The `grpcCall` `options.transport` seam fakes the control plane in lifecycle tests.
- Staging actor smoke: status SERVING + gvisor present; secrets-sync creates a
  `substrate-credentials` Secret + read grant; run a trivial prompt → actor READY →
  streamed result; **inside the actor** `curl 169.254.169.254` is DENIED and
  OpenRouter:443 ALLOWED with a gateway-injected credential while actor env has
  **no** key; actor SUSPENDED+DELETED after TTL.

## 9. Known limits / risks

- Pre-1.0 upstream: ateapi proto field numbers and CRD schemas can drift — pinned
  in `substrate.js` against the tracked `.proto`.
- gVisor runsc must be available on the pool's node image; plain containers are
  unsupported. Cloud Hypervisor microVM is the fallback.
- Actor cold-start / resume latency must fit inside the planner stage request
  budget; measure on staging before defaulting orgs to `substrate`.
