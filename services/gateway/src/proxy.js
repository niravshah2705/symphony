'use strict';

const log = require('@ai-fleet/shared/logger');

/**
 * Minimal reverse proxy from the gateway to an isolated agent service.
 *
 * The gateway is the only browser-facing origin; agent endpoints (/api/agent,
 * /api/coder) are served by separate service processes. This forwards the
 * request verbatim (method, path + query via req.originalUrl, JSON body) to the
 * target service and streams the response status/body back. All agent endpoints
 * speak JSON, so the body is reconstructed from the already-parsed req.body
 * rather than re-piping the raw stream.
 *
 * A network failure (service down) surfaces as 502 with a clear message instead
 * of a hung request — the UI degrades gracefully when an agent service is off.
 */
function createProxy(baseUrl) {
  return async function proxy(req, res) {
    const target = `${baseUrl}${req.originalUrl}`;
    const headers = {};
    const init = { method: req.method, headers };

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    if (hasBody && req.body && Object.keys(req.body).length > 0) {
      init.body = JSON.stringify(req.body);
      headers['content-type'] = 'application/json';
    }

    try {
      const resp = await fetch(target, init);
      const text = await resp.text();
      res.status(resp.status);
      const contentType = resp.headers.get('content-type');
      if (contentType) res.set('content-type', contentType);
      res.send(text);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      log.error(`gateway proxy ${req.method} ${target} failed: ${message}`);
      res.status(502).json({ error: `Agent service unavailable: ${message}` });
    }
  };
}

module.exports = { createProxy };
