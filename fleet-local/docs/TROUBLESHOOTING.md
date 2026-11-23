# fleet-local troubleshooting guide

Chronological record of every issue hit while standing up and live-testing the
fleet-local edge + onboarding stack on kind cluster `flexprice-local`, with the
exact fix and the reusable script for each. Scripts live in `scripts/fixes/`.

Conventions used below:
- Cluster context: `kind-flexprice-local`; hosts file maps `app.fleet.dev` /
  `kagent.fleet.dev` → `127.0.0.1` (mkcert TLS).
- Secrets are never printed; commands fetch them inline from k8s Secrets.

---

## T-01 Google rejects `.local` origins ("Must end with a public top-level domain")

**Symptom:** Google OAuth consent screen errors on `https://app.local/oauth2/callback`.
**Cause:** Google only accepts redirect URIs / JS origins on public TLDs.
**Fix:** Renamed everything to `app.fleet.dev` / `kagent.fleet.dev` (config.ts,
both oauth2-proxy manifests, both Ingresses, 00-prereqs mkcert SANs + /etc/hosts,
verify-e2e.sh). Rebuilt BFF image.
**Script:** applied via `scripts/10-ingress-oauth.sh` (idempotent re-apply).

## T-02 oauth2-proxy CrashLoopBackOff — "cookie_secret must be 16, 24, or 32 bytes… but is 44"

**Symptom:** Both proxy deployments crashloop after first apply.
**Cause:** Secret generated with `openssl rand -base64 32` → 44-char string stored
literally as the secret value (oauth2-proxy reads the raw bytes, not decoded).
**Fix:** Generate with `openssl rand 32 | base64` (raw 32 bytes, base64-wrapped).
Patching an existing secret's `.data` requires re-encoding: `printf '%s' "$V" | base64`.
**Script:** `scripts/00-prereqs.sh` (fixed) · one-off patch: `scripts/fixes/t02-cookie-secret.sh`

## T-03 `/api/me` returns 401 although Google login succeeds

**Symptom:** BFF logs show no `Authorization` header reaching it; oauth2-proxy log
shows AuthSuccess.
**Cause:** `--set-authorization-header=true` only exposes/mints the ID-token cookie
for the browser; it does NOT forward the header upstream.
**Fix:** Added `--pass-authorization-header=true` to both proxies (kept
`--set-authorization-header=true`). Applied via `scripts/10-ingress-oauth.sh`.
**Verify:** `curl -s -o /dev/null -w '%{http_code}' https://app.fleet.dev/api/me`
after login → 200.

## T-04 Onboarding step "LiteLLM virtual key" fails — 403 "only available for LiteLLM Enterprise users: tags"

**Symptom:** `POST /key/generate` rejected with enterprise feature error naming `tags`.
**Cause:** `tags` is Enterprise-only in LiteLLM OSS. Virtual keys themselves,
`metadata`, `max_budget`, `budget_duration`, `team_id` ARE free (verified empirically).
**Fix:** Removed `tags` from `onboarding/steps/key.ts`. Budget attribution uses
`metadata.{fleet_org,fleet_project}` instead.
**Rebuild cycle:** `docker build -f deploy/bff/Dockerfile -t fleet-bff:local . && kind load docker-image fleet-bff:local --name flexprice-local && kubectl -n fleet-system rollout restart deploy/fleet-bff`

## T-05 Flexprice wallet topup 404 — `POST /v1/wallets/{id}/topup`

**Symptom:** `404 page not found` from flexprice-api.
**Cause:** Route is hyphenated: `/v1/wallets/{id}/top-up`, and body REQUIRES
`transaction_reason` (allowed: FREE_CREDIT_GRANT, PURCHASED_CREDIT_INVOICED,
PURCHASED_CREDIT_DIRECT, SUBSCRIPTION_CREDIT_GRANT, CREDIT_NOTE, INVOICE_VOID_REFUND).
**Discovery method:** mine the embedded swagger from the binary:
`kubectl -n flexprice exec deploy/flexprice-api -- strings /app/server | grep -oE '/v1/wallets[a-zA-Z0-9/:_.{}-]*' | sort -u`
**Fix:** `clients/flexprice.ts` → `top-up` + `transaction_reason: 'PURCHASED_CREDIT_DIRECT'`.

## T-06 Flexprice subscription 400 — BillingPeriod/Currency required, then "Invalid billing period: RECURRING"

**Symptom:** `validation_error` on `POST /v1/subscriptions`.
**Cause:** `billing_period` enum is BILLING_PERIOD_{ANNUAL,DAILY,HALF_YEAR,MONTHLY,
ONETIME,QUARTER,WEEKLY} — bare `"MONTHLY"` accepted; `RECURRING` belongs to
`billing_cadence`, not `billing_period`. Currency must match the plan's prices.
**Fix:** `{currency: 'INR', billing_period: 'MONTHLY'}` per user decision (prepaid
wallet in INR). Also added an INR usage price to the seeded plan (plan only had USD
prices → "No prices match the subscription criteria"): ₹83 ≈ USD×1.10 at ~₹83/$,
FLAT_FEE on the passthrough meter, backdated start_date.
**Script:** `scripts/fixes/t06-flexprice-inr.sh` (creates the INR price if absent).

## T-07 Flexprice: one active wallet per currency+type (409 already_exists)

**Symptom:** `createWallet` 409 when a stale USD wallet exists.
**Fix:** Step now lists wallets and picks the INR one, else creates
(`onboarding/steps/flexprice.ts` + `flexprice.listWallets`). Stray zero-balance
wallet closed via `POST /v1/wallets/{id}/terminate` (route discovered via T-05 method).

## T-08 Create Agent stuck NotReady — "golden build failed (GoldenActorCrashed)", wakeup probe :8081 refused

**Symptom chain (each layer verified live):**
1. Agent CR `Ready=False golden build failed (GoldenActorCrashed), retry N`.
2. kagent controller: `resume failed: atelet Run: while waiting for container
   wakeup probe: wakeup probe for "kagent" never returned 200 within 30s
   (~7,400–16,300 attempts, last error: Get "http://169.254.17.2:8081/readyz":
   connection refused)`.
3. Worker pod (gVisor console): `materialize agent config in /config: bootstrap
   initialization deadline: context deadline exceeded` — the agent process dies
   during its FIRST action (fetching bootstrap config from
   `kagent-controller.kagent.svc.cluster.local:8083` with a substrate-minted
   actor JWT, audience `kagent-bootstrap`) before it ever binds :8081.
4. atenet-egress access logs: the `GetBootstrapConfig` call takes **~3,000 ms per
   attempt** (a hard 3s connect deadline inside agentgateway), so 5 retries × 3s
   blow past the runtime's bootstrap deadline → crash → probe never answers.

**Attempts made (in order):**
| # | Hypothesis | Action | Result |
|---|---|---|---|
| 1 | Snapshot scheme (`s3://` vs `gs://`) broke resume | Patched demo Harness to `gs://ate-snapshots/` (like org-nirav) | No change — still GoldenActorCrashed. Scheme exonerated. |
| 2 | ModelConfig / stream flag broke boot | Patched `demo-model-mock` `stream:false`; recreated Agent | No change. |
| 3 | LiteLLM virtual key invalid for tenant | Inline `/key/info` + `/v1/chat/completions` check via python | Key works for chat — not the cause. |
| 4 | Bundle env/mounts differ from working tenant | Exported actor_templates protobuf from postgres `atepg`, string-diffed org-nirav vs demo/prod | Byte-comparable; no missing mount/env. |
| 5 | gVisor runtime assets corrupted | Compared runsc sha across actors (`f702ae92…`) | Identical — not it. |
| 6 | Node resource pressure (load 15.4, swap in use, dmesg OOM kills of Kafka/temporal) | Scaled org-prod deploy + org-nirav/org-prod workerpools to 0; dropped page cache | ~3 GiB freed, load fell to 5–8 — build still failed identically. Secondary factor only. |
| 7 | Poll storm starving CPU | Measured kagent-controller polling `GetActorTemplate` ~80×/sec for failed builds | Real waste; stopped by pausing pools. Did not fix T-08. |
| 8 | trusted-proxy auth rejects actor bootstrap JWT | Flipped cm `kagent-controller` `server.auth.mode`: `trusted-proxy` → `disabled` (controller CrashLoopBackOff: valid modes are `[insecure, trusted-proxy]`) → `insecure`; restarted controller; deleted+recreated demo & prod Agents | Still fails. Auth mode NOT the root cause. (Timeline correlation was coincidental.) |
| 9 | NetworkPolicy blocks egress→controller:8083 | Inspected `kagent-controller-ingress` (allows kagent+fleet-system ns on 8083); curl from normal pod to ClusterIP = 0 ms | Path open; plain HTTP reachability fine. |
| 10 | `substrateEgress` policy RPC (atenet-egress → ate-api-server `GetActorEgressPolicy`) adds ~3s/call | Removed the policy from the HTTP route in cm `atenet-egress-agentgateway-config` + rollout | First attempt corrupted the YAML (stripped nested keys → gateway rejected config, zero requests logged). Restored from `atenet-egress-agentgateway-substrate-config` backup, re-applied clean bypass, restarted. |
| 11 | Stale worker pods hold old egress registration after gateway restarts | Attempted delete of org-demo/org-prod worker pods | **Blocked by approval hook** — not yet executed. This is the immediate next step. |
| 12 | Clean `substrateEgress` bypass on HTTP route isolates the policy RPC | Re-patched cm with only the policy removed (anchor/alias intact), restarted egress | After the restart the gateway logged **zero** bootstrap requests — workers stop tunneling to a new egress pod until they restart. |
| 13 | Policy-bypass + fresh worker tunnel isolates the stall | Bypassed `substrateEgress` on the HTTP route, rolled org-demo pool to a fresh worker | Gateway itself rejected every call in **1–7 ms** with `error="missing substrate egress request policy" reason=Authorization` — so the ~3 s was inside the *policy processing*, and the bypass is not a viable end state (the policy injects the bootstrap `Authorization` header). Policy restored verbatim from backup cm. |
| 14 | Stale tunnels after egress restarts cause the stall | Restored policy + rolled org-demo pool (new pod `wvh9w`) + fresh build | Stall **reproduced** (2617–3164 ms/call) ⇒ stale tunnels exonerated. But api-server logs showed the policy RPCs are fast: `GetActorEgressPolicy` 25–39 ms, `GetActor` 30 ms, `MintActorJwt` 14 ms. Gateway errors were `upstream call failed: Connect: deadline has elapsed` / `upstream call timeout` ⇒ the stall was opening the **upstream TCP connection to kagent-controller:8083** from the gateway pod. |
| 15 | **ROOT CAUSE:** NetworkPolicy `kagent-controller-ingress` (ns kagent) allows :8083 only from `kagent` + `fleet-system` namespaces — but actor bootstrap traffic egresses from the **atenet-egress gateway pods in ns `ate-system`** | Patched the NP to also admit `namespaceSelector: ate-system + podSelector: app=atenet-egress`; rebuilt agents | Bootstrap calls dropped to **74–815 ms**; `demo-agent-worker` and `prod-agent-worker` both reached **Ready=True** (golden snapshot taken). Repeated confirmation under both `insecure` and `trusted-proxy` auth: `grpc.status=0`. The earlier "curl to ClusterIP = 0 ms" test was flawed — it ran from an allowed namespace. |

**Diagnosis trail (kept for posterity):** attempts 1–12 correctly localised the
stall to the gateway's request pipeline but mis-attributed it to the policy RPC.
Attempt 14's api-server `elapsed-time` fields disproved that (all RPCs <40 ms)
and attempt 15 found the real cause: the gateway's *upstream connect* to
`kagent-controller:8083` was being packet-dropped by the `kagent-controller-ingress`
NetworkPolicy, which predated the egress-tunnel data path and never listed the
`ate-system/atenet-egress` pods. The `substrateEgress` policy is load-bearing
(the bootstrap `Authorization` header is injected by it) so removing it is not
a fix — only widening the NP is.

**Reproduction / observation commands:**
```bash
# the 3s signature, live:
kubectl -n ate-system logs deploy/atenet-egress --since=5m \
  | grep GetBootstrapConfig \
  | sed -E 's/.*T([0-9:]+).*(duration=[0-9]+ms).*/\1 \2/'
# api-server RPC mix (watch GetActorEgressPolicy count vs churn):
kubectl -n ate-system logs deploy/ate-api-server --since=15m \
  | grep -oE '"method":"[^"]+"' | sort | uniq -c | sort -rn
# node pressure:
docker exec flexprice-local-control-plane sh -c 'free -m | sed -n 2p; uptime'
```

**STATUS: RESOLVED (2026-11-21).** Root cause = NetworkPolicy gap (attempt 15):
`kagent -n kagent get networkpolicy kagent-controller-ingress` must include
`from: namespaceSelector ate-system + podSelector app=atenet-egress` on :8083,
otherwise every actor→controller bootstrap upstream connect from the egress
gateway is packet-dropped and burns the ~3 s gateway connect deadline.
After the patch: bootstrap 74–815 ms, `org-demo/demo-agent-worker` and
`org-prod/prod-agent-worker` reached Ready=True (golden snapshot), confirmed
under both `insecure` and `trusted-proxy` controller auth (`grpc.status=0`).
NOTE: one `trusted-proxy` attempt failed with `mint actor certificate: no
children to pick from` — that was the T-12 starvation burst (ate-idp-server
restart-loop), not a regression of the T-08 fix; the retry minutes later
reached Ready=True under trusted-proxy. See T-12 Recurrence 2.
**Fix script:** `scripts/fixes/t08-egress-np-fix.sh` (idempotent) +
`scripts/fixes/t08-agent-diagnose.sh` (diagnosis). The temporary test mutations
(substrateEgress bypass in the egress cm, `insecure` auth mode) were reverted:
cm `atenet-egress-agentgateway-config` restored verbatim from
`atenet-egress-agentgateway-substrate-config`, controller `server.auth.mode`
back to `trusted-proxy` (`userIdClaim: email`).

## T-12 Node memory/CPU pressure on kind VM (secondary finding, 2026-11-21)

**Recurrence 2 (15:26 local / 09:56 UTC, during the T-08 close-out):** load
average hit **93.8** inside the kind VM (8 vCPU), swap 449 MiB in use, free mem
122 MiB, **154 zombie tasks**, top consumers clickhouse (93% CPU), beyla
(42.9% / 637 MB RSS), temporal, kubelet, node_exporter-style node procs.
Consequence observed: **ate-idp-server exit-0 "Completed" restarts every ~50 s
under probe pressure**, and a golden-build attempt landing in that window
failed with `mint actor certificate: no children to pick from` (idp child CA
not registered yet after restart) — a *starvation artifact, not a substrate
bug*. This produced the only post-fix build failure (retry 2 pending).
Removal of Beyla is now on the table (it adds uprobe churn to every container
start/stop — exactly what build retries generate). Rule stands: no timing
builds while load > 6 or idp has restarted in the last 5 min.

**Symptom:** load avg up to 15.4 on 8 vCPU, swap in use, dmesg memory-cgroup OOM
kills (flexprice Kafka java, temporal-server); liveness-probe restart storms
across ate-idp/litellm/postgres/langfuse whenever golden builds retry.
**Measurements:** pod working set ≈ 9.5 GiB of 11.9 GiB; Committed_AS 26 GB
(overcommit, harmless until touched); Docker reports no hard mem/cpu limit on the
kind container (can grow into host's 16 GB); buff/cache reclaimable.
**Actions taken:** dropped page cache (`echo 3 > /proc/sys/vm/drop_caches`,
available 2.7→3.4 GiB); deleted stuck one-shot job pod `rustfs-langfuse-bucket`
(bucket existed; loop never exited); scaled idle tenant workerpools to 0;
identified the controller's ~80/sec `GetActorTemplate` poll storm as the main CPU
waste during failing retries.
**Durable fixes to consider:** raise Docker Desktop memory allocation; give
workerpools explicit `spec.template.resources`; stop failed-build retries by
fixing T-08; add resource requests to langfuse/flexprice frontend (736 MB RSS for
a static frontend is heavy).

## T-09 (rejected approach) Google GCS as the snapshot store

User asked about "google gsc for storage" → clarified **no AWS/GCP account exists**.
GCS would require workload identity federation wired into Substrate's snapshot
plugin — out of scope for a fully local prototype. RustFS (S3-compatible, in-cluster)
stays the object store. No cloud credentials are needed anywhere in this stack.

## T-10 Shell SigV4 against RustFS fails with SignatureDoesNotMatch

**Symptom:** openssl-based HMAC SigV4 PUT/GET to RustFS → 403 SignatureDoesNotMatch,
while aws-cli with the same creds works.
**Cause:** busybox `printf` does not interpret `\n` inside variables; canonical
request strings silently contained literal backslash-n.
**Lesson:** do signing in Python (stdlib hmac/hashlib), not shell.
**Also:** rustfs/rustfs:1.0.3 image has no sh-visible tooling for this (musl, no
openssl CLI); sidecar pattern = alpine + `apk add python3` mounted next to rustfs.
Note the pod IP changes on every rollout — use `127.0.0.1:9000` from a co-located
sidecar.

## T-11 kubectl cp / exec stdin hangs on this cluster

`kubectl cp` to the alpine sidecar timed out twice; `exec ... < file` wrote 0 bytes.
**Workaround that works:** base64 the file into the command string
(`echo <b64> | base64 -d > /tmp/x`), or patch it into a Deployment arg via python.

---

## T-13 kubectl exec fails on distroless images (ateapi / atelet / credential-provider / agentgateway)

**Symptom:** `exec: "sh"/"ls": executable file not found` — the substrate control
plane and agentgateway ship distroless, so no shell exists for debugging.
**Workarounds that work:** read state via `kubectl logs`; query postgres `atepg`
(schema `substrate`, entities are protobuf `proto bytea` — export with
`encode(proto,'base64')` + Python string extraction); inspect node-level state via
`docker exec flexprice-local-control-plane` under `/var/lib/ate/{actors,workers,snapshots}`;
mount an alpine sidecar (runAsUser:0 + apk) when in-pod tooling is unavoidable.

## T-14 Grafana Beyla install via helm (eBPF tracing, for the T-08 3s-stall question)

**Goal:** instrument actor→controller / egress RPC latency with eBPF to prove
where the ~3 s bootstrap stall sits (user-requested install).
**Install:** `helm repo add grafana https://grafana.github.io/helm-charts`;
`helm install beyla grafana/beyla --version 1.16.19 -n monitoring --create-namespace -f /tmp/beyla-values.yaml`
(app v3.42.0). Pod runs privileged DaemonSet on the kind node; image pull ~28 s.

**Issues hit during install (all in order):**
1. **Wrong values key:** chart renders its ConfigMap from `config.data`, NOT
   `config`; setting `config.otel_traces_export` produced a default config with
   no OTLP exports, and `--reuse-values` then froze the wrong render. Fix:
   values file under `config.data:` (discovery, attributes, otel_traces_export
   → collector :4317, otel_metrics_export → collector :4318) and upgrade without
   `--reuse-values`.
2. **No cluster name:** `can't fetch Kubernetes Cluster Name` warning → set env
   `OTEL_EBPF_KUBE_CLUSTER_NAME=flexprice-local` (also
   `attributes.kubernetes.cluster_name` in config).
3. **Distroless:** like the substrate images, beyla has no shell — verify via
   logs and HTTP scrape from a probe pod, not `kubectl exec`.
4. **Procfs:** host processes need `/proc` visible; chart default doesn't mount
   it. Patched DaemonSet: hostPath `/proc` → `/host/proc` +
   `BEYLA_PROCFS_MOUNT_PATH=/host/proc`, plus `/sys/kernel/debug` mount. Debug
   logs then showed the full pipeline working: 450+ processes watched, k8s pod
   enrichment, Go binaries detected (`detected type … type=go`, moduledata found,
   instrumentation points resolved, uprobes attached as uprobe_multi links).
5. **RESOLVED: /metrics was empty because Beyla was OOM-killed.** dmesg shows
   `Memory cgroup out of memory: Killed process (beyla)` — the 512Mi limit was
   too small while watching 450+ processes (uprobe attach churn), which also
   explains the repeated `beyla-xxxxx` pod replacements in `kubectl events`.
   Fix: limits 1Gi / requests 512Mi. Re-verify /metrics under traffic.

### Event-log findings (2026-11-21 09:35 UTC review)

- A **cluster-wide starvation burst ~09:15** hit every readiness/liveness probe
  simultaneously (clickhouse `/ping` timeout, `pg_isready` timeout, even
  `ls /` timed out after 1s, fleet-bff/oauth2-proxy/litellm/atelet all failing
  probes at once). Uniform `context deadline exceeded` across unrelated static
  services = node CPU/IO saturation window, not per-service bugs — coincided
  with the repeated atenet-egress/ate-api-server restarts + scrape pods +
  beyla eBPF attach. Golden-build attempts landing inside such a window will
  fail the 3 s bootstrap deadline for that reason alone.
- **ate-idp-server** has flapped readiness/liveness repeatedly (6 restarts,
  worst during that window). It mints actor identity JWTs — keep it warm before
  judging build results.
- Worker-pod events show the expected cold-start pattern: `:8080/readyz`
  refused → 503 → Ready within ~30–60 s of pod creation. Not a fault.
- Current dormant state to correct before the next test: org-demo pool = 0
  (its agent cannot even attempt a build), org-prod pool = 1 with worker up.

**Useful commands:**
```bash
helm -n monitoring get values beyla
kubectl -n monitoring get cm beyla -o jsonpath='{.data.beyla-config\.yml}'
kubectl -n monitoring logs ds/beyla --since=2m | grep -iE 'attach|detected type|Configuring exporter'
# scrape (beyla pod IP on kind docker net; from in-cluster probe pod):
kubectl run beyla-scrape --rm -i --restart=Never --image=alpine:3.20 --command -- \
  sh -c 'apk add --no-cache curl >/dev/null 2>&1; curl -s http://<podIP>:9090/metrics | head'
```

## T-15 Fresh rebuild via `scripts/setup-env.sh` — defects found & baked into the step scripts (2026-11-21)

Run of the new setup suite on a destroyed-and-recreated cluster. Each defect's
fix is IN the step script (no manual remedy needed going forward); this is the
trail of why each line exists.

1. **s06 substrate: image pull 404 `podcertcontroller:1.0.1`.** The installer
   (`flexprice/docs/install-substrate-local.sh`) interpolates git refs as
   `v$VERSION` (so callers must pass the BARE `VERSION=1.0.1`) but passed that
   same bare value to `--image-tag`, while ghcr tags carry the `v`. Fixed the
   installer: `--image-tag "${IMAGE_TAG:-v${VERSION#v}}"` — one VERSION spelling,
   overridable. Also pre-installs `substrate-crds --version 1.0.1` in s06
   because the installer's chart refs are unpinned (latest-skew risk).
2. **s03 litellm: prisma `P1003 Database 'litellm' does not exist` CrashLoop.**
   On the original cluster the `litellm` database had been created ad-hoc; the
   fresh flexprice chart does not create it. s03 now `CREATE DATABASE litellm`
   on `sts/flexprice-postgres` (idempotent check via `pg_database`) and deletes
   the stale `litellm-migrations` job when it creates the DB.
3. **llm-mock stuck `ContainerCreating` — `FailedMount … configmap
   "llm-mock-srv" not found`.** `deploy/litellm/llm-mock.yaml` mounts the mock
   server code from a ConfigMap that was likewise created ad-hoc originally.
   s03 now builds `llm-mock-srv` from `deploy/litellm/llm-mock-server.py`
   (`--dry-run=client -o yaml | apply`).
4. **`helm upgrade --wait` keeps failing `Progress deadline exceeded` after the
   root cause is fixed.** The Deployment's `Progressing=False` condition sticks
   from the crash-loop generation; re-running the upgrade with an unchanged
   template never resets the clock. Remedy: `kubectl -n litellm delete deploy
   litellm` (helm owns it, re-run recreates) then re-run the step.
5. **s03 silently lost `OPENROUTER_API_KEY`.** The step reads it from the env
   but nobody exported it; s03 now sources `fleet-local/.env` (gitignored) when
   present, matching where prereqs recovery stashed the key.
6. **Cold-pull timeouts:** first-time big images (prometheus/otel/jaeger, and
   every substrate image incl. the 400 MB agentgateway) blow past the fixed
   60 s ready-wait inside `ate-setup deploy` and the 180 s script waits.
   Symptom: identical `Error: waiting for deployment/ate-api-server … 0/2
   replicas available (took 60.001s)` on each rerun while pods are actually
   still `Pulling`. Remedy: let the pulls finish once (pods converge on their
   own), then rerun — the step scripts are idempotent. Rollout waits in s05
   raised to 600 s / helm `--timeout 10–15m`.
7. **substrate parent chart install refused (import collisions):** `unable to
   continue with install: NetworkPolicy "default-deny-ingress" … exists and
   cannot be imported into the current release` — the ate-setup bootstrap
   kubectl-applies most chart objects WITHOUT Helm ownership metadata
   (NetworkPolicies, ResourceQuota, Roles/RoleBindings, Services, … — 25+
   objects, so per-kind fixes are whack-a-mole and an adopt-and-retry loop
   just crawls). Final fix in `flexprice/docs/install-substrate-local.sh`
   step 5: `helm upgrade --install … --take-ownership` (helm >= 3.17/4.x —
   this repo has v4.3.0). That surfaced the next collision: the completed
   bootstrap Job `rustfs-bucket-init` — `Job.spec.template is immutable`,
   adoption can't fix Jobs, so step 5 now deletes completed Jobs in
   ate-system first (the chart recreates them; bucket-init is idempotent).
   Placement matters: the failing helm is the INSTALLER's own step-5 install
   — an adoption loop placed in s06 (first attempt) never executes because
   `set -e` aborts inside the installer. s06's overlay upgrade carries
   `--take-ownership` too for the same reason on odd re-runs.

8. **kagent controller stuck `ContainerCreating` — FailedMount `secret
   "kagent-postgres-readwrite" not found` (+ `-owner`):** the kagent chart
   mounts two DSN Secrets by name but ships no bootstrap for them, and the
   bundled substrate postgres accepts **podcert client certificates only**
   (setup.sql creates the `*_user` logins password-less). On the original
   cluster these were created ad-hoc. s07 now does it the documented way
   (docs/SUBSTRATE_KAGENT_LOCAL.md §1b): run substrate's **parameterized**
   `pkg/postgressetup/setup.sql` a second time against `atepg` with
   `kagent_schema=kagent / kagent_owner / kagent_owner_user / kagent_readwrite
   / kagent_readwrite_user` (the ALTER DEFAULT PRIVILEGES half is what stops
   the 42501-on-own-tables failure), then create
   `kagent-postgres-{readwrite,owner}` with the same podcert DSN shape the
   substrate installer uses. Requires `database.postgres.clientCertificate:
   true` in values-base (flipped — projects
   `/run/postgres.podcert.ate.dev/kagent_*.pem` into the controller, which the
   DSNs reference).
   **Meta-defect found later:** the first version of that block ran
   `kubectl exec` without `-i`, so the `< setup.sql` stdin never reached psql —
   psql hit instant EOF and exited 0, and the step "succeeded" without
   creating anything. The failure only surfaced two layers down (item 12's
   hba fix finally let the FATAL be about the missing role). s07 now uses
   `exec -i` and guards on `pg_roles` instead of the secrets, so an empty
   bootstrap can never pass the check again.

9. **kagent controller `database.readWrite: parse database connection source:
   invalid PostgreSQL connection string`.** pgx (v5) opens `sslrootcert`,
   `sslcert` and `sslkey` **at parse time**, so a wrong file path surfaces as a
   *parse* error, never a connection error. The first s07 DSN copied the
   substrate installer's shape verbatim (`sslrootcert=/run/servicedns.podcert.
   ate.dev/trust-bundle.pem`) — that mount exists on the GKE layout (see
   `~/git/local-symphony/modules/kagent-platform/locals.tf:63-66`), but the
   kagent chart projects exactly ONE volume (`kagent_*.pem` +
   `trust-bundle.pem`) at `/run/postgres.podcert.ate.dev`. s07's DSN now uses
   that path. Verified with a throwaway `pgxpool.ParseConfig` binary before
   applying.

10. **Signer denial is permanent per request:** after patching the
    `--postgres-client` allowlist (s07), already-created
    PodCertificateRequests stay `Denied` and the deployment keeps its
    `ProgressDeadlineExceeded` condition — pods must be restarted to re-issue.
    s07 does both re-asserts (allowlist + rollout restart) on every run
    because step 6's `ate-setup` bootstrap re-applies the signer deployment
    outside Helm.

11. **`dial error: timeout: context deadline exceeded` to
    `postgres.ate-system.svc:5432` (NOT a slow migration):** ate-system is
    default-deny and the substrate-owned NetworkPolicy `postgres` admits
    :5432 only from `app=ate-api-server`. Fixed with a SEPARATE additive
    policy `deploy/networkpolicy/postgres-kagent.yaml` (NetworkPolicies union;
    patching the chart's policy would be silently reverted by a substrate
    rerun). s07 applies it before the helm install.

12. **`FATAL: no pg_hba.conf entry for host …, user "kagent_owner_user"
    (SQLSTATE 28000)`** — TLS completed, auth was refused: `ate-setup` bakes
    pg_hba from a static manifest listing only `substrate_*_user`. s07 appends
    `hostssl atepg kagent_owner_user,kagent_readwrite_user all cert` to the
    `postgres-config` ConfigMap and re-asserts it every run (same revert-on-
    step-6 class as item 10). No postgres restart needed — the pod's
    tls-reloader sidecar hashes `pg_hba.conf` every 60 s and SIGHUPs on
    change, so s07 sleeps 75 s after patching.

13. **`run database migrations: core migrations: context canceled` on first
    start.** The chart's default startup probe gives the controller ~60 s
    (15 s delay + 3×15 s); the initial migration against an empty schema
    exceeds it and kubelet SIGTERMs mid-flight — which also masked items 11-12
    (each kill restarted the dial from scratch). `values-base.yaml` now sets
    `controller.startupProbe` with `failureThreshold: 40` (≈10 min). A healthy
    boot still becomes Ready in the first probes.

14. **`substrate: dial ate-api "dns:///api.ate-system.svc:443": context
    deadline exceeded` after migrations succeeded:** the `ate-api-server`
    NetworkPolicy admits :443 only from namespaces labeled
    `ate.dev/api-access: "true"` (gate §1a — applied to org namespaces by the
    BFF; the `kagent` namespace itself needs it too, for the controller's
    substrate client). s07 now `kubectl label ns kagent ate.dev/api-access=true
    --overwrite` before the helm install.

15. **`RemoteMCPServer kagent-api` endless `Unauthorized` reconciler errors,
    `Accepted=False` forever:** the chart registers the controller's OWN
    `/mcp` endpoint for tool discovery, but under `trusted-proxy` auth the
    controller has no caller token to present to itself. Upstream's intended
    opt-out (`go/core/pkg/consts/labels.go`) is the label
    `kagent.dev/discovery=disabled` — the server goes `Accepted=True
    (DiscoveryDisabled)` and agents resolve its tools at runtime with their
    own credentials. s07 applies the label after every helm run (the chart
    re-renders the CR without it).

16. **ClickHouse Code 516 `AUTHENTICATION_FAILED` from 00-prereqs/20-langfuse
    (`--user default`):** the flexprice CH config only accepts the IMPLICIT
    default user over localhost (no `--user` flag — it has access_management);
    an explicit `--user default` consults users.d where a password IS set, and
    `flexprice-secrets/clickhouse-password` belongs to the `flexprice` user,
    not `default`. Both scripts now call bare `clickhouse-client`. The four
    admin calls in 20-langfuse also lost their `|| true` — they were what let
    this fail silently on every run until Langfuse itself complained.
17. **`rustfs-langfuse-bucket` Job hangs with zero logs:** the substrate-
    owned `rustfs` NetworkPolicy admits job pods only by
    `job-name=rustfs-bucket-init`, so 00-prereqs' own bucket Job was
    packet-dropped inside its silent aws-cli retry loop. 00-prereqs now labels
    the pod template `fleet.local/rustfs-bucket-init=true` and applies the
    additive `rustfs-langfuse.yaml` policy (extended with that label rule)
    BEFORE creating the Job. Same script also derives
    `ate-system/kagent-rustfs-credentials` if absent — on a fresh cluster s05
    runs before step 6 created rustfs, so the s05 derivation alone left step
    8's Job without the Secret (ordering cycle; fail-fast message added).
18. **LiteLLM proxy crash-looped after the langfuse patch: `FLEXPRICE_API_URL
    and FLEXPRICE_API_KEY are required`:** helm merges maps but REPLACES
    lists — `values-patch.yaml` set `environmentSecrets:
    [litellm-langfuse-keys]`, wiping values-base's `[litellm-fleet-secrets]`.
    The patch now repeats BOTH secrets; keep it in sync with values-base when
    adding env sources.
19. **`helm status | head -N` aborts scripts with rc=141 (SIGPIPE):** helm's
    NOTES block is bigger than head's window, head exits, helm dies on EPIPE,
    `set -o pipefail` propagates 141 and the caller (s05b) never reaches the
    next script. Fixed in 20-langfuse/30-litellm/40-kagent-fix by switching to
    `sed -n '1,Np'` (reads the stream to EOF). Symptom is deceptively
    "everything printed looks fine, step failed".

20. **Both oauth2-proxy deployments crash-looped: `cookie_secret must be 16,
    24, or 32 bytes … but is 44`:** 00-prereqs stored
    `openssl rand 32 | base64` — oauth2-proxy uses the value VERBATIM (44
    chars), it does not base64-decode env/flag secrets. Generation switched to
    `openssl rand -hex 16` (32 chars) and the exists-branch now measures the
    stored length and re-keys anything that is not 16/24/32 (self-heal on
    rerun; costs one logout).
21. **fleet-bff crash-looped `missing required env FLEXPRICE_API_KEY` and
    seed-flexprice died on `jq: Invalid numeric literal` (nginx 404 HTML):**
    two fresh-vs-old cluster shape mismatches — (a) the litellm chart carries
    FLEXPRICE_* via `environmentSecrets` (secret `litellm-fleet-secrets`), NOT
    as Deployment env literals, so 50-bff-spa and seed-flexprice fetched empty
    strings from `deploy … .env[?]` — both now read the Secret first with the
    env-literal path as fallback, plus fail-fast and a self-heal patch for an
    already-empty fleet-bff-env; (b) `api.flexprice.local` had NO Ingress at
    all (old cluster ad-hoc, never scripted): new
    `deploy/ingress/flexprice-api.yaml`, applied by s02. The flexprice.local
    UI host is deliberately NOT recreated — the pinned chart ships no
    frontend (only temporal-frontend refs); the fleet SPA is the UI.
22. **verify-e2e false FAIL `app ingress missing sanitize snippet`:** the
    check greps lowercase `x-auth-request-email` but app.yaml writes
    `X-Auth-Request-Email` — grep -qi fixed it (the strip was always live).
23. **Wizard step 2c 404 `Plan with ID plan_01M7T6... was not found`:**
    `deploy/bff/configmap.yaml` carried the OLD cluster's Flexprice plan ID as
    a literal — every fresh Flexprice database mints a new one, and the BFF
    reads `FLEXPRICE_PLAN_ID` only at boot. Now `seed-flexprice.sh` publishes
    the seeded plan ID into `fleet-bff-config` and restarts fleet-bff when it
    differs (configmap literal marked PLACEHOLDER). Recovery on an existing
    env: `bash scripts/seed-flexprice.sh` — it prints the republish line.
24. **Wizard step 2c 400 `No prices match the subscription criteria`:** the
    BFF creates wallet/top-up/subscription in **INR** (`flexprice.ts`), but a
    fresh seed only attaches USD prices to the plan — Flexprice matches
    subscription currency+billing_period against published plan prices. The old
    cluster had a manual `scripts/fixes/t06-flexprice-inr.sh` patch; the seed
    now creates `LLM Passthrough Cost (INR)` (USAGE/FLAT_FEE on the
    `LLM Passthrough Cost (untagged)` meter — mind the exact name, a wrong
    meter_id returns `null` id, now fail-fast) so INR/MONTHLY subscriptions
    validate. Recovery: re-run `scripts/seed-flexprice.sh`.
25. **Chat fails; LiteLLM 500 `OpenAIException - Connection error` /
    `socket.gaierror` for model `mock-gpt`:** `deploy/litellm/llm-mock.yaml`
    shipped only the Deployment — the old cluster's bare pod had a Service
    created ad hoc, so `api_base http://llm-mock:8000/v1` did not resolve on
    a fresh build. The manifest now includes the `llm-mock` Service (s03
    applies the whole file). Recovery: `kubectl -n litellm apply -f
    deploy/litellm/llm-mock.yaml`. Note the actor itself was healthy — the
    run checkpointed normally; the error surfaced as empty/failed chat output.
26. **LiteLLM → OpenRouter 500 `Forbidden control character detected in
    headers. Potential header injection attack`:** the Secret's
    `OPENROUTER_API_KEY` had been patched in via an `echo` pipe, so the stored
    value ended with `\n\n`. LiteLLM builds `Authorization: Bearer <key>\n`
    and aiohttp (the openrouter transport) rejects any header control
    character — the key itself was valid (direct curl worked). `s03-litellm.sh`
    now sanitizes `OPENROUTER_API_KEY` after loading `.env` (`tr -d ' \t\r\n'`)
    and its exists-branch re-keys a stored value containing whitespace/control
    chars + restarts litellm. Recovery: `bash scripts/setup/s03-litellm.sh`.
    When piping keys into `base64`/`--from-literal`, always `printf %s`.

27. **P6 live-tenant upgrade (`scripts/fixes/t26-tenant-model-catalog.sh`) — three API/shell traps.**
    (a) LiteLLM 1.109.1 `GET /key/list` returns **hashed-token strings**, not key objects, even with
    `?info=true`; `GET /key/info` (no id) errors. There is no alias→key_id enumeration path on this
    build. Fix: address the tenant key by its **plaintext value** (read inline from the org Secret
    `litellm-<slug>-<projSlug>` field `key`, piped via stdin) and `POST /key/update {key:<token>}`.
    (b) `kubectl --context X -n ns deploy/foo exec …` → "flags cannot be placed before plugin name".
    `exec` must come **before** the target: `kubectl -n ns exec deploy/foo -- cmd`.
    (c) A `kubectl exec -i` **without an stdin redirect inside a `while read` loop swallows the loop's
    remaining lines** (only the first org was processed, exit 0, no error). Any interactive/exec call in
    a read-loop needs `</dev/null` unless its stdin is deliberate. Recovery: re-run the script (idempotent).

28. **P7 claude harness — three kagent contract rules that look like they'd help but bite.**
    (a) The `claude` harness **reserves every `ANTHROPIC_*` env var** (base URL, token, model, and the
    Claude-Code-owned telemetry/credential vars): putting `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/
    `ANTHROPIC_MODEL` in `Harness.spec.env` marks EVERY Agent on that Harness `Compatible=False`
    ("conflicts with Claude-owned runtime configuration"). The adapter writes those vars itself — the
    model/base URL come from an **Anthropic-provider ModelConfig** (`anthropic.baseUrl`, no `/v1`
    suffix — the SDK appends `/v1/messages`), and the key NEVER touches the CR: the egress gateway
    binds `ModelConfig.apiKeySecret` to the destination hostname and injects `x-api-key` per request
    (rotation = update the Secret). (b) `workload.image` **rejects tags** — pin the manifest-list
    digest (`docker buildx imagetools inspect <image>:<tag>` first line; CRD pattern
    `^[^@]+@sha256:[a-f0-9]{64}$`). (c) claude/codex harnesses **reject a ModelConfig that sets
    `defaultHeaders`/`tls`/`tokenPassthrough`** — the static `x-fleet-*` attribution headers cannot
    ride on claude turns; cost rows attribute via the tenant key (org/team) + traceparent, and
    `raw_user` may be empty because the claude runtime doesn't add identity baggage. Chart guards
    (a)+(b) in `_helpers.tpl`; `modelconfig.yaml` renders the `anthropic:` block and drops
    `defaultHeaders` for Anthropic providers; `t26-tenant-model-catalog.sh` is runtime-aware
    (`ORG_FILTER=<slug>` to do one tenant first).

29. **P7 headless verification (`scripts/fixes/t28-claude-harness-probe.sh`) — the A2A wire shape.**
    A first probe written from intuition used `/a2a/{ns}/{name}` + `method:"message/stream"` +
    `role:"role_user"` — all wrong, and the failure was a silent non-SSE 404. The real contract
    (canonical in `apps/control-plane/src/kagent/a2a.ts`): `POST {controller}/agents/{ns}/{name}`
    with the **PascalCase** JSON-RPC methods (`SendStreamingMessage`), the mandatory
    `A2A-Version: 1.0` header, `Accept: text/event-stream`, and message
    `{messageId, role:"ROLE_USER", parts:[{text}]}`. Streaming events carry the payload under
    `result.task` / `result.statusUpdate` / `result.artifactUpdate` (artifact text appears both on
    the incremental `artifactUpdate` and the final task — hence a duplicated reply is normal).
    Auth: port-forward svc/kagent-controller 18083:8083 and send a **self-signed** JWT
    (`iss=https://accounts.google.com`, `email=<user>`) — trusted-proxy mode skips signature
    verification by design; the :8083 NetworkPolicy is the control. Evidence the whole chain ran:
    reply text `P7-CLAUDE-HARNESS-OK`, terminal `TASK_STATE_COMPLETED`, and a
    `POST /v1/messages … 200` line in `kubectl -n litellm logs deploy/litellm`.

30. **P8 codex harness — same pattern, different contract.**
    The `codex` harness block is empty and its ModelConfig stays on the **OpenAI** provider but MUST
    set `openAI.apiFormat: responses` (LiteLLM serves `/v1/responses` and bridges to OpenRouter) —
    no other `openAI` key beyond `baseUrl`. Like claude it **rejects `defaultHeaders`/`tls`/
    `tokenPassthrough`**, so attribution rides on the tenant key. Reserved env (sets → every Agent
    `Compatible=False`, "conflicts with Codex's compiled configuration"): `CODEX_HOME`,
    `OPENAI_API_KEY`, `AWS_*` — the adapter compiles them from the ModelConfig + egress injection.
    `workload.image` may be **omitted**: kagent 1.0.0 ships a digest-pinned codex-harness default
    (`kubectl -n kagent get cm kagent-controller -o yaml | grep codex` to read it; the Agent echoes
    the resolved image on `status.workloadImage`). Because both harness types share the OTEL trio and
    the wire evidence differs, the t28 probe now takes `EXPECT=<token> WIRE=<messages|responses>`:
    `EXPECT=P8-CODEX-HARNESS-OK WIRE=responses scripts/fixes/t28-claude-harness-probe.sh
    test-agent-nemotron-codex-worker`.

## T-16 P9 agent internet access — webfetch MCP (no built-in web tool in kagent 1.0)

The chat run `https://www.archagentix.com/ summarise what's it says` failed on the
openai/kagent agent: there is **no web tool at all** in the fleet — the kagent 1.0
chart ships no websearch component and the kagent-tools MCP only has k8s/cluster
tools. Fix = one shared fetch MCP the agents call as a tool. `scripts/fixes/t29-agent-web-access.sh`
builds/deploys/binds/probes the whole chain; the notes below are why each piece is shaped like it is.

1. **Transport: streamable-HTTP, not SSE.** The binding must work on ALL THREE
   harnesses. kagent speaks both; the claude and codex adapters only mount MCP
   servers over **streamable-HTTP** (SSE is rejected), so the server is
   `mcp-server-fetch` (stdio, the reference Python fetch tool) fronted by
   `supergateway --outputTransport streamableHttp --port 8087` — one process, no
   custom tool code. **supergateway must be v4** — v2's CLI has no
   streamable-HTTP output (`--outputTransport` choices are stdio|sse|ws; a bogus
   `--outputChannel` flag is silently ignored) so the pod serves SSE and every
   agent POST to `/mcp` gets Express `Cannot POST /mcp`. v4:
   `--outputTransport streamableHttp` (path defaults to `/mcp`).
2. **One shared Deployment, one CR per tenant.** `deploy/webfetch/webfetch.yaml`
   runs `webfetch` in ns `kagent` (the fetch tool is stateless; per-org
   deployments would buy nothing). The tenant chart renders a
   `RemoteMCPServer` CR `<slug>-mcp-webfetch` in the TENANT namespace pointing at
   `http://webfetch.kagent.svc.cluster.local:8087/mcp` — `allowedNamespaces`
   defaults to Same, so a same-namespace server is what the AgentTemplate can
   actually reference. Chart sugar: `values.mcp[]` (servers) +
   `templates[].mcp[]` (names to bind); `_helpers.tpl` fails the render on an
   unknown name or a missing url. The CRD's required list is
   `[description, url]` — a first cut that only set `url` made the whole helm
   upgrade fail server-side-apply (`spec.description: Required value`), so the
   chart always emits a description (value or `"<name> MCP server"` default).
3. **SSRF is the whole security story.** `fetch_url` is model-driven — the LLM
   picks the URL — so the webfetch pod carries a NetworkPolicy that allows egress
   ONLY to the public internet (TCP 80/443 `0.0.0.0/0` **except**
   10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16) plus DNS 53.
   Without the policy, a prompt-injected agent could exfil via
   `fetch_url http://litellm…/key/info` or the k8s API. t29 step 3 proves the
   posture at the socket layer (internal svc + metadata IP must be unreachable,
   public 443 must be reachable) before anything touches the agents.
4. **Actor → MCP reachability.** The actor talks to the in-cluster Service IP,
   which is inside the substrate egress path. This works as-is on the local
   atenet setup because egress permits pod-network destinations; if a future
   stack drops it, the symptom is the tool call hanging and the remedy is an
   explicit `EgressPolicy` allowing `webfetch.kagent.svc` (kagent compiles
   `EgressPoliciesApplied` on the Agent — check that condition first).
5. **Probe = fetch + token, per harness.** t28 gained `PROMPT=<text>` so the
   same headless A2A wake proves tool execution, not just the ModelConfig path:
   `PROMPT="Use your web fetch tool to open https://www.archagentix.com/ … reply
   with exactly: P9-WEBFETCH-OK" EXPECT=P9-WEBFETCH-OK
   scripts/fixes/t28-claude-harness-probe.sh <agent>` for
   `test-agent-nemotron-worker` (kagent), `-claude-worker`, and
   `WIRE=responses … -codex-worker`. If the reply lacks the token, check
   `kubectl -n kagent logs deploy/webfetch` — a fetch reached the server but the
   model ignored the tool means prompt/harness binding; no log line means the
   CR binding or egress (items 2/4). Two handshake details the direct probe must
   tolerate: supergateway streamableHttp is **stateless by default** (a valid
   `initialize` returns 200 with the result and **no** `mcp-session-id` header —
   do not require it), and the fetch tool's `tools/list` name is
   version-dependent (`fetch` vs `fetch_url`) — match it by regex.
6. **Dockerfile base: `python:3.12-bookworm` + NodeSource, never the slim
   default.** `python:*-slim` moved to trixie, whose apt `nodejs`/`npm` pull
   ~300 node-* debs and npm's own installer rejects the jest-debundundle shim
   ("This is not the npm installer"). NodeSource `setup_22.x` on bookworm is
   the supported path. Also note `imagePullPolicy: Never` + a mutable local tag
   means `kubectl apply` alone will NOT pick up a rebuilt image — t29 does a
   `rollout restart` after apply. The same trap bit `50-bff-spa.sh`: an unchanged
   `deployment.yaml` means `apply` rolls nothing, so a rebuilt `fleet-bff:local`
   (with new chart templates under `deploy/charts`) kept serving from the OLD
   pod — helm upgrades run IN that pod and silently used the pre-P9 chart, so no
   RemoteMCPServer rendered. The script now does `rollout restart` + wait.
7. **`kubectl exec` + heredoc needs `-i`, and `node -e` args start at
   `argv[1]`.** The SSRF socket probe (`python3 - <<'PY'`) silently ran on empty
   stdin without `-i` (exit 0, no output — looked like a pass), and with
   `node -e` there is no script path in argv, so `slice(2)` shifted the MCP URL
   into the wrong variable and the probe POSTed `initialize` to the public site.
   Both fixed in t29; the symptom of the second is `no mcp-session-id 404`
   followed by the target site's HTML. Same family: a **single quote inside the
   single-quoted `node -e '...'`** closes the shell string mid-script (surfaces
   as a JS `ReferenceError` over bash word salad) — use double quotes or a
   regex literal in inline scripts.

## T-17 Self-hosted Flexprice dashboard UI + Temporal UI (flexprice.local)

`scripts/fixes/t30-selfhost-uis.sh` + `deploy/uis/uis.yaml`. What bit us, in order:

1. **The backend chart ships no frontend.** `flexprice-pinned-*` (v2.1.48) has no
   UI directory — the dashboard is the separate repo `flexprice/flexprice-front`
   (we pin tag `v2.0.22`, released after the backend commit). Clone is done by
   t30 into `/Users/niravshah/git/flexprice-front-pinned-<tag>`.
2. **`VITE_API_URL` is a BUILD arg, not a container env.** Vite inlines
   `import.meta.env.*` at compile time (`src/config/config.ts:312`), so the image
   must be built with `--build-arg VITE_API_URL=http://api.flexprice.local/v1`
   (note the `/v1` suffix — the default includes it; the api ingress serves the
   raw backend). Changing the URL later means rebuilding the image.
3. **Upstream's own Dockerfile ends with `npm run start`** — that is the vite DEV
   server, not the built app. Our `deploy/uis/flexprice-ui/Dockerfile` builds
   `dist/` and serves it with plain nginx (SPA `try_files ... /index.html`
   fallback, port 80).
4. **Dashboard login cannot work against the seeded DB as-is.** The migration
   job seeds `auths.token = 'sk_local_flexprice_test_key'` (plaintext), but
   `flexpriceAuth.Login` does `bcrypt.CompareHashAndPassword` — 403
   "Invalid email or password" forever, and `/v1/auth/signup` refuses because
   the user row exists. Fix (t30 step 4): overwrite the hash with pgcrypto —
   `UPDATE auths SET token = crypt(:'PW', gen_salt('bf',8)) WHERE
   provider='flexprice' AND user_id='0000…0000'` — password generated once into
   gitignored `fleet-local/.env` as `FLEXPRICE_UI_PASSWORD` and reused on
   re-runs. Email is `admin@flexprice.dev`. Again: `kubectl exec` + heredoc
   needs `-i` or psql sees empty stdin and exits 0 (silent no-op, T-16.7).
5. **CORS is not an obstacle**: `internal/rest/middleware/cors.go` sets
   `Access-Control-Allow-Origin: *` (upstream TODO), so
   `flexprice.local → api.flexprice.local` works with no backend config. The UI
   picks the environment per request via `X-Environment-ID` (Sandbox/Production
   seeded by s02) — no extra setup.
6. **Temporal UI**: no web component ships with `temporalio/auto-setup:1.26.2`;
   we run standalone `temporalio/ui:2.31.2` (era-matched tag, arm64 exists —
   verify with `docker manifest inspect` before pinning on this arm host) with
   `TEMPORAL_ADDRESS=flexprice-temporal-frontend.flexprice.svc.cluster.local:7233`.
   The UI proxies gRPC server-side, so only port 8080 (HTTP) needs ingress.
   Namespace `default` is the one s02 registers. **`enableServiceLinks: false`
   is mandatory on the pod**: a Service named `temporal-ui` makes kubelet inject
   `TEMPORAL_UI_PORT=tcp://<clusterip>:8080` into every pod in the namespace,
   and the UI reads `TEMPORAL_UI_PORT` as its own int port — crashloop with
   `config file corrupted: cannot unmarshal !!str 'tcp://1…' into int` (the
   "config file" framing is a red herring; it is env contamination).
7. **Host wiring**: kind maps host `:80/:443` to ingress-nginx, and
   `00-prereqs.sh` now appends
   `127.0.0.1 flexprice.local api.flexprice.local temporal.flexprice.local` to
   `/etc/hosts`, so no `kubectl port-forward` is needed for either UI.
   Rebuild trap as always: mutable `fleet-flexprice-ui:local` tag +
   `imagePullPolicy: Never` → `kind load` then `rollout restart` (t30 does both).
8. **The seeded admin has no roles, so the dashboard 403s on every write.**
   First login lands on the "Welcome to Flexprice — Just three quick questions"
   onboarding wizard, and submitting it fails with
   `{"message":"insufficient permissions"}` (403). Cause: the s02 migration seed
   inserts `users.roles = NULL`, and a dashboard JWT carries **no roles claim** —
   `internal/rest/middleware/auth.go` re-reads the user row on every request and
   passes `user.Roles` into the context, so the RBAC middleware denies with
   `access denied: caller has no roles assigned` / `"roles":[]` in the api log.
   Fix (t30 step 5): `UPDATE users SET roles='["super_admin"]'::jsonb WHERE
   id='0000…0000'` (`super_admin` is `internal/types/rbac.go:14`).
   **Do not also set `type='owner'`** — that was my first attempt and it trades
   a 403 for a 400: `users.type` is a `UserType` enum of `user` /
   `service_account` only (`internal/types/user.go:9-16`), and the dashboard
   passes `user.type` into `GET /v1/rbac/roles?user_type=...`, which answers
   `validation_error: User type must be 'user' or 'service_account'`. Owner-ship
   in a self-hosted tenant is expressed by the role, not the type.
9. **…and the roles UPDATE appears to do nothing until you flush Redis.**
   The user repository caches `GetByID` under `flexprice:local:<tenant>:<env>:
   user:v1:<user_id>` (`internal/cache` `PrefixUser`, TTL
   `ExpiryDefaultRedis`), and a raw `UPDATE` bypasses the repository's
   invalidation — so the API keeps serving the cached `roles:[]` and the PUT
   still 403s even though `psql` returns the new row. Deleting the keys fixes it
   without a restart: `kubectl -n flexprice exec flexprice-redis-0 -- sh -c
   'for k in $(redis-cli --scan --pattern "*user:v1*"); do redis-cli del "$k";
   done'` (t30 step 5 does this; `rollout restart deploy/flexprice-api` is the
   hammer). Tenant reads are cached the same way, but those go through
   `Tenant.Update`, which invalidates — only out-of-band SQL writes need this.
10. **Setting the wizard's answers from the CLI.** The three questions are one
    call: `PUT /v1/tenants/update` with
    `{"name":..., "metadata":{"onboarding_completed":"true",
    "onboarding_referral_source":..., "onboarding_organization_url":...}}`
    (`src/pages/onboarding/useOnboardingTenant.ts` → `TenantApi.updateTenant`;
    the metadata key constant is `TenantMetadataKey.ONBOARDING_COMPLETED` in
    `src/models/Tenant.ts:27`, and `onboarding.tsx`'s `referralSourceOptions`
    are free-form strings stored verbatim — use one of the seven exact option
    values, e.g. `ChatGPT / Perplexity / Gemini`, so the UI echoes it back
    sanely). Send it with the **dashboard JWT plus `X-Environment-ID`** — that is
    the pair the wizard itself uses. An `x-api-key` also passes RBAC (config
    operator keys are granted `super_admin` explicitly; vault keys carry
    `secrets.roles`), but then the actor recorded on the change is the key, not
    the admin user. t30 step 5 seeds `Fleet Local` /
    `http://flexprice.local`, which is why a fresh login skips the wizard. The
    router also honours a localStorage shortcut
    (`flexprice_onboarding_completed_v1`): if the wizard still shows after
    seeding, that stale key is the reason, not the server.

11. **"Authentication is not configured for this deployment." on the login form
    — while `curl /v1/auth/login` returns a token.** The build arg
    `VITE_APP_ENV` was missing, so it defaulted to `APP_ENV.Local`
    (`src/config/config.ts:296`), and `LoginForm.handleLogin` branches on
    `config.app.env !== APP_ENV.SelfHosted`: it then calls
    `supabase.auth.signInWithPassword`, which in a self-hosted deploy is the
    **mock client** in `src/core/services/supbase/config.ts` returning exactly
    that message. The SPA never issues the HTTP call, so the backend log stays
    empty and curl-based checks pass — the failure is invisible outside a
    browser. Fix: build with `--build-arg VITE_APP_ENV=self-hosted` (t30 does
    this; the same flag is what makes `AuthService` read the JWT out of
    `localStorage.token` instead of a Supabase session). Guard against the
    silent version of this trap: the image now ships
    `/usr/share/nginx/html/build-info.json` (`{"apiUrl","appEnv"}`), which t30
    step 2 compares against the intended build args and rebuilds on mismatch —
    because Vite inlines env at BUILD time, a present-but-stale image otherwise
    keeps serving the old choice.
12. **Verifying a login the way a user does.**
    `node scripts/fixes/t30-ui-login-check.mjs admin@flexprice.dev "$(grep
    ^FLEXPRICE_UI_PASSWORD= .env | cut -d= -f2-)"` drives the real form in
    Chromium, asserts the bundle stamp, that `/v1/auth/login` was actually
    called and returned 200, that no toast error is showing, that the URL left
    `/login`, and that `localStorage.token` holds the session. Requires
    `npx playwright install chromium` once. It also sweeps every `/v1` response
    for 4xx/5xx after landing, which is how the `user_type=owner` mistake in
    item 8 was found — a login can pass while the dashboard sits on a broken
    query. This is the check that would have caught items 4 and 11; curl alone
    proves only the backend half.

## T-18 Chat returns an OAuth2-Proxy 502 page exactly 30s after send

**Symptom:** the browser shows the stock `502 Bad Gateway / Secured with
OAuth2 Proxy version v7.14.0` HTML (with a `Request ID`) instead of the chat
stream. Everything else on `app.fleet.dev` — `/api/me`, `/sessions`, `/models`,
the SPA assets — is fine, and the session list refreshes normally seconds later.
**First place to look:** the proxy's OWN access log — the Request ID printed on
that page is the log key, so the failing hop is identified without guessing:
```bash
kubectl -n fleet-system logs deploy/fleet-oauth2-proxy | grep <request-id>
# 172.20.0.1 - 237cf33d… - niravshah2705@gmail.com [15:15:37] app.fleet.dev POST /
#   "/api/orgs/…/projects/…/chat" … 502 2236 30.006
# [error_page.go:91] Error proxying to upstream server: net/http: timeout awaiting response headers
```
**Cause:** oauth2-proxy's `--upstream-timeout` defaults to **30s**, and nothing in
this stack set it. `30.006` latency + "timeout awaiting response headers" is that
timer firing, not the BFF failing. The edge looks tuned — `deploy/ingress/app.yaml`
raises nginx to `proxy-read-timeout: 1800` — but nginx is not the hop that died:
**each proxy on the path enforces its own deadline, and the shortest one wins.**
Chain: browser → ingress-nginx (1800s) → oauth2-proxy (**30s**) → fleet-bff.

**Why only `/chat` breaks:** `apps/control-plane/src/kagent/proxy.ts` awaits
`streamMessage(...)` (line 125) BEFORE `reply.hijack()` + `writeHead(200)` (line
131). `fetch` resolves on upstream RESPONSE HEADERS, so the BFF emits zero bytes
until kagent starts streaming — and a cold actor wake is 30–60s (T-15). The wake
overruns the 30s budget by seconds, so the run usually SUCCEEDS behind a dead
front: the actor finishes waking into a connection nobody is reading.
**Fix:** `--upstream-timeout=1800s` on both proxies
(`deploy/oauth2-proxy/fleet.yaml` + `kagent.yaml`), re-applied by
`scripts/10-ingress-oauth.sh` (the manifests are the only source; `s09` delegates
to that script). The value must stay >= the Ingress `proxy-read-timeout`, or the
next-shortest hop simply becomes the failing one. Rollout does NOT log anyone
out: the session lives in the cookie and `google-oauth/cookie-secret` is unchanged.
**Guard:** `scripts/verify-e2e.sh` §10 now asserts both proxies report
`upstream-timeout >= 1800`, so a fresh cluster that lost the flag fails loudly
instead of showing a 502 only when someone happens to chat with a cold agent.
**STATUS: RESOLVED (2026-11-22).**

> Deeper fix, not taken: move `hijack()`/`writeHead`/the `event: session` frame
> above the `await streamMessage(...)`, so headers flush at t=0 and NO
> intermediate timeout can ever matter. Cost is error semantics — a failed kagent
> call would arrive as an SSE error event instead of a 502 status the SPA
> branches on. Revisit if a 502/timeout class returns on another long route.

---

## T-19 Chat answers `(no output)` after the 502 class is gone

**Symptom:** a turn ends with no text at all and the SPA renders the literal
`(no output)`. Nothing else looks wrong: the request completed, no proxy error
page, the session closes. The kagent controller log DID name the reason, e.g.
`Error 401: user_message: Invalid API key #1005` (an expired OpenRouter key
behind LiteLLM — see the rotation note below), and the user never sees it.

**Where the reason went — three separate losses, all in the BFF:**
1. `kagent/proxy.ts` typed the frame's `status` as `{ state?: string }` and read
   only the state, so `status.message` — the agent's own explanation, which IS
   on the wire — was parsed away before it ever reached the browser.
2. `parseEvent` had no notion of a non-terminal-but-not-running state, so
   `TASK_STATE_INPUT_REQUIRED` was treated as terminal. Approval and `ask_user`
   were structurally impossible: the row closed, the meter stopped, and the
   resume the client wanted to send had nothing to re-arm.
3. The BFF answered failures with `{ "error": "<string>" }`. assistant-ui's A2A
   client builds an `A2AError` from `{error:{code,status,message,details}}` and
   nothing else, so any string body arrives as `A2A request failed: 409` — the
   status code survives, the reason does not.

**The same blind spot was billing, not just UX.** `markTerminal` fired for ANY
terminal state and for stream errors, and the sweeper meters
`WHERE status='closed'`, so a run that produced zero tokens behind a dead
provider key was invoiced as full wall-clock `fleet.actor_compute`. Worse, the
relay's terminal set spelled cancel `TASK_STATE_CANCELLED` while the proto name
is `TASK_STATE_CANCELED` (one L) — a cancelled task matched nothing, so it was
never closed and never metered at all. And because a conversation is ONE
`sessions` row, only turn 1 could ever be billed: `metered_at` was stamped once
and never cleared.

**Fix: the BFF speaks A2A.** `src/a2a/` + `routes/a2a.ts` mount a per-project
A2A server (`/api/a2a/orgs/{orgId}/projects/{projectId}/…`) that the browser
drives with the standard client, so there is no private `event: session` frame
and no bespoke reader to lose a field in:
`agent-card.json` (URLs rewritten to the facade; the controller guards the card
with the same auth as the RPC endpoint, so that GET needs the identity headers
too — a bare one answers 401), `message:stream`,
`message:send`, `tasks/{id}`, `tasks/{id}:cancel`, `tasks/{id}:subscribe`.
Controller frames are relayed **verbatim** — the client normalises
`TASK_STATE_*`/`ROLE_*` itself, so re-shaping only adds ways to be wrong — and
read *tolerantly* for bookkeeping (`a2a/translate.ts inspectFrame`). All
classification lives in `a2a/contract.ts`: `outcome` + `close_reason` are now
columns on the session row, `input-required`/`auth-required` are **paused, not
terminal**, and every error leaves this process in the `{error:{…}}` shape.
Metering is per turn: `meter_seconds` accumulates the time a stream was
actually open (never the human's think-time on a paused task), `billed_seconds`
is what has been invoiced, and the sweeper bills the delta under an event id
keyed on `session:turn`. `settlementPolicy` encodes "depends on the failure
type": a turn the PLATFORM broke (`upstream_error`, `no_events`) is written off
with 0 seconds and never re-swept; a turn the agent answered wrongly, the user
cancelled, or the browser abandoned does bill, because that compute happened.

**Task ids are not tenant-scoped upstream**, so `tasks/*` never trusts the
client's project id: the facade resolves the id through its own `sessions` row
(`findSessionByTask`) and confirms the task's `contextId` against
`listContextIds(org, project)`. A context or task this facade never minted is a
404, not a new conversation — org-level agents are shared across projects, so
accepting an unknown `contextId` would let one project append to another's.

**A platform fault is NOT an agent failure — and there are three kinds.** On the
wire kagent reports it as an ordinary `TASK_STATE_FAILED` whose `status.message`
is the provider's own text
(`llm error response (code STREAM_ERROR): "OpenAI API error: 401 Unauthorized"`).
`isPlatformFault` recognises that class in three shapes:
`PLATFORM_FAULT` (auth / quota / rate-limit / no-upstream), `MODEL_UNAVAILABLE`
(a **retired model id** — `anthropic/claude-sonnet-4 is no longer available on
OpenRouter: no provider serves this model anymore`, surfaced as a 404), and
`RUN_NOT_STARTED` (the controller refused to begin
— `input was not accepted; retry after the session becomes available`). All three
re-label the turn `upstream_error`, so the policy writes it off at 0 seconds; an
unrecognised failure stays `failed` and **is** billed, because the agent really
did run. The list is deliberately conservative — a failure we cannot name is
charged, never silently written off — and deliberately narrow on `404`: an agent
that fetches a dead URL hit a real model with real compute, so only a 404 that
comes out of the LLM error envelope counts as the platform's. The two extra
classes were found by rotating the key: the retired slug had been billing 49-82
seconds of harness retry per attempt for a turn that could never reach a model.

**A completion can also be legitimately empty.** The `mock` worker settles a turn
with no artifacts and no `status.message` at all (proved live: the completed task
has only the echoed user message), which is the second way to get an empty
bubble. `inspectFrame` therefore tracks whether any artifact / message / status
part arrived, and a silent completion records
`the agent completed the turn without producing any output` in `close_reason` —
still outcome `completed`, still billable compute, but explainable to the user.
Only `mock` does this: with a working credential the OpenRouter-backed models
answer with real artifact frames, so an empty bubble from `nemotron*` is a
regression, not the harness's nature.

**Guard:** `scripts/fixes/t31-a2a-facade-check.sh` proves the card rewrite, the
401-is-JSON routing, a relayed `message:stream` turn, the ownership refusals, and
the `outcome`/`meter_seconds` read-back against the live cluster. Gate 8 is the
one that cannot be done with curl: it runs the SPA's real client
(`apps/spa/src/a2a/FleetA2AClient.ts`, i.e. `@assistant-ui/react-a2a`'s
`A2AClient`) against the port-forwarded facade and asserts the strict card parser
accepts the rewrite, every frame arrives as a *typed* A2A event, the turn settles,
and `message.metadata['fleet.dev/model']` lands on the session row.
**STATUS: IMPLEMENTED + unit-tested + verified in-cluster (2026-11-23).**
`t31-a2a-facade-check.sh` passes all 29 gates against `kind-flexprice-local`.
PR 2 has landed: the chat tab is now the A2A client talking to this facade, so
`(no output)` is gone — the bubble shows the `close_reason` recorded here, with
Retry. The legacy `/chat` relay still exists (PR 3 deletes it) and shares
`pumpTurn` with the facade, so the two paths cannot disagree about a turn.
Observed live: a `message:stream` turn relays 4 controller frames verbatim and
binds `contextId`; the mock worker's silent completion records
`the agent completed the turn without producing any output`; a nemotron turn
behind the dead OpenRouter key lands as
`upstream_error | "…OpenAI API error: 401 Unauthorized" | meter_seconds=3.069 |
metered_seconds=0` — the reason the user never saw, and 0 seconds billed.
Two things gate 8 found that curl could not: the client's role spelling is
lowercase `user` (`toWireMessage` maps anything else to `ROLE_UNSPECIFIED`, which
this facade refuses with `400 INVALID_ARGUMENT` rather than starting a bad turn),
and because the library calls `streamMessage(message, configuration, void 0,
signal)`, per-message metadata is the only channel model choice can ride — which
is why the `x-fleet-model` header fallback is deleted rather than kept as a
second path for the same decision.

**If a gate reports `000` on every call** it is not the protocol: with
`replicas=1` and a 25%/25% rolling update the Deployment can run with zero ready
endpoints for minutes while an in-flight SSE holds the old pod terminating. The
script now waits for `/healthz` (bounded by `READY_WAIT`) instead of a fixed
`sleep 2`, and fails with the `kubectl -n fleet-system get pods` hint.

> Operator actions, unrelated to this code. The OpenRouter key behind LiteLLM
> **was rotated on 2026-11-23** (`kubectl -n litellm patch secret
> litellm-fleet-secrets` `OPENROUTER_API_KEY`, then `rollout restart
> deploy/litellm` — the `openrouter/*` wildcard group reads
> `os.environ/OPENROUTER_API_KEY`, so one rotation covers every model).
> `/api/v1/models` answers 200 with a dead key, so only a generation call proves
> it. What that rotation exposed is a **retired model id**: the `claude` catalog
> entry points at `openrouter/anthropic/claude-sonnet-4`, which OpenRouter no
> longer serves. Fixing it means moving `deploy/litellm/values-base.yaml`
> (`model_list`) and `deploy/bff/configmap.yaml` (`FLEET_MODELS`) together —
> LiteLLM matches `model_name` verbatim, so a slug fixed in only one of them
> still fails, just with a different error. Until then the `claude` option in the
> chat model selector is a known-broken path: it now shows its 404 inline and
> bills nothing, which is the correct behaviour, not a fix.

---

```bash
# Flexprice admin calls (keys fetched inline, never printed; fresh-cluster
# shape = litellm-fleet-secrets; the deploy-env literal only exists on old clusters)
FP_KEY=$(kubectl -n litellm get secret litellm-fleet-secrets -o jsonpath='{.data.FLEXPRICE_API_KEY}' | base64 -d)
FP_ENV=$(kubectl -n litellm get secret litellm-fleet-secrets -o jsonpath='{.data.FLEXPRICE_ENVIRONMENT_ID}' | base64 -d)
curl -sS --resolve api.flexprice.local:80:127.0.0.1 "http://api.flexprice.local/v1/..." -H "x-api-key: $FP_KEY" -H "X-Environment-ID: $FP_ENV"

# Discover any Flexprice route/enum from the binary
kubectl -n flexprice exec deploy/flexprice-api -- strings /app/server | grep -oE '/v1/<area>[a-zA-Z0-9/:_.{}-]*' | sort -u

# LiteLLM admin API
kubectl -n litellm port-forward svc/litellm 14000:4000 &
MK=$(kubectl -n litellm get secret litellm-masterkey -o jsonpath='{.data.masterkey}' | base64 -d)

# BFF redeploy cycle
docker build -f deploy/bff/Dockerfile -t fleet-bff:local . \
 && kind load docker-image fleet-bff:local --name flexprice-local \
 && kubectl -n fleet-system rollout restart deploy/fleet-bff \
 && kubectl -n fleet-system rollout status deploy/fleet-bff --timeout=180s

# Onboarding state per org
kubectl -n fleet-system exec deploy/fleet-bff -- node -e "..."   # or via /api/orgs/:id/onboarding
```
