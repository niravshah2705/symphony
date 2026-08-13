# Archived gateway agent endpoints

This directory is historical reference only. Nothing here is imported by or
copied into the gateway image.

The gateway decoupling is complete: browser authentication/authorization,
billing, EULA enforcement, request publishing, SSE, and reverse-proxy routing
remain in `services/gateway`; model/SDK-aware handlers execute in the planner.
The browser-facing URLs did not change.

| Public gateway surface | Execution owner |
| --- | --- |
| Live `/api/settings/*` handlers (including Codex and Claude) | planner |
| `/api/observability/*` | planner |
| `/api/locale/*` | planner |
| `/api/projects`, `/api/issues`, `/api/businesses`, `/api/roles` | planner |
| `/api/agent/*` | planner |
| `/api/coder/*` | coder |

The former Codex browser credential-management endpoints are intentionally
gone. The gateway returns explicit `Cache-Control: no-store` HTTP 410 responses
for:

- `GET /api/settings/codex/login`
- `GET /api/settings/codex/_pending`
- `GET /auth/callback`
- `DELETE /api/settings/codex` (the old browser sign-out)

`codex-oauth-redirect.js` records the removed implementation for archaeology;
it is not a restoration plan. Codex credentials are imported and deleted only
through the separate privileged settings-service operator surface, which the
browser-facing gateway refuses to proxy.

The enforced boundary is:

- `services/gateway` declares only `@ai-fleet/shared-core` among AI Fleet
  packages;
- gateway source does not import `@ai-fleet/shared`, LangChain, DeepAgent, or an
  agent SDK;
- `deploy/gcp/Dockerfile.gateway` copies only the gateway and shared-core
  workspaces.
