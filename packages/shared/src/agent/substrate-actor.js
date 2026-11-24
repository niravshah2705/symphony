'use strict';

/**
 * Substrate actor-side run route.
 *
 * Inside a substrate actor, the actor image (deploy/gcp/Dockerfile.substrate-
 * actor, entered via services/orchestrator/src/substrate-actor-entry.js) serves
 * POST /internal/plan/run. The atenet-router forwards the backend's
 * dispatchActorPrompt request here after checking `ate-target-actor`; the
 * request carries a short-lived actor JWT minted by ate-idp-server.
 *
 * The route verifies that JWT against the JWKS, then runs the planning stage
 * IN-PROCESS via `executeAgentRuntime` — never through `dispatchPlanning`,
 * which would recurse back into substrate. Credentials are already injected
 * by the egress gateway on the actor's outbound calls; nothing sensitive
 * crosses this request boundary.
 *
 * The router is only mounted when the process is running as an actor and can say
 * what a token must be for (SUBSTRATE_ACTOR_MODE=true + SUBSTRATE_JWKS_URL +
 * SUBSTRATE_ACTOR_JWT_AUDIENCE), so a normal planner pod returns 404 for this path
 * and a half-configured actor pod does not start at all.
 */

const express = require('express');
const { executeAgentRuntime } = require('./runtimes');
const { verifyActorJwt } = require('./substrate-runner');
const { resolveSubstrateAtespace } = require('./substrate');
const { runWithRemoteTraceparent } = require('./langfuse');
const { cleanTraceparent } = require('@software-factory/shared-core/traceparent');
const { getJwks } = require('./substrate-jwks');
const log = require('../logger');

// getJwks error codes that mean "this pod cannot check signatures", as opposed to
// "this token is bad". The first is a 503 an operator must see; the second is a 401.
const JWKS_FAULT = new Set(['jwks_unconfigured', 'jwks_empty']);

function createSubstrateActorRouter({
  verify = verifyActorJwt,
  runner = executeAgentRuntime,
  jwks = getJwks,
  resolveAtespace = resolveSubstrateAtespace,
} = {}) {
  const router = express.Router();
  // No default. 'substrate-router' is the audience the ROUTER is minted for, and
  // spelling it here as a fallback meant any consumer that guessed the same string
  // accepted the same token — one mint authenticating at every hop. The audience is
  // now a declared deployment fact (SUBSTRATE_ACTOR_JWT_AUDIENCE), and the dispatcher
  // mints for that same declared value.
  const audience = process.env.SUBSTRATE_ACTOR_JWT_AUDIENCE || '';
  const trustDomain = process.env.SUBSTRATE_TRUST_DOMAIN || 'cluster.local';

  router.post('/internal/plan/run', express.json({ limit: '2mb' }), async (req, res) => {
    if (!audience) return res.status(503).json({ error: 'actor_audience_unconfigured' });
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return res.status(401).json({ error: 'missing_actor_jwt' });

    let check;
    try {
      check = await verify(token, { audience, trustDomain, getJwks: jwks });
    } catch (err) {
      // Anything the JWKS seam itself got wrong is OUR fault, not the caller's:
      // 503 says "this pod cannot verify anything right now", where 401/500 would
      // send an operator chasing a token that was fine.
      const code = err && err.code;
      if (JWKS_FAULT.has(code)) {
        log.error(`substrate actor: JWKS unavailable (${code}); refusing run`);
        return res.status(503).json({ error: code });
      }
      return res.status(500).json({ error: 'jwt_check_failed', message: String(err && err.message || err).slice(0, 200) });
    }
    if (!check.valid) return res.status(401).json({ error: check.reason || 'invalid_actor_jwt' });

    const body = req.body || {};
    if (!body.prompt || !String(body.prompt).trim()) {
      return res.status(400).json({ error: 'prompt_required' });
    }

    // A verified JWT says WHICH WORKLOAD is calling; it does not say which tenant it
    // may serve. `body.organizationId` used to reach the harness on the strength of
    // `check.valid` alone, so one legitimately minted actor token could run a plan
    // with another organization's settings. The actor's own atespace is the
    // server-side fact — it comes from the ActorTemplate env the control plane wrote,
    // never from this request — so any organization named by the caller has to resolve
    // to exactly that space. Both a mismatch and an unresolvable name are 404: this
    // route must not confirm that another tenant exists while refusing it.
    let homeAtespace;
    try {
      homeAtespace = resolveAtespace({});
    } catch {
      homeAtespace = null;
    }
    if (!homeAtespace) return res.status(503).json({ error: 'actor_atespace_unresolved' });
    if (body.organizationId) {
      let claimedAtespace = null;
      try {
        claimedAtespace = resolveAtespace({ organizationId: String(body.organizationId) });
      } catch {
        claimedAtespace = null;
      }
      if (claimedAtespace !== homeAtespace) {
        log.warn(`substrate actor: refused a run claiming org ${String(body.organizationId)} outside this actor's atespace`);
        return res.status(404).json({ error: 'context_not_found' });
      }
    }

    // The caller's trace continues into this process: the header is the only
    // thing that ties an actor's log lines and spans to the run that created it,
    // and an actor that starts its own trace makes every run look like two.
    const traceparent = cleanTraceparent(req.headers.traceparent);

    // Never route through dispatchPlanning here — that would send the request
    // back out to substrate and loop. Run the harness directly.
    async function execute() {
      try {
        const result = await runner({
          runtime: body.runtime || body.agentRuntime,
          workflowPattern: body.workflowPattern,
          workflow: body.workflow,
          stage: body.stage || 'planning',
          prompt: String(body.prompt),
          llm: body.llm,
          organizationId: body.organizationId,
          projectId: body.projectId,
          projectName: body.projectName,
          settings: body.settings || {},
          invokeConfig: { runId: body.runId, actorVerified: true, actorSub: check.claims && check.claims.sub },
          ctx: {
            organizationId: body.organizationId,
            projectId: body.projectId,
            projectName: body.projectName,
            stage: body.stage || 'planning',
          },
        });
        const finalText = (result && result.finalText) || '';
        res.json({
          finalText,
          messages: Array.isArray(result && result.messages) ? result.messages : [{ role: 'assistant', content: finalText }],
          model: (body.llm && body.llm.model) || null,
          // Metering is the caller's job: this process was created by an
          // ActorTemplate that sets no env at all (substrate.js upsertActorTemplate),
          // so it has no tenant store to write a usage record to. We only report
          // what the run consumed; the planner pod that dispatched us owns the
          // billing write. See billing/usage.js recordUsage.
          usage: (result && result.usage) || null,
          costUsd: (result && result.costUsd) ?? null,
          traceId: (result && result.traceId) || null,
        });
      } catch (err) {
        const status = err && (err.statusCode || err.httpStatus) || 500;
        log.error(`substrate actor: planning failed: ${err && err.message || err}`);
        res.status(status).json({ error: 'planning_failed', message: String((err && err.message) || err).slice(0, 300) });
      }
    }

    return runWithRemoteTraceparent(traceparent, () => log.runWithContext({
      organizationId: body.organizationId,
      projectId: body.projectId,
      runId: body.runId,
      traceparent,
    }, execute));
  });

  return router;
}

function shouldMount() {
  return process.env.SUBSTRATE_ACTOR_MODE === 'true'
    && !!process.env.SUBSTRATE_JWKS_URL
    && !!process.env.SUBSTRATE_ACTOR_JWT_AUDIENCE;
}

/**
 * Actor mode asked for a verifier but did not say what the token must be for. The
 * mount gate above answers by staying shut, which is safe but silent — the run fails
 * as a 404 from the router and reads like a dead cluster. The startup check turns it
 * into a container that will not come up.
 */
function actorModeFault() {
  if (process.env.SUBSTRATE_ACTOR_MODE !== 'true') return '';
  const missing = ['SUBSTRATE_JWKS_URL', 'SUBSTRATE_ACTOR_JWT_AUDIENCE'].filter((name) => !process.env[name]);
  if (!missing.length) return '';
  return `SUBSTRATE_ACTOR_MODE is true but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set`;
}

module.exports = { createSubstrateActorRouter, shouldMount, actorModeFault };
