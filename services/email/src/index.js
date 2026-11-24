'use strict';

const log = require('@software-factory/shared-core/logger');
const { loadConfig } = require('./config');
const { createMailer } = require('./mailer');
const { createApp } = require('./app');

function start() {
  const config = loadConfig();
  const mailer = createMailer(config);
  const app = createApp({ config, mailer });
  const server = app.listen(config.port, () => {
    log.info(`Software Factory email service listening on :${config.port}`);
  });
  const shutdown = () => {
    mailer.close();
    server.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}

if (require.main === module) start();

module.exports = { start };
