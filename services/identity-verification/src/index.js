'use strict';

const { CONFIG } = require('@software-factory/shared-core/config');
const log = require('@software-factory/shared-core/logger');
const { createApp } = require('./app');

function start(options = {}) {
  const app = options.app || createApp(options);
  const port = Number(options.port) || CONFIG.SERVICES.identityPort || 4080;
  const server = app.listen(port, () => log.info(`Software Factory identity verification listening on :${port}`));
  const shutdown = () => server.close();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}

if (require.main === module) start();

module.exports = { createApp, start };
