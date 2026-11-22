# fleet-local — next actions plan

Updated 2026-11-21 ~10:00 UTC. **T-08 is RESOLVED** — root cause was the
`kagent-controller-ingress` NetworkPolicy not admitting the atenet-egress
gateway pods (ns `ate-system`, app `atenet-egress`) on :8083, so every
actor→controller bootstrap upstream connect was packet-dropped and burned the
gateway's ~3 s connect deadline. See TROUBLESHOOTING.md T-08 attempts 13–15.
Fix: `scripts/fixes/t08-egress-np-fix.sh` (idempotent).

**2026-11-21 later: final setup deliverable landed** — `scripts/setup-env.sh`
(11 steps, helm-first, idempotent, reuses every existing script unchanged) +
`scripts/setup/s0X-*.sh` + `deploy/{setup,litellm,substrate,kagent,observability}`
values/manifests (sanitized, no plaintext creds) + docs
`SETUP-ENVIRONMENT.md` / `AUTH-CONFIGURATION.md`. The T-08 ate-system NP entry
is now part of `deploy/networkpolicy/kagent-controller.yaml` itself.
NOTE: `helm -n ate-system list` showed substrate `pending-upgrade` at
recon time (user ran an upgrade in another thread) — confirm it reached
`deployed` before the next timing-sensitive test.

## State snapshot (current)

- NetworkPolicy `kagent -n kagent get networkpolicy kagent-controller-ingress`
  now allows kagent + fleet-system + (ate-system AND app=atenet-egress) on 8083.
- kagent-controller `server.auth.mode` = **`trusted-proxy`** (`userIdClaim:
  email`) — reverted from the temporary `insecure` test; confirmation build in
  progress (`org-demo/demo-agent-worker`, retry 1 — first attempt hit a cold
  4 s upstream right after the controller restart).
- Egress cm `atenet-egress-agentgateway-config` restored **verbatim** with the
  `substrateEgress` policy (the bypass test proved the policy is load-bearing:
  it injects the bootstrap `Authorization` header; without it the gateway
  rejects with "missing substrate egress request policy" in ~1 ms).
- Workerpools: org-demo=1, org-prod=1, org-nirav=0, kagent-default=1.
- Agents: org-demo Ready=True and org-prod Ready=True under `insecure`;
  org-nirav Ready. Beyla up with 1Gi limit (verify /metrics under load — T-14).
- Node: load was 5–8 earlier; recheck before heavy tests (quiet-window rule).

## Next: plan verification gate (tasks #9–#10)

0. **Headless wake verified (10:12 UTC):** port-forward :8083 → MCP
   `initialize`/`tools/list`/`invoke_agent` with a self-signed trusted-proxy
   JWT (email claim) → actor Restore from golden snapshot (12.6 s), LiteLLM
   `openai/mock-gpt` 200 OK, `TASK_STATE_COMPLETED`, Checkpoint gen-2 in 1.4 s.
   Reuse: `scripts/fixes/t08-egress-np-fix.sh` verify block + this flow.
1. Task #9 cluster-side gate: **DONE** — trusted-proxy confirmation build
   reached Ready=True (retry 2, 09:58 UTC; `demo-agent-worker` golden snapshot
   taken with `server.auth.mode=trusted-proxy`). The single failed attempt in
   between was the T-12 starvation burst (`no children to pick from`), not a
   regression. Remaining for #9: Google OAuth edge verification (login →
   identity headers via app.fleet.dev / kagent.local).
2. Wizard run: onboard org-demo end-to-end via https://app.fleet.dev, re-run →
   zero duplicates, UUID parity check (org/team/customer/labels same UUID).
3. `scripts/verify-e2e.sh` 12-point gate: chat SSE, llm-mock baggage echo,
   Flexprice ai.usage + fleet.actor_compute read-backs, Langfuse trace link,
   limits 429 test, spoofed-header strip test.
4. T-14 close-out: scrape Beyla /metrics under agent traffic with the 1Gi
   limit; if populated, keep for future latency work; if not, uninstall
   (`helm -n monitoring uninstall beyla`) — it cost a node-pressure episode.
5. Housekeeping:
   - demo harness snapshot scheme: chart `s3://` vs hand-patched `gs://` —
     reconcile in values so a helm re-render doesn't revert it.
   - `seed-demo-snap` sidecar: keep or remove deliberately.
   - Persist workerpool replicas in values if keeping org-nirav dormant.
   - Consider folding the NP allow-entry into the tenant-onboarding steps
     (BFF gate script) so future org-* namespaces get the same rule — note:
     the NP lives in the `kagent` ns and is cluster-shared, so one patch
     covers all tenants; no per-org action needed.

## Capacity guardrails (from T-12, still active)

- Keep org-nirav pool at 0 unless testing it; one tenant ≈ 1 CPU / 1 Gi.
- Watch for poll storms: any NotReady agent with retry backoff hammers
  `GetActorTemplate`; pause the pool instead of deleting the agent.
- Before any timing-sensitive test: quiet-window rule (load < 6, no probe
  failures for 2 min, ate-idp-server stable).
- If OOM recurs: Docker Desktop memory first, then trim flexprice-frontend /
  langfuse-web requests+limits.

## T-31 chat: BFF as an A2A facade (in progress, 2026-11-23)

Root cause write-up lives in TROUBLESHOOTING.md T-19 (`(no output)` + the
billing blind spot). Four PRs, one seam:

- **PR 1 — facade (landed, 20/20 in-cluster gates pass).** `apps/control-plane/src/a2a/`
  (`contract.ts` classification + settlement policy, `translate.ts` wire reading
  + card rewrite, `facade.ts` orchestration + SSE pump) and `routes/a2a.ts`
  (one wildcard per project under `/api/a2a/orgs/{orgId}/projects/{projectId}`,
  `application/a2a+json` parser, A2A-shaped error handler). `sessions` gains
  `outcome`, `close_reason`, cumulative `meter_seconds`, `billed_seconds`,
  `awaiting_since`, `turn`, `metered_seconds`, `metered_outcome`; the sweeper
  bills the **delta** per turn and writes off a platform-fault turn at 0.
  Two rules the live cluster forced into the open: a dead provider key arrives
  as an ordinary `TASK_STATE_FAILED` with the provider's text, so
  `isPlatformFault` re-labels it `upstream_error` (never billed) while any
  failure it cannot name stays billable; and a task can complete with **no
  artifact at all** (the mock worker does), which is now recorded as
  `the agent completed the turn without producing any output` instead of an
  unexplained empty bubble. The card GET needs the identity headers too — the
  controller 401s a bare one, which is how `agentCard()` lost discovery.
  Legacy `/chat` still works — `kagent/proxy.ts` now shares the same pump.
  Gate: `scripts/fixes/t31-a2a-facade-check.sh` (read-only; `REBUILD=1` to roll;
  waits for `/healthz` because a 1-replica rolling update can leave zero ready
  endpoints for minutes and every curl then answers `000`).
- **PR 2 — SPA switch** to `@assistant-ui/react` + `@assistant-ui/react-a2a`
  (headless primitives, no Tailwind/shadcn), `FleetA2AClient` for the model
  metadata, and the failure/status surface: `incomplete (error)` + the agent's
  own reason inline + Retry, `TaskStatusBar` for the 9 states, `ThoughtPanel`
  fed by the reasoning artifact. Model choice rides on message **metadata**,
  proven live: gate 5 posts `{"fleet.dev/model":"not-a-model"}` and gets a 400
  `unknown_model`, so the facade is reading it (and strips it before kagent
  sees it). The `x-fleet-model` header path is the redundant fallback — PR 2
  should delete it unless another client needs it. Also carry the facade gaps:
  it does NOT rewrite the card's `capabilities`, which advertises
  `pushNotifications: true` and `extendedAgentCard: true` while the facade
  answers both with `501` (`push_notifications_unsupported`), and `message:send`
  exists server-side but the SPA never uses it (it streams).
- **PR 3 — delete the bespoke relay:** `/chat`, `Chat.tsx`, `api.chat`, the
  private `event: session` frame, `verify-e2e.sh` §4 wording.
- **PR 4 — make the unreachable features real:** `mcp_require_approval` in the
  tenant chart (no Agent CR sets `requireApproval` today), HITL extension
  declaration + approval payload, and thought-part emission. The card already
  advertises `https://kagent.dev/extensions/hitl/v1`, so only the CR field and
  the harness emission are missing.

Blocking any visible test: the OpenRouter key behind LiteLLM is dead
(`/api/v1/models` lies with a 200 — only generation proves it). Rotate, patch
`litellm-fleet-secrets` `OPENROUTER_API_KEY`, `rollout restart deploy/litellm`.
