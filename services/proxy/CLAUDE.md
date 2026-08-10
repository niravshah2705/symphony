# CLAUDE.md — AI agent guide for the egress proxy sidecar

Read this before changing `services/proxy`. It encodes the invariants that keep
credential isolation correct.

## What this is

An **authenticating reverse proxy** that runs as a Cloud Run sidecar next to each
agent runtime (planner / coder-control / coder-worker). The agent routes every
third-party call to `http://127.0.0.1:4030/<prefix>` over the shared loopback;
this process holds (or resolves per-org) the real credential and injects it, then
re-originates TLS to the true upstream. The agent container therefore carries NO
raw provider key.

It is a reverse proxy (base-URL + git-remote rewrite), **not** a transparent
MITM/`HTTP_PROXY`: the agent's SDK/fetch base URLs already point here (via
`CONFIG.*` when `EGRESS_PROXY_URL` is set), so no CA distribution or TLS
interception is needed.

## Files

- `src/index.js` — HTTP server (`PROXY_PORT`, default 4030) + `/healthz`.
- `src/proxy.js` — the reverse-proxy core: `matchRoute` (longest-prefix), build
  the upstream URL, strip inbound auth + retarget Host, inject the credential,
  and **stream** both ways (SSE-safe — never buffer). Pure header/URL helpers are
  exported and unit-tested (`proxy.test.js`, `server.test.js`).
- `src/credentials.js` — resolve the credential per route: managed platform key
  (sidecar env) vs customer key (per-org vault). **Fail closed** when a customer
  key is selected but missing.
- `src/secrets-client.js` — S2S call to the settings vault resolver
  (`/internal/s2s/orgs/{orgId}/secrets`, `X-Internal-Token` + Cloud Run OIDC).
- `src/oauth-manager.js` — Claude/Codex OAuth: reads the per-namespace store
  token sets and refreshes on near-expiry (reuses
  `packages/shared/src/agent/oauth-tokens.js`, single in-flight refresh).

The prefix→upstream→credential contract is shared with the agent-side config in
`packages/shared/src/egress.js` (`EGRESS_ROUTES`) — change it there, not here.

## Invariants — DO NOT BREAK

1. **No open relay / SSRF.** The upstream is chosen ONLY from `EGRESS_ROUTES`
   (trusted config). An unmatched path is 404 — never honor a caller-supplied host.
2. **Strip inbound auth.** The sentinel the agent sends is never forwarded
   upstream; the proxy replaces it wholesale.
3. **Fail closed on credentials.** A missing customer key or a settings-resolve
   failure returns 5xx — never forward a request unauthenticated or with a wrong
   key. (Do NOT copy the settings-client's fail-open posture.)
4. **Never log secrets.** Log route prefixes + generic errors only; never request
   bodies, headers, or the S2S response.
5. **Stream, don't buffer.** LLM SSE + git packfiles are long-lived; pipe bodies.

## Per-org scope

This sidecar serves ONE org (`PROXY_ORG_ID`, injected by the provisioner for a
per-tenant stack; unset on the shared stack ⇒ managed-only, using the operator's
sign-in + mounted platform keys). `STORE_NAMESPACE` selects the tenant's store
for the OAuth token sets.

## Tests

`npm test` (node --test). Credential injection, fail-closed, routing, header
stripping, and the streaming server path are covered without any live upstream
(a stub `fetchImpl`/`oauthManager` is injected into `createProxyHandler`).
