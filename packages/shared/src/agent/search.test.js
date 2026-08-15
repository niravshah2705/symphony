'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchRequest, webSearch } = require('./search');

const PROJECT_ID = '7e2ce8ba-57d3-4d80-bdba-ec18a8d2d348';
const PROXY_CONFIG = {
  EGRESS_PROXY_URL: 'http://127.0.0.1:4030',
  DUCKDUCKGO_HTML_ORIGIN: 'http://127.0.0.1:4030/duckduckgo-html',
};

test('proxy web search uses the fixed DuckDuckGo route and validated project context', () => {
  const request = searchRequest('fleet security', {
    config: PROXY_CONFIG,
    context: { projectId: PROJECT_ID },
  });
  assert.equal(
    request.url,
    'http://127.0.0.1:4030/duckduckgo-html/html/?q=fleet%20security',
  );
  assert.equal(request.headers['X-AI-Fleet-Project-ID'], PROJECT_ID);

  const invalid = searchRequest('fleet', {
    config: PROXY_CONFIG,
    context: { projectId: 'not-a-uuid' },
  });
  assert.equal(invalid.headers['X-AI-Fleet-Project-ID'], undefined);
});

test('webSearch sends its request through the configured origin', async () => {
  let requested;
  const snippets = await webSearch('egress proxy', 2, {
    config: PROXY_CONFIG,
    context: { projectId: PROJECT_ID },
    fetchImpl: async (url, options) => {
      requested = { url, options };
      return {
        ok: true,
        text: async () => '<a class="result__snippet">A sufficiently long proxy search result snippet.</a>',
      };
    },
  });
  assert.equal(requested.url.startsWith(`${PROXY_CONFIG.DUCKDUCKGO_HTML_ORIGIN}/html/`), true);
  assert.equal(requested.options.headers['X-AI-Fleet-Project-ID'], PROJECT_ID);
  assert.deepEqual(snippets, ['A sufficiently long proxy search result snippet.']);
});
