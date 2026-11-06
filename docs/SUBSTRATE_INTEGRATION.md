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
2. Run **Deploy to GCP** with `gke_reconcile` (see §7 for the first-apply note). That
   creates the worker pool, namespaces, snapshot class and ingress. It does **not**
   touch the control-plane version: Substrate needs GKE 1.37+ (§5.2), and if the
   cluster is older you upgrade the master directly rather than through the module:
   `gcloud container clusters upgrade <cluster> --location <zone> --project <project> --master --cluster-version <1.37.x from the cluster's own channel> --quiet`.
   It is a real control-plane upgrade and the node pools roll behind it, so park the
   tenant pool first.
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
5. Bring up the two things the card alone cannot give you: the rotating
   control-plane bearer (§5.4 — Terraform makes the Secret, the rotator fills it)
   and something for the actor to land on (§5.5 — a `WorkerPool` object plus one
   node that tolerates it). Until both exist, `substrate/status` reports
   `credentialConfigured: false` and `POST …/run` fails at `CreateActor`.

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
- **A control-plane route.** The planner reaches the control plane over gRPC, and it
  only listens in-cluster. Set `SUBSTRATE_CONTROL_PLANE_PUBLIC=true` to also publish a
  `GRPCRoute` for `substrate.ateapi.v1.Control` →
  `${SUBSTRATE_ATEAPI_SERVICE}:${SUBSTRATE_ATEAPI_PORT}` (defaults `api:443`, the
  Service the installer actually creates) on the same hostname, together with the
  `Backend` that re-encrypts that hop and the NetworkPolicy that lets the front's proxy
  reach the pod. **This is the only way `substrateUrl` can be a public URL, and it is off
  by default**: the control plane creates and deletes actors and mints actor JWTs, and
  this config adds **no caller authentication of its own** — it relies on `api`'s authn,
  which accepts only a GKE-projected service-account token. That token is minted and
  rotated by CI and reaches the caller as the managed secret `substrateApiToken`
  (§5.3 item 4, §5.4); nothing about the *route* authenticates a stranger, so a
  third party who could reach the hostname and had any `ate-client` token could create
  actors. Prefer a private path (VPC connector / IAP / service mesh) for anything but a
  smoke test.

The route matches on gRPC service rather than path prefix because that is exactly what the
client puts on the wire — `substrate.js` sends `:path = /substrate.ateapi.v1.Control/<Method>` over HTTP/2,
and `http2.connect()` upgrades to TLS for an `https://` `substrateUrl`. So the plain
hostname (no port) is the correct value; Envoy terminates the client's TLS and re-encrypts
to `api:443` with the pod-identity CA and `alpnProtocols: [h2]` (§5.3 items 2–3).

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
| `substrateUrl` | The address the installer actually creates is `https://api.ate-system.svc:443` (TLS-only; `api` is a headless Service with ports `grpc=443`, `exchange=8445`) and it is reachable only from inside the cluster. The public form `https://substrate.archagentix.com` needs `SUBSTRATE_CONTROL_PLANE_PUBLIC=true`, whose route carries gRPC (§5.3 items 1–3) and whose one accepted credential — a projected `ate-client` token — is minted by CI and resolved per run as the managed secret `substrateApiToken` (§5.4). There is **no token field on this card and no plan to add one**: the bearer is platform-managed, never browser-writable, and putting it in a settings document would copy a cluster-privileged credential into the same store that holds org configuration. `credentialConfigured` on the status endpoint tells you whether it resolves |
| `substrateIngressUrl` | `https://substrate.archagentix.com` |
| `substrateAtespace` | **must be one of `SUBSTRATE_ALLOWED_ATESPACES`** (default `tenant-a,tenant-b`) — anything else is silently dropped by `resolveSubstrateAtespace` and it falls back to the org-derived space (`tenant-a` by default). Leave blank to derive per organization; `GET /api/agent/substrate/status` echoes what was resolved and the runner creates it over ateapi (`CreateAtespace`/`GetAtespace`) if missing |
| `substrateWorkerPool` | the **name of a `WorkerPool` custom resource** in `ate-system` (`workerpools.ate.dev`), not a node label and not the GKE pool name — although Terraform names both `substrate-worker-pool`, so **that** is the value to type here (§5.5). The `workerSelector` the client sends is `{"ate.dev/worker-pool": <this value>}`, and that key addresses the WorkerPool object: the controller stamps the label onto the worker pods it synthesises from it, while a hand-written one in `template.labels` is CEL-rejected, so no node label can ever satisfy it. Blank is safe on this deployment: both `DEFAULT_WORKER_POOL` (`substrate.js:40`) and `CONFIG.SUBSTRATE.workerPool` fall back to `substrate-worker-pool`, which is the object `var.substrate_worker_pool_name` renders — rename that variable and you must also set this field (or `SUBSTRATE_WORKER_POOL`), because the fallback is a constant, not a read of Terraform. Quota is not the constraint here, one `e2-standard-4` fits easily |
| `substrateActorTemplate` | `planner` |
| `substratePlannerImage` | the planner image **pinned by digest** (`name@sha256:…`) — `upsertActorTemplate` throws on a tag, so use the digest the stack is on |
| `substrateTimeoutMs` | per-call gRPC deadline; `60000` is the default. Keep it under the Cloud Run / ingress budget of the calling service |
| `substrateActorTtlMs` | how long the per-run actor survives before the power path suspends/reaps it; `120000` default. Below the actor's resume cost is wasted |

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
| `preflight` | Reports every prerequisite PASS/FAIL (worker pool, whether the API server serves the `certificates.k8s.io` types the podcertificate controller needs, snapshot bucket **and its region**, transfer GSA, `ate-system`, existing `ate.dev` CRDs, Envoy Gateway + cert-manager CRDs, whether the substrate front is `Programmed` and on which address, whether the CI identity may create **and label** `substrate-ip`, and whether the release images actually exist at the pinned tag) and prints the exact `ate-setup` command install mode will run | No |
| `install` | After the same report: provisions the GCS snapshot bucket + IAM through substrate-gke's `setup-gcp`, clones substrate at the pinned tag, and runs `deploy ate-system` | Yes (creates `ate-system`) |

The control-plane version is a hard prerequisite, not a preference: Substrate's
`podcertificate-controller` discovers `certificates.k8s.io` **ClusterTrustBundle**
and **PodCertificateRequest**, and GKE does not serve either before 1.37. On 1.36 the
installer gets as far as its CRDs and pool secrets, then fails ~10 minutes later on
`waiting for ClusterTrustBundle podidentity.podcert.ate.dev:identity:primary-bundle:
context deadline exceeded (last discovery error: neither v1 nor v1beta1
ClusterTrustBundle is served)`, with the controller in CrashLoopBackOff on `Error
discovering PodCertificateRequest API`. The `certificates APIs served` preflight row
asks the discovery document directly, so it says this in one second instead.

Upgrade the control plane directly: `gcloud container clusters upgrade <cluster>
--location <zone> --project <project> --master --cluster-version <1.37.x> --quiet`.
Pick a build the cluster's own release channel offers (`gcloud container
get-server-config --zone <zone>`; `REGULAR` offered `1.37.1-gke.1552000` when this was
written — a cross-channel version is rejected, an in-channel manual minor bump is
allowed). The module deliberately does not pin the version: a `min_master_version`
floor records it in Terraform, but a floor the channel has already rolled past is dead
config, and raising a master is a one-time action per cluster rather than a state to
converge on every apply. `--quiet` is not a style choice — gcloud asks for
confirmation, a non-interactive shell refuses the prompt, and piping the output
anywhere hides that failure behind the pipe's exit code. The control plane upgrades in
place, then GKE rolls the node pools to match, so park the tenant pool before it.

The bundled postgres does not fit this stack either, and neither mismatch is visible
from the pod. Upstream `postgres.yaml` asks for a 500 Gi `standard-rwo` volume and a
2 CPU request. `pd-balanced` counts against the `SSD_TOTAL_GB` quota, which is 500 in
this project, so the PVC sits Pending on `QUOTA_EXCEEDED ... 'SSD_TOTAL_GB' ...
Limit: 500.0` — and the scheduler's stale `FailedScheduling` events blame node
capacity, so read the *PVC's* events before believing them. The 2 CPU request is
larger than an `e2-standard-2` pool node's 1930m allocatable, so even a provisioned
volume would leave the pod unschedulable. `SUBSTRATE_POSTGRES_STORAGE` (default
`50Gi`) and `SUBSTRATE_POSTGRES_CPU_REQUEST` (default `500m`) patch the pinned
checkout before the installer runs: `--ateapi-postgres-storage-class` is the only
size-adjacent knob upstream offers, and `spec.volumeClaimTemplates` is immutable, so a
live `sts/postgres` has to be deleted for a new number to take effect rather than
patched.

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
| `SUBSTRATE_VERSION` | latest upstream release | Pins checkout **and** image tag together. Unset prints a warning each run — **set to `v1.0.0`**, the tag the live `ateapi` runs |
| `SUBSTRATE_IMAGE_REPO` | `ghcr.io/agent-substrate/substrate` | Release images; a mirror works if it holds every image the install needs |
| `SUBSTRATE_SNAPSHOT_BUCKET` | `ate-snapshots-<project>` | ate-setup refuses to deploy ate-api-server on GKE without a bucket, and it will not create one — the workflow runs `setup-gcp create bucket` for you, in the **cluster's** region (`setup-gcp`'s own `--region` default is us-west1, and it rejects an existing bucket elsewhere) |
| `SUBSTRATE_SANDBOX_CLASSES` | `gvisor` | `gvisor,microvm` additionally stages guest assets into `<bucket>-assets` |
| `SUBSTRATE_CREDENTIAL_PROVIDER` | `{"name":"k8s.io"}` | The zero-trust path: the bundled Secrets provider plus a NetworkPolicy admitting only the egress gateway |
| `SUBSTRATE_INGRESS_SPIFFE_IDS` | `spiffe://cluster.local/ns/ate-system/sa/atenet-client` | Unset means **no** client may reach actors through the router |
| `SUBSTRATE_POSTGRES_STORAGE_CLASS` | unset (cluster default) | Set `dynamic-rwo` if the bundled postgres PVC will not attach to your node machine type |
| `SUBSTRATE_POSTGRES_STORAGE` | `50Gi` | Size of the bundled postgres volume; the upstream 500 Gi does not fit a 500 GB `SSD_TOTAL_GB` quota (§5.2) |
| `SUBSTRATE_POSTGRES_CPU_REQUEST` | `500m` | The upstream `"2"` request exceeds an `e2-standard-2` node's 1930m allocatable (§5.2) |
| `SUBSTRATE_ROLLOUT_TIMEOUT` | `10m` | Cold-start image pulls on a just-created pool are slow; the installer default is 60s |
| `SUBSTRATE_REPO_URL` / `SUBSTRATE_GKE_REPO_URL` | upstream GitHub URLs | Only change these to mirror or to pin a fork |

The snapshot transfer service account is fixed to substrate-gke's default name,
`ate-snapshot-transfer`; if you override `SNAPSHOT_TRANSFER_GSA_NAME` there, the
preflight's GSA row and the installer flag will disagree.

### 5.3 What the public control-plane route does — and the caller identity it needed

`SUBSTRATE_CONTROL_PLANE_PUBLIC=true` renders a path from
`https://<hostname>/substrate.ateapi.v1.Control/<Method>` to the installer's control
plane, and that path **carries gRPC today**: with a bearer token the call returns
`grpc-status: 0`, without one `grpc-status: 16 / missing bearer token` — i.e. the
failure comes from the control plane's authn, not from Envoy. Four things had to be
true, each verified against the live install; 1–3 are encoded in `substrate.tf` and
the fourth in `substrate_token.tf` (root stack, applied by `deploy.yml`'s `terraform`
job) plus the rotator workflow (§5.4).

1. **The right Service.** The installer's control-plane Service is `api`, headless,
   ports `grpc=443` and `exchange=8445`. The module used to point at `ateapi:8443`, a
   name that has never existed here, so Envoy reported
   `ResolvedRefs=False (BackendNotFound)` and built no cluster. The defaults are now
   `api`/`443` (`SUBSTRATE_ATEAPI_SERVICE` / `SUBSTRATE_ATEAPI_PORT` only matter if a
   future release renames it). Confirm with
   `kubectl -n ate-system get svc api -o jsonpath='{.spec.ports}'`.
2. **TLS to the backend, with real verification material.** `api:443` only speaks TLS
   (`--grpc-server-cred-bundle=/run/servicedns.podcert.ate.dev/credential-bundle.pem`)
   with leaves whose SAN is `api.ate-system.svc`, signed by the
   `servicedns.podcert.ate.dev/identity` CA. Gateway API `BackendTLSPolicy` accepts only
   `caCertificateRefs` / `wellKnownCACertificates` (no `skipVerify`), and in Envoy
   Gateway v1.8.1 it is only processed for `targetRef.kind: Service`, so it cannot
   describe a route-targeted backend. `substrate.tf` therefore uses EG's own `Backend`
   (`tls.sni`, `tls.caCertificateRefs`, `tls.alpnProtocols: [h2]`) and copies the CA from
   `secret/service-dns-ca-pool` in `podcertificate-controller-system` into
   `cm/substrate-ateapi-ca` in `ate-system` — a `data.kubernetes_secret` read plus
   `yamlencode`, because the PEM is multi-line and a heredoc built by interpolation
   breaks on the first indent change. Two consequences of that shape: the `Backend` kind
   is **gated by the cluster-wide `extensionApis.enableBackend` in
   `envoy-gateway-config`**, which is Helm-managed and outside this repo (off, the
   Backend is simply never reconciled and the route reports
   `Backend is disabled in Envoy Gateway configuration`; the preflight step has a row for
   it), and the copied CA is a snapshot of a self-signed one-year certificate, so
   re-running `gke_reconcile` before rotation is what refreshes it.
3. **HTTP/2 upstream, and permission to reach the pod.** `api`'s port is *named* `grpc`,
   which is not an appProtocol EG maps to HTTP/2, so an `HTTPRoute` upstreams HTTP/1.1 and
   grpc-go drops the stream (`reset reason: connection timeout`, then
   `connection termination` once connectivity was allowed). The route is a `GRPCRoute`
   with a `method.service` exact match on `substrate.ateapi.v1.Control`, which forces h2
   end to end — and the `BackendTrafficPolicy` that disables the request timeout
   retargets it accordingly. If an `HTTPRoute` for this address is already in Terraform
   state, the kind change is a replace (create plus delete) and the apply needs
   `gke_allow_destroy`; on this cluster the flag had never been applied, so the converge
   planned 4 create + 1 update + 0 delete.
   The installer's `ate-api-server` NetworkPolicy admits 443 only from the control-plane
   pods, so `substrate-front-to-ateapi` adds the front's Envoy proxy pods
   (`gateway.envoyproxy.io/owning-gateway-name=substrate-ingress` in
   `envoy-gateway-system`); NetworkPolicies are additive unions, so nothing existing
   loses access.
4. **A caller identity the control plane trusts — answered.** `api` authenticates with
   `--authentication-config=/etc/ateapi/authentication/authentication.yaml`, which
   declares exactly one `jwtProviders` entry: issuer
   `https://container.googleapis.com/v1/projects/<project>/locations/<zone>/clusters/<cluster>`,
   audience `api.ate-system.svc`, plus
   `--authz-bootstrap-owners=system:serviceaccount:ate-system:ate-client`. Internal
   callers arrive as `"principal":{"ID":"spiffe://cluster.local/ns/...","Kind":"mtls"}`.
   So the accepted credential is precisely a **GKE-projected service-account token for
   `ate-client`** carrying that audience — minted by the cluster's own API server, not a
   GCP service-account key and not a self-signed JWT. Probes, all against the public
   hostname:

   ```bash
   # A legacy service-account token is refused: token issuer
   # "kubernetes/serviceaccount" not trusted. A projected token works:
   TOK=$(kubectl -n ate-system create token ate-client --audience=api.ate-system.svc)  # 1 h
   printf '\000\000\000\000\000' > /tmp/req.bin   # 5-byte header, empty message
   curl -s --http2 -X POST -H 'content-type: application/grpc' -H 'te: trailers' \
     -H "authorization: Bearer $TOK" --data-binary @/tmp/req.bin \
     https://<hostname>/substrate.ateapi.v1.Control/ListActors -D -
   ```

   (Write the frame to a file: a shell that truncates `'\0...'` at the first NUL sends an
   empty body, and grpc-go then answers the misleading `code 2 / EOF` rather than the
   `16` that shows the route is fine.)

   The gap was never the route — it was that a projected service-account JWT is minted
   by the API server, and a Cloud Run service, where the gateway and planner actually
   run, cannot mint one for itself. That is closed by a **CI job that stands in for the
   cluster**: it mints the token with exactly the invocation above and publishes it into
   Secret Manager, which the settings service *can* read (§5.4). Three ways to confirm the
   identity is reaching the control plane:

   - `GET /api/agent/substrate/status` → `credentialConfigured: true` (the key resolves)
     plus `status.status: "SERVING"` (it was accepted). `configured` is now the AND of both
     halves, so `configured: true, connected: false` means the route or the credential
     failed, not that nothing is configured.
   - the rotator's closing step, which dials the live control plane through the public
     hostname with the token it just published and fails the run unless the reply is
     `grpc-status: 0` — so a green run is the end-to-end proof, republished on schedule.
   - the manual recipe above, needing no app deployment, and the one to reach for when the
     first two disagree.

   What remains open is operation rather than architecture: the identity is only as
   current as the last successful rotation, which depends on CI and on the schedule having
   landed on the default branch (§5.4, §7); a 12-hour bearer lives in Secret Manager for
   those twelve hours; and the writer is the CI deployer identity, so a compromised runner
   could mint and publish a token of its own. The blast radius is bounded by design —
   write access to one secret and nothing else (the role also lets it read that secret's
   versions, because the rotator reads one back to probe the route, so the bound is the
   scope rather than a read ban), a mint grant scoped to `ate-client` alone rather than any
   service account in `ate-system`, a capability that expires in 12 hours and is only ever
   what `ate-client` is authorized for, and a timestamped version history for every
   publication (§9).

`SUBSTRATE_CONTROL_PLANE_PUBLIC` stays `false` in the module and is set `true` via repo
variable here; flipping it back off destroys the route, `Backend`, CA ConfigMap and
policies, which needs `gke_reconcile` **and** `gke_allow_destroy` — the destroy gate in
`deploy.yml` is doing its job there, not failing.

### 5.4 Rotating the control-plane bearer

§5.3 item 4 leaves one question: who mints the `ate-client` token, and where does the
caller read it from. The answer is a scheduled job and Secret Manager.

**The shape.** `.github/workflows/substrate-token-rotate.yml` runs on a six-hour cron plus
`workflow_dispatch`. It authenticates as the CI deployer through Workload Identity
Federation — the same identity **Deploy to GCP** uses, so no new credential is introduced
— and runs the exact mint §5.3 proves works, publishing the result with
`gcloud secrets versions add substrate-ateapi-token --data-file=…`. The `--data-file` is
not tidiness: it keeps the token out of the command line and the process list, and
**the token is never echoed anywhere in the job.** Between mint and publish the job decodes
the JWT and checks its own claims (`iss` is this cluster's GKE issuer, `aud` is
`api.ate-system.svc`, `exp` is in the future), so a token minted against the wrong audience
or a stale cluster context fails the run instead of silently poisoning what the planner is
handed. Its last step re-probes the live control plane through the public hostname with the
token it just published and requires `grpc-status: 0` — which is what makes a green run
mean *the caller can authenticate right now*, not merely *something was written*.

```bash
kubectl -n ate-system create token ate-client \
  --audience=api.ate-system.svc --duration=43200s
```

**Why 12 hours against a 6-hour cadence.** GKE will mint far longer — 7 days was accepted
when the ceiling was probed. The short lifetime is the deliberate choice, because this
bearer creates and deletes actors and a leaked one should expire on its own. The gap
between lifetime and cadence is the outage budget: 12 hours is **two missed runs of slack**.
That slack is needed for a specific reason — GitHub runs *scheduled* workflows from the
**default branch's** copy and does not guarantee their start time, so a run can be delayed
or skipped with no signal to the branch that edited the file. The operational consequence:
**the rotator is live only after merge.** Until the file is on the default branch nothing
is rotating anything and the only way to fill the secret is to dispatch it by hand once it
lands; `credentialConfigured: false` on an unmerged branch is expected, not a bug.

**Storage and grants** (`deploy/gcp/terraform/substrate_token.tf`, in the root stack, so
applied by `deploy.yml`'s `terraform` job rather than `gke_reconcile`): the secret
`substrate-ateapi-token` plus exactly two bindings —
`roles/secretmanager.secretVersionManager` for `gh-deployer@…` and
`roles/secretmanager.secretAccessor` for `settings-sa@…`, scoped to this secret so holding
it grants no visibility into the provider keys the same service account mounts. The
writer role is `secretVersionManager`, not the tempting
`roles/secretmanager.secretVersionAdd`: the extra fine-grained version roles bind only to
a *version*, which a publisher cannot address before the version exists, and the apply
said so (`Role roles/secretmanager.secretVersionAdd is not supported for this resource`).
`secretVersionManager` also covers `versions.access`, which the rotator genuinely uses —
it reads back what it published to send a probe frame — so the grant is the smallest one
that matches the job rather than an aspiration to keep the minter from reading. Minting is
*not* left to `roles/container.admin` implying cluster-admin: a `Role`/`RoleBinding` in
`ate-system` grants `serviceaccounts/token` `create` on `resourceNames: [ate-client]` to
the deployer identity. Nothing here writes a value — Terraform makes the container, the
rotator fills it, the same rule `secrets.tf` follows.

**Why dynamic rather than env-mounted.** `substrateApiToken` is a managed key
(`services/settings/app/models/secrets.py:83`, held out of `BROWSER_WRITABLE_SECRET_KEYS`
at `:108`) and the only managed key resolved at request time:
`services/settings/app/core/secret_manager.py` reads `versions/latest` over REST with ADC —
no new SDK, and it never puts the payload or response body into an exception — while
`secrets_service.py` memoises it for `SUBSTRATE_ATEAPI_TOKEN_TTL_SECONDS` (default **300**).
The reason is Cloud Run: container env is frozen at start, so a 12-hour bearer mounted as
an env var would be served stale — and rejected as expired — for days. 300s is what tracks
a 21600s rotation. Two behaviours matter when tuning it: **a failed fetch yields the key
*absent*, never an error** — the cache stores `None`, the resolver omits the key, and the
caller fails closed on that one key while everything else still resolves, so a Secret
Manager outage degrades to `credentialConfigured: false` rather than a 500 on
`/internal/s2s/managed-secrets`; and a non-numeric or non-positive TTL falls back to 300.
Lower it to recover from an outage sooner, never raise it past the cadence.

**Callers.** `resolveSubstrateApiToken()` (`packages/shared-core/src/agent/substrate.js:149`)
resolves per run/request — deliberately uncached — in order: caller-supplied value, the
store / non-proxied managed overlay, then the S2S managed path (`fetchS2sSecrets`), handing
the result to `grpcCall` as `options.token`. `runPlanningOnSubstrate` resolves **once per
run** and threads one value into every RPC, so a run cannot straddle a rotation with half
its calls authenticated. `substrate.js` fails closed **before opening the socket** when
nothing resolved (`substrate.js:240`) — an unauthenticated call answers
`16 / missing bearer token`, which reads as a broken cluster rather than the missing
managed secret it actually is — and `withCredentialHint` turns a returned 16 into a message
naming `substrateApiToken`. `SUBSTRATE_TOKEN` stays the local-dev/test fallback only.

**Invariant to preserve:** `substrateApiToken` is deliberately **not** synced into the
actor's `substrate-credentials` Secret. `syncSubstrateSecrets` reads `githubToken`,
`openrouterApiKey` and `imageRegistryPassword` by name and nothing else
(`substrate-runner.js:54-81`); adding this key would copy a cluster-privileged bearer into
a namespace reachable by sandbox workload — the exact exfiltration path the egress
boundary closes.

| Task | How |
|---|---|
| First-time setup | `gke_reconcile` creates the secret + bindings, then **dispatch the rotator once by hand**, then the schedule takes over |
| Rotate now | `gh workflow run substrate-token-rotate.yml` — also the recovery after a missed schedule |
| Retire | remove the cron trigger and revoke both bindings; disable the secret's versions rather than deleting them, which keeps the audit trail |
| Prove without the app | the manual `kubectl create token` probe in §5.3 item 4 |

Inputs that matter: `GCP_PROJECT_ID` / `GCP_WORKLOAD_IDENTITY_PROVIDER` (the identity the
job federates as), `GKE_LOCATION` / `GKE_CLUSTER_NAME` (whose issuer is trusted — the job
checks `iss` against it), `SUBSTRATE_INGRESS_HOSTNAME` (what the closing probe dials). No
token value is ever a repo variable or a secret input.

### 5.5 Where the worker actually runs: a WorkerPool object, not a node label

This corrects an earlier instruction in this document, which was chasing the wrong object,
so the reasoning is worth stating in full.

`workerSelector: {"ate.dev/worker-pool": <name>}` — what `substrate.js` sends on
`CreateActorTemplate` and `CreateActor` — names a **`WorkerPool` custom resource**
(`workerpools.ate.dev`, `ate.dev/v1`, Namespaced), not a node label. Its `spec.template`
carries `nodeSelector`, `tolerations`, `nodeAffinity`, `resources` and
`serviceAccountName`; its `spec` requires `replicas`, `workerImage` and `sandboxClasses[]`
(enum `gvisor|microvm`, `maxItems: 1`, `configRef` → a **cluster-scoped** SandboxConfig) —
the control plane keeps no server-side default for `workerImage`, so it cannot be omitted.
The controller **stamps the `ate.dev/worker-pool` label onto the worker pods it synthesises**
from that object, and `template.labels` reserves the `ate.dev/` domain for exactly that:
the CRD's CEL rule rejects a hand-written `ate.dev/worker-pool` label outright. So labelling
nodes could never have satisfied the selector, and no custom label is wanted at all — GKE
already writes `cloud.google.com/gke-nodepool` on every node, which is what the WorkerPool's
`nodeSelector` keys on. Adding `node_config.labels` instead would buy a second ForceNew on
the pool for nothing.

The pool is Terraform-owned and named `substrate-worker-pool`
(`var.substrate_worker_pool_name`), which is **also** the GKE node-pool name — the two
share a string here, so do not read the field as a choice between them. The client's
fallback for a blank Settings field is the same string (`DEFAULT_WORKER_POOL`,
`substrate.js:40`, and `CONFIG.SUBSTRATE.workerPool`), so leaving it blank on this
deployment resolves to the object that exists. That fallback is a constant, not a read of
Terraform: rename `var.substrate_worker_pool_name` and you must also set
`substrateWorkerPool` (or `SUBSTRATE_WORKER_POOL`), or the run selects a worker pool that
does not exist and placement fails. Quota is not the constraint: 4 of 100 CPUS are used in
`asia-south1`, so one `e2-standard-4` fits.
`spec.replicas` defaults to 1 — warm workers, not a ceiling: an actor *claims* a worker,
it does not create one, so replicas is how many actors run concurrently before a run has
to wait.

The **taint** was the other half of the mistake. The pool was tainted
`substrate.ate.dev/workers=true:NO_SCHEDULE` and **nothing** tolerated that key — least of
all `atelet`, the installer-owned per-node agent that actually boots a gVisor sandbox:

```bash
kubectl -n ate-system get ds atelet \
  -o jsonpath='{.spec.template.spec.tolerations}'
# -> [{ate.dev/sandboxClass Exists NoSchedule},
#     {cloud.google.com/compute-class Exists NoSchedule}]
```

A node atelet cannot join is a node on which no actor can ever run, which is why the pool
scaled up into nodes that stayed permanently unusable. The taint is now
`ate.dev/sandboxClass=<class>` with `NoSchedule` on the toleration side, and the two are
derived from one local rather than restated so they cannot drift. Note the spelling
difference, which is not a typo: **the node-pool API spells it `NO_SCHEDULE` and a
Kubernetes toleration spells the same taint `NoSchedule`.** Get either one wrong and the
scheduler silently unschedules everything rather than erroring.

Because `node_config` is ForceNew on google provider 6.50, the taint change **replaces the
node pool** — safe only while it holds zero actors, so confirm with
`kubectl get nodes -l cloud.google.com/gke-nodepool=<pool>` and the `workerpools.ate.dev`
ready count before applying, and expect the `gke_allow_destroy` gate (§7): the destroy gate
doing its job, not failing.

One ordering trap survives from §5's sequence, the same chicken-and-egg the `ate-system`
namespace is: **the WorkerPool CRD arrives with the installer run, which step 3 places
*after* the apply.** So a first-time apply fails with
`could not find the requested resource, Kind "WorkerPool"` and converges on the next one —
that error is the expected state before the install, not a broken manifest.

Check each link in order; each names what is broken if it fails:

```bash
kubectl -n ate-system get workerpools.ate.dev -o yaml   # the object: zero instances until converged
kubectl -n ate-system describe workerpool <name>        # replicas / sandboxClasses / ready count
kubectl get sandboxconfigs.ate.dev                      # cluster-scoped; `gvisor-default` for class gvisor
kubectl get nodes -l cloud.google.com/gke-nodepool=substrate-worker-pool  # did a node come up?
kubectl -n ate-system get pods -o wide | grep atelet     # one atelet per node, on the new node?
kubectl -n ate-system describe node <new-node> | grep -A3 Taints           # and who tolerates it
```

A `Pending` worker pod whose events blame node capacity is the taint/toleration pair
disagreeing, not the WorkerPool. An `atelet` that is `Running` but absent from the new node
means the pool has no node yet. With the WorkerPool converged and one worker node up, an
actor can be placed — the remaining step between "control plane reachable + credential
resolving" and a first successful `POST /api/agent/substrate/run`.

## 6. Key files


- `packages/shared-core/src/agent/substrate.js` — ateapi gRPC client (control plane),
  incl. `resolveSubstrateApiToken` and the fail-closed-before-the-socket check.
- `packages/shared-core/src/agent/substrate-runner.js` — credential bridge + per-run
  actor lifecycle (`runPlanningOnSubstrate`) + `verifyActorJwt`.
- `packages/shared-core/src/agent/grpc-wire.js` — protobuf primitives shared with OpenShell.
- `packages/shared-core/src/secrets/s2s-resolver.js` — single managed secret source.
- `services/settings/app/core/secret_manager.py` — request-time Secret Manager read (ADC,
  REST, `versions/latest`) behind the one dynamic managed key (§5.4).
- `services/settings/app/services/secrets_service.py` — the dynamic-managed cache + its
  `SUBSTRATE_ATEAPI_TOKEN_TTL_SECONDS` knob.
- `packages/shared-core/src/guardrails/{spec,consumers}.js` — unified spec + per-pattern renderers.
- `packages/shared/src/agent/pattern-router.js` — `dispatchPlanning` branch (substrate|openshell|cloudrun).
- `services/planner/src/routes/agent.js` — `/agent/substrate/*` and `/agent/guardrail` routes.
- `services/planner/src/routes/substrate-actor.js` — actor-side `POST /internal/plan/run` (only mounted when `SUBSTRATE_ACTOR_MODE=true`).
- `services/planner/src/jwks.js` — cached JWKS fetcher used by the actor route.
- `deploy/gcp/terraform-openshell-gke/substrate.tf` — pool, namespaces, snapshots, the
  public front (Gateway, `EnvoyProxy`, routes) and the control-plane `Backend`/`GRPCRoute`
  of §5.3.
- `deploy/gcp/terraform/substrate_token.tf` — the `substrate-ateapi-token` secret and its
  writer/reader bindings (§5.4). Writes no value.
- `.github/workflows/substrate-token-rotate.yml` — mints and publishes the bearer (§5.4).
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
`.github/workflows/substrate-control-plane.yml` and
`.github/workflows/substrate-token-rotate.yml` are the other two substrate workflows.
The first is `workflow_dispatch`-only and touches no Cloud Run service and no Terraform
state, so it can be run from a branch without deploying anything (§5.2). It shares
`concurrency.group: openshell-cluster-power` with the power workflow so an install
never races a scale-to-zero.

The second is the bearer rotator (§5.4) and the only substrate workflow with a
**schedule**, which changes what "it passed on my branch" can mean: GitHub fires a
scheduled workflow from the **default branch's** copy of the file, never the copy on the
branch that edited it, and does not guarantee the start time. A branch adding a cron
trigger therefore cannot observe it firing at all — it can only dispatch its own copy via
`--ref`, the same workaround §5.2 uses — and the rotation is in service only once merged.
Treat a green branch dispatch as proof the steps work and nothing more; verify the
schedule by confirming, after merge, that a run appeared unasked.

`deploy/gcp/terraform/substrate_token.tf` lives in the **root** stack, so it is the
`deploy.yml` `terraform` job that converges it — not `gke_reconcile`, whose state prefix
covers only `terraform-openshell-gke/`. It creates the secret and both bindings but
**never a value**: the first apply leaves
`substrate-ateapi-token` with zero versions and `credentialConfigured: false` persists
until the rotator publishes the first one. Deliberate — Terraform holding no copy of a
cluster-privileged bearer keeps it out of state.

It **reads the live substrate node-pool bounds back** and feeds them as
`substrate_min/max_nodes`, so a reconcile cannot silently start a pool the power
workflow parked. `openshell-cluster-power.yml` parks/wakes the substrate pool in
lockstep when `SUBSTRATE_NODE_POOL` is set.

The **first apply with `substrate_enabled = true` shows the new resources as
`create`** (pool, namespaces, snapshot class, ingress) — this is expected and does
**not** destroy anything, so it passes the destroy gate. Do not set
`gke_allow_destroy` for it. The worker-pool taint change of §5.5 is the opposite case:
`node_config` is ForceNew, so the plan says *replace*, and that one does need the gate —
which is why it is a deliberate, separate apply rather than something that rides along
with a routine converge.

## 8. Verification

- Unit (`npm test`): protobuf golden frames, `normalizeGuardrailSpec` /
  `validateGuardrailSpec`, `resolveSubstrateAtespace`, `syncSubstrateSecrets` leaks
  no raw token, `pattern-router` branch table, `verifyActorJwt` vs fixture JWKS.
  The `grpcCall` `options.transport` seam fakes the control plane in lifecycle tests.
  Token-path coverage: `substrate.test.js` asserts the resolve order (caller → store →
  S2S) and that both an absent credential and a returned `16` name `substrateApiToken`;
  `substrate-runner.test.js` asserts one resolve per run and that the token is **not**
  among the names `syncSubstrateSecrets` writes;
  `services/settings/tests/unit/test_dynamic_managed_secret.py` covers the TTL, the
  env-must-not-win case, and a failed fetch yielding the key absent rather than an error.
- Token path, **without printing the secret**. Whether the credential resolves and whether
  the control plane accepts it are the two questions; neither needs the value on a
  terminal. Never assign it to a variable, echo it, or write it to a file — these pipe it
  straight into a decoder that prints claims only:

  ```bash
  # 1. Does the caller see a credential at all? (the two halves, separately)
  curl -s $GW/api/agent/substrate/status \
    | jq '{configured, credentialConfigured, status: .status.status, grpcStatus: .status.grpcStatus}'
  # 2. Is a version published, and when? (`describe` returns metadata, never data)
  gcloud secrets versions describe latest --secret=substrate-ateapi-token \
    --format 'value(name, createTime, state)'
  # 3. Are the claims the ones the control plane trusts? prints iss/aud/exp, not the token
  gcloud secrets versions access latest --secret=substrate-ateapi-token \
    | cut -d. -f2 | base64 -d 2>/dev/null | jq -c '{iss, aud, exp}'
  ```

  Expected: `credentialConfigured: true` with `status: "SERVING"`; a `createTime` inside
  the last six hours (older means the schedule is not firing — §5.4's default-branch
  caveat); `aud` exactly `api.ate-system.svc`, `iss` this cluster's GKE issuer.
  `credentialConfigured: false` beside a fresh version points at the settings accessor or
  `GCP_PROJECT_ID`, not at the rotator. The `grpc-status` the rotator asserts is the one
  value that may legitimately reach a log.
- Staging actor smoke: status SERVING + gvisor present; secrets-sync creates a
  `substrate-credentials` Secret + read grant; run a trivial prompt → actor READY →
  streamed result; **inside the actor** `curl 169.254.169.254` is DENIED and
  OpenRouter:443 ALLOWED with a gateway-injected credential while actor env has
  **no** key; actor SUSPENDED+DELETED after TTL.
- Public hostname (§5.1), before touching the Settings card:
  ```bash
  kubectl -n ate-system get gateways substrate-ingress -o wide   # Programmed + address = substrate-ip
  kubectl -n ate-system get envoyproxies substrate-proxy-config
  kubectl -n ate-system get httproutes substrate-actors
  kubectl -n ate-system get grpcroutes substrate-control-plane   # §5.3: a GRPCRoute, not an HTTPRoute
  kubectl -n ate-system get backend substrate-ateapi             # must have a status, else enableBackend is off
  kubectl -n ate-system get networkpolicy substrate-front-to-ateapi
  kubectl get svc -A -l gateway.envoyproxy.io/owning-gateway-name=substrate-ingress
  dig +short A substrate.<your-domain>                           # must equal substrate_ingress_ip
  curl -sI https://substrate.<your-domain>/                      # reply from atenet-router, not a TLS error
  # The control-plane hop, end to end (§5.3): 0 with a token, 16 without one.
  printf '\000\000\000\000\000' > /tmp/req.bin
  curl -s --http2 -X POST -H 'content-type: application/grpc' -H 'te: trailers' \
    -H "authorization: Bearer $(kubectl -n ate-system create token ate-client --audience=api.ate-system.svc)" \
    --data-binary @/tmp/req.bin \
    https://substrate.<your-domain>/substrate.ateapi.v1.Control/ListActors -D - \
    | grep -i 'grpc-status\|grpc-message'
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
- The public control-plane route depends on two things this repo does not own:
  `extensionApis.enableBackend` in the Helm-managed `envoy-gateway-config` (off, the
  `Backend` is silently never reconciled) and the projected-token authn of `api`, which
  no Cloud Run identity can satisfy directly (§5.3 items 2 and 4). The second is worked
  *around* rather than fixed: the rotator mints the token CI-side and the settings
  service reads it out of Secret Manager, so the dependency has moved from "an in-cluster
  caller" to "Actions and Secret Manager are both healthy", and the route is unusable
  whenever the published version has aged past its 12 hours.
- **A 12-hour cluster-privileged bearer lives in Secret Manager** for those twelve hours
  (`substrate-ateapi-token`, `versions/latest`). That is the price of the workaround above,
  bounded deliberately: the lifetime is short even though GKE would mint a week (§5.4),
  the writer grant is on this one secret and no other, the mint grant is scoped to
  `ate-client` alone, and only `settings-sa` can read it outside CI. It is still a
  credential that creates and deletes actors in a store with an
  audit trail rather than in nobody's hands, so retiring the rotator means retiring the
  secret, not just the cron.
- **Known bug, deliberately unfixed: `packages/shared-core/src/agent/openshell.js:9`
  imports the config module as if it were the object** — `const CONFIG = require('../config')`,
  while `config.js` exports `{ CONFIG, …helpers }`. Every `CONFIG?.OPENSHELL?.*` read there
  is `undefined` and silently takes its default: URL `:70`, allowed workspaces `:80`,
  workspace `:109`, call timeout `:120`, token `:169` and `:367`. The same defect in
  `substrate.js`, `substrate-runner.js` and `secrets/s2s-resolver.js` surfaced while wiring
  the control-plane credential and is fixed there — those three destructure now. It is
  worth understanding what the fix in `s2s-resolver.js` alone meant: with
  `CONFIG.SERVICES.settingsUrl` `undefined`, `fetchS2sSecrets()` returned `{}` for **every**
  shared-core caller, so the managed-secret resolution these routes are built on was a
  no-op. `openshell.js` stays broken on purpose in this change: honoring an operator-set
  OpenShell URL/token where it previously ignored one alters the working OpenShell path and
  needs its own validation, not a drive-by inside a credential rotation. Until then,
  OpenShell runs on `CONFIG` defaults — `process.env.OPENSHELL_TOKEN` at `:367` is what
  keeps the token path alive.
- `cm/substrate-ateapi-ca` is a copy, not a watch: the servicedns CA is self-signed with
  a one-year validity, so the trust material refreshes only when `gke_reconcile` runs
  again. A rotation that lands between applies fails as a TLS handshake error on the
  route, not as a plan-time conflict.

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
  the pool exists — so `substrate.tf` is in plan. Its taint is now
  `ate.dev/sandboxClass=<class>`, which atelet tolerates; the previous
  `substrate.ate.dev/workers=true:NO_SCHEDULE` was tolerated by nothing (§5.5). The
  replacement has been applied: the live pool carries the sandboxClass taint and one
  e2-standard-4 node, and that node costs money whenever the pool is up —
  `substrate_worker_pool_replicas = 0` is the way to park it (§5.5).
- The front **is** serving `substrate.archagentix.com`: the `A` record points at
  `substrate-ip` (34.14.137.62), `substrate-server-tls` is `Ready=True` with a real
  Let's Encrypt certificate, `http://` answers `301` to `https://`, and the `https`
  listener is Programmed with two routes attached. `https://…/` answers `503` because
  it resolves to `atenet-router:8444`, the actor CONNECT-tunnel port — a plain `GET /`
  has no upstream to talk to, which is the front working as designed rather than a
  broken page.
- **The control plane is installed.** `mode=install` from PR #253 landed
  `ate-api-server` (×2), `ate-controller`, `ate-idp-server` (×2), `atelet`,
  `atenet-router`, `atenet-egress`, `k8s-credential-provider` and `postgres-0`, all
  `Running`, and `data-postgres-0` bound at the right-sized 50 Gi. Both blockers that
  killed the earlier runs are gone: the master is on `1.37.1-gke.1552000` (`REGULAR`)
  with `clustertrustbundles` + `podcertificaterequests` served, and the postgres volume
  and CPU request no longer exceed the `SSD_TOTAL_GB` quota and the node's allocatable
  (§5.2).
- **The public control-plane route carries gRPC.** `https://substrate.archagentix.com/
  substrate.ateapi.v1.Control/ListActors` returns `grpc-status: 0` with a projected
  `ate-client` token and `16 missing bearer token` without one (§5.3 items 1–3). The four
  objects behind this (`cm/substrate-ateapi-ca`, `backend/substrate-ateapi`,
  `grpcroute/substrate-control-plane`, `networkpolicy/substrate-front-to-ateapi`) were
  created by hand while the path was being found; `gke_reconcile` from this branch has
  since adopted them (4 create + 1 update, no deletes) and a follow-up plan reports
  **No changes**, with `ListActors` still answering `0` / `16` as above.
- **The caller identity is solved in code, not yet in service.** §5.3 item 4's "a Cloud Run
  service cannot mint a projected token" is no longer what blocks `substrateUrl` — the
  rotator mints it CI-side and settings resolves it per run (§5.4). What stands between
  that and `credentialConfigured: true` is sequencing, not design: the rotator's schedule
  exists only once its file is on the default branch, so until merge only a hand dispatch
  fills the secret; `substrate-ateapi-token` has zero versions until the root `terraform`
  job has created it **and** the rotator has published into it, since Terraform writes no
  value;
  and the app is not yet deployed from this change, so the live planner still lacks
  `resolveSubstrateApiToken`, the destructured `CONFIG` that makes managed resolution
  happen at all (§9), and the stricter `configured`.
- **No `WorkerPool` object existed on the cluster, and that — not a missing node
  label — is what prevented placement.** `workerpools.ate.dev` had **zero instances** in
  `ate-system`, `substrate-worker-pool` sat at zero nodes, and `atelet`/`atenet-egress`
  ran on tenant-pool nodes. Labelling nodes with `ate.dev/worker-pool` was addressing the
  wrong object (§5.5). The object is now Terraform-owned and **converged**: the apply from
  this branch created `workerpools.ate.dev/substrate-worker-pool`, the controller resolved
  `gvisor-default` (`RESOLVED=True`), the cluster autoscaler took the pool 0→1, `atelet`
  landed on the new node, and the synthesised worker pod reached `Running` with the pool at
  `READY 1/1`. So placement is proven at the pool level; what has not yet been observed is
  an *actor* scheduled onto that worker, which is the run call below.
  `substrateWorkerPool` may stay blank now — the client's fallback is
  `substrate-worker-pool`, the name Terraform renders (§5.5).
- **Pinned: `SUBSTRATE_VERSION = v1.0.0`** (repo variable), which is what
  `ate-api-server` actually runs (`ghcr.io/agent-substrate/substrate/ateapi:v1.0.0@sha256:2f1ee44…`).
  Before the pin every install resolved "latest release" and printed the warning; the
  checkout and the images now move only when the variable does (§5.2).
- The `ate-system` control plane is never installed by Terraform; it lands when the
  **Substrate control plane (preflight / install)** workflow runs with `mode=install`
  (§5 step 3, §5.2).
- Neither Cloud Run service carries `SUBSTRATE_URL` / `SUBSTRATE_INGRESS_URL` — correct by
  design, those come from the Settings store. But `configured` no longer means "a URL is
  set": it is `Boolean(url) && Boolean(token)`, with `credentialConfigured` isolating the
  credential half. `configured: false, credentialConfigured: false` with a URL saved means
  the bearer is not resolving, so §5.4 is the next place to look, not §5.1.
- `POST /api/agent/substrate/run` passes no `applyManifest` seam, and
  `syncSubstrateSecrets` fails closed when a credential resolves without one (Secret CRUD
  is not an ateapi RPC). Until a cluster-side applier exists, apply the
  `substrate-credentials` Secret and the `atenet-egress` read grant out of band, or smoke
  against an organization whose vault resolves nothing.
