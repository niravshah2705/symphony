'use strict';

const express = require('express');
const { CONFIG } = require('@software-factory/shared-core/config');
const store = require('@software-factory/shared-core/store');
const catalog = require('@software-factory/shared-core/agent/guest-demo/catalog');
const { buildSkillCrSet, renderCrSet } = require('@software-factory/shared-core/agent/registry/agent-crset');
const { requirePermission, requireGuestOnly } = require('../auth');
const { createIpRateLimit } = require('../rate-limit');
const { createGuestDemoRunner, GuestDemoError } = require('../guest-demo-runner');
const { createGuestDeployerClient } = require('../guest-deployer-client');

/**
 * The guided demo an unauthenticated visitor gets.
 *
 *   GET  /api/guest/demo/commands        — the starter list, the notice copy, the retention numbers
 *   POST /api/guest/demo/command         — open a session for one clicked command
 *   POST /api/guest/demo/answer          — click an answer on the session's current node
 *   GET  /api/guest/demo/session/:id     — rehydrate this tab's transcript
 *
 * This router is LOCAL: no `createProxy`, no orchestrator hop, no tenant read.
 * Guest traffic therefore cannot reach tenant state even if a guard downstream is
 * weakened, because there is nowhere for the request to go. The only public
 * surface the demo touches is `knowledge-search`, and the browser calls that
 * itself with a query the server supplied.
 *
 * Everything the visitor can send is an id. Unknown ids are 400, a stale node is
 * 409, an aged-out session is 410 — and fields outside this table are ignored,
 * never forwarded, so a crafted body cannot smuggle a model, a worker pool, an
 * organization header or free text into the run.
 */
function createGuestDemoRouter(options = {}) {
  const config = options.config || CONFIG.GUEST_DEMO;
  // The deployer is a separate broker (§5) and the gateway never holds the
  // hosting credential, so it is reached only through the client. Without a
  // configured broker the flow still renders the plan and the CR set and marks
  // the preview step skipped.
  const deployer = options.deployer !== undefined
    ? options.deployer
    : config.deployerUrl ? createGuestDeployerClient({ baseUrl: config.deployerUrl, token: config.deployerToken }) : null;
  const runner = options.runner || createGuestDemoRunner({
    store,
    catalog,
    crset: { buildSkillCrSet, renderCrSet },
    config,
    deployer,
    // Injectable clock so the 1-day expiry is testable without waiting a day.
    ...(options.now ? { now: options.now } : {}),
  });
  const gates = { requirePermission, requireGuestOnly, ...(options.gates || {}) };
  const rateLimit = options.rateLimit
    || createIpRateLimit({ ...CONFIG.RATE_LIMIT.guest, enabled: CONFIG.AUTH.enabled });

  const router = express.Router();
  router.use(rateLimit);
  router.use(gates.requirePermission('workspace', { level: 'read' }));
  router.use(gates.requireGuestOnly());

  /** Report a runner refusal in the gateway's error shape, uncacheable. */
  function fail(res, error) {
    if (error instanceof GuestDemoError) {
      return res.status(error.status).set('Cache-Control', 'no-store').json({ error: error.message, code: error.code });
    }
    throw error;
  }

  /** Only the keys this route understands; anything else is dropped, not passed on. */
  function body(req, keys) {
    const source = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const picked = {};
    for (const key of keys) picked[key] = typeof source[key] === 'string' ? source[key] : undefined;
    return picked;
  }

  function handle(handler) {
    return (req, res) => {
      try {
        const outcome = handler(req, res);
        if (outcome && typeof outcome.then === 'function') {
          return outcome.then((payload) => res.set('Cache-Control', 'no-store').json(payload)).catch((error) => fail(res, error));
        }
        return res.set('Cache-Control', 'no-store').json(outcome);
      } catch (error) {
        return fail(res, error);
      }
    };
  }

  router.get('/commands', handle(() => runner.commands()));

  router.post('/command', handle((req) => {
    const { commandId } = body(req, ['commandId']);
    return runner.startSession({ commandId });
  }));

  router.post('/answer', handle((req) => {
    const { sessionId, nodeId, answerId } = body(req, ['sessionId', 'nodeId', 'answerId']);
    return runner.answer({ sessionId, nodeId, answerId });
  }));

  router.get('/session/:id', handle((req) => runner.getSession(req.params.id)));

  return router;
}

module.exports = { createGuestDemoRouter };
