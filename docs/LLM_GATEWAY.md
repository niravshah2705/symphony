# LLM Gateway — per-request feature flag

Route a single request's LLM traffic through a gateway instead of straight to
the provider. Two gateways, one header:

| Mode | Target | Why you would pick it |
|---|---|---|
| `langsmith` | [LangSmith LLM Gateway](https://docs.langchain.com/langsmith/llm-gateway) | per-org spend caps + rate limits + auto-traced audit **enforced outside our stack** |
| `litellm` | self-hosted [LiteLLM](https://docs.litellm.ai/) proxy on Cloud Run | the same routing point, in-house: our infra cost, our model list, our trace store |

Everything else (unflagged requests, antigravity, local providers) keeps the
standard route, byte-for-byte.

## How a request opts in

1. The browser sets `X-AI-Fleet-Llm-Gateway: langsmith|litellm`. The SPA sends it
   from `localStorage.aiFleetLlmGateway` (`public/js/api.js`); any value outside
   that list is dropped.
2. The gateway service honors the header only when the matching server gate is
   on — `LLM_GATEWAY_ENABLED` for `langsmith`, `LITELLM_GATEWAY_ENABLED` for
   `litellm` (`services/gateway/src/request-context.js`, mode table
   `CONFIG.LLM_GATEWAY_MODES` in `packages/shared-core/src/config.js`); otherwise
   it is dropped at ingestion and nothing downstream ever sees it. Each hop that
   forwards the value re-checks membership only, never availability, so a run
   admitted by the gateway is not silently re-decided mid-pipe by one service's
   own env.
3. The flag threads to the eventual run on the same channel as org/project
   context:
   - legacy path: Pub/Sub message field `llmGateway` → coder Cloud Run Job env
     `LLM_GATEWAY_FLAG` / planner job record field → merged into the `settings`
     passed to `resolveLlm`;
   - durable path: `PipelineStart.request.llmGateway` → stage command →
     `resolveStageAgent` merge.
4. `resolveLlm` emits a `gateway: '<mode>'` descriptor: the mode's egress route
   (`/llmgw` or `/litellm`, base URL from the sidecar's trusted env, sentinel
   token) or its direct origin in non-proxied local runs. `wireModelId()` prefixes
   the model as `provider/model` on the wire **for `langsmith` only** — LiteLLM
   matches `model_name` verbatim, so its model list uses bare ids. **The flag
   changes routing, never model selection** — `enforceLlmModel` and admission
   snapshots see bare model names.

## Runtime scope

| Runtime | Gateway surface | Notes |
|---|---|---|
| deepagent (LangChain) | `/v1/chat/completions` (+ `/v1/messages` for Claude models) | via `createChatModel` |
| claude-agent-sdk | `/v1/messages` | `ANTHROPIC_AUTH_TOKEN` Bearer (not the OAuth env); no `anthropic-beta` oauth header |
| codex-sdk | `/v1/responses` | always the `api` descriptor shape — the gateway has no chatgpt.com backend surface; the selected model must be metered-API-available |
| antigravity (@google/genai) | — | stays on the native Google path (no native surface at the gateway) |
| LM Studio / Ollama / oMLX | — | local, untouched |

## Deployment setup (langsmith)

1. **LangSmith (Plus/Enterprise):** create (or pick) the managed workspace; add
   the Anthropic + OpenAI provider secrets under workspace Provider Secrets;
   mint a workspace API key.
2. **Secrets:** add the workspace key to the settings service's
   `managed_provider_secrets` map as `LANGSMITH_GATEWAY_API_KEY => <secret-id>`
   (vault key `langsmithGatewayApiKey`, managed-only — never browser-writable).
   The proxy resolves it through the same settings S2S path as every other
   managed credential. Never mount it on a proxy, gateway, planner, coder, or
   worker container. A trusted non-proxied local process may use the store env
   overlay. It is deliberately distinct from `langsmithApiKey` (tracing) so a
   customer tracing key can never become the billing credential.
3. **Env:** set `LLM_GATEWAY_ENABLED=true` on the gateway service AND the
   planner/coder/worker containers. BYOC/self-hosted LangSmith: set
   `LANGSMITH_GATEWAY_URL=https://<data-plane-host>/gateway` only on deployed
   proxy sidecars (or on the trusted process in non-proxied local mode).
4. **Policies (LangSmith UI):** set the customer-identifier header to
   `X-Fleet-Org-Id`; define per-org spend/rate policies keyed on its values;
   consider a default-deny/zero-budget policy for unknown org ids. The proxy
   stamps the header from `PROXY_ORG_ID` (omitted on the shared stack — that
   traffic is the platform's own).

## Invariants

- Agents still hold zero raw secrets: in egress-proxy mode the flag only swaps
  which sidecar route carries the traffic (`/llmgw` vs `/anthropic|/codex|…`);
  the sentinel-token mechanism is unchanged and a missing workspace key fails
  closed at the proxy (502), never forwarding unauthenticated.
- Model allowlisting stays in-house (settings-policy `models` cascade /
  `enforceLlmModel`) — the gateway adds spend/rate/audit control, not model
  allowlists.
- Tracing: the gateway auto-traces routed calls. A flagged run with agent-side
  LangSmith tracing pointed at the SAME workspace double-traces LLM spans
  (`configureTracing` logs a warning) — use separate projects/workspaces or
  disable `langsmithTracing` for flagged runs.
- Codex subscription OAuth is bypassed on flagged runs — spend moves to the
  workspace's metered keys, and a ChatGPT-subscription-only model will 404 at
  the gateway.

## Smoke test (no agent needed)

```bash
# Precondition: the local settings service holds LANGSMITH_GATEWAY_API_KEY and
# validates this org-bound internal token. The proxy receives no provider key.
PROXY_PORT=4030 PROXY_ORG_ID=test-org \
  SETTINGS_SERVICE_URL=http://127.0.0.1:8002 \
  ORG_INTERNAL_API_TOKEN=<org-bound-token> \
  node services/proxy/src/index.js

curl http://127.0.0.1:4030/llmgw/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-5-codex","messages":[{"role":"user","content":"ping"}]}'

curl http://127.0.0.1:4030/llmgw/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"anthropic/claude-sonnet-4-6","max_tokens":32,"messages":[{"role":"user","content":"ping"}]}'
```

Expect 200s, the calls appearing as LangSmith traces attributed to `test-org`,
and a 402 once the org's spend cap trips.

---

# Self-hosted LiteLLM gateway (`litellm`)

One Cloud Run service, `ai-fleet-litellm`, three containers on the shared
loopback namespace (`deploy/gcp/terraform/litellm.tf`):

```
app      :4000  LiteLLM proxy      ← the ONLY container declaring ports{}, so the only one with ingress
postgres :5432  PG16, PGDATA on emptyDir
redis    :6379  Redis 7, AOF off, on emptyDir
```

`max_instance_count = 1` is **structural, not a preference**: two instances would
be two independent Postgres and two independent Redis, i.e. split-brain keys and
spend logs. Redis is still worth its memory because LiteLLM runs many uvicorn
workers inside the one container and router cooldown state is per-worker
otherwise. Ingress is `INGRESS_TRAFFIC_INTERNAL_ONLY`; the only workload that can
reach it is an agent egress sidecar, which gets its origin from
`LITELLM_PROXY_UPSTREAM` (set by `local.proxy_plain_env`, sidecars only — an agent
container must never learn the real origin, because model-generated code in the
coder could otherwise drive an arbitrary target through the `/litellm` passthrough).

## The PoC trade-off, stated plainly

Cloud Run has no persistent local disk, so state lives on `emptyDir` — per-instance,
destroyed on **every** redeploy, restart, and scale-to-zero. Consequences:

- **Spend logs and trace rows disappear.** `min_instance_count = 1` defers this, it
  does not prevent it. This gateway cannot answer "what did we spend last week"
  across a deploy. Provider *credentials* are not affected: `config.yaml` reads them
  from `os.environ/`, so nothing key-bearing is stored in the database at all.
- **Per-org virtual keys cannot work here.** Minting one is `POST /key/generate`,
  which returns a **new** token on every call — so re-creating the `org:<id>` alias
  after a wipe yields the same alias and a different secret. There is no endpoint to
  write the replacement back into an org's vault, and a `secret_key_ref` at
  `version = "latest"` does not hot-propagate into a running container either.
  **So an operator mints one model-scoped virtual key per opted-in org by hand and
  writes it to that org's vault as `litellmApiKey`.** After a wipe those runs fail
  closed at the proxy (502) until re-minted.
- **Never substitute the master key to dodge that**, however tempting — it would
  survive every restart. The `/litellm` route forwards any sub-path, so the
  credential a coder container can reach is also a credential that can reach
  `/key/generate`, `/global/spend/logs`, and `/user/info`: unlimited key minting and
  every other org's usage. Failing closed after a redeploy is the better failure;
  an admin credential inside the egress boundary is the exact thing the sidecar
  exists to prevent.

To make attribution durable, pick one: (a) move Postgres to Cloud SQL —
`google_sql_database_instance` in `memory.tf` is the in-repo template — and mint
per-org keys once; or (b) keep the ephemeral DB and attribute inside the
request instead, via LiteLLM's `user` / `metadata.tags` fields, which needs a body
rewrite in the harnesses. (a) is the smaller change. Note the third option — a
scheduled `pg_dump` to GCS — restores history but does not fix key identity, and
`gcsfuse` is safe for a flat dump file and *not* safe for a live `PGDATA`.

## Deployment setup (litellm)

1. **Enable:** repo variable `LITELLM_ENABLED=true`. CI then builds the three images
   (`deploy/gcp/Dockerfile.litellm-{app,db,redis}`, each `FROM` pinned by digest —
   Cloud Run pulls only from Artifact Registry) and passes one tag to all three
   `*_image_tag` vars. The app image is the upstream proxy plus
   `deploy/litellm/config.yaml`; we do not fork LiteLLM.
2. **Seed the two key values out-of-band** (Terraform creates the containers with
   `prevent_destroy` and never writes their contents):
   ```bash
   gcloud secrets create litellm-master-key --data-from-file=/dev/stdin <<<"sk-$(openssl rand -hex 24)"
   gcloud secrets create litellm-salt-key   --data-from-file=/dev/stdin <<<"sk-$(openssl rand -hex 24)"
   ```
   The Postgres password and its DSN are generated and written by Terraform.
3. **Provider keys:** `var.litellm_provider_secrets` defaults to the existing
   `anthropic-api-key` / `openai-api-key` ids, mounted read-only on the gateway's
   own service account. Agent containers gain no provider credential.
4. **Per-org credential:** mint a key restricted to the models that org may use,
   then write it into that org's vault as `litellmApiKey`:
   ```bash
   curl -sS -X POST "$LITELLM_URL/key/generate" \
     -H "Authorization: Bearer $(gcloud secrets versions access latest --secret=litellm-master-key)" \
     -H 'content-type: application/json' \
     -d '{"key_alias":"org-test-org","models":["claude-sonnet-5","gpt-5.4-mini"],"max_budget":20,"budget_duration":"30d"}'
   ```
   Operator-only write: `litellmApiKey` is excluded from browser-writable keys, and a
   browser-settable value would let an org point platform traffic at an arbitrary
   gateway. Use the **returned `key`**, not the master key (see the trade-off above).
5. **Admit the flag:** `LITELLM_GATEWAY_ENABLED=true` on the gateway service AND the
   planner/coder/worker containers, exactly as `LLM_GATEWAY_ENABLED` is supplied.
   Keep the mode **off** for orgs whose provider keys are customer-sourced —
   otherwise their traffic bills against the platform's key.
6. **Model list:** `config.yaml` must declare a `model_name` for **every** bare model
   id `enforceLlmModel` can produce, because a litellm descriptor keeps the bare id
   on the wire. `deploy/gcp/litellm-config.test.js` diffs the file against the live
   harness catalog in CI; a missing entry is rejected with 403
   `key_model_access_denied` on that run, not a fallback.

## Reading the traces

`turn_off_message_logging: true` by default — prompt bodies contain model-generated
code and customer secrets, so the PoC keeps tokens/cost/model and drops the payload.
Flip per need (or per request with `x-litellm-enable-message-redaction: true`).

- **Spend/usage without opening a port,** from a process that can already reach the
  gateway and holds the master key — i.e. a local parity run
  (`LITELLM_URL=http://127.0.0.1:4000`):
  ```bash
  curl -sS -H "Authorization: Bearer $(gcloud secrets versions access latest --secret=litellm-master-key)" \
    "$LITELLM_URL/global/spend/logs"
  ```
  From a deployed agent the same read goes through the sidecar, which injects the
  org's key instead: `curl "$EGRESS_PROXY_URL/litellm/global/spend/logs"` with the
  sentinel Bearer token. The `/litellm` prefix forwards any sub-path, so this needs
  no new route.
- **Admin UI:** `https://ai-fleet-litellm-…/ui`, password = the master key. Internal
  ingress means you need a network path — `gcloud run services proxy
  ai-fleet-litellm --region <region>` from a machine on the VPC. Do not relax
  `var.litellm_ingress` to make the UI convenient: with `min_instance_count = 1` a
  public master-key-only endpoint is live and spendable the whole time it is up.
- **OTel** (`callbacks: ["otel"]`) is available but stays off: this repo has no OTel
  producers yet, so LiteLLM's honored `traceparent` has no parent span to join.
  `gcs_bucket` / `gcs_pubsub` sinks are Enterprise-license gated and unavailable.

## Smoke test (no agent needed)

```bash
# Precondition: LITELLM_PROXY_UPSTREAM points at a reachable gateway, the org's
# vault holds litellmApiKey, and LiteLLM's config.yaml declares this model.
PROXY_PORT=4030 PROXY_ORG_ID=test-org \
  SETTINGS_SERVICE_URL=http://127.0.0.1:8002 \
  ORG_INTERNAL_API_TOKEN=<org-bound-token> \
  LITELLM_PROXY_UPSTREAM=http://127.0.0.1:4000 \
  node services/proxy/src/index.js

curl http://127.0.0.1:4030/litellm/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-5","max_tokens":32,"messages":[{"role":"user","content":"ping"}]}'

curl http://127.0.0.1:4030/litellm/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.4-mini","max_tokens":32,"messages":[{"role":"user","content":"ping"}]}'
```

Note the **bare** model names — `claude-sonnet-5`, not `anthropic/claude-sonnet-5`.
Expect 200s, `x-litellm-call-id` on the response headers, and a matching row in
`/global/spend/logs`. An unmatched model is a 403 from LiteLLM (measured:
`key_model_access_denied`, not a fallback to direct egress); an unmatched *prefix*
on the sidecar is a 404 from `matchRoute` (no open relay).

**Restart test, do not skip:** redeploy the service and confirm the empty `PGDATA`
re-initialises, LiteLLM re-applies its schema, and a subsequent request still
authenticates. This is the only test that exercises the ephemeral path that a
recycled instance will hit in production for reasons nobody chose.

## Optional front: agentgateway, in the substrate cluster

`litellm` mode can take one more hop in front of LiteLLM instead of replacing it:

```text
browser ──(X-AI-Fleet-Llm-Gateway: litellm)──▶ sidecar /agentgw ──▶ agentgateway ──▶ LiteLLM ──▶ provider
```

The flag and the mode table do not change — there is no third mode, because the
header is a per-request choice and the gateway is a per-deployment physical
target. `services/proxy/src/credentials.js` resolves
`AGENTGATEWAY_PROXY_UPSTREAM` through the same SSRF guard as every other
trusted origin, and `deploy/gcp/agentgateway-config.test.js` keeps the Terraform
validation and that guard the same rule.

**Both halves have to be asked for, and neither is on:**

| Half | Where | Knob |
|---|---|---|
| Render the gateway | `deploy/gcp/terraform-substrate-gke` | `agentgateway_enabled`, plus `agentgateway_llm_upstream_host`, `agentgateway_models`, `agentgateway_virtual_keys` (hashes only) |
| Route to it | `deploy/gcp/terraform` (Cloud Run) | `agentgateway_proxy_upstream`, sidecar env only — never an agent container |

An origin set on one side and not the other is the failure mode to watch for:
the route 502s closed (sidecar has no target) or the gateway serves traffic no
client can reach (origin empty). `terraform output agentgateway_url` is the
value the Cloud Run root wants, and it prints `null` while
`agentgateway_ingress_hostname` is empty — because a ClusterIP address is not
routable from Cloud Run. Until an authenticated bidirectional path between the
two is proven, the honest state is dark, which is why
`deploy/gcp/terraform-substrate-gke/agentgateway.tf` ships enabled=false.

What the front deliberately does not do: enforce a token budget (a `local`
rate limit counts per proxy replica, which is a hint, not enforcement),
authenticate actors (a bearer key inside an actor container is the invariant
this repo exists to protect), or route per-tenant traffic to per-tenant
upstream keys (route selection cannot read the virtual identity, so that
isolation stays in LiteLLM's per-org virtual keys). Its `/a2a` listener admits
no HTTPRoute from any namespace, and `docs/SUBSTRATE_INTEGRATION.md` §12 says why
nothing is behind it.
