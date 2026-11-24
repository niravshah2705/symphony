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

- **PR 1 — facade (landed; the shared gate now runs 29, see PR 2).** `apps/control-plane/src/a2a/`
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
  artifact at all** (the offline mock stub did until it learned to stream), which
  is now recorded as
  `the agent completed the turn without producing any output` instead of an
  unexplained empty bubble. Rotating the key then exposed a THIRD member of the
  same class, and it was being billed: a **retired model id** (`404 … is no
  longer available on OpenRouter`) and a run the controller **refused to start**
  (`input was not accepted; retry after the session becomes available`) both
  settled as `failed` and billed 49-82 s of harness retry for a turn that never
  reached a model. `MODEL_UNAVAILABLE` + `RUN_NOT_STARTED` now cover them — a
  bare `404` is deliberately not matched, because an agent's own tool can hit
  one and that compute is real. The card GET needs the identity headers too — the
  controller 401s a bare one, which is how `agentCard()` lost discovery.
  Legacy `/chat` was still working here — the relay shared the same pump — and PR
  3 deleted it once nothing on the browser side called it.
  Gate: `scripts/fixes/t31-a2a-facade-check.sh` (read-only; `REBUILD=1` to roll;
  waits for `/healthz` because a 1-replica rolling update can leave zero ready
  endpoints for minutes and every curl then answers `000`).
- **PR 2 — SPA switch (landed, then re-spoken by PR 3).** `apps/spa` now runs the
  real library runtime (`@assistant-ui/react@0.15.37` + `@assistant-ui/react-a2a@0.2.54`, headless
  primitives on our own `styles.css` — no Tailwind/shadcn):
  **Everything below about the A2A *client* is history**: PR 3 moved the browser
  leg to `@assistant-ui/react-ag-ui`, so `src/a2a/useFleetA2A.ts`,
  `src/a2a/artifacts.ts` and `ThoughtPanel.tsx` are deleted and
  `src/a2a/FleetA2AClient.ts` moved to `scripts/fixes/` (the live gate still
  drives it, and the A2A wire it proves is unchanged). What the library forced
  into the open still holds — it is the reason the facade reads the model from
  the message and refuses a run input with no thread handle.
  What runs today: `src/agui/{FleetAgUiAgent.ts,useFleetAgUi.ts}` inside
  `src/assistant-ui/{Thread,ui/ThreadView,TaskStatusBar,FailureNotice}.tsx`
  (library-styled markup + the vendored `.aui` stylesheet, mounted by `Shell.tsx`).
  A provider 401 is still an `incomplete (error)` bubble carrying the
  controller's own words plus Retry, never `(no output)`. What the library forced
  into the open, all of it verified against shipped source and the live facade:
  * it calls `streamMessage(message, configuration, void 0, signal)`, so
    per-message **metadata** is the only place the model choice can ride — and
    that is now proven end-to-end (gate 8), so the `x-fleet-model` header
    fallback is **deleted** rather than kept as a second path that can drift;
  * the agent-card parser is strict and card discovery gates every run, and a
    stream whose frames the client cannot type throws `…ended without any
    events` — the exact shape the old `(no output)` had, which is why the gate
    asserts typed events, not just HTTP 200;
  * its A2A role spelling is lowercase (`toWireMessage` maps `"user"` →
    `ROLE_USER`, anything else → `ROLE_UNSPECIFIED`). A mis-spelled role is
    refused by the facade with `400 INVALID_ARGUMENT` instead of silently
    starting a bad turn;
  * changing the client identity rebuilds its controller, so the client is
    pinned per conversation and switching sessions means a new client — not a
    new option on a stale one;
  * artifacts are NOT merged into message content (they live on
    `message.metadata.custom.a2a.artifacts`), which is why PR 2 needed a
    `ThoughtPanel` reading `useA2AArtifacts()` and an interim artifact bridge at
    all. AG-UI removed the need: the encoder turns answer text and thoughts into
    `TEXT_MESSAGE_*` / `REASONING_*` events server-side, so both bridge files are
    gone and the library renders the parts. Still contract +
    plumbing: nothing emits a thought part yet (PR 4).
  Cost of the switch: the SPA bundle went 240 kB → 698 kB (211 kB gzip) and now
  trips Vite's 500 kB chunk warning; the AG-UI leg costs more again — `@ag-ui/client`
  brings rxjs, and `@assistant-ui/react-ag-ui` peers on zod v4 — for
  1 334 kB (378 kB gzip). Chunking it is open work, not a gate. Not yet rewritten: the card's
  `capabilities`, which advertises `pushNotifications` / `extendedAgentCard`
  while the facade answers both with `501`. `message:send` exists server-side
  and the SPA never uses it (it streams). Browser click-through is still manual:
  a normal answer, an inline 401 with Retry, a >60 s turn, an `input-required`
  pause. Gate 8 asserts answer *content* when `ANSWER_MODEL` names a model that
  actually generates, and the gate's own assertion passes for each of the three
  healthy catalog entries — `nemotron`, `nemotron-claude` and `nemotron-codex`
  (the claude harness delivers its text in `artifactUpdate` frames, the other two
  in the task's status message; all three reach the client). `mock` streams two
  SSE deltas through LiteLLM now, so it reaches the client as artifact text too;
  the silent-completion case the notice exists for is left to a model that
  settles a turn without parts, which unit tests cover rather than the stub.
- **PR 3 — the browser leg is AG-UI, and the bespoke relay is gone (landed).**
  Northbound stays A2A; only the southbound protocol changed.
  *server*: `apps/control-plane/src/agui/{encode,runinput,server}.ts` +
  `routes/agui.ts` — `POST /api/agui/orgs/{orgId}/projects/{projectId}/agent`, its
  own Fastify scope so a refusal is plain `{error:{message,code,reason}}` JSON
  instead of an `A2AError` body an AG-UI client would report as a transport
  failure. `encode.ts` is pure (A2A frames in, `RUN_STARTED` / `TEXT_MESSAGE_*` /
  `REASONING_*` / one terminal event out) and unit-tested without a cluster;
  `runinput.ts` reads the `RunAgentInput` and hands `openTurn` the SAME `RestTurn`
  the A2A leg builds, so conversation resolution, model selection, ownership and
  metering cannot drift into two ideas of a turn. A pause becomes
  `RUN_FINISHED{outcome:interrupt}` whose `interrupt.id` IS the paused A2A task,
  and a `resume` entry answers it.
  *browser*: `apps/spa/src/agui/{FleetAgUiAgent.ts,useFleetAgUi.ts}`. The thread
  handle is the client's own (`crypto.randomUUID()` per conversation, stored as
  `sessions.thread_id`) because the app must never name kagent's context id;
  `FleetAgUiAgent` overrides `prepareRunAgentInput` to put the model on
  `forwardedProps`, the one channel `UseAgUiRuntimeOptions` does not expose. A
  conversation switch is a React remount (`key={projectId:threadId}`), not an
  agent option — `useAgUiRuntime` builds its controller once and `updateOptions`
  never clears the transcript.
  *deleted*: `/chat` + `kagent/proxy.ts` + `Chat.tsx` + `api.chat`/`api.agentCard`
  + the private `event: session` frame + the chat's bespoke CSS (`.bubble`,
  `.composer`, `.messages`, `.thought`). `verify-e2e.sh` §4 wording followed.
  Gates: 6 asserts `POST /chat → 404` (a route that comes back, or an SPA fallback
  swallowing `/api`, both fail it); 9 drives the AG-UI run end-to-end and reads
  `sessions.thread_id` + `outcome` back off the row.
  **Not yet run against the live cluster** — gate 9 and the 404 need a BFF image
  built from this tree (`REBUILD=1 scripts/fixes/t31-a2a-facade-check.sh`), and the
  browser click-through the user does themselves.
- **PR 4 — make the unreachable features real:** `mcp_require_approval` in the
  tenant chart (no Agent CR sets `requireApproval` today), HITL extension
  declaration + approval payload, and thought-part emission. The card already
  advertises `https://kagent.dev/extensions/hitl/v1`, so only the CR field and
  the harness emission are missing.

The OpenRouter key behind LiteLLM was dead and **was rotated 2026-11-23** into
`litellm-fleet-secrets` `OPENROUTER_API_KEY` (+ `rollout restart deploy/litellm`);
`nemotron`, `nemotron-claude` and `nemotron-codex` now answer real text through
the facade and the browser client. What is still broken is a **retired model id**:
the `claude` catalog entry maps to `openrouter/anthropic/claude-sonnet-4`, which
OpenRouter no longer serves at all (`404 … is no longer available … no provider
serves this model anymore`). Fix = a live slug in **two** places that must move
together: `deploy/litellm/values-base.yaml` `model_list` (e.g.
`anthropic/claude-sonnet-4.6`) and `deploy/bff/configmap.yaml`'s `FLEET_MODELS`
`model` field — LiteLLM matches `model_name` verbatim, so one without the other
just moves the failure. `/api/v1/models` lies with a 200 either way; only
generation proves it.
