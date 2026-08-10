'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// config.js reads EGRESS_PROXY_URL once at module load, so each mode is asserted
// in its own subprocess.
function evalWith(env, code) {
  const out = execFileSync(process.execPath, ['-e', code], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return out.trim();
}

const DUMP = `
const { CONFIG } = require('./src/config');
const { validateRepository } = require('./src/agent/repository-broker');
const repo = validateRepository({ provider:'github', https:'https://github.com/acme/widget.git', owner:'acme', name:'widget', fullName:'acme/widget' }, 'github');
console.log(JSON.stringify({
  linear: CONFIG.LINEAR_API_URL,
  ghApi: CONFIG.GITHUB_API_ORIGIN,
  gitOrigin: CONFIG.GIT_HTTPS_ORIGIN,
  claude: CONFIG.CLAUDE.baseUrl,
  codex: CONFIG.OAUTH.chatgptBaseUrl,
  gemini: CONFIG.ANTIGRAVITY.openaiBaseUrl,
  hf: CONFIG.HUGGINGFACE.defaultHost,
  repoApi: repo.apiOrigin,
  repoHttps: repo.https,
}));
`;

test('direct mode (no EGRESS_PROXY_URL) keeps real upstreams — backward compatible', () => {
  const cfg = JSON.parse(evalWith({ EGRESS_PROXY_URL: '' }, DUMP));
  assert.equal(cfg.linear, 'https://api.linear.app/graphql');
  assert.equal(cfg.ghApi, 'https://api.github.com');
  assert.equal(cfg.claude, 'https://api.anthropic.com');
  assert.equal(cfg.repoHttps, 'https://github.com/acme/widget.git');
});

test('proxy mode retargets every provider base at the sidecar prefixes', () => {
  const cfg = JSON.parse(evalWith({ EGRESS_PROXY_URL: 'http://127.0.0.1:4030' }, DUMP));
  assert.equal(cfg.linear, 'http://127.0.0.1:4030/linear');
  assert.equal(cfg.ghApi, 'http://127.0.0.1:4030/github-api');
  assert.equal(cfg.gitOrigin, 'http://127.0.0.1:4030/git/github');
  assert.equal(cfg.claude, 'http://127.0.0.1:4030/anthropic');
  assert.equal(cfg.codex, 'http://127.0.0.1:4030/codex');
  assert.equal(cfg.gemini, 'http://127.0.0.1:4030/gemini');
  assert.equal(cfg.hf, 'http://127.0.0.1:4030/hf');
  // The broker retargets both REST and the git remote at the proxy.
  assert.equal(cfg.repoApi, 'http://127.0.0.1:4030/github-api');
  assert.equal(cfg.repoHttps, 'http://127.0.0.1:4030/git/github/acme/widget.git');
});

test('explicit per-provider env override still wins over the proxy default', () => {
  const cfg = JSON.parse(
    evalWith({ EGRESS_PROXY_URL: 'http://127.0.0.1:4030', CLAUDE_ANTHROPIC_BASE_URL: 'https://direct.example' }, DUMP)
  );
  assert.equal(cfg.claude, 'https://direct.example');
  // Others still route through the proxy.
  assert.equal(cfg.linear, 'http://127.0.0.1:4030/linear');
});
