'use strict';

const log = require('@ai-fleet/shared/logger');
const { loadConfig } = require('./config');
const { createMailer } = require('./mailer');
const { createApp } = require('./app');

function start() {
  const config = loadConfig();
  const mailer = createMailer(config);
  const app = createApp({ config, mailer });
  const server = app.listen(config.port, () => {
    log.info(`AI Fleet email service listening on :${config.port}`);
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
