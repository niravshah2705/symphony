# OpenShell Kubernetes Integration, Authentication & Local Verification Guide

This document covers the architecture, authentication verification, local & GKE integration tests, per-organization secret & container image push/pull management, and NetworkPolicy configuration for OpenShell sandboxes in Symphony.

---

## 1. Local & Cluster Verification Tests (Run First)

Before modifying or debugging the OpenShell integration, run the following verification suite from your workstation (which has `kubectl`, `helm`, and `openshell` CLI access to the cluster).

### Test 1.1: Verify Helm Releases & Kubernetes Pods

```bash
helm list -A
kubectl get pods -A
```

Expected releases:
- `cert-manager` (`cert-manager` namespace)
- `eg` (`envoy-gateway-system` namespace, Envoy Gateway v1.8.1)
- `openshell` (`openshell` namespace, `helm-chart-0.1.5`)
- `openshell-workspace-tenant-a` (`tenant-a` namespace, `openshell-workspace-0.0.0`)
- `openshell-workspace-tenant-b` (`tenant-b` namespace, `openshell-workspace-0.0.0`)

### Test 1.2: Verify Operator Namespace Allowlist & RBAC

OpenShell runs with `workspace_mode = "operator"` and `operator_namespace_label = "openshell.ai/workspace-allowed"`. Verify which Kubernetes namespaces are labeled and allowed to host sandboxes:

```bash
kubectl get ns -l openshell.ai/workspace-allowed=true --show-labels
```

Expected output shows `tenant-a` and `tenant-b` with `openshell.ai/workspace-allowed=true`.

### Test 1.3: Verify OpenShell Gateway gRPC Health & Auth

Test connectivity over HTTP/2 + TLS through Envoy Gateway (`https://openshell.archagentix.com`) using both the CLI and the Node.js gRPC client:

```bash
# CLI health check
openshell status

# Node.js gRPC health check & workspace discovery
node -e '
  const os = require("./packages/shared-core/src/agent/openshell.js");
  os.getOpenShellStatus({ url: "https://openshell.archagentix.com", workspace: "tenant-a" })
    .then((res) => console.log(JSON.stringify(res, null, 2)));
'
```

### Test 1.4: Verify Per-Organization Provider Secret Creation (`openshell-credentials`)

Verify that OpenShell can create and update provider secrets in `openshell-credentials` scoped to a tenant workspace (including OpenRouter, GitHub, and Container Image Registry push/pull credentials):

```bash
node -e '
  const os = require("./packages/shared-core/src/agent/openshell.js");
  os.syncNvidiaSecrets({
    url: "https://openshell.archagentix.com",
    workspace: "tenant-a",
    organizationId: "org-demo",
    openrouterApiKey: "sk-or-v1-test-token",
    imageRegistryUrl: "ghcr.io",
    imageRegistryUsername: "org-demo-bot",
    imageRegistryPassword: "ghp_test_registry_push_token"
  }).then((res) => console.log(JSON.stringify(res, null, 2)));
'

# Confirm the encrypted Kubernetes Secret objects exist in openshell-credentials:
kubectl get secrets -n openshell-credentials
```

### Test 1.5: Verify Real Sandbox Pod Provisioning & Command Execution on GKE

Verify that `ensureProjectSandbox` provisions a real Kubernetes pod (`pod/<sandbox-name>` and `pod/os-supervisor-<uuid>`) in `tenant-a`, waits until `SANDBOX_PHASE_READY`, and executes commands inside the live container:

```bash
node -e '
  const os = require("./packages/shared-core/src/agent/openshell.js");
  (async () => {
    const ensured = await os.ensureProjectSandbox({
      url: "https://openshell.archagentix.com",
      workspace: "tenant-a",
      organizationId: "org-demo",
      projectKey: "KAN",
      projectName: "Kanban Board"
    });
    console.log("Ensured sandbox:", ensured.sandboxName, ensured.sandbox?.phase);

    const execRes = await os.execInSandbox({
      url: "https://openshell.archagentix.com",
      workspace: "tenant-a",
      sandboxName: ensured.sandboxName,
      command: ["bash", "-lc", "uname -a && id && pwd && opencode --version"]
    });
    console.log("Exec output:", execRes);
  })();
'

# Confirm live pods in Kubernetes:
kubectl get pods,svc,pvc -n tenant-a
```

### Test 1.6: Run Automated Unit Tests

```bash
npm test
```

---

## 2. OpenShell Authentication Architecture & Root Causes Resolved

### 2.1 Gateway Authentication Modes

OpenShell supports three authentication layers between the client (`packages/shared-core/src/agent/openshell.js`) and the gateway (`openshell-server`):

1. **TLS Termination via Envoy Gateway (`https://openshell.archagentix.com`)**:
   - External traffic terminates TLS 1.3 at the Envoy Gateway LoadBalancer (`envoy-gateway-system` using Let's Encrypt certificate `openshell-server-external-tls`) and routes `h2c` (HTTP/2 cleartext gRPC) to `openshell.openshell.svc.cluster.local:8080`.
   - In `openshell/openshell-config` (`gateway.toml`), `[server.auth]` is configured with `allow_unauthenticated_users = true` behind the Envoy ingress.
2. **Bearer Token / OIDC Authentication (`authorization: Bearer <token>`)**:
   - When `OPENSHELL_TOKEN` / `OPENSHELL_API_KEY` (or per-org `openshellToken`) is configured, `grpcCall` attaches `authorization: Bearer <token>` on every HTTP/2 gRPC request (`@nvidia/openshell-sdk` transport convention).
   - If Cloudflare Access / edge proxy protection is enabled (`OPENSHELL_EDGE_TOKEN`), `grpcCall` attaches `cf-access-jwt-assertion` and `Cookie: CF_Authorization=<edgeToken>`.
3. **Mutual TLS (mTLS)**:
   - When `OPENSHELL_TLS_CERT`, `OPENSHELL_TLS_KEY`, and `OPENSHELL_TLS_CA` are provided, `grpcCall` passes the client certificate and key to `http2.connect`.

### 2.2 Why Sandbox & Provider Creation Originally Failed (Root Causes)

During live cluster diagnostics against `https://openshell.archagentix.com`, three issues prevented backend sandbox creation:

1. **Operator Namespace Allowlist (`PERMISSION_DENIED` on `default` workspace)**:
   - The cluster's `gateway.toml` uses `workspace_mode = "operator"` with `operator_namespace_label = "openshell.ai/workspace-allowed"`.
   - Only `tenant-a` and `tenant-b` have the label `openshell.ai/workspace-allowed=true` and the `openshell-workspace` Helm chart installed (`ServiceAccount/openshell-sandbox` + RBAC `Role`/`RoleBinding`).
   - Calling `CreateSandbox` or `CreateProvider` with `workspace: "default"` failed with gRPC status `7` (`PERMISSION_DENIED: namespace 'default' is not in the operator namespace allowlist`).
   - Additionally, `tenant-a` and `tenant-b` needed to be registered via `CreateWorkspace` in the OpenShell server database.
   - **Fix**: `resolveOpenShellWorkspace` maps organizations to allowed tenant workspaces (`tenant-a`, `tenant-b`, or explicit per-org `openshellWorkspace`) and automatically ensures the workspace record exists via `CreateWorkspace`.

2. **Protobuf `ObjectMeta` Field Number Mismatch (`datamodel.proto`)**:
   - In `/Users/niravshah/git/OpenShell/proto/datamodel.proto`, `ObjectMeta` defines:
     - `id = 1` (`string`)
     - `name = 2` (`string`)
     - `reserved 3, 8;`
     - `labels = 4` (`map<string, string>`)
     - `resource_version = 5` (`uint64`)
     - `annotations = 6` (`map<string, string>`)
     - `workspace = 7` (`string`)
   - Previously, `encodeObjectMeta` encoded `labels` at field `3` (reserved), `annotations` at field `4` (`labels`), and `resource_version` as a varint at field `7` (`workspace`, which is a string!). That corrupted `ObjectMeta` whenever `CreateProvider` or `UpdateProvider` ran.
   - **Fix**: `encodeObjectMeta` and `decodeObjectMeta` now strictly match `datamodel.proto` (`labels = 4`, `resource_version = 5`, `annotations = 6`, `workspace = 7`).

3. **Asynchronous Kubernetes Pod Provisioning (`SANDBOX_PHASE_PROVISIONING`)**:
   - On GKE, `CreateSandbox` creates a PVC (`workspace-<name>`), a boundary Service (`os-boundary-<uuid>`), a supervisor Pod (`os-supervisor-<uuid>`), and the sandbox Pod (`<name>`).
   - Reaching `SANDBOX_PHASE_READY` (`phaseCode === 2`) takes ~10–25 seconds while GKE binds the volume and starts containers.
   - **Fix**: `ensureProjectSandbox` now polls `getProjectSandboxStatus` until `phase === 'READY'` before running bootstrap scripts (`opencode` setup, `.docker/config.json` registry auth, and git repository clone).

---

## 3. Per-Organization Secret & Container Image Push/Pull Management

Secrets are managed at the **organization level** (stored encrypted in the per-organization vault / settings store and synced into OpenShell with organization-scoped provider names):

| Secret Key | OpenShell Provider / Target | Purpose |
|---|---|---|
| `openrouterApiKey` | `openrouter-<org>` (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`) | Authenticates `opencode` and OpenRouter free/paid models inside the sandbox |
| `githubToken` | `github-<org>` (`GITHUB_TOKEN`, `GH_TOKEN`) | Authenticates `git clone`, `git push`, and `gh pr create` inside the sandbox |
| `nvidiaApiKey` | `nvidia-<org>` (`NVIDIA_API_KEY`, `NGC_API_KEY`) | Authenticates NVIDIA NIM endpoints |
| `imageRegistryUrl` | `registry-<org>` (`DOCKER_REGISTRY_URL`) | Target container registry (`ghcr.io`, `docker.io`, `gcr.io`, `nvcr.io`, etc.) |
| `imageRegistryUsername` | `registry-<org>` (`DOCKER_USERNAME`) | Organization container registry username / service account |
| `imageRegistryPassword` | `registry-<org>` (`DOCKER_PASSWORD`) | Organization container registry push/pull token (also written to `~/.docker/config.json` in sandbox & K8s `docker-registry` secret spec) |

When a sandbox is provisioned for an organization:
1. `syncNvidiaSecrets` creates/updates organization-scoped providers in OpenShell (`openshell-credentials` namespace).
2. If `imageRegistryUsername` and `imageRegistryPassword` are configured for the organization, `ensureProjectSandbox` configures `/sandbox/.docker/config.json` and `$HOME/.docker/config.json` inside the sandbox so `docker push`, `podman push`, `skopeo copy`, `crane push`, and `kaniko` work out of the box, and generates the Kubernetes `kubernetes.io/dockerconfigjson` secret manifest for `imagePullSecrets`.

---

## 4. NetworkPolicy Architecture (Kubernetes L3/L4 + OpenShell L7)

Each tenant namespace (`tenant-a`, `tenant-b`) enforces defense-in-depth using two policy layers:

1. **Kubernetes `NetworkPolicy` (L3/L4)**:
   - `default-deny-all`: blocks all ingress and egress by default.
   - `allow-dns`: allows UDP/TCP port `53` to `kube-system` (`kube-dns`).
   - `openshell-workspace-<tenant>-sandbox-ssh`: allows ingress on TCP port `2222` from `openshell-server` to sandbox supervisor pods.
   - `allow-openshell-and-https-egress`: allows sandbox & supervisor pods to connect to `openshell-server` (`8080/TCP` in `openshell` namespace) and outbound HTTPS (`443/TCP`) for OpenRouter (`openrouter.ai`), GitHub (`github.com`, `api.github.com`), and container image registries (`ghcr.io`, `registry-1.docker.io`, `nvcr.io`).
2. **OpenShell `SandboxPolicy.network_policies` (L7 Supervisor Filter)**:
   - Restricts outbound destinations and HTTP methods per process inside the sandbox (`/usr/bin/git`, `/usr/bin/curl`, `/sandbox/.local/bin/opencode`, `/usr/local/bin/node`).
