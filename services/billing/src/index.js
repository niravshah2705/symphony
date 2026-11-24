'use strict';

const { CONFIG } = require('@software-factory/shared-core/config');
const log = require('@software-factory/shared-core/logger');
const { createApp } = require('./app');
const { reportBoot: reportCallerTrustBoot } = require('./trusted-caller');

function start(options = {}) {
  // Which callers may name an org is a config fact the operator needs to see
  // before the first degraded Usage page, not after.
  reportCallerTrustBoot(options.trustedCaller || {});
  const app = options.app || createApp(options);
  const port = Number(options.port) || Number(process.env.BILLING_SERVICE_PORT) || CONFIG.SERVICES.billingPort || 4050;
  const server = app.listen(port, () => log.info(`Software Factory billing service listening on :${port}`));
  const shutdown = () => server.close();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}

if (require.main === module) start();

module.exports = { createApp, start };
