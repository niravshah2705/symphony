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

## Useful one-liners

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
