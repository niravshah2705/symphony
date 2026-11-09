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

### 3.1 Two egress boundaries, and which one owns a key

Everything above describes **actor egress** (see
[`GLOSSARY.md`](../GLOSSARY.md)). It is a second boundary alongside the Cloud Run
**egress proxy** sidecar (`services/proxy`), and conflating them is how a key ends
up with two rotation paths:

| | Cloud Run egress proxy | Substrate actor egress |
|---|---|---|
| Substitution point | loopback sidecar, inside the container's network namespace | the substrate gateway, outside the gVisor sandbox |
| Credential source | settings S2S → vault, per call | k8s Secrets in `substrate-credentials`, pushed by `syncSubstrateSecrets` |
| Route table | `EGRESS_ROUTES` (`packages/shared-core/src/egress.js`) | the guardrail `CredentialProviderPolicy` scopes |
| Today | every provider key the run uses | `ghcr-pull-and-clone`, `image-registry-creds`, `openrouter-api-key` |

The `openrouter-api-key` row is the seam to close, not a design: model traffic
belongs behind a **model gateway** (agentgateway's `/agentgw` route is the seam
that exists for it), so that actor egress narrows to registry-pull and clone
credentials, which are not LLM spend. That re-pointing lands with the substrate
root's `agentgateway.tf`; until then a substrate run's LLM calls are injected at
this boundary and are **not** covered by the `/agentgw` route, which ships dark —
no client-side base URL points at it, and an unconfigured
`AGENTGATEWAY_PROXY_UPSTREAM` fails closed with a 502 rather than defaulting onto
someone else's gateway.

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
3. Install the control plane with the **Substrate control plane
   (preflight / install)** workflow — see §5.2. It replaces the old "run the
   installer from a workstation with a substrate checkout" step; the only thing
   a workstation is still needed for is reading the upstream GKE guide, since
   GKE-specific setup (PD/Filestore CSI already on, snapshot class) comes from
   this module. Run preflight first and read the table — it names the missing
   prerequisite, and a `workflow_dispatch` workflow only becomes dispatchable
   once it is on the default branch (§5.2).
   ```bash
   gh workflow run "Substrate control plane (preflight / install)" -f mode=preflight
   gh workflow run "Substrate control plane (preflight / install)" -f mode=install
   ```
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
`substrate_ingress_dns` output prints the record for you) and create the **A
record**. `archagentix.com` is not served by Cloud DNS in this project — its
nameservers are `ns1/ns2.bmctech.in` — so the record is an operator step, and with
no record there is nothing to reach the front and nothing to validate.

#### The certificate is the chicken, the front is the egg

A `Gateway` whose **only** listener references a Secret that does not exist yet is
not built at all: Envoy Gateway logs `failed to process TLS SecretRef for gateway`,
the `Gateway` reports `Programmed=False reason=AddressNotAssigned`, and there is no
Envoy Deployment, Service or load balancer — so HTTP-01, which connects to port 80
of that front, can never reach it. That is the state the front builds itself into,
and a port-80 listener is what gets out of it: Envoy Gateway will happily build a
data plane for the listeners that are valid, so `substrate-ingress` comes up on 80,
solves the challenge, and 443 joins the Service once
`substrate-server-external-tls` exists. Verified on the live cluster: the listener
alone took the Gateway from `Programmed=False` to an Envoy Deployment plus a
LoadBalancer Service on `substrate-ip` with `PORT(S) = 80`, while the `https`
listener still reported `ResolvedRefs=False InvalidCertificateRef`.

Two manifests carry that through:

- **A port-80 `http` listener** on `substrate-ingress`. `substrate-http-redirect`
  sends everything else on it to `https://…:443` with a 301, and the actor and
  control-plane routes pin `sectionName: https`, so no actor traffic ever
  terminates in plaintext. The redirect cannot swallow the challenge: Envoy Gateway
  orders routes by match precedence (`internal/gatewayapi/sort.go` — Exact > Regex >
  PathPrefix, and a `/` prefix is scored as zero characters), and the solver path is
  an Exact match.
- **`local.acme_solver_parent_refs`** (substrate.tf, consumed by both
  `ClusterIssuer`s) lists both fronts. cert-manager's `gatewayHTTPRoute` solver
  creates one HTTPRoute carrying every `parentRefs` entry, and an unprogrammed
  parent still Accepts it, so the challenge answers on whichever front the A record
  resolves to — including an operator who points the hostname at the shared
  OpenShell front instead of `substrate-ip`. The issuer used to be pinned to
  `openshell-ingress` alone, which silently made every substrate challenge depend
  on that one front.

So the sequence is one step, not a dance: apply → create the **A record for
`substrate_ingress_ip`** → cert-manager issues and the `https` listener lights up.
Watch it with `kubectl -n ate-system get gateway substrate-ingress -o wide`
(`PROGRAMMED=True` + an address) and `kubectl -n ate-system get certificate`; the
Service gains `443` in the same minute the Secret lands.

Because every one of those manifests lives in `ate-system` and the apply runs
**before** the installer, `substrate.tf` creates that namespace itself whenever a
hostname is requested (`kubernetes_namespace_v1.substrate_system`). Without it the
apply dies on `namespaces "ate-system" not found` and there is no front at all; with
it, the installer's own `kubectl apply` of the namespace merges into Terraform's.
Leave `SUBSTRATE_INGRESS_HOSTNAME` unset and the installer stays the sole owner.

| Settings field | Value for `substrate.archagentix.com` |
|---|---|
| `substrateUrl` | `https://substrate.archagentix.com` with `SUBSTRATE_CONTROL_PLANE_PUBLIC=true` (gRPC rides the `/substrate.ateapi.v1.Control` prefix); otherwise the in-cluster `ateapi.ate-system.svc:8443`, reachable only from inside the VPC |
| `substrateIngressUrl` | `https://substrate.archagentix.com` |
| `substrateAtespace` | **must be a space this deployment has already declared** — i.e. listed in `SUBSTRATE_ALLOWED_ATESPACES`, pinned as `SUBSTRATE_ATESPACE`, or a value in `SUBSTRATE_ATESPACE_BY_ORG`. Anything else is dropped by `resolveSubstrateAtespace`, which then resolves from the binding table by organization id. Nothing is derived from the *text* of an org id any more, and once a deployment declares more than one space an organization that is not bound **throws** instead of landing in `tenant-a`. A per-tenant stack does not need this field: the provisioner pins `SUBSTRATE_ATESPACE` from the deployment slug. `GET /api/agent/substrate/status` echoes what was resolved; the runner creates the atespace over ateapi (`CreateAtespace`/`GetAtespace`) if missing |
| `substrateWorkerPool` | the value of the `ate.dev/worker-pool` **node label** the `workerSelector` matches — not automatically the GKE pool name. This config taints the pool but does not label it, so either label the nodes (`gcloud container node-pools update substrate-worker-pool … --node-labels ate.dev/worker-pool=substrate-worker-pool`) or set the field to whatever label the upstream installer applied. Blank falls back to `planner-pool` |
| `substrateActorTemplate` | `planner` |
| `substratePlannerImage` | the planner image **pinned by digest** (`name@sha256:…`) — `upsertActorTemplate` throws on a tag, so use the digest the stack is on |
| `substrateTimeoutMs` | per-call gRPC deadline; `60000` is the default. Keep it under the Cloud Run / ingress budget of the calling service |
| `substrateActorTtlMs` | how long the per-run actor survives before the power path suspends/reaps it; `120000` default. Below the actor's resume cost is wasted |

The node label is a one-off, but note `gcloud container node-pools update --node-labels`
rolls the pool's nodes, so do it while the pool is parked (the power workflow scales it
to zero overnight).

### 5.2 Installing `ate-system` from CI

`.github/workflows/substrate-control-plane.yml` runs the upstream installer, so
no workstation needs a substrate checkout or a Go toolchain.

It is a separate workflow, on purpose: dispatching **Deploy to GCP** on a branch
runs that workflow's path filters, and a branch touching `services/planner/**` or
`public/**` would rebuild and redeploy those Cloud Run services **from the
unmerged branch**. A control-plane preflight must never be able to ship app code.

The installer's images are ko-built from its own checkout, which is why Terraform
cannot vendor them — but `--image-repo` + `--image-tag` make it install the
published release images instead of building any, so the runner needs no ko, no
Docker and no registry push. The **manifests still come from the checkout**, so
the clone is pinned to the same revision the images carry.

| Mode | What it does | Mutates? |
|---|---|---|
| `preflight` | Reports every prerequisite PASS/FAIL (worker pool, snapshot bucket **and its region**, transfer GSA, `ate-system`, existing `ate.dev` CRDs, Envoy Gateway + cert-manager CRDs, whether the substrate front is `Programmed` and on which address, whether the CI identity may create **and label** `substrate-ip`, and whether the release images actually exist at the pinned tag) and prints the exact `ate-setup` command install mode will run | No |
| `install` | After the same report: provisions the GCS snapshot bucket + IAM through substrate-gke's `setup-gcp`, clones substrate at the pinned tag, and runs `deploy ate-system` | Yes (creates `ate-system`) |

Before the first install, three rows read FAIL by design — the snapshot bucket,
the transfer GSA and `ate-system` itself are things `install` mode creates. The
rows that matter are the pool and the CRDs: `install` refuses on those. Preflight
always exits 0 and records every row: Actions runs a bare `run:` as `bash -eo
pipefail`, so a failing check inside a command substitution would otherwise abort
the step at the first FAIL — an advisory report that dies is worse than no report.

The image row is not a formality: `deploy ate-system` resolves every tag it is
about to use to a digest before deploying anything, and one missing image (the
installer needs all of them under one tag, `envoy-dataplane` included) otherwise
surfaces after the checkout and Go build, tens of minutes in.

`install` refuses to proceed if `SUBSTRATE_ENABLED` is not `true`, the worker pool
does not exist, or the Envoy Gateway CRDs are missing — installing a control plane
onto a cluster that cannot run actors produces a namespace of CrashLooping pods and
no error worth reading later.

The static-IP row is a `testIamPermissions` call, not a role-name guess: in this job the
caller *is* `GCP_DEPLOYER_SA`, so it tests the identity that will run the apply. Ask about
`compute.addresses.setLabels` as well as `create`, because `google_compute_address` labels
the address in a second call once it exists — a role with only `create` gets past the first
verb and 403s on the second, leaving the address half-made. Both live in the
`substrateStaticIpAdmin` custom role that `deploy/gcp/bootstrap.sh` creates and keeps
current; `roles/compute.viewer`, which the deployer has always had, can read the addresses
but cannot make one.

**Registration comes from the default branch.** GitHub will not dispatch a
`workflow_dispatch` workflow whose file is absent from `main`, so the branch that
*introduces* it cannot test-drive it: validate such a change by running its read-only
steps against a local cluster context, then dispatch for real after the merge. Once the
file is on `main`, `--ref <branch>` does run that branch's copy — which is how later
edits to this workflow get validated before merging them.

Repo variables it reads (all optional; defaults shown):

| Variable | Default | Why |
|---|---|---|
| `SUBSTRATE_VERSION` | latest upstream release | Pins checkout **and** image tag together. Unset prints a warning each run — pin it once the cluster is live |
| `SUBSTRATE_IMAGE_REPO` | `ghcr.io/agent-substrate/substrate` | Release images; a mirror works if it holds every image the install needs |
| `SUBSTRATE_SNAPSHOT_BUCKET` | `ate-snapshots-<project>` | ate-setup refuses to deploy ate-api-server on GKE without a bucket, and it will not create one — the workflow runs `setup-gcp create bucket` for you, in the **cluster's** region (`setup-gcp`'s own `--region` default is us-west1, and it rejects an existing bucket elsewhere) |
| `SUBSTRATE_SANDBOX_CLASSES` | `gvisor` | `gvisor,microvm` additionally stages guest assets into `<bucket>-assets` |
| `SUBSTRATE_CREDENTIAL_PROVIDER` | `{"name":"k8s.io"}` | The zero-trust path: the bundled Secrets provider plus a NetworkPolicy admitting only the egress gateway |
| `SUBSTRATE_INGRESS_SPIFFE_IDS` | `spiffe://cluster.local/ns/ate-system/sa/atenet-client` | Unset means **no** client may reach actors through the router |
| `SUBSTRATE_POSTGRES_STORAGE_CLASS` | unset (cluster default) | Set `dynamic-rwo` if the bundled postgres PVC will not attach to your node machine type |
| `SUBSTRATE_ROLLOUT_TIMEOUT` | `10m` | Cold-start image pulls on a just-created pool are slow; the installer default is 60s |
| `SUBSTRATE_REPO_URL` / `SUBSTRATE_GKE_REPO_URL` | upstream GitHub URLs | Only change these to mirror or to pin a fork |

The snapshot transfer service account is fixed to substrate-gke's default name,
`ate-snapshot-transfer`; if you override `SNAPSHOT_TRANSFER_GSA_NAME` there, the
preflight's GSA row and the installer flag will disagree.

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
`.github/workflows/substrate-control-plane.yml` is the other substrate workflow:
it is `workflow_dispatch`-only and touches no Cloud Run service and no Terraform
state, so it can be run from a branch without deploying anything (§5.2). It shares
`concurrency.group: openshell-cluster-power` with the power workflow so an install
never races a scale-to-zero.

It **reads the live substrate node-pool bounds back** and feeds them as
`substrate_min/max_nodes`, so a reconcile cannot silently start a pool the power
workflow parked (the same read-back now covers `openshell-system-node-pool`, which
`openshell-cluster-power.yml` also parks last). That workflow parks/wakes the
substrate pool in lockstep when `SUBSTRATE_NODE_POOL` is set.

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

- `SUBSTRATE_ENABLED=true` and `SUBSTRATE_NODE_POOL=substrate-worker-pool` are set, and
  the pool exists (tainted, never labelled) — so `substrate.tf` is in plan.
- The front is applied but **not yet serving** `substrate.archagentix.com`:
  `substrate-ip` is allocated (34.14.137.62), `substrate-ingress` is Programmed and its
  Envoy LoadBalancer is up on port 80, but `substrate-server-external-tls` has never been
  issued so the `https` listener is still invalid — and there is no DNS record for the
  hostname at all (§5.1). Until the record lands, HTTP-01 cannot complete and the two URL
  fields have nowhere public to point.
- The pool is tainted but carries no `ate.dev/worker-pool` **label**, so the installer's
  `workerSelector` matches nothing until the nodes are labelled (§5.1 field table).
- `SUBSTRATE_VERSION` is unset, so every preflight/install run resolves the tag from
  "latest release" and warns; pin it once the cluster is live (§5.2).
- The `ate-system` control plane is never installed by Terraform; it lands when the
  **Substrate control plane (preflight / install)** workflow runs with `mode=install`
  (§5 step 3, §5.2).
- Neither Cloud Run service carries `SUBSTRATE_URL` / `SUBSTRATE_INGRESS_URL`, so
  `configured: false` until the Settings store supplies them.
- `POST /api/agent/substrate/run` passes no `applyManifest` seam, and
  `syncSubstrateSecrets` fails closed when a credential resolves without one (Secret CRUD
  is not an ateapi RPC). Until a cluster-side applier exists, apply the
  `substrate-credentials` Secret and the `atenet-egress` read grant out of band, or smoke
  against an organization whose vault resolves nothing.
