# Harness capability & environment matrix

This is the authoritative reference for which agent **harness** CLIs run as **kagent** native
runtimes, what each one **supports vs does not support**, and the **parameters / environment
variables** it reads. A "harness" is the agent-runtime technology that executes a run (the SDK,
loop, and tool surface) — see [`../GLOSSARY.md`](../GLOSSARY.md): *"what runs the agent"*.

> **Honesty first.** "Registered" ≠ "works". This doc states the *verified* status of every
> runtime. Do not read a `scaffold-experimental` row as a runnable production agent.

## Status legend

| Status | Meaning | Verified how |
|---|---|---|
| `native-full` | Real native runtime: controller translator + durable HITL + a machine-readable event protocol (stream-JSON / JSON-RPC). Runs end-to-end. | `go/harness/claude`, `go/harness/codex` (built images, README checklists) |
| `passthrough-bounded` | Runs a CLI subprocess but only maps **stdout lines → TextDelta**; no confirmed event protocol, so no tool/subagent/MCP events. | `go/harness/deepagent`, `go/harness/deepseek` (`driver.go` NOTE) |
| `scaffold-experimental` | Source scaffold **compiles + unit-tests offline** but has NO published image, NO controller translator, NO upstream kagent CRD `spec.<runtime>` key → **cannot run in-cluster yet**. | the 6 new dirs (build/vet/test green, dark Dockerfiles) |

## Harnesses covered

| Harness | kagent runtime id | Status | Where |
|---|---|---|---|
| Claude Code | `claude` | `native-full` | `go/harness/claude` — **already present, no code change** |
| Codex CLI | `codex` | `native-full` | `go/harness/codex` — **already present, no code change** |
| DeepAgent | `deepagent` | `passthrough-bounded` | `go/harness/deepagent` |
| DeepSeek | `deepseek` | `passthrough-bounded` | `go/harness/deepseek` |
| OpenCode | `opencode` | `scaffold-experimental` | `go/harness/opencode` (new) |
| Gemini CLI | `gemini` | `scaffold-experimental` | `go/harness/gemini` (new) |
| Pi | `pi` | `scaffold-experimental` | `go/harness/pi` (new) |
| Qoder | `qoder` | `scaffold-experimental` | `go/harness/qoder` (new) |
| Kilo | `kilo` | `scaffold-experimental` | `go/harness/kilo` (new) |
| Goose | `goose` | `scaffold-experimental` | `go/harness/goose` (new) |

Design-time selectable harness names live in `HARNESS_OPTIONS`
(`packages/shared-core/src/workflow/model.js:13`, mirrored in
`public/js/workflow-designer-model.mjs:34`, pinned by
`public/js/workflow-designer-model.parity.test.mjs`). The SDK/artifact pipeline catalog is a
separate vocabulary in `packages/shared-core/src/agent/harness-catalog.json` (see PR-2 note at the
bottom).

## 1. Capability matrix

`✅` supported · `◑` partial / limited · `⛔` not supported · `❓` unconfirmed by an event protocol
(scaffold only maps stdout text).

| Capability | Claude Code | Codex | DeepAgent | OpenCode | Gemini CLI | Pi | Qoder | Kilo | Goose |
|---|---|---|---|---|---|---|---|---|---|
| Streaming text (deltas) | ✅ | ✅ | ◑ (stdout lines) | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ |
| Tool-call events | ✅ | ✅ | ⛔ | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ |
| Tool-result events | ✅ | ✅ | ⛔ | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ |
| HITL approval / subtask pause (`runtime.PendingTurn`) | ✅ | ✅ | ⛔ | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ |
| Session / continuation resume | ✅ | ✅ | ◑ | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ |
| Task cancellation | ✅ | ✅ | ◑ (proc group) | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ |
| Subagents (child agents) | ◑ shared local only | ◑ shared-agents, no child-approval | ⛔ | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ |
| Skills | ✅ (+ plugin skills) | ✅ (plugin-selected) | ⛔ | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ |
| Plugins | ✅ | ◑ (no hooks/commands/exec/implicit-MCP) | ⛔ | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ |
| MCP — remote servers | ◑ HTTP+SSE whole-server | ◑ Streamable-HTTP + allowed-tools | ⛔ | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ |
| MCP — per-tool selection | ⛔ (planned) | ✅ | ⛔ | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ |
| MCP — HITL approval | ✅ | ✅ | ⛔ | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ |
| Built-in tools | ✅ | ✅ | ◑ | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ |
| Runs under egress proxy (no raw key in agent) | ✅ | ✅ | ✅ | ❓ | ❓ | ❓ | ⛔ (hosted-only) | ❓ | ❓ |
| In-cluster kagent execution | ✅ | ✅ | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ |

Notes:
- Claude `✅`/`◑` cells come from the checked lists in `go/harness/claude/README.md:21-31,99-104`
  (streaming over A2A, built-in tools, shared local subagents, standalone+plugin skills, HTTP/SSE
  MCP whole-server, HITL MCP approval; **not yet**: per-tool MCP selection, dedicated/nested subagents).
- Codex cells from `go/harness/codex/README.md:28-45` (Streamable-HTTP MCP with allowed-tools, native
  shared agents, per-server MCP approval, plugin-selected skills; **explicitly not advertised**:
  `tokenPassthrough`, custom TLS, legacy SSE MCP, dedicated agents, checkpoint/fork).
- Every `❓` for the 6 new runtimes means: the scaffold's driver maps **stdout text only** and does
  **not** claim a tool/subagent/MCP event contract. That is a deliberate honesty stance — the real
  event protocol must be confirmed per CLI before any of these cells become `✅`/`⛔`.

## 2. Model-family & provider compatibility

Model families: `MODEL_FAMILIES = ['anthropic','openai','bedrock','vertexai','gemini','byok']`
(`workflow/model.js:12`).

| Harness | Native model family(s) | Managed-provider notes |
|---|---|---|
| Claude Code | `anthropic`, `bedrock` (bearer) | Anthropic API keys + Bedrock bearer injected by gateway; AWS IAM keys and Vertex SA keys rejected by compiler (`claude/README.md:34-36`) |
| Codex | `openai` (Responses API), `bedrock` bearer | `AWS_BEARER_TOKEN_BEDROCK`; ChatGPT backend for deep-agent path |
| DeepAgent | `openai`-compatible / byok | provider-driven via `requiresProvider` |
| OpenCode | `byok`, `openai`-compatible | providers set in `opencode.json` with `{env:…}` substitution |
| Gemini CLI | `gemini`, `vertexai` | `GOOGLE_GENAI_USE_VERTEXAI` switches API vs Vertex |
| Pi | `byok` / OpenAI-compatible | *(proposed — verify upstream)* |
| Qoder | hosted Qoder only | `requiresProvider: qoder`; org's own Qoder account |
| Kilo | `anthropic`/`openai`-compatible | *(proposed, low confidence — verify before pinning)* |
| Goose | `byok`, OpenAI/Anthropic-compatible | MCP-native; provider via `GOOSE_PROVIDER`/`GOOSE_MODEL` |

## 3. Egress / proxy routing

The canonical prefix→upstream map is `EGRESS_ROUTES`
(`packages/shared-core/src/egress.js:71-141`). Deployed agents hold only the
`SENTINEL_TOKEN`; the egress-proxy sidecar strips it and injects the real credential
(`services/proxy/src/credentials.js`). Unset `EGRESS_PROXY_URL` is trusted-local-only.

| Harness / family | Route prefix | Auth kind | Secret key |
|---|---|---|---|
| Anthropic (Claude) | `/anthropic` | `claude` | `anthropicApiKey` |
| OpenAI / Codex Responses | `/openai` | `codex-api` / `codex-chatgpt` | `openaiApiKey` / `codexTokenBundle` |
| Bedrock bearer | (AWS SDK, gateway-injected) | — | — |
| Gemini API | `/gemini`, `/gemini-native` | `apiKey` | `geminiApiKey` |
| LiteLLM gateway | `/litellm` | `apiKey` (bearer) | `litellmApiKey` (per-org vault) |
| LiteLLM (direct/local) | `LITELLM_URL` | bearer | `litellmApiKey` |
| LangSmith LLM GW | `/llmgw` | `llm-gateway` | `langsmithGatewayApiKey` |
| AgentGateway | `/agentgw` | `apiKey` | `fleetGatewayApiKey` |
| OpenRouter / Ollama / LMStudio / oMLX / HF | `/openrouter` `/ollama` `/lmstudio` `/omlx` `/hf` | apiKey/url-secret | provider keys |

- **Qoder cannot be proxied.** The sidecar cannot broker the qodercli endpoint, so a proxied Qoder
  run fails closed with `runtime_unavailable` (503): `packages/shared/src/agent/harnesses/qoder.js`.
- LLM Gateway is a **per-request feature flag** (`X-AI-Fleet-Llm-Gateway: langsmith|litellm`) gated by
  `LLM_GATEWAY_ENABLED` / `LITELLM_GATEWAY_ENABLED`. Mode list is `CONFIG.LLM_GATEWAY_MODES`
  (`packages/shared-core/src/config.js`) — never re-spell `=== 'langsmith'` mid-pipe. The flag changes
  **routing only**, never model selection; LiteLLM matches the **bare** model id verbatim, so its
  catalog entries must equal the bare id (`llm.js` `wireModelId`). See
  [`LLM_GATEWAY.md`](./LLM_GATEWAY.md).

## 4. Parameters / environment variables

Two columns: **read today in repo** (cited) vs **proposed for scaffold** (upstream docs —
verify against the pinned CLI before trusting; none are asserted at runtime yet).

### native-full / passthrough runtimes (grounded in repo)

| Harness | Env / params (repo-cited) | Source |
|---|---|---|
| Claude | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_REGION`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`, `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, `GOOGLE_APPLICATION_CREDENTIALS`, `KAGENT_CLAUDE_GOOGLE_CREDENTIALS_JSON`, `KAGENT_CLAUDE_MCP_CREDENTIAL_*`, `CLAUDE_CONFIG_DIR`, `DISABLE_UPDATES`, `CLAUDE_CODE_MAX_RETRIES`, `IS_SANDBOX`, `CLAUDE_CODE_ENABLE_TELEMETRY` | `go/harness/claude/config/config.go:25-56` (`OwnsEnvironment`) |
| Codex | `CODEX_HOME`, `KAGENT_BOOTSTRAP_JSON`, `AWS_BEARER_TOKEN_BEDROCK`; `CODEX_OPENAI_BASE_URL`→`/openai`, `CODEX_CHATGPT_BASE_URL`→`/codex`, `CODEX_BACKEND`, `CODEX_OPENAI_MODEL`, `CODEX_CLIENT_VERSION` | `go/harness/codex/` + `packages/shared-core/src/config.js:281-324` |
| DeepAgent | `DEEPAGENTS_DISABLE_UPDATES`, executable `deepagents-code`; `HOME`/`XDG_*` sandboxed | `go/harness/deepagent/config/config.go:15-31` |
| Qoder (JS) | `QODER_PERSONAL_ACCESS_TOKEN`, `QODERCLI_PATH`, `QODER_MODEL` | `packages/shared-core/src/config.js:483-493`, `store.js:717` |
| Common agent env | `EGRESS_PROXY_URL`, `STREAM_TOKEN_SERVICE_URL`, `LANGFUSE_*` (basic-pair), `LLM_GATEWAY_FLAG` | `packages/shared/src/config.js`, `egress.js` |

### scaffold-experimental runtimes (proposed — not yet asserted)

| Harness | Executable | Disable-update env | Other env (proposed) |
|---|---|---|---|
| OpenCode | `opencode` | `OPENCODE_DISABLE_AUTOUPDATE` | `opencode.json` provider keys via `{env:…}`; OpenAI/Anthropic-compatible base URLs |
| Gemini CLI | `gemini` | `GEMINI_CLI_DISABLE_AUTO_UPGRADE` | `GEMINI_API_KEY`/`GOOGLE_API_KEY`; `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` |
| Pi | `pi` | `PI_DISABLE_AUTO_UPDATE` | npm-pinned `@earendil-works/pi-coding-agent`; OpenAI-compatible provider env |
| Qoder | `qodercli` | `QODER_DISABLE_AUTO_UPDATE` | `QODER_PERSONAL_ACCESS_TOKEN` (token), `QODERCLI_PATH` — **fail closed under proxy** |
| Kilo | `kilo` | `KILO_DISABLE_UPDATE` | `@kilocode/cli`; Claude/OpenAI-compat provider env *(low confidence)* |
| Goose | `goose` | `GOOSE_DISABLE_VERSION_CHECK` | `GOOSE_PROVIDER`, `GOOSE_MODEL`; overrides `~/.config/goose/config.yaml` |

Each scaffold's `Production()` config sets `StrictVersion: false` and no asserted `expected_version`,
and sets `runtime_telemetry.runtime` empty — so a `--check` or a turn cannot silently claim a verified
provider pin or emit a telemetry runtime string the weaver registry doesn't know. See the honesty
guards in `go/harness/README.md`.

## 5. Harness CR appendix (`api.kagent.dev/v1alpha3`)

The platform-managed `Harness` selects the runtime; the `Agent` references it (`harnessRef`) and
defines behavior inline. Only `spec.claude`/`spec.codex` exist today. The blocks below are the
**proposed** shape for the new runtimes and **require upstream kagent CRD support** that is not in
this repo — they are documentation of intent, not deployable manifests.

```yaml
# REQUIRES upstream kagent CRD support — spec.opencode is not in this repo
apiVersion: api.kagent.dev/v1alpha3
kind: Harness
metadata: { name: opencode, namespace: kagent }
spec:
  opencode: {}
  substrate:
    workerPoolRef: { name: kagent-default }
    snapshotPolicy: { location: s3://ate-snapshots/kagent/ }
```

The same `spec.<runtime>: {}` pattern is proposed for `gemini`, `pi`, `qoder`, `kilo`, `goose`.
A runnable, real example (using an already-working runtime) is
[`deploy/gcp/terraform-substrate-gke/examples/kagent-litellm-harness.yaml`](../deploy/gcp/terraform-substrate-gke/examples/kagent-litellm-harness.yaml)
— a tenant-namespaced `Harness`+`Agent` with LiteLLM egress. `renderAgentCrd` renders only the
`Agent` + a `harnessRef` reference (`packages/shared-core/src/agent/kagent.js:107-172`); it does not
emit a `Harness` CR.

## PR-2 boundary

`opencode`, `pi`, `qoder` already appear in the **SDK/artifact catalog**
(`packages/shared-core/src/agent/harness-catalog.json`) as `experimental`/`available`; `gemini-cli`,
`kilo`, `goose` do not. Adding them to that catalog is a separate change that forces lockstep edits
across `registry/schema.js`, `registry/sources.json`, `scripts/harness-registry/artifact-builder.js`,
and `.github/workflows/sync-harness-registry.yml` (exact-key-set + hardcoded-count enforcement). That
ECC build pipeline is orthogonal to the kagent format documented here.
