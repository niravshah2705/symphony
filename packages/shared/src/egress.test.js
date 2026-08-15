'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  SENTINEL_TOKEN,
  EGRESS_ROUTES,
  EGRESS_SECRET_KEYS,
  egressUrl,
  matchRoute,
  normalizeProxyBase,
  projectEgressHeaders,
} = require('./egress');

test('egressUrl: proxy mode cannot be bypassed by an explicit provider override', () => {
  const url = egressUrl({
    proxyBase: 'http://127.0.0.1:4030',
    prefix: '/anthropic',
    explicit: 'https://custom.example',
    fallback: 'https://api.anthropic.com',
  });
  assert.equal(url, 'http://127.0.0.1:4030/anthropic');
});

test('egressUrl: proxy base wins over fallback when no explicit', () => {
  assert.equal(
    egressUrl({ proxyBase: 'http://127.0.0.1:4030/', prefix: '/anthropic', fallback: 'https://api.anthropic.com' }),
    'http://127.0.0.1:4030/anthropic'
  );
});

test('egressUrl: fallback used when no proxy and no explicit', () => {
  assert.equal(
    egressUrl({ proxyBase: '', prefix: '/anthropic', fallback: 'https://api.anthropic.com' }),
    'https://api.anthropic.com'
  );
});

test('normalizeProxyBase strips trailing slashes', () => {
  assert.equal(normalizeProxyBase('http://x:4030//'), 'http://x:4030');
});

test('projectEgressHeaders emits only canonical UUID context', () => {
  const id = '7e2ce8ba-57d3-4d80-bdba-ec18a8d2d348';
  assert.deepEqual(projectEgressHeaders({ projectId: id }), { 'X-AI-Fleet-Project-ID': id });
  assert.deepEqual(projectEgressHeaders({ projectId: 'legacy-project-id' }), {});
});

test('matchRoute: longest-prefix disambiguates /linear vs /linear-mcp', () => {
  assert.equal(matchRoute('/linear').route, EGRESS_ROUTES.linear);
  assert.equal(matchRoute('/linear-mcp').route, EGRESS_ROUTES.linearMcp);
});

test('matchRoute: /github-api and /git/github are distinct', () => {
  assert.equal(matchRoute('/github-api/repos/x/y').route, EGRESS_ROUTES.githubApi);
  assert.equal(matchRoute('/git/github/o/r.git/info/refs').route, EGRESS_ROUTES.git);
});

test('matchRoute: GitLab, Jira, Asana, and OMLX use fixed route prefixes', () => {
  assert.equal(matchRoute('/gitlab-api/projects/1').route, EGRESS_ROUTES.gitlabApi);
  assert.equal(matchRoute('/git/gitlab/acme/app.git').route, EGRESS_ROUTES.gitlabGit);
  assert.equal(matchRoute('/jira-api/issue/AI-1').route, EGRESS_ROUTES.jiraApi);
  assert.equal(matchRoute('/asana-api/tasks').route, EGRESS_ROUTES.asanaApi);
  assert.equal(matchRoute('/omlx/v1/models').route, EGRESS_ROUTES.omlx);
});

test('matchRoute: anonymous and trusted operator activity has fixed proxy routes', () => {
  assert.equal(matchRoute('/duckduckgo-html/html/?q=fleet').route, EGRESS_ROUTES.duckDuckGoHtml);
  assert.equal(matchRoute('/ipwho/8.8.8.8?fields=country_code').route, EGRESS_ROUTES.ipwho);
  assert.equal(matchRoute('/ollama/api/tags').route, EGRESS_ROUTES.ollama);
  assert.equal(matchRoute('/lmstudio/v1/models').route, EGRESS_ROUTES.lmstudio);
  assert.equal(matchRoute('/openswe/threads').route, EGRESS_ROUTES.openSwe);
  assert.equal(matchRoute('/codex-oauth-token').route, EGRESS_ROUTES.codexOauthToken);
  assert.equal(matchRoute('/claude-oauth-token').route, EGRESS_ROUTES.claudeOauthToken);
  assert.equal(matchRoute('/codex-oauth-token/other'), null);
  assert.equal(matchRoute('/claude-oauth-token?target=other'), null);
});

test('matchRoute: Slack webhook is exact and cannot select a path or query', () => {
  assert.equal(matchRoute('/slack-webhook').route, EGRESS_ROUTES.slackWebhook);
  assert.equal(matchRoute('/slack-webhook/other'), null);
  assert.equal(matchRoute('/slack-webhook?target=other'), null);
});

test('matchRoute: returns path remainder after the prefix', () => {
  assert.equal(matchRoute('/anthropic/v1/messages').rest, '/v1/messages');
  assert.equal(matchRoute('/linear').rest, '/');
});

test('matchRoute: unknown path returns null (no open relay)', () => {
  assert.equal(matchRoute('/evil.example/steal'), null);
  assert.equal(matchRoute('/'), null);
});

test('EGRESS_SECRET_KEYS is the deduped set of static-key routes', () => {
  assert.ok(EGRESS_SECRET_KEYS.includes('githubToken'));
  assert.ok(EGRESS_SECRET_KEYS.includes('linearApiKey'));
  // Deduped: githubToken backs both github-api and github-mcp but appears once.
  assert.equal(EGRESS_SECRET_KEYS.filter((k) => k === 'githubToken').length, 1);
});

test('SENTINEL_TOKEN is a non-empty constant', () => {
  assert.equal(typeof SENTINEL_TOKEN, 'string');
  assert.ok(SENTINEL_TOKEN.length > 0);
});
