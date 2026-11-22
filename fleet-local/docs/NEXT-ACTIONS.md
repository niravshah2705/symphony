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
