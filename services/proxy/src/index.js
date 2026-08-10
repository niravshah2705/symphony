'use strict';

const http = require('http');
const log = require('@ai-fleet/shared/logger');
const { createProxyHandler } = require('./proxy');

/**
 * AI Fleet egress proxy sidecar. Co-located with an agent runtime (planner /
 * coder / coder-worker) so that — over the shared loopback of a Cloud Run
 * multi-container instance — the agent routes every third-party call here and
 * NEVER holds a raw provider credential. This process holds the secrets (or
 * resolves them per-org from the settings vault) and injects them on egress.
 */

const PORT = Number(process.env.PROXY_PORT) || 4030;
const handle = createProxyHandler();

const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  Promise.resolve(handle(req, res)).catch((err) => {
    log.error(`egress proxy handler error: ${err && err.message ? err.message : err}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy error' }));
    } else {
      res.end();
    }
  });
});

// Long-lived streaming responses (LLM SSE, git packfiles) must not be cut off by
// the default request/headers timeouts.
server.requestTimeout = 0;
server.headersTimeout = 0;

if (require.main === module) {
  server.listen(PORT, () => {
    log.info(`AI Fleet egress proxy sidecar listening on http://127.0.0.1:${PORT}`);
  });
}

module.exports = server;
