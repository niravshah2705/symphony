'use strict';

/**
 * Substrate actor image entry — the only process an actor runs.
 *
 * Being invoked as this entry IS the actor-mode decision: the image's CMD is
 * used exclusively by ActorTemplate containers, so no SUBSTRATE_ACTOR_MODE
 * predicate gates the mount here (agent-server/app.js keep their own gate for
 * the control-plane image). The process serves exactly
 *   POST /internal/plan/run — actor-JWT verified, own JSON parser
 *   GET  /healthz           — the ActorTemplate wakeupProbe
 * and nothing else: no agent surface, no pipeline controller, and never a
 * dispatch through dispatchPlanning, which would recurse back into substrate.
 * Without SUBSTRATE_JWKS_URL the route answers 503 jwks_unconfigured, so a
 * half-provisioned actor fails closed instead of accepting prompts.
 */

const express = require('express');
const log = require('@ai-fleet/shared-core/logger');
const { createSubstrateActorRouter } = require('@ai-fleet/shared/agent/substrate-actor');

const app = express();
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
app.use(createSubstrateActorRouter());

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => log.info(`substrate actor listening on :${port}`));
