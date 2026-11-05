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
   gh variable set SUBSTRATE_INGRESS_HOSTNAME --body "substrate.<your-domain>"   # optional, see §5.1
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
4. In **Settings → Models & runtime → Execution substrate** (bottom card of that
   section), pick the `substrate` pattern, set `substrateUrl` (ateapi gRPC
   endpoint) and `substrateIngressUrl`, and edit the shared guardrails. The card
   needs a `settings` **write** permission — see §10 if the panel is missing.

### 5.1 Serving it on a public hostname (`substrate.archagentix.com`)

`SUBSTRATE_INGRESS_HOSTNAME` turns on the data-plane front: a dedicated static IP
(`substrate-ip`), a cert-manager certificate, an Envoy `Gateway` + `HTTPRoute` in
`ate-system`, and `BackendTrafficPolicy`s that lift Envoy's default request timeout
so one streaming planning POST stays open for the whole run.

Two things make the hostname usable rather than decorative:

- **Its own Envoy data plane.** The `eg` GatewayClass pins the *OpenShell* IP at
  class level (`openshell-proxy-config`), so a second Gateway on that class would
  fight over the same address. `substrate.tf` therefore renders a per-Gateway
  `EnvoyProxy substrate-proxy-config` (in `ate-system`, so `parametersRef` needs no
  ReferenceGrant) bound to `substrate-ip`, and points
  `spec.infrastructure.parametersRef` at it.
- **A control-plane route.** The planner reaches ateapi over gRPC, and ateapi only
  listens in-cluster. Set `SUBSTRATE_CONTROL_PLANE_PUBLIC=true` to also publish a
  path-prefixed route for `/substrate.ateapi.v1.Control` →
  `${SUBSTRATE_ATEAPI_SERVICE}:${SUBSTRATE_ATEAPI_PORT}` (defaults `ateapi:8443`) on
  the same hostname. **This is the only way `substrateUrl` can be a public URL, and
  it is off by default**: ateapi creates/deletes actors and mints actor JWTs, and
  this config adds **no caller authentication** in front of it. Prefer a private
  path (VPC connector / IAP / service mesh) for anything but a smoke test.

The route matches on path prefix because that is exactly what the client puts on the
wire — `substrate.js` sends `:path = /substrate.ateapi.v1.Control/<Method>` over HTTP/2,
and `http2.connect()` upgrades to TLS for an `https://` `substrateUrl`. So the plain
hostname (no `:8443`) is the correct value; Envoy terminates TLS and forwards the
`/substrate.ateapi.v1.Control/*` prefix to ateapi's gRPC port.

Then:

```bash
gh variable set SUBSTRATE_INGRESS_HOSTNAME      --body "substrate.archagentix.com"
gh variable set SUBSTRATE_CONTROL_PLANE_PUBLIC  --body "true"   # only if you accept the caveat above
```

Apply, read the IP back from the `substrate_ingress_ip` output (the
`substrate_ingress_dns` output prints the record for you), create the **A record**
at the DNS zone, and let cert-manager finish issuing before saving the Settings card
— an HTTPS listener without a ready `Certificate` just hangs `kubectl_manifest.substrate_ingress_gateway`.

| Settings field | Value for `substrate.archagentix.com` |
|---|---|
| `substrateUrl` | `https://substrate.archagentix.com` with `SUBSTRATE_CONTROL_PLANE_PUBLIC=true` (gRPC rides the `/substrate.ateapi.v1.Control` prefix); otherwise the in-cluster `ateapi.ate-system.svc:8443`, reachable only from inside the VPC |
| `substrateIngressUrl` | `https://substrate.archagentix.com` |
| `substrateAtespace` | leave blank to derive it per organization, or pin one shared space. `GET /api/agent/substrate/status` echoes the resolved value; the runner creates it over ateapi (`CreateAtespace`/`GetAtespace`) if missing |
| `substrateWorkerPool` | `substrate-worker-pool` (= `SUBSTRATE_NODE_POOL`) |
| `substrateActorTemplate` | `planner` |
| `substratePlannerImage` | the planner image **pinned by digest** (`name@sha256:…`) — `upsertActorTemplate` throws on a tag, so use the digest the stack is on |

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
The hostname front (§5.1) is likewise opt-in through `SUBSTRATE_INGRESS_HOSTNAME`,
`SUBSTRATE_ATEAPI_SERVICE`, `SUBSTRATE_ATEAPI_PORT` and
`SUBSTRATE_CONTROL_PLANE_PUBLIC` — the last has no default in the workflow, so the
public control-plane route never appears unless asked for.
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
- Public hostname (§5.1), before touching the Settings card:
  ```bash
  kubectl -n ate-system get gateways substrate-ingress -o wide   # Programmed + address = substrate-ip
  kubectl -n ate-system get envoyproxies substrate-proxy-config
  kubectl -n ate-system get httproutes substrate-actors substrate-control-plane
  kubectl get svc -A -l gateway.envoyproxy.io/owning-gateway-name=substrate-ingress
  dig +short A substrate.<your-domain>                           # must equal substrate_ingress_ip
  curl -sI https://substrate.<your-domain>/                      # reply from atenet-router, not a TLS error
  ```
  Envoy names the front `envoy-<namespace>-<gateway>-<hash>` and stamps the owning
  Gateway on it; the OpenShell front lives in `envoy-gateway-system` because the
  class-level `EnvoyProxy` does, so expect the substrate one beside its own
  `EnvoyProxy` in `ate-system`. A `Gateway` stuck on `Programmed=False` with no
  address means the Envoy Service could not bind `substrate-ip` — check the
  `parametersRef` name/namespace pair, not the DNS.

## 9. Known limits / risks

- Pre-1.0 upstream: ateapi proto field numbers and CRD schemas can drift — pinned
  in `substrate.js` against the tracked `.proto`.
- gVisor runsc must be available on the pool's node image; plain containers are
  unsupported. Cloud Hypervisor microVM is the fallback.
- Actor cold-start / resume latency must fit inside the planner stage request
  budget; measure on staging before defaulting orgs to `substrate`.

## 10. Operator access — why the panel can be missing

Three independent gates, checked in this order:

1. **RBAC.** The full Settings page is the only one that carries the tiles. It renders
   only when the session holds `settings` at `write`
   (`public/js/views/settings.js` — `canWriteGlobal`); otherwise
   `renderScopedPolicySettings` replaces it and the substrate tiles are never in the DOM.
   Server-side the same permission guards the routes behind it
   (`/api/settings`, `/api/agent` in `services/gateway/src/index.js`), so a 403 there
   means the UI would be lying. The role resolves through `resolveRole`
   (`packages/shared-core/src/authz.js`): `AUTH_ADMIN_EMAILS` bootstrap → the Firebase
   `role` custom claim → `AUTH_DEFAULT_ROLE` (unset ⇒ `viewer`, which is `settings: read`
   only and therefore cannot see or save the panel). Check a live session with
   `GET /api/auth/me` — it returns the resolved `{ role, permissions }`.
   As of 2026-11-05 the shared gateway runs with `AUTH_ADMIN_EMAILS=niravshah2705@gmail.com`
   and `AUTH_DEFAULT_ROLE=viewer`, so that account resolves to `admin` /
   `settings: write` and is not blocked at this gate.
2. **Settings read path.** `GET /api/settings` must expose `agentPattern` and every
   `substrate*` key (`publicSettings` in `services/planner/src/routes/settings.js`).
   It exposed none of them while `POST /api/agent/substrate/pattern` happily persisted
   them, so the UI fell back to `cloudrun` on each load and the "Substrate configuration"
   card — gated on the active pattern being `substrate` — never appeared, making a
   correctly saved install look absent. Regression:
   `services/planner/src/routes/settings.substrate.test.js`.
3. **Local install.** A `node_modules` older than the Langfuse migration aborts the whole
   stack at boot with `Cannot find module '@langfuse/client'`
   (`packages/shared/src/agent/analytics.js`), which also blocks `npm run test:e2e`.
   Run `npm install` before concluding the feature is missing.

`GET /api/agent/substrate/status` (the card's "Check control plane" button) also threw
`ReferenceError: Cannot access 'status' before initialization`: the actor list was gated
on `status_ok(status)` inside the same `const [status, actors] = await Promise.all([…])`
destruction that defines `status`, so every operator saw an error string instead of a
health line. Status is now awaited first and the actor list fetched only once connected.
Regression: `services/planner/src/routes/agent.substrate.test.js`.

## 11. Loading one sandbox by hand

There is no "launch actor" button — the lifecycle is intentionally one API call, and the
actor is torn down in its `finally`:

```bash
GW=https://platform.archagentix.com      # or http://127.0.0.1:1456 locally
curl -s $GW/api/agent/substrate/status                          # control plane + actors
curl -s -X PUT $GW/api/agent/substrate/secrets/sync -d '{}' \
     -H 'content-type: application/json'                        # fingerprint-only preview
curl -s -X POST $GW/api/agent/substrate/run -H 'content-type: application/json' \
     -d '{"prompt":"summarize this repo in five bullets"}'      # ensure→create→dispatch→teardown
```

Unprovisioned pieces on the shared deployment today, each of which the run call surfaces
as an error rather than a silent no-op:

- `SUBSTRATE_ENABLED` / `SUBSTRATE_NODE_POOL` repo variables are unset, so `substrate.tf`
  stays out of plan: no worker pool, namespaces, snapshot class or ingress.
- `SUBSTRATE_INGRESS_HOSTNAME` is unset too, so nothing serves
  `substrate.archagentix.com` yet — no `substrate-ip`, no `Gateway`, no
  `substrate-proxy-config` EnvoyProxy and no control-plane route (§5.1). Until that
  apply plus the DNS record land, the two URL fields have nowhere public to point.
- The `ate-system` control plane is ko-built and never installed by Terraform (§5 step 3).
- Neither Cloud Run service carries `SUBSTRATE_URL` / `SUBSTRATE_INGRESS_URL`, so
  `configured: false` until the Settings store supplies them.
- `POST /api/agent/substrate/run` passes no `applyManifest` seam, and
  `syncSubstrateSecrets` fails closed when a credential resolves without one (Secret CRUD
  is not an ateapi RPC). Until a cluster-side applier exists, apply the
  `substrate-credentials` Secret and the `atenet-egress` read grant out of band, or smoke
  against an organization whose vault resolves nothing.
