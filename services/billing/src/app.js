'use strict';

const express = require('express');
const { CONFIG } = require('@ai-fleet/shared-core/config');
const log = require('@ai-fleet/shared-core/logger');
const { asyncHandler, sendError } = require('@ai-fleet/shared-core/util');
const store = require('@ai-fleet/shared-core/store');
const ledger = require('@ai-fleet/shared-core/billing/ledger');
const { SHARED_ORG_ID } = require('@ai-fleet/shared-core/billing/org-context');
const cashfreeClient = require('@ai-fleet/shared-core/billing/cashfree-client');
const { processBillingSweep } = require('@ai-fleet/shared-core/billing/sweep');
const billingApi = require('./billing-api');
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
  app.get('/', (req, res) => {
    const orgId = CONFIG.BILLING.orgId || SHARED_ORG_ID;
    const account = ledger.ensureAccount(orgId);
    const html = renderDashboardHtml({
      account,
      cashfreeConfigured: cashfreeClient.isConfigured(),
      environment: process.env.CASHFREE_ENV || 'sandbox',
    });
    res.set('Content-Type', 'text/html').send(html);
  });
  app.get('/ui', (req, res) => res.redirect('/'));

  // Cloud Scheduler / PubSub sweep tick target
  app.post('/pubsub/billing-tick', asyncHandler(async (req, res) => {
    try {
      const result = await processBillingSweep();
      log.info(`Billing sweep completed via /pubsub/billing-tick: ${JSON.stringify(result)}`);
      return res.status(200).json({ status: 'ok', result });
    } catch (err) {
      log.error(`Billing sweep error: ${err && err.message ? err.message : err}`);
      return res.status(500).json({ error: err && err.message ? err.message : 'Sweep error' });
    }
  }));

  // Billing API. Mounted under /api/billing for the gateway proxy and under / for
  // callers that use the bare paths.
  app.use('/api/billing', billingApi);
  app.use('/', billingApi);

  // Terminal error handler. Without it Express answers a thrown error with its
  // own 500 page, so a Cashfree rejection (or a malformed body) reached the
  // browser as an undiagnosable 500 instead of the status + message the service
  // attached.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error(`Billing request failed: ${req.method} ${req.path}`, { status: err && err.status, error: err && err.message });
    sendError(res, err);
  });

  return app;
}

module.exports = { createApp };
