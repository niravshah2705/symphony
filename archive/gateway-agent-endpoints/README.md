# archive/gateway-agent-endpoints

Holding area for gateway route code being **moved off the gateway** as it becomes
a pure router + config-gate (see the plan: "Router gateway + LangGraph pipeline
orchestrator"). Files here are **not imported by the running gateway** and this
directory is **outside the gateway build path**, so nothing here ships in the
gateway image. Kept (not deleted) for reference during the migration, per the
project decision to archive removed gateway agent code.

## Why the gateway is being stripped

The gateway should authenticate, run a cheap **config preflight** (harness
allowed + provider key connected + billing OK — resolved from the settings
service), and **proxy** to the right stage/orchestrator. It must import **no
agent/harness code** so its image and closure reduce to `@ai-fleet/shared-core`.

## Phase 2 relocation checklist (endpoint → new home)

Status legend: ✅ done · 🔜 next · ⏳ needs live-stack verification

- ✅ **SDK-free shim imports repointed to `@ai-fleet/shared-core`** — the gateway
  OAuth/preset imports that were already shims (`agent/oauth`,
  `agent/claude-oauth`, `agent/model-presets`) now import from `shared-core`
  directly (zero behavior change). Files: `routes/codex.js`, `routes/claude.js`,
  `routes/settings.js`.

Remaining gateway → agent imports to remove (grep `@ai-fleet/shared/agent` under
`services/gateway/src/routes/`):

- ⏳ **OAuth flows** — `routes/codex.js`, `routes/claude.js` still import
  `agent/llm` (`ensureFresh*Tokens`, `resolveLlm`, `createChatModel` → pulls
  `@langchain/*`) and `agent/model-discovery`. Move the token-refresh helpers
  (SDK-free) to `shared-core`; relocate model-discovery + `createChatModel`
  behind the planner and have the gateway **proxy** `/api/codex/*` and
  `/api/claude/*`. **Preserve the exact OAuth redirect URIs** (Codex needs port
  1455 — see memory `codex-login-requires-port-1455`). Verify the browser
  redirect round-trip on the live stack before merge.
- ⏳ **Settings catalog + model-discovery** — `routes/settings.js` still imports
  `agent/runtimes` (harness catalog — serve from the settings-service
  `/universe` + `runtimeCatalog`), `agent/settings-patch`, `agent/model-discovery`
  (lazy), and `agent/workspace` (`repoParts`). Move `repoParts` to `shared-core`;
  serve the catalog/patch surface from the settings service; gateway proxies.
- ⏳ **Observability** — `routes/observability.js` imports `agent/analytics`,
  `agent/diagnostics` (SDK-free — probes via `require.resolve`), and
  `agent/workflow-patterns` (SDK-free). Move diagnostics + workflow-patterns
  catalog to `shared-core` (or proxy to the orchestrator); relocate analytics.
- ⏳ **Businesses** — `routes/businesses.js` only needs `repoParts` — resolves
  once `repoParts` moves to `shared-core`.
- ⏳ **Localization** — `routes/localization.js` imports `agent/localization`
  (LLM-backed) — proxy to the planner.

## Definition of done for Phase 2

`grep -r "@ai-fleet/shared/agent" services/gateway/src` returns nothing, the
gateway boots importing only `@ai-fleet/shared-core`, and every relocated
endpoint still answers through the gateway proxy (OAuth round-trip verified).
