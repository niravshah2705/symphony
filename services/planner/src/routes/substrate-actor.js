'use strict';

/**
 * Substrate actor-side run route.
 *
 * Inside a substrate actor, the planner image starts in "actor mode" and
 * serves POST /internal/plan/run. The atenet-router forwards the backend's
 * dispatchActorPrompt request here after checking `ate-target-actor`; the
 * request carries a short-lived actor JWT minted by ate-idp-server.
 *
 * The route verifies that JWT against the JWKS, then runs the planning stage
 * IN-PROCESS via `executeAgentRuntime` — never through `dispatchPlanning`,
 * which would recurse back into substrate. Credentials are already injected
 * by the egress gateway on the actor's outbound calls; nothing sensitive
 * crosses this request boundary.
 *
 * The router is only mounted when the process is running as an actor
 * (SUBSTRATE_ACTOR_MODE=true and SUBSTRATE_JWKS_URL set), so a normal
 * planner pod returns 404 for this path.
 */

const express = require('express');
const { executeAgentRuntime } = require('@ai-fleet/shared/agent/runtimes');
const { verifyActorJwt } = require('@ai-fleet/shared/agent/substrate-runner');
const { runWithRemoteTraceparent } = require('@ai-fleet/shared/agent/langfuse');
const { cleanTraceparent } = require('@ai-fleet/shared/traceparent');
const { getJwks } = require('../jwks');
const log = require('@ai-fleet/shared/logger');

function createSubstrateActorRouter({ verify = verifyActorJwt, runner = executeAgentRuntime, jwks = getJwks } = {}) {
  const router = express.Router();
  const audience = process.env.SUBSTRATE_ACTOR_JWT_AUDIENCE || 'substrate-router';
  const trustDomain = process.env.SUBSTRATE_TRUST_DOMAIN || 'cluster.local';

  router.post('/internal/plan/run', express.json({ limit: '2mb' }), async (req, res) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return res.status(401).json({ error: 'missing_actor_jwt' });

    let check;
    try {
      check = await verify(token, { audience, trustDomain, getJwks: jwks });
    } catch (err) {
      if (err && err.code === 'jwks_unconfigured') {
        log.error('substrate actor: JWKS not configured; refusing run');
        return res.status(503).json({ error: 'jwks_unconfigured' });
      }
      return res.status(500).json({ error: 'jwt_check_failed', message: String(err && err.message || err).slice(0, 200) });
    }
    if (!check.valid) return res.status(401).json({ error: check.reason || 'invalid_actor_jwt' });

    const body = req.body || {};
    if (!body.prompt || !String(body.prompt).trim()) {
      return res.status(400).json({ error: 'prompt_required' });
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
  return process.env.SUBSTRATE_ACTOR_MODE === 'true' && !!process.env.SUBSTRATE_JWKS_URL;
}

module.exports = { createSubstrateActorRouter, shouldMount };
