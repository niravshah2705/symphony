'use strict';

const express = require('express');
const log = require('@ai-fleet/shared/logger');
const { decodePushMessage } = require('@ai-fleet/shared/messaging/publisher');
const { pushAuth } = require('@ai-fleet/shared/messaging/oidc');
const { loadConfig } = require('./config');
const { createMailer } = require('./mailer');
const { createIdempotencyStore } = require('./idempotency');
const { InvalidEmailJob, parseEmailJob } = require('./templates');

function createApp(options = {}) {
  const config = options.config || loadConfig();
  const logger = options.logger || log;
  const mailer = options.mailer || createMailer(config);
  const idempotency = options.idempotency || createIdempotencyStore(config);
  const authenticatePush = options.authenticatePush || pushAuth();
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '128kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (req, res) => {
    try {
      if (await mailer.ready()) return res.json({ status: 'ready' });
    } catch (_) {
      // Readiness deliberately returns no provider/config details.
    }
    return res.status(503).json({ status: 'not_ready' });
  });

  app.post('/pubsub/email', authenticatePush, async (req, res) => {
    const message = decodePushMessage(req.body);
    const pubsubMessageId = String(req.body?.message?.messageId || req.body?.message?.message_id || '').trim();
    let job;
    try {
      job = parseEmailJob(message, pubsubMessageId);
    } catch (err) {
      const code = err instanceof InvalidEmailJob ? err.code : 'invalid_message';
      logger.warn(`email delivery dropped non-retriable message (${code})`);
      return res.status(204).end();
    }

    let claim;
    try {
      claim = await idempotency.claim(job.idempotencyKey);
    } catch (_) {
      logger.error('email delivery could not reserve idempotency key');
      return res.status(500).json({ error: 'email delivery unavailable' });
    }
    if (!claim.acquired) {
      // Never ACK a concurrent redelivery while the first SMTP attempt is still
      // unresolved: that could lose the message if the first attempt later fails.
      if (claim.state === 'in_progress') return res.status(409).json({ error: 'email delivery in progress' });
      return res.status(204).end();
    }

    try {
      await mailer.send(job);
    } catch (_) {
      try {
        await idempotency.release(job.idempotencyKey, claim.claimId);
      } catch (_) {
        logger.error('email delivery could not release failed idempotency claim');
      }
      logger.error('email delivery failed; Pub/Sub will retry');
      return res.status(500).json({ error: 'email delivery failed' });
    }
    try {
      await idempotency.complete(job.idempotencyKey, claim.claimId);
      return res.status(204).end();
    } catch (_) {
      // SMTP already accepted the message. Keep the lease rather than releasing
      // it for an immediate duplicate, but ACK the successfully delivered job.
      // A retry cannot repair this record without sending the email twice.
      logger.error('email delivery sent but idempotency completion failed');
      return res.status(204).end();
    }
  });

  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  return app;
}

module.exports = { createApp };
