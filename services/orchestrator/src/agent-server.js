'use strict';

/**
 * Agent service entry — the standalone boot for the surface the retired Cloud
 * Run planner service owned: the gateway-facing /api routes, the legacy
 * /pubsub push surface, the pipeline plan-stage command endpoint, and the
 * substrate actor router when this process runs as an actor.
 *
 * In the cloud the same surface is also mounted inside the pipeline
 * orchestrator app (services/orchestrator/src/app.js) so one service answers;
 * this entry exists for local development (scripts/start-all.js) and as the
 * substrate actor image's CMD, where the pipeline controller must not run.
 */

const express = require('express');
const { CONFIG } = require('@ai-fleet/shared-core/config');
const log = require('@ai-fleet/shared-core/logger');
const { initStore } = require('@ai-fleet/shared/store');
const scheduler = require('@ai-fleet/shared/agent/scheduler');
const { reportBoot: reportBillingGateBoot } = require('@ai-fleet/shared/billing/gate');
const { createAgentSurface } = require('./agent-surface');
const {
  createSubstrateActorRouter,
  shouldMount: shouldMountSubstrateActor,
  actorModeFault: actorModeMisconfigured,
} = require('@ai-fleet/shared/agent/substrate-actor');

const app = express();

// Substrate actor mode: mounted only when this process is running as an actor
// (SUBSTRATE_ACTOR_MODE=true + SUBSTRATE_JWKS_URL + SUBSTRATE_ACTOR_JWT_AUDIENCE).
// The route owns its own actor-JWT check and JSON parser and bypasses gateway auth —
// inside the actor there is no gateway; the atenet-router already forwarded by
// `ate-target-actor`.
// Half-configured actor mode is a startup failure, not a quiet 404: an actor that
// cannot say what audience it accepts cannot authenticate anything, and a container
// that starts anyway shows up as an unreachable cluster rather than a bad deploy.
const substrateActorFault = actorModeMisconfigured();
if (substrateActorFault) {
  log.error(`substrate actor mode: ${substrateActorFault}; refusing to start this process`);
  throw new Error(`substrate actor mode misconfigured: ${substrateActorFault}`);
}
if (shouldMountSubstrateActor()) {
  app.use(createSubstrateActorRouter());
}

app.use(createAgentSurface());

function start() {
  const port = Number(process.env.PORT) || CONFIG.SERVICES.agentPort;
  return initStore()
    .then(() => new Promise((resolve) => {
      const server = app.listen(port, () => {
        log.info(`AI Fleet agent service running at http://localhost:${port}`);
        // The scheduler and /enqueue both ask the gate, so say which rule is in force.
        reportBillingGateBoot();
        if (CONFIG.MESSAGING_MODE !== 'pubsub' && !CONFIG.PIPELINE.orchestratorEnabled) {
          scheduler.startScheduler();
        }
        resolve(server);
      });
      const shutdown = () => server.close();
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    }));
}

if (require.main === module) {
  start().catch((err) => {
    log.error(`agent service failed to initialize store: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}

module.exports = { app, start };
