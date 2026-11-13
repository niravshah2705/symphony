'use strict';

const express = require('express');
const { CONFIG } = require('@ai-fleet/shared-core/config');
const log = require('@ai-fleet/shared-core/logger');
const { asyncHandler } = require('@ai-fleet/shared-core/util');
const store = require('@ai-fleet/shared-core/store');
const ledger = require('@ai-fleet/shared-core/billing/ledger');
const gate = require('@ai-fleet/shared-core/billing/gate');
const { SHARED_ORG_ID } = require('@ai-fleet/shared-core/billing/org-context');
const cashfreeClient = require('@ai-fleet/shared-core/billing/cashfree-client');
const { processBillingSweep } = require('@ai-fleet/shared-core/billing/sweep');
const outboxDrain = require('@ai-fleet/shared-core/billing/outbox-drain');
const billingApi = require('./billing-api');
const { sweepActorSessions } = require('./actor-session-sweeper');
const { renderDashboardHtml } = require('./ui');

function createStoreHydrationMiddleware(initStore) {
  return function bindStoreContext(_req, _res, next) {
    Promise.resolve().then(() => initStore()).then(() => next(), next);
  };
}

function createApp(options = {}) {
  const app = express();
  const hydrateStore = createStoreHydrationMiddleware(options.initStore || store.initStore);

  // Cashfree signs the raw request body, so keep the bytes express consumed for
  // the webhook's HMAC check.
  app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
  }));

  // Probes
  app.get('/healthz', (req, res) => res.json({ status: 'ok', service: 'billing' }));
  app.get('/readyz', (req, res) => res.json({ status: 'ok', service: 'billing' }));

  // Billing state (accounts, ledger, usage records) is intentionally global, so
  // every route below reads the store's legacy entry rather than a per-workspace
  // one. The Firestore backend refuses those reads until initStore() has hydrated
  // the entry, and the reads are synchronous, so hydration has to happen here
  // rather than at the call sites. initStore() is idempotent and deduplicates
  // concurrent callers; it stays out of the probes above so readiness never
  // depends on the database.
  app.use(hydrateStore);

  // Standalone Basic UI Dashboard
  app.get('/', asyncHandler(async (req, res) => {
    const orgId = CONFIG.BILLING.orgId || SHARED_ORG_ID;
    const account = ledger.ensureAccount(orgId);
    // The balance on this page is the wallet's, read now — the account document
    // has no balance field to render any more.
    const fund = await gate.ensureFundStatus(orgId);
    const html = renderDashboardHtml({
      account,
      fund,
      cashfreeConfigured: cashfreeClient.isConfigured(),
      environment: process.env.CASHFREE_ENV || 'sandbox',
    });
    res.set('Content-Type', 'text/html').send(html);
  }));
  app.get('/ui', (req, res) => res.redirect('/'));

  // Cloud Scheduler / PubSub sweep tick target
  app.post('/pubsub/billing-tick', asyncHandler(async (req, res) => {
    try {
      const result = await processBillingSweep();
      log.info(`Billing sweep completed via /pubsub/billing-tick: ${JSON.stringify(result)}`);
      // The drain is its own step, and its own failures: a tick must not report
      // 500 because FlexPrice was unreachable, or Cloud Scheduler replays the
      // sweep too, and the outbox already says exactly what is undelivered.
      const actorSessions = await (options.sweepActorSessions || sweepActorSessions)().catch(() => {
        log.error('actor_session_sweep_failed');
        return null;
      });
      const outbox = await (options.drainOutbox || outboxDrain.drainOnce)().catch((err) => {
        log.error(`Billing outbox drain failed: ${err && err.message ? err.message : err}`);
        return null;
      });
      return res.status(200).json({ status: 'ok', result, actorSessions, outbox });
    } catch (err) {
      log.error(`Billing sweep error: ${err && err.message ? err.message : err}`);
      return res.status(500).json({ error: err && err.message ? err.message : 'Sweep error' });
    }
  }));

  // Recharge, platform charge, credit expiry and reconciliation run as Cloud Run
  // Jobs (billing_job.tf); locally run their entrypoints with node directly.

  // Billing API. Mounted under /api/billing for the gateway proxy and under / for
  // callers that use the bare paths.
  app.use('/api/billing', billingApi);
  app.use('/', billingApi);

  // Central JSON error handler. Without it every asyncHandler rejection falls to
  // Express's default handler, which answers with an HTML 500: the gateway copies
  // the upstream status through verbatim and the SPA's JSON parse then degrades to
  // "Request failed (500)", so a provider rejection such as Cashfree's 401
  // authentication_failed reaches the browser as an unattributable Internal Server
  // Error. Handlers carry the HTTP status + code they want surfaced in err.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = Number(err && err.status) || 500;
    if (status >= 500) {
      log.error(`billing request failed: ${err && err.message ? err.message : err}`, {
        code: err && err.code ? err.code : null,
        providerStatus: err && err.providerStatus ? err.providerStatus : null,
        providerCode: err && err.providerCode ? err.providerCode : null,
        path: req.path,
      });
    }
    if (res.headersSent) return next(err);
    return res.status(status).json({
      error: err && err.message ? err.message : 'Server error.',
      ...(err && err.code ? { code: err.code } : {}),
    });
  });

  return app;
}

module.exports = { createApp };
