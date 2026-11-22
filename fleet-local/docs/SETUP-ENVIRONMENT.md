# fleet-local — final environment setup

Generated 2026-11-21 from the working cluster after T-01…T-14 were resolved.
One entry point reproduces the whole stack on a fresh machine:

```bash
cd fleet-local
scripts/setup-env.sh --list      # the step map
scripts/setup-env.sh             # steps 1..11, all idempotent
scripts/setup-env.sh --from 6    # resume after an interruption
DRY_RUN=1 scripts/setup-env.sh   # print the plan, run nothing
```

Design rules held throughout: **helm-first** wherever a chart exists; the
existing per-phase scripts (`scripts/00…50`, `seed`, `verify-e2e`, `fixes/*`)
are called unchanged — `setup/` only orchestrates; **no plaintext credential**
in any file, values or commit (secrets are generated inline or fetched from
in-cluster Secrets / `deploy/flexprice/.env`, never printed).

## Prerequisites (host)

| Needs | For step | |
|---|---|---|
| docker, kind ≥0.33, kubectl, helm, node 22 | all | `brew install kind kubernetes-cli helm node mkcert` |
| `npm run billing:flexprice:bootstrap` once at repo root (generates `deploy/flexprice/.env`) | 2 | real secrets, mode 0600, values never printed. On a rebuild where `.env` was lost, the live cluster can regenerate it (values from `flexprice-secrets` + the raw API key from the litellm deployment env, verified against the key-map hash) |
| `FLEXPRICE_CHECKOUT` in `.env` must point at a tree at the `deploy/flexprice/VERSION` pin (`21524530`, v2.1.48) | 2 | newer trees break chart staging (lint fails on the un-strippable subchart deps); keep your `main` checkout untouched and add `git worktree add --detach ~/git/flexprice-pinned-<sha> <sha>` |
| `OPENROUTER_API_KEY` exported (optional) | 3 | online models; mock-gpt works without |
| go ≥1.24 + substrate checkout `~/git/ate/substrate` | 6 | the `ate-setup` bootstrap (installer fetches tag v1.0.1 itself) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` exported; `mkcert -install` done | 8 | GCP **Web** client from the Firebase project; redirect URIs `https://app.fleet.dev/oauth2/callback` + `https://kagent.fleet.dev/oauth2/callback` |

## The 11 steps

| # | Step | Tool | What it does |
|---|---|---|---|
| 1 | kind + edge | `setup/s01-kind.sh` | `kind create cluster` from `deploy/setup/kind-config.yaml` (single node `kindest/node:v1.37.0` — substrate needs the 1.37 PodCertificate API; host `0.0.0.0:80/443` → node hostPort) then **helm** `ingress-nginx` 4.10.1 (controller v1.10.x) from `deploy/setup/ingress-nginx-values.yaml`: `allow-snippet-annotations=true` (header-strip snippets depend on it), `hostPort.enabled`, `watch-ingress-without-class` (legacy flexprice Ingresses). |
| 2 | Flexprice | `setup/s02-flexprice.sh` → repo root `npm run billing:flexprice:helm -- --verbose` | the 9-phase kind install (`deploy/flexprice/helm/values-kind.yaml`, pinned checkout chart, locally built image + `kind load`), then `billing:flexprice:provision` mints this cluster's API keys into `.env`. The fleet meter/plan **seed runs in step 9** (`seed-flexprice.sh` reads the key from the `litellm-fleet-secrets` Secret). Ends by applying `deploy/ingress/flexprice-api.yaml` (`api.flexprice.local` over nginx — the old cluster had it only ad-hoc; no flexprice.local UI host exists because the pinned chart ships no frontend, the fleet SPA is the UI). |
| 3 | LiteLLM | `setup/s03-litellm.sh` | **helm** `oci://ghcr.io/berriai/litellm-helm:1.109.1` with `deploy/litellm/values-base.yaml` — the live release shape with every plaintext key **removed**: postgres creds copied inline from `flexprice-postgresql`; `litellm-masterkey` generated once; `litellm-fleet-secrets` (OpenRouter + Flexprice keys) via `environmentSecrets`; `masterkeySecretName` points the chart at the generated Secret. Also applies `llm-mock` + the `litellm-callback` ConfigMap (flexprice_callback, fleet_metadata, fleet_identity). Baseline callbacks = flexprice + fleet hook only. |
| 4 | metrics-server | `setup/s04-metrics.sh` | **helm** metrics-server 3.14.0 with `--kubelet-insecure-tls --kubelet-preferred-address-types=InternalIP` (kind kubelet cert/name — without these, no metrics, ever). |
| 5 | observability | `setup/s05-observability.sh` | `otel-system` ns + the two billing-contract ConfigMaps from `../../deploy/flexprice/kind` (verified by `scripts/kind-metrics-install.sh` — their count-connector/scrape filters decide whether `fleet.actor_compute` data exists) + `deploy/observability/otel-system.json` (digest-pinned collector 0.163.2, Jaeger 2.22, Prometheus v3.15.1; **ClusterIP only — no Ingress by design**, use `scripts/port-forwards.sh`). Then **Langfuse** (`20-langfuse.sh`) + the litellm langfuse half (`30-litellm.sh`) — but Langfuse needs the `langfuse` postgres/ClickHouse dbs + RustFS bucket that step 8 creates, so on a fresh cluster this part defers to **5b** (the orchestrator re-runs s05 after step 8; the first pass skips it with a warning when the stores are absent). |
| 6 | Substrate | `setup/s06-substrate.sh` | runs the canonical installer `../../flexprice/docs/install-substrate-local.sh`: substrate-crds **helm**, the `ate-setup` bootstrap (signer CA pools + podcertificate-controller + actor-id pools + postgres + agentgateway egress mitm), DB roles/secrets, substrate chart. Then the fleet overlay `deploy/substrate/values-kind.yaml` via `helm upgrade --reuse-values --force-conflicts`: bootstrapOwners = kagent-controller SA, router ingress allowlist, `namespacePolicies` for kagent, `preview: [PerTemplateSnapshotLocation, GoldenEgressPolicy]`. Tenant `org-*` policy entries are appended per-org by BFF onboarding — never pre-added here. |
| 7 | kagent | `setup/s07-kagent.sh` | **helm** kagent-crds 1.0.1 + kagent 1.0.0 with `deploy/kagent/values-base.yaml` (trusted-proxy auth + `userIdClaim: email`, substrate apiEndpoint/router + client cert, `substrateWorkerPool` gVisor image, UI forwarded-header allowlist). Before the install it bootstraps the kagent database on the shared substrate postgres (setup.sql under `kagent_*` names + the two podcert DSN Secrets), re-asserts two things `ate-setup` owns outside helm (signer `--postgres-client` allowlist for the kagent SA, and the `kagent_*_user` pg_hba line — hot-reloaded by the postgres tls-reloader), applies `deploy/networkpolicy/postgres-kagent.yaml` (opens :5432 — the chart-owned postgres policy admits ate-api-server only), labels the ns `ate.dev/api-access=true` (substrate :443 gate), and labels the `kagent-api` RemoteMCPServer `kagent.dev/discovery=disabled` (trusted-proxy gives controller self-discovery no token). After: `deploy/networkpolicy/kagent-controller.yaml` — **load-bearing** and now including the T-08 entry (ate-system + app=atenet-egress on :8083, or every actor golden-build dies on the bootstrap call). Full defect trail: TROUBLESHOOTING T-15 items 8-15. |
| 8 | certificates | `setup/s08-certificates.sh` → `00-prereqs.sh` | `fleet-system/google-oauth` Secret, mkcert TLS Secret `fleet-local-tls` (app.fleet.dev + kagent.fleet.dev), `/etc/hosts`, `fleet_control` + `langfuse` postgres dbs, ClickHouse `langfuse` db, RustFS `langfuse` bucket. |
| 9 | services | `setup/s09-services.sh` | `10-ingress-oauth.sh` (two oauth2-proxies, upstream mode `--set-authorization-header --set-xauthrequest`, TLS Ingresses, nginx snippet enable) → `40-kagent-fix.sh` (re-assert patch — no-op after s07 — + stale-Agent cleanup + NP) → `50-bff-spa.sh` (arm64 BFF image, kind load, inline Secret from in-cluster Secrets) → `seed-flexprice.sh` (meters/plan/backdated prices). Then **browser**: login at https://app.fleet.dev → 9-step wizard for a tenant org (that is onboarding, not cluster setup). |
| 10 | auth documentation | — | [`AUTH-CONFIGURATION.md`](./AUTH-CONFIGURATION.md): every hop, header, claim and guard of the Google-OAuth → trusted-proxy → actor chain. |
| 11 | e2e gate | `setup/s11-verify.sh` | `verify-e2e.sh` (12-point gate) + the headless wake recipe below. |

## Model catalog & chat model selection (P6)

The chat model list is **configuration**: `FLEET_MODELS` (JSON array of
`{id,label,model,default?}`) in ConfigMap `fleet-system/fleet-bff-config`
(`deploy/bff/configmap.yaml`; default seed = mock-gpt, claude-sonnet-4,
`openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`). One entry per model, the
`default` one is the chat default. The BFF parses it at boot
(`parseModelCatalog` in `@fleet-local/shared`), so: edit -> `kubectl apply -f
deploy/bff/configmap.yaml` -> `rollout restart deploy/fleet-bff`.

Effects of an entry (all derived, nothing hardcoded per model):
- onboarding wizard step 4-5 renders a ModelConfig `<t>-model-<id>`, AgentTemplate
  `<id>-coding` and Agent `<slug>-agent-<id>-worker` via the vendored chart;
- LiteLLM org/team/key `models` get every catalog `model` **plus the `openrouter/*`
  wildcard** (`litellmModelList`), so new OpenRouter models need no key re-mint;
- `GET /api/orgs/:o/projects/:p/models` feeds the SPA dropdown; `POST .../chat`
  takes `model` (catalog id) — a NEW session binds to that model's agent, an
  EXISTING session stays on the agent it started with (checkpointed actor).

**Existing tenants do not pick a catalog change up by themselves** — run
`scripts/fixes/t26-tenant-model-catalog.sh` (idempotent; team/key model list +
helm upgrade + wait Ready + `projects.agent_name` -> default worker). T-15 item 27
records the API/shell traps it navigates.

## Headless wake probe (step 11, no browser)

Proves the full chain end-to-end: OAuth-less MCP call → controller trusted-proxy
JWT → egress tunnel bootstrap → actor Restore → LLM → Checkpoint.

```bash
kubectl --context kind-flexprice-local -n kagent port-forward svc/kagent-controller 18083:8083 &
# self-signed JWT is ACCEPTED by design (trusted-proxy does not verify signatures —
# the :8083 NetworkPolicy is the control):
# header {"alg":"RS256"}; claims iss=https://accounts.google.com, email=<you>, exp=+1h
# then MCP-over-SSE: initialize -> notifications/initialized -> tools/list ->
# invoke_agent {"agent":{"namespace":"org-demo","name":"demo-agent-worker"},"message":"..."}
```

Expected: `Atelet/Restore` ~10–15 s (cold, from golden snapshot), model 200 OK,
`TASK_STATE_COMPLETED`, `Atelet/Checkpoint` ~1–2 s. Reuse the JWT + session-id
snippets from `scripts/fixes/t08-egress-np-fix.sh` + docs/NEXT-ACTIONS.md ("Headless
wake verified 10:12 UTC").

## Fresh-cluster ordering notes (why the run order ≠ the list order)

- **Langfuse after Substrate AND step 8**: the S3 backend is RustFS inside
  `ate-system` (step 6), but the `langfuse` dbs/bucket are created by 00-prereqs
  (step 8) — so the re-run **5b** rides after step 8, not step 6.
- **Flexprice seed after LiteLLM**: `seed-flexprice.sh` reads the Flexprice key
  from the `litellm-fleet-secrets` Secret (the chart injects env from there;
  Deployment-env literals exist only on the old-cluster shape, kept as fallback).
- **kagent ns before the substrate overlay**: `bootstrapOwners` references the
  kagent-controller service account.
- **Never split** the substrate release into podcert/atelet sub-releases; patch
  only with `--reuse-values` (the installer's own comment explains why).

## Capacity guardrails (from T-12 — still true)

One tenant ≈ 1 CPU / 1 Gi on the single node. Keep dormant pools at 0. Do not
run golden/snapshot builds while `kubectl top nodes` load > ~6 or while
`ate-idp-server` restarted in the last 5 min — the starvation failure
(`no children to pick from`) is an artifact, not a substrate bug. Docker
Desktop memory is the first knob if OOM recurs.

## Teardown / reset

```bash
kind delete cluster --name flexprice-local     # everything is cluster-local except deploy/flexprice/.env
# per-step re-runs are safe: every script is idempotent (helm upgrade --install + create|apply)
```

Known generated-file tension: harness snapshots run as `gs://ate-snapshots/...`
even on RustFS (chart default `s3://` vs hand-patch) — reconcile in values
before a helm re-render, see NEXT-ACTIONS housekeeping.
