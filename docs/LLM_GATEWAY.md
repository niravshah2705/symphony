# LangSmith LLM Gateway — per-request feature flag

Route a single request's LLM traffic through the [LangSmith LLM Gateway]
(https://docs.langchain.com/langsmith/llm-gateway) for access control: per-org
spend caps, rate limits, and auto-traced audit — enforced outside our stack.
Everything else (unflagged requests, antigravity, local providers) keeps the
standard route, byte-for-byte.

## How a request opts in

1. The browser sets `X-AI-Fleet-Llm-Gateway: langsmith`. The SPA sends it when
   `localStorage.aiFleetLlmGateway === 'langsmith'` (`public/js/api.js`).
2. The gateway service honors the header only when `LLM_GATEWAY_ENABLED=true`
   (`services/gateway/src/request-context.js`); otherwise it is dropped at
   ingestion and nothing downstream ever sees it.
3. The flag threads to the eventual run on the same channel as org/project
   context:
   - legacy path: Pub/Sub message field `llmGateway` → coder Cloud Run Job env
     `LLM_GATEWAY_FLAG` / planner job record field → merged into the `settings`
     passed to `resolveLlm`;
   - durable path: `PipelineStart.request.llmGateway` → stage command →
     `resolveStageAgent` merge.
4. `resolveLlm` emits a `gateway: 'langsmith'` descriptor: base URL `/llmgw`
   (egress-proxied, sentinel token) or `gateway.smith.langchain.com` (non-proxied,
   key from the store env overlay), and `wireModelId()` prefixes the model as
   `provider/model` on the wire only. **The flag changes routing, never model
   selection** — `enforceLlmModel` and admission snapshots see bare model names.

## Runtime scope

| Runtime | Gateway surface | Notes |
|---|---|---|
| deepagent (LangChain) | `/v1/chat/completions` (+ `/v1/messages` for Claude models) | via `createChatModel` |
| claude-agent-sdk | `/v1/messages` | `ANTHROPIC_AUTH_TOKEN` Bearer (not the OAuth env); no `anthropic-beta` oauth header |
| codex-sdk | `/v1/responses` | always the `api` descriptor shape — the gateway has no chatgpt.com backend surface; the selected model must be metered-API-available |
| antigravity (@google/genai) | — | stays on the native Google path (no native surface at the gateway) |
| LM Studio / Ollama / oMLX | — | local, untouched |

## Deployment setup

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
