'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EGRESS_ROUTES, matchRoute } = require('@ai-fleet/shared-core/egress');
const {
  buildUpstreamUrl,
  buildForwardHeaders,
  filterResponseHeaders,
  requestProjectId,
  createProxyHandler,
  statusClass,
  probeSegment,
} = require('./proxy');
const credentials = require('./credentials');

test('buildUpstreamUrl appends the path remainder', () => {
  assert.equal(
    buildUpstreamUrl(EGRESS_ROUTES.anthropic, '/v1/messages'),
    'https://api.anthropic.com/v1/messages'
  );
  // Root request (rest '/') hits the upstream base unchanged.
  assert.equal(buildUpstreamUrl(EGRESS_ROUTES.linear, '/'), 'https://api.linear.app/graphql');
  assert.equal(buildUpstreamUrl(EGRESS_ROUTES.openai, '/chat/completions'), 'https://api.openai.com/v1/chat/completions');
});

test('buildForwardHeaders strips inbound auth and retargets Host', () => {
  const out = buildForwardHeaders(
    {
      authorization: 'Bearer egress-proxy-sentinel',
      'x-internal-token': 'secret',
      'x-forwarded-authorization': 'Bearer user',
      'private-token': 'caller-gitlab-token',
      'x-api-key': 'caller-api-key',
      'x-goog-api-key': 'caller-google-key',
      'x-ai-fleet-project-id': '7e2ce8ba-57d3-4d80-bdba-ec18a8d2d348',
      forwarded: 'for=attacker',
      'anthropic-beta': 'caller-controlled',
      cookie: 'session=abc',
      'content-type': 'application/json',
      host: '127.0.0.1:4030',
      'accept-encoding': 'gzip',
    },
    'https://api.anthropic.com/v1/messages',
    { authorization: 'Bearer real-token', 'anthropic-beta': 'oauth-2025-04-20' }
  );
  // Inbound secrets/sentinel are gone; injected credential is present.
  assert.equal(out.authorization, 'Bearer real-token');
  assert.equal(out['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(out['x-internal-token'], undefined);
  assert.equal(out['x-forwarded-authorization'], undefined);
  assert.equal(out['private-token'], undefined);
  assert.equal(out['x-api-key'], undefined);
  assert.equal(out['x-goog-api-key'], undefined);
  assert.equal(out['x-ai-fleet-project-id'], undefined);
  assert.equal(out.forwarded, undefined);
  assert.equal(out.cookie, undefined);
  assert.equal(out['accept-encoding'], undefined);
  // Host is retargeted to the upstream, not the proxy loopback.
  assert.equal(out.host, 'api.anthropic.com');
  assert.equal(out['content-type'], 'application/json');
});

test('buildForwardHeaders cannot smuggle an OAuth beta header into API-key auth', () => {
  const out = buildForwardHeaders(
    { 'anthropic-beta': 'oauth-2025-04-20' },
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': 'managed-key' },
  );
  assert.equal(out['anthropic-beta'], undefined);
  assert.equal(out['x-api-key'], 'managed-key');
});

test('filterResponseHeaders drops body-frame + hop-by-hop but keeps content-type', () => {
  const out = filterResponseHeaders(
    new Map([
      ['content-type', 'text/event-stream'],
      ['content-length', '1234'],
      ['content-encoding', 'gzip'],
      ['transfer-encoding', 'chunked'],
      ['x-request-id', 'abc'],
    ])
  );
  assert.equal(out['content-type'], 'text/event-stream');
  assert.equal(out['x-request-id'], 'abc');
  assert.equal(out['content-length'], undefined);
  assert.equal(out['content-encoding'], undefined);
  assert.equal(out['transfer-encoding'], undefined);
});

// --- credential injection ---------------------------------------------------

test('resolveStaticKey: managed value from the settings payload (one path)', () => {
  const key = credentials.resolveStaticKey(
    'githubToken',
    { secrets: { githubToken: { source: 'managed', value: 'ghp_platform' } } }
  );
  assert.equal(key, 'ghp_platform');
});

test('resolveStaticKey: fails closed instead of falling back to process env', () => {
  assert.throws(
    () => credentials.resolveStaticKey('githubToken', null, { env: { GITHUB_TOKEN: 'ghp_env' } }),
    (error) => error instanceof credentials.FailClosed,
  );
});

test('proxy credential scope accepts a dedicated fleet org but rejects conflicting pins', () => {
  assert.equal(credentials.configuredProxyOrgId({ FLEET_ORG_ID: 'org-1' }), 'org-1');
  assert.equal(credentials.configuredProxyOrgId({ PROXY_ORG_ID: 'org-1', FLEET_ORG_ID: 'org-1' }), 'org-1');
  assert.throws(
    () => credentials.configuredProxyOrgId({ PROXY_ORG_ID: 'org-1', FLEET_ORG_ID: 'org-2' }),
    /must identify the same organization/,
  );
});

test('buildInjection: managed static key injects the settings-resolved value (Bearer)', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.githubApi, {
    resolved: { secrets: { githubToken: { source: 'managed', value: 'ghp_managed' } } },
  });
  assert.equal(headers.authorization, 'Bearer ghp_managed');
});

test('buildInjection: customer static key uses the vault plaintext', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.linear, {
    resolved: { secrets: { linearApiKey: { source: 'customer', value: 'lin_customer' } } },
  });
  // Linear uses the raw scheme (no Bearer prefix).
  assert.equal(headers.authorization, 'lin_customer');
});

test('buildInjection: customer-selected but missing key FAILS CLOSED', async () => {
  await assert.rejects(
    () =>
      credentials.buildInjection(EGRESS_ROUTES.githubApi, {
        resolved: { secrets: { githubToken: { source: 'customer', value: null, error: 'missing' } } },
      }),
    (err) => err.name === 'FailClosed' && err.status === 502
  );
});

test('buildInjection: git route builds x-access-token Basic auth', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.git, {
    resolved: { secrets: { githubToken: { source: 'customer', value: 'ghp_c' } } },
  });
  const expected = 'Basic ' + Buffer.from('x-access-token:ghp_c').toString('base64');
  assert.equal(headers.authorization, expected);
});

test('buildInjection: langfuse basic-pair injects Basic base64(publicKey:secretKey)', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.langfuse, {
    resolved: {
      secrets: {
        langfusePublicKey: { source: 'managed', value: 'pk-lf-managed' },
        langfuseSecretKey: { source: 'managed', value: 'sk-lf-managed' },
      },
    },
  });
  const expected = 'Basic ' + Buffer.from('pk-lf-managed:sk-lf-managed').toString('base64');
  assert.deepEqual(headers, { authorization: expected });
});

test('buildInjection: langfuse fails closed when either half of the pair is missing', async () => {
  await assert.rejects(
    credentials.buildInjection(EGRESS_ROUTES.langfuse, {
      resolved: { secrets: { langfusePublicKey: { source: 'managed', value: 'pk-lf-managed' } } },
    }),
    /langfuseSecretKey/,
  );
  await assert.rejects(
    credentials.buildInjection(EGRESS_ROUTES.langfuse, {
      resolved: { secrets: { langfuseSecretKey: { source: 'managed', value: 'sk-lf-managed' } } },
    }),
    /langfusePublicKey/,
  );
});

test('buildUpstreamUrl: langfuse keeps the SDK-appended OTLP path on the bare origin', () => {
  assert.equal(
    buildUpstreamUrl(EGRESS_ROUTES.langfuse, '/api/public/otel/v1/traces'),
    'https://cloud.langfuse.com/api/public/otel/v1/traces'
  );
});

test('GitLab REST and smart-HTTP routes use provider-specific injection', async () => {
  const resolved = { secrets: { gitlabToken: { source: 'customer', value: 'glpat_c' } } };
  assert.deepEqual(
    await credentials.buildInjection(EGRESS_ROUTES.gitlabApi, { resolved }),
    { 'private-token': 'glpat_c' },
  );
  const git = await credentials.buildInjection(EGRESS_ROUTES.gitlabGit, { resolved });
  assert.equal(git.authorization, `Basic ${Buffer.from('oauth2:glpat_c').toString('base64')}`);
});

test('Asana route injects a required vault bearer', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.asanaApi, {
    resolved: { secrets: { asanaAccessToken: { source: 'customer', value: 'asana_c' } } },
  });
  assert.deepEqual(headers, { authorization: 'Bearer asana_c' });
});

test('Jira route uses only an allow-listed Atlassian tenant and Basic account auth', async () => {
  const opts = {
    egressConfig: { jira_origin: 'https://acme.atlassian.net', jira_email: 'owner@example.com' },
    resolved: { secrets: { jiraApiToken: { source: 'customer', value: 'jira_c' } } },
  };
  assert.equal(
    await credentials.resolveUpstream(EGRESS_ROUTES.jiraApi, opts),
    'https://acme.atlassian.net/rest/api/3',
  );
  assert.deepEqual(
    await credentials.buildInjection(EGRESS_ROUTES.jiraApi, opts),
    { authorization: `Basic ${Buffer.from('owner@example.com:jira_c').toString('base64')}` },
  );
  for (const jira_origin of [
    'http://acme.atlassian.net',
    'https://acme.atlassian.net/other',
    'https://acme.eu.atlassian.net',
    'https://127.0.0.1',
    'https://acme.atlassian.net.evil.test',
  ]) {
    await assert.rejects(
      () => credentials.resolveUpstream(EGRESS_ROUTES.jiraApi, {
        egressConfig: { jira_origin, jira_email: 'owner@example.com' },
      }),
      (error) => error instanceof credentials.FailClosed,
    );
  }
});

test('OMLX upstream comes only from trusted env and may be anonymous', async () => {
  const route = await credentials.resolveRoute(EGRESS_ROUTES.omlx, {
    env: { OMLX_PROXY_UPSTREAM: 'http://omlx.internal:8000/' },
    resolved: { secrets: {} },
  });
  assert.deepEqual(route, { upstream: 'http://omlx.internal:8000', headers: {} });
  await assert.rejects(
    () => credentials.resolveUpstream(EGRESS_ROUTES.omlx, { env: { OMLX_PROXY_UPSTREAM: 'file:///tmp/socket' } }),
    (error) => error instanceof credentials.FailClosed,
  );
});

test('Ollama, LM Studio, and OpenSWE targets come only from trusted proxy environment', async () => {
  assert.deepEqual(
    await credentials.resolveRoute(EGRESS_ROUTES.ollama, {
      env: { OLLAMA_PROXY_UPSTREAM: 'http://ollama.internal:11434/' },
    }),
    { upstream: 'http://ollama.internal:11434', headers: {} },
  );
  assert.deepEqual(
    await credentials.resolveRoute(EGRESS_ROUTES.lmstudio, {
      env: { LMSTUDIO_PROXY_UPSTREAM: 'http://lmstudio.internal:1234' },
    }),
    { upstream: 'http://lmstudio.internal:1234', headers: {} },
  );
  assert.deepEqual(
    await credentials.resolveRoute(EGRESS_ROUTES.openSwe, {
      env: { OPENSWE_PROXY_UPSTREAM: 'https://openswe.internal/' },
    }),
    { upstream: 'https://openswe.internal', headers: {} },
  );
  await assert.rejects(
    () => credentials.resolveRoute(EGRESS_ROUTES.ollama, {
      env: { OLLAMA_PROXY_UPSTREAM: 'http://user:pass@ollama.internal:11434' },
    }),
    (error) => error instanceof credentials.FailClosed,
  );
  await assert.rejects(
    () => credentials.resolveRoute(EGRESS_ROUTES.openSwe, {
      env: { OPENSWE_PROXY_UPSTREAM: 'https://user:pass@openswe.internal' },
    }),
    (error) => error instanceof credentials.FailClosed,
  );
  await assert.rejects(
    () => credentials.resolveRoute(EGRESS_ROUTES.openSwe, {
      env: { OPENSWE_PROXY_UPSTREAM: 'https://openswe.internal?target=https://evil.test' },
    }),
    (error) => error instanceof credentials.FailClosed,
  );
});

test('LiteLLM upstream comes only from trusted proxy env and its key is required', async () => {
  // /litellm/** is a multi-segment passthrough that fans out to the public
  // internet from the gateway, so its real origin must stay operator-selected
  // (no-open-relay invariant) and the per-org virtual key must fail closed.
  assert.deepEqual(
    await credentials.resolveRoute(EGRESS_ROUTES.litellm, {
      env: { LITELLM_PROXY_UPSTREAM: 'https://ai-fleet-litellm.internal/', PROXY_ORG_ID: 'org-42' },
      resolved: { secrets: { litellmApiKey: { source: 'customer', value: 'sk-lit-org42' } } },
    }),
    { upstream: 'https://ai-fleet-litellm.internal', headers: { authorization: 'Bearer sk-lit-org42' } },
  );
  for (const bad of [
    '',
    'file:///tmp/lit.sock',
    'https://user:pass@litellm.internal',
    'https://litellm.internal?target=https://evil.test',
  ]) {
    await assert.rejects(
      () => credentials.resolveRoute(EGRESS_ROUTES.litellm, {
        env: { LITELLM_PROXY_UPSTREAM: bad },
        resolved: { secrets: { litellmApiKey: { source: 'customer', value: 'sk-x' } } },
      }),
      (error) => error instanceof credentials.FailClosed,
      bad,
    );
  }
});

test('buildInjection: litellm injects the org virtual key and stamps no org header', async () => {
  // Per-org attribution at LiteLLM lives in the key alias, not a header, so the
  // sidecar never writes x-fleet-org-id here (and never trusts an inbound one).
  const headers = await credentials.buildInjection(EGRESS_ROUTES.litellm, {
    resolved: { secrets: { litellmApiKey: { source: 'customer', value: 'sk-lit-org42' } } },
    env: { PROXY_ORG_ID: 'org-42' },
  });
  assert.deepEqual(headers, { authorization: 'Bearer sk-lit-org42' });
});

test('buildInjection: litellm fails closed on a missing or env-mounted key', async () => {
  await assert.rejects(
    () => credentials.buildInjection(EGRESS_ROUTES.litellm, { resolved: { secrets: {} }, env: {} }),
    (err) => err.name === 'FailClosed' && err.status === 502,
  );
  await assert.rejects(
    () => credentials.buildInjection(EGRESS_ROUTES.litellm, {
      resolved: null,
      env: { LITELLM_API_KEY: 'sk_env' },
    }),
    (err) => err.name === 'FailClosed' && err.status === 502,
  );
});

test('agentgateway resolves its origin only from trusted env, and is dark without it', async () => {
  // One prefix fronts LLM, MCP and A2A, and the gateway fans out to the internet
  // holding a real provider key — so the origin must stay operator-selected and
  // the per-org virtual key must fail closed.
  assert.deepEqual(
    await credentials.resolveRoute(EGRESS_ROUTES.agentgateway, {
      env: { AGENTGATEWAY_PROXY_UPSTREAM: 'https://agentgw.cluster.local/', PROXY_ORG_ID: 'org-42' },
      resolved: { secrets: { fleetGatewayApiKey: { source: 'customer', value: 'agw-org42' } } },
    }),
    { upstream: 'https://agentgw.cluster.local', headers: { authorization: 'Bearer agw-org42' } },
  );
  // There is deliberately no enable flag to flip: an unset origin IS the dark
  // state. A second knob (AGENTGATEWAY_ENABLED) could only disagree with this one.
  await assert.rejects(
    () => credentials.resolveRoute(EGRESS_ROUTES.agentgateway, {
      env: { PROXY_ORG_ID: 'org-42' },
      resolved: { secrets: { fleetGatewayApiKey: { source: 'customer', value: 'agw-x' } } },
    }),
    (err) => err.name === 'FailClosed' && err.status === 502,
  );
  await assert.rejects(
    () => credentials.resolveRoute(EGRESS_ROUTES.agentgateway, {
      env: { AGENTGATEWAY_PROXY_UPSTREAM: 'https://agentgw.cluster.local@evil.test/' },
      resolved: { secrets: { fleetGatewayApiKey: { source: 'customer', value: 'agw-x' } } },
    }),
    (error) => error instanceof credentials.FailClosed,
  );
  await assert.rejects(
    () => credentials.buildInjection(EGRESS_ROUTES.agentgateway, { resolved: { secrets: {} }, env: {} }),
    (err) => err.name === 'FailClosed' && err.status === 502,
  );
});

test('agentgateway: one prefix routes LLM, MCP and A2A as sub-paths', () => {
  for (const [path, rest] of [
    ['/agentgw/v1/messages', '/v1/messages'],
    ['/agentgw/mcp', '/mcp'],
    ['/agentgw/a2a/agent-card.json', '/a2a/agent-card.json'],
  ]) {
    const matched = matchRoute(path);
    assert.equal(matched.route, EGRESS_ROUTES.agentgateway, path);
    assert.equal(matched.rest, rest);
  }
});

test('buildForwardHeaders strips a forged org header and the sentinel on a litellm call', () => {
  const out = buildForwardHeaders(
    {
      authorization: 'Bearer egress-proxy-sentinel',
      'x-fleet-org-id': 'org-victim',
      'x-ai-fleet-project-id': '22222222-2222-2222-2222-222222222222',
      'content-type': 'application/json',
    },
    'https://litellm.internal/v1/messages',
    { authorization: 'Bearer sk-lit-org42' },
  );
  assert.equal(out['x-fleet-org-id'], undefined);
  assert.equal(out['x-ai-fleet-project-id'], undefined);
  assert.equal(out.authorization, 'Bearer sk-lit-org42');
  assert.equal(out['content-type'], 'application/json');
});

test('fixed anonymous routes resolve without consulting credential sources', async () => {
  for (const [route, upstream] of [
    [EGRESS_ROUTES.duckDuckGoHtml, 'https://html.duckduckgo.com'],
    [EGRESS_ROUTES.ipwho, 'https://ipwho.is'],
    [EGRESS_ROUTES.codexOauthToken, 'https://auth.openai.com/oauth/token'],
    [EGRESS_ROUTES.claudeOauthToken, 'https://console.anthropic.com/v1/oauth/token'],
  ]) {
    assert.deepEqual(await credentials.resolveRoute(route, {}), { upstream, headers: {} });
  }
});

test('Slack route resolves one exact hooks.slack.com vault target', async () => {
  const valid = 'https://hooks.slack.com/services/T000/B000/secret-token';
  assert.equal(
    await credentials.resolveUpstream(EGRESS_ROUTES.slackWebhook, {
      resolved: { secrets: { slackWebhookUrl: { source: 'customer', value: valid } } },
    }),
    valid,
  );
  await assert.rejects(
    () => credentials.resolveUpstream(EGRESS_ROUTES.slackWebhook, {
      resolved: { secrets: { slackWebhookUrl: { source: 'customer', value: 'https://evil.test/services/T/B/C' } } },
    }),
    (error) => error instanceof credentials.FailClosed,
  );
});

test('project context accepts one UUID and rejects untrusted header values', () => {
  const id = '7e2ce8ba-57d3-4d80-bdba-ec18a8d2d348';
  assert.equal(requestProjectId({ 'x-ai-fleet-project-id': id }), id);
  assert.equal(requestProjectId({}), '');
  assert.throws(() => requestProjectId({ 'x-ai-fleet-project-id': 'not-a-uuid' }), /UUID/);
});

test('proxy passes project scope only to the resolver and strips it upstream', async () => {
  const projectId = '7e2ce8ba-57d3-4d80-bdba-ec18a8d2d348';
  let resolverProjectId = null;
  let upstreamHeaders = null;
  const handler = createProxyHandler({
    routeResolver: {
      resolveRoute: async (_route, opts) => {
        resolverProjectId = opts.projectId;
        return { upstream: 'https://api.linear.app/graphql', headers: { authorization: 'real-key' } };
      },
    },
    fetchImpl: async (_url, init) => {
      upstreamHeaders = init.headers;
      return { status: 200, headers: new Map(), body: null };
    },
    logger: { error() {}, warn() {}, info() {} },
  });
  const response = {
    headersSent: false,
    writeHead() { this.headersSent = true; },
    end() {},
  };
  await handler({
    url: '/linear',
    method: 'GET',
    headers: { 'x-ai-fleet-project-id': projectId, authorization: 'egress-proxy-sentinel' },
  }, response);
  assert.equal(resolverProjectId, projectId);
  assert.equal(upstreamHeaders['x-ai-fleet-project-id'], undefined);
  assert.equal(upstreamHeaders.authorization, 'real-key');
});

test('proxy rejects provider redirects without exposing a Location or following it', async () => {
  let fetchCalls = 0;
  let bodyCancelled = false;
  const handler = createProxyHandler({
    routeResolver: {
      resolveRoute: async () => ({
        upstream: 'https://api.linear.app/graphql',
        headers: { authorization: 'real-key' },
      }),
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return {
        status: 302,
        headers: new Map([['location', 'https://attacker.example/collect']]),
        body: { cancel: async () => { bodyCancelled = true; } },
      };
    },
    logger: { error() {}, warn() {}, info() {} },
  });
  const response = {
    headersSent: false,
    status: null,
    headers: null,
    ended: false,
    writeHead(status, headers) {
      this.headersSent = true;
      this.status = status;
      this.headers = headers;
    },
    end() { this.ended = true; },
  };

  await handler({ url: '/linear', method: 'GET', headers: {} }, response);

  assert.equal(fetchCalls, 1);
  assert.equal(bodyCancelled, true);
  assert.equal(response.status, 502);
  assert.equal(response.headers, undefined);
  assert.equal(response.ended, true);
});

test('buildInjection: langsmith uses x-api-key scheme', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.langsmith, {
    resolved: { secrets: { langsmithApiKey: { source: 'customer', value: 'ls_c' } } },
  });
  assert.equal(headers['x-api-key'], 'ls_c');
  assert.equal(headers.authorization, undefined);
});

test('buildInjection: native gemini uses x-goog-api-key scheme', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.geminiNative, {
    resolved: { secrets: { geminiApiKey: { source: 'managed', value: 'gm_key' } } },
  });
  assert.equal(headers['x-goog-api-key'], 'gm_key');
  assert.equal(headers.authorization, undefined);
});

test('buildInjection: claude route injects Bearer + anthropic-beta from oauth manager', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.anthropic, {
    resolved: { secrets: { anthropicApiKey: { source: 'managed', value: null } } },
    env: {},
    oauthManager: {
      getClaudeAuth: async () => ({ accessToken: 'acc', betaHeader: 'oauth-2025-04-20' }),
    },
  });
  assert.equal(headers.authorization, 'Bearer acc');
  assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20');
});

test('buildInjection: Anthropic route uses a selected static key without OAuth headers', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.anthropic, {
    resolved: { secrets: { anthropicApiKey: { source: 'managed', value: 'sk-ant-managed' } } },
    env: {},
    oauthManager: { getClaudeAuth: async () => { throw new Error('must not use OAuth'); } },
  });
  assert.deepEqual(headers, { 'x-api-key': 'sk-ant-managed' });
});

test('buildInjection: metered OpenAI route uses its selected static key', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.openai, {
    resolved: { secrets: { openaiApiKey: { source: 'customer', value: 'sk-openai-customer' } } },
    env: {},
    oauthManager: { getCodexAuth: async () => { throw new Error('must not use OAuth'); } },
  });
  assert.deepEqual(headers, { authorization: 'Bearer sk-openai-customer' });
});

test('buildInjection: metered OpenAI route honors the preflight-preferred org token bundle', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.openai, {
    resolved: {
      secrets: {
        codexTokenBundle: { source: 'customer', value: '{"accessToken":"vault"}' },
        openaiApiKey: { source: 'managed', value: 'sk-managed' },
      },
    },
    env: {},
    oauthManager: { getCodexAuth: async () => ({ accessToken: 'oauth-access' }) },
  });
  assert.deepEqual(headers, { authorization: 'Bearer oauth-access' });
});

test('buildInjection: codex chatgpt route injects Bearer + chatgpt-account-id', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.codex, {
    oauthManager: {
      getCodexAuth: async () => ({ accessToken: 'acc', accountId: 'acct-123' }),
    },
  });
  assert.equal(headers.authorization, 'Bearer acc');
  assert.equal(headers['chatgpt-account-id'], 'acct-123');
});

// --- LangSmith LLM gateway route ---------------------------------------------

test('buildForwardHeaders strips an inbound x-api-key sentinel', () => {
  const out = buildForwardHeaders(
    { 'x-api-key': 'egress-proxy-sentinel', 'content-type': 'application/json' },
    'https://gateway.smith.langchain.com/v1/messages',
    { authorization: 'Bearer lsv2_gw' }
  );
  assert.equal(out['x-api-key'], undefined);
  assert.equal(out.authorization, 'Bearer lsv2_gw');
  assert.equal(out['content-type'], 'application/json');
});

test('buildInjection: llm-gateway injects Bearer + the per-org policy header', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.llmGateway, {
    resolved: { secrets: { langsmithGatewayApiKey: { source: 'managed', value: 'lsv2_gw' } } },
    env: { PROXY_ORG_ID: 'org-42' },
  });
  assert.deepEqual(headers, { authorization: 'Bearer lsv2_gw', 'x-fleet-org-id': 'org-42' });
});

test('buildInjection: llm-gateway omits the org header on the shared stack', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.llmGateway, {
    resolved: { secrets: { langsmithGatewayApiKey: { source: 'managed', value: 'lsv2_gw' } } },
    env: {},
  });
  assert.deepEqual(headers, { authorization: 'Bearer lsv2_gw' });
});

test('buildInjection: llm-gateway FAILS CLOSED without a key', async () => {
  // Unlike generic apiKey routes (forward unauthenticated, upstream rejects),
  // a missing workspace key must never reach the billing gateway.
  await assert.rejects(
    () => credentials.buildInjection(EGRESS_ROUTES.llmGateway, { resolved: { secrets: {} }, env: {} }),
    (err) => err.name === 'FailClosed' && err.status === 502
  );
});

test('buildInjection: llm-gateway never falls back to a proxy-mounted env key', async () => {
  await assert.rejects(
    () => credentials.buildInjection(EGRESS_ROUTES.llmGateway, {
      resolved: null,
      env: { LANGSMITH_GATEWAY_API_KEY: 'lsv2_env' },
    }),
    (err) => err.name === 'FailClosed' && err.status === 502
  );
});

// --- egress decision records (observability + the two security signals) ------

/** Handler wired to a capturing logger; returns the records it wrote. */
function recordingHandler({ resolver, fetchImpl, env } = {}) {
  const records = [];
  const note = (severity) => (message, meta) => records.push({ severity, message, meta });
  const handler = createProxyHandler({
    routeResolver: resolver || {
      resolveRoute: async () => ({ upstream: 'https://api.linear.app/graphql', headers: { authorization: 'real-key' } }),
    },
    fetchImpl: fetchImpl || (async () => ({ status: 200, headers: new Map(), body: null })),
    logger: { info: note('info'), warn: note('warn'), error: note('error') },
    env: env || {},
  });
  const res = { headersSent: false, writeHead() { this.headersSent = true; }, end() {} };
  return { handler, records, res };
}

test('a forwarded request writes exactly one decision record, and never a secret', async () => {
  const { handler, records, res } = recordingHandler();
  await handler({
    url: '/linear?x=1',
    method: 'GET',
    headers: { authorization: 'egress-proxy-sentinel', 'x-ai-fleet-project-id': '' },
  }, res);

  assert.equal(records.length, 1, 'one record per request — two would double-count every egress call');
  const { severity, message, meta } = records[0];
  assert.equal(severity, 'info');
  assert.equal(message, 'egress forwarded');
  assert.equal(meta.prefix, '/linear');
  assert.equal(meta.decision, 'forwarded');
  assert.equal(meta.upstreamHost, 'api.linear.app');
  assert.equal(meta.statusClass, '2xx');
  assert.equal(meta.method, 'GET');
  assert.ok(Number.isInteger(meta.latencyMs) && meta.latencyMs >= 0);

  // The metric line is the one place a proxy could leak: no injected value, no
  // sentinel, no header name, no query string.
  const line = JSON.stringify(records);
  assert.doesNotMatch(line, /real-key|egress-proxy-sentinel|authorization|x=1/);
});

test('cred_unavailable is counted at error severity with the pinned org', async () => {
  const FailClosed = credentials.FailClosed;
  const { handler, records, res } = recordingHandler({
    env: { PROXY_ORG_ID: 'org-42' },
    resolver: {
      resolveRoute: async () => { throw new FailClosed('no secret in vault for linearApiKey'); },
    },
  });
  await handler({ url: '/linear', method: 'POST', headers: {} }, res);

  assert.equal(records.length, 1);
  assert.equal(records[0].severity, 'error', 'a page-able fail-closed signal');
  assert.equal(records[0].meta.decision, 'cred_unavailable');
  assert.equal(records[0].meta.statusClass, '5xx');
  assert.equal(records[0].meta.orgId, 'org-42');
  assert.equal(records[0].meta.upstreamHost, '', 'nothing was resolved, so nothing is claimed');
});

test('an unmatched path is counted as a probe, with the raw path dropped', async () => {
  const { handler, records, res } = recordingHandler();
  await handler({
    url: '/relay?target=https://evil.example/&apiKey=sk-live1234567890',
    method: 'GET',
    headers: {},
  }, res);

  assert.equal(records.length, 1);
  assert.equal(records[0].severity, 'warn', 'open-relay probing is a signal, not an error page');
  assert.equal(records[0].meta.decision, 'no_route');
  assert.equal(records[0].meta.statusClass, '4xx');
  assert.equal(records[0].meta.prefix, 'unmatched:relay');
  assert.doesNotMatch(JSON.stringify(records[0]), /sk-live1234567890|evil\.example|\.\.\//);
});

test('a bad project context, a rejected redirect and an unreachable upstream each count once', async () => {
  const badContext = recordingHandler();
  await badContext.handler({
    url: '/linear', method: 'GET', headers: { 'x-ai-fleet-project-id': 'not-a-uuid' },
  }, badContext.res);
  assert.equal(badContext.records[0].meta.decision, 'bad_context');
  assert.equal(badContext.records[0].severity, 'warn');

  const redirect = recordingHandler({
    fetchImpl: async () => ({
      status: 301,
      headers: new Map([['location', 'https://attacker.example/collect']]),
      body: { cancel: async () => {} },
    }),
  });
  await redirect.handler({ url: '/linear', method: 'GET', headers: {} }, redirect.res);
  assert.equal(redirect.records.length, 1, 'the record is written before the response, so a 502 is never silent');
  assert.equal(redirect.records[0].meta.decision, 'redirect_rejected');
  assert.doesNotMatch(JSON.stringify(redirect.records), /attacker\.example|collect/);

  const unreachable = recordingHandler({ fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); } });
  await unreachable.handler({ url: '/linear', method: 'GET', headers: {} }, unreachable.res);
  assert.equal(unreachable.records[0].meta.decision, 'upstream_error');
  assert.equal(unreachable.records[0].meta.statusClass, '5xx');
});

test('decision helpers stay total on hostile input', () => {
  assert.equal(statusClass(200), '2xx');
  assert.equal(statusClass(502), '5xx');
  assert.equal(statusClass(undefined), 'none');
  assert.equal(statusClass('nonsense'), 'NaNxx');
  assert.equal(probeSegment('/../../admin'), '..');
  // Only the first segment is ever echoed, so a traversal probe reads as '..' and
  // never as a path; percent-encoding collapses to underscores.
  assert.equal(probeSegment('/%2e%2e/admin'), '_2e_2e');
  assert.equal(probeSegment('/admin/x'), 'admin');
  // Log injection: a newline in the probe path must not become a second line.
  assert.equal(probeSegment('/\ninjection\t'), '_injection_');
  assert.doesNotMatch(JSON.stringify(probeSegment('/a\nb')), /\n/);
  assert.equal(probeSegment('/' + 'a'.repeat(200)).length, 32);
  assert.equal(probeSegment('/a'.repeat(200)), 'a', 'only the first segment is ever echoed');
  assert.equal(probeSegment(''), '');
});
