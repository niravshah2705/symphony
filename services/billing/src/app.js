'use strict';

const express = require('express');
const { CONFIG } = require('@ai-fleet/shared-core/config');
const log = require('@ai-fleet/shared-core/logger');
const { asyncHandler } = require('@ai-fleet/shared-core/util');
const ledger = require('@ai-fleet/shared-core/billing/ledger');
const { SHARED_ORG_ID } = require('@ai-fleet/shared-core/billing/org-context');
const cashfreeClient = require('@ai-fleet/shared-core/billing/cashfree-client');
const { processBillingSweep } = require('@ai-fleet/shared-core/billing/sweep');
const billingApi = require('./billing-api');
const { renderDashboardHtml } = require('./ui');

function createApp(options = {}) {
  const app = express();
  // Cashfree signs the raw request body, so keep the bytes express consumed for
  // the webhook's HMAC check.
  app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
  }));

  // Probes
  app.get('/healthz', (req, res) => res.json({ status: 'ok', service: 'billing' }));
  app.get('/readyz', (req, res) => res.json({ status: 'ok', service: 'billing' }));

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

  return app;
}

module.exports = { createApp };
