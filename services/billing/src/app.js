'use strict';

const express = require('express');
const { CONFIG } = require('@ai-fleet/shared-core/config');
const log = require('@ai-fleet/shared-core/logger');
const { asyncHandler } = require('@ai-fleet/shared-core/util');
const store = require('@ai-fleet/shared-core/store');
const ledger = require('@ai-fleet/shared-core/billing/ledger');
const { SHARED_ORG_ID } = require('@ai-fleet/shared-core/billing/org-context');
const cashfreeClient = require('@ai-fleet/shared-core/billing/cashfree-client');
const { processBillingSweep } = require('@ai-fleet/shared-core/billing/sweep');
const rechargeTrigger = require('@ai-fleet/shared-core/billing/recharge-trigger');
const autoRechargeJob = require('./auto-recharge-job');
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

  // Hourly auto-recharge + alert tick. The sweep runs as a one-shot Cloud Run Job
  // execution rather than inside this request: it reads the org service once per
  // candidate org and may post several Cashfree charges, which would outlive the
  // scheduler's ack deadline and could leave the recharge cooldown stamped
  // half-written if the container were killed mid-pass. See billing_job.tf.
  // Local (direct mode) has no Job to launch, so the entrypoint runs in-process.
  app.post('/pubsub/billing-recharge-tick', asyncHandler(async (req, res) => {
    const trigger = options.rechargeTrigger || rechargeTrigger;
    const runJob = options.runAutoRechargeJob || autoRechargeJob.main;
    try {
      if (trigger.isCloudJobEnabled()) {
        const { execution } = await trigger.runRechargeJob({ env: options.rechargeJobEnv });
        log.info(`Billing auto-recharge Job launched via /pubsub/billing-recharge-tick: ${execution}`);
        return res.status(200).json({ status: 'launched', execution });
      }
      const summary = await runJob({ exit: () => {} });
      log.info(`Billing auto-recharge sweep completed in-process: ${JSON.stringify(summary)}`);
      return res.status(200).json({ status: 'completed', ...summary });
    } catch (err) {
      log.error(`Billing auto-recharge tick error: ${err && err.message ? err.message : err}`);
      return res.status(500).json({ error: err && err.message ? err.message : 'Recharge tick error' });
    }
  }));

  // Billing API. Mounted under /api/billing for the gateway proxy and under / for
  // callers that use the bare paths.
  app.use('/api/billing', billingApi);
  app.use('/', billingApi);

  return app;
}

module.exports = { createApp };
