'use strict';

/**
 * Guest preview deployer — the only workload that can write to the guest
 * hosting site.
 *
 * It is a plain http server with an explicit route table rather than a framework
 * router: anything not listed here answers 404, so "what can a caller ask this
 * process to do" is readable from the top of the file and cannot grow by
 * accident. It holds no provider credential and no tenant data — the token on a
 * preview is a capability to overwrite that one preview's path and nothing else.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { guestDeployConfig } = require('./deploy-config');
const { createGuestReleases } = require('./releases');
const { createFirebaseHosting } = require('./hosting');
const { createGuestDeployService } = require('./service');
const templates = require('@software-factory/shared-core/agent/guest-demo/templates');

const RPC_PREFIX = '/internal/s2s/guest-deploy';
const TOKEN_SEGMENT = /^\/internal\/s2s\/guest-deploy\/([0-9a-f-]+)$/;

function writeLog(stream, level, message, fields) {
  const timestamp = new Date().toISOString();
  const detail = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
  stream.write(`[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}${detail}\n`);
}

const deployerLogger = Object.freeze({
  info: (message, fields) => writeLog(process.stdout, 'info', message, fields),
  warn: (message, fields) => writeLog(process.stdout, 'warn', message, fields),
  error: (message, fields) => writeLog(process.stderr, 'error', message, fields),
});

function requestPath(req) {
  try {
    return new URL(req.url, 'http://127.0.0.1').pathname;
  } catch {
    return '';
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * Constant-time, length-hiding comparison: the shared secret is compared through
 * its digest so a caller cannot read the token's length back out of the timing.
 */
function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || !provided) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error('request body too large');
        error.status = 413;
        error.code = 'guest_deploy_body_too_large';
        req.destroy();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        const error = new Error('request body must be JSON');
        error.status = 400;
        error.code = 'guest_deploy_body_invalid';
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/** Only the two fields the gateway is allowed to send; a text or URL field is ignored. */
function deployInput(body) {
  const template = typeof body.template === 'string' ? body.template : '';
  const variant = body.variant && typeof body.variant === 'object' && !Array.isArray(body.variant) ? body.variant : {};
  return { template, variant };
}

function createGuestDeployer(options = {}) {
  const config = options.config || guestDeployConfig(process.env);
  const log = options.log || deployerLogger;
  const now = options.now || (() => Date.now());
  const releases = options.releases || createGuestReleases({ dataDir: config.dataDir, retentionMs: config.retentionMs, now });
  const hosting = options.hosting || createFirebaseHosting({
    site: config.site,
    channel: config.channel,
    getAccessToken: options.getAccessToken || null,
    log,
  });
  const service = options.service || createGuestDeployService({
    config,
    releases,
    hosting,
    templates,
    baseOrigin: config.previewBaseOrigin,
    now,
    log,
  });

  async function handle(req, res) {
    const path = requestPath(req);
    if ((path === '/healthz' || path === '/health') && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (path !== RPC_PREFIX && !TOKEN_SEGMENT.test(path)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (!tokenMatches(req.headers['x-internal-token'], config.token)) {
      log.warn('guest-deploy denied', { op: 'auth', path });
      sendJson(res, 401, { error: 'the guest deployer is not available to this caller', code: 'guest_deploy_unauthorized' });
      return;
    }

    const match = TOKEN_SEGMENT.exec(path);
    const token = match ? match[1] : null;
    let body = {};
    if (req.method === 'POST') body = await readJsonBody(req, config.maxBodyBytes);

    if (token && req.method === 'GET') {
      const status = await service.status(releases.requireToken(token));
      if (!status) {
        sendJson(res, 404, { error: 'This preview is no longer available.', code: 'guest_preview_expired' });
        return;
      }
      sendJson(res, 200, status);
      return;
    }
    if (token && req.method === 'DELETE') {
      const removed = await service.remove(releases.requireToken(token));
      if (!removed) {
        sendJson(res, 404, { error: 'This preview is no longer available.', code: 'guest_preview_expired' });
        return;
      }
      sendJson(res, 200, { removed: true, fileCount: removed.fileCount, live: removed.live });
      return;
    }
    if (token && req.method === 'POST') {
      const { template, variant } = deployInput(body);
      const result = await service.redeploy({ token: releases.requireToken(token), template, variant });
      sendJson(res, 200, publicResult(result));
      return;
    }
    if (!token && req.method === 'POST') {
      const { template, variant } = deployInput(body);
      const result = await service.deploy({ template, variant });
      sendJson(res, 200, publicResult(result));
      return;
    }
    sendJson(res, 405, { error: 'That method is not available here.', code: 'guest_deploy_method_not_allowed' });
  }

  const server = http.createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch((error) => report(error, res, log));
  });
  server.keepAliveTimeout = 5000;

  return { server, handle, service, config };
}

/** The caller never needs the internal release bookkeeping, only its handle. */
function publicResult(result) {
  return { token: result.token, url: result.url, expiresAt: result.expiresAt, template: result.template, fileCount: result.fileCount, live: result.live };
}

function report(error, res, log) {
  const status = Number(error && error.status) > 0 ? Number(error.status) : 502;
  const code = (error && error.code) || 'guest_deploy_failed';
  log.error('guest-deploy failed', { code, status, message: error && error.message ? error.message : String(error) });
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, status, { error: status >= 500 ? 'The preview could not be published.' : error.message, code });
}

if (require.main === module) {
  const config = guestDeployConfig(process.env);
  const { server, service } = createGuestDeployer({ config });
  // The boot release is what closes a crash that landed between a version
  // finalize and its release; afterwards the union is only re-released when a
  // preview appears or ages out.
  const maintenance = service.startMaintenance();
  server.listen(config.port, config.bindHost, () => {
    deployerLogger.info(`Software Factory guest deployer listening on http://${config.bindHost}:${config.port}`);
    service.tick().catch((error) => deployerLogger.error('boot release failed', { message: error.message }));
  });
  const shutdown = () => {
    clearInterval(maintenance);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createGuestDeployer, deployerLogger, tokenMatches, readJsonBody, requestPath, publicResult, RPC_PREFIX, TOKEN_SEGMENT };
