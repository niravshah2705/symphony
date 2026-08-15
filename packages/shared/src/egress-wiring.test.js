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
const gitlab = validateRepository({ provider:'gitlab', https:'https://gitlab.com/acme/platform/widget.git', owner:'acme/platform', name:'widget', fullName:'acme/platform/widget' }, 'gitlab');
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
  gitlabApi: gitlab.apiOrigin,
  gitlabHttps: gitlab.https,
  omlx: CONFIG.OMLX.defaultHost,
  ollama: CONFIG.OLLAMA.defaultHost,
  lmstudio: CONFIG.LMSTUDIO.defaultHost,
  openswe: CONFIG.CODER.openswe.url,
  search: CONFIG.DUCKDUCKGO_HTML_ORIGIN,
  ipwho: CONFIG.IPWHO_ORIGIN,
  codexToken: CONFIG.OAUTH.tokenUrl,
  codexAuthorize: CONFIG.OAUTH.authorizeUrl,
  claudeToken: CONFIG.CLAUDE.tokenUrl,
  claudeAuthorize: CONFIG.CLAUDE.authorizeUrl,
  sdkProxy: CONFIG.EGRESS_PROXY_INCLUDE_SDK,
}));
`;

test('direct mode (no EGRESS_PROXY_URL) keeps real upstreams — backward compatible', () => {
  const cfg = JSON.parse(evalWith({ EGRESS_PROXY_URL: '' }, DUMP));
  assert.equal(cfg.linear, 'https://api.linear.app/graphql');
  assert.equal(cfg.ghApi, 'https://api.github.com');
  assert.equal(cfg.claude, 'https://api.anthropic.com');
  assert.equal(cfg.repoHttps, 'https://github.com/acme/widget.git');
  assert.equal(cfg.gitlabApi, 'https://gitlab.com/api/v4');
  assert.equal(cfg.gitlabHttps, 'https://gitlab.com/acme/platform/widget.git');
  assert.equal(cfg.sdkProxy, false);
  assert.equal(cfg.ollama, 'http://localhost:11434');
  assert.equal(cfg.lmstudio, 'http://localhost:1234');
  assert.equal(cfg.openswe, 'http://localhost:2024');
  assert.equal(cfg.search, 'https://html.duckduckgo.com');
  assert.equal(cfg.ipwho, 'https://ipwho.is');
  assert.equal(cfg.codexToken, 'https://auth.openai.com/oauth/token');
  assert.equal(cfg.claudeToken, 'https://console.anthropic.com/v1/oauth/token');
});

test('direct development preserves a trusted OPENSWE_URL override', () => {
  const cfg = JSON.parse(evalWith({
    EGRESS_PROXY_URL: '',
    OPENSWE_URL: 'http://127.0.0.1:2121',
  }, DUMP));
  assert.equal(cfg.openswe, 'http://127.0.0.1:2121');
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
  assert.equal(cfg.gitlabApi, 'http://127.0.0.1:4030/gitlab-api');
  assert.equal(cfg.gitlabHttps, 'http://127.0.0.1:4030/git/gitlab/acme/platform/widget.git');
  assert.equal(cfg.omlx, 'http://127.0.0.1:4030/omlx');
  assert.equal(cfg.ollama, 'http://127.0.0.1:4030/ollama');
  assert.equal(cfg.lmstudio, 'http://127.0.0.1:4030/lmstudio');
  assert.equal(cfg.openswe, 'http://127.0.0.1:4030/openswe');
  assert.equal(cfg.search, 'http://127.0.0.1:4030/duckduckgo-html');
  assert.equal(cfg.ipwho, 'http://127.0.0.1:4030/ipwho');
  assert.equal(cfg.codexToken, 'http://127.0.0.1:4030/codex-oauth-token');
  assert.equal(cfg.claudeToken, 'http://127.0.0.1:4030/claude-oauth-token');
  assert.equal(cfg.codexAuthorize, 'https://auth.openai.com/oauth/authorize');
  assert.equal(cfg.claudeAuthorize, 'https://claude.ai/oauth/authorize');
  assert.equal(cfg.sdkProxy, true);
});

test('proxy mode ignores settings-selected Ollama and LM Studio origins', () => {
  const code = `
global.fetch = async () => ({ ok:false });
const { resolveLlm } = require('./src/agent/llm');
Promise.all([
  resolveLlm({ llmProvider:'ollama', ollamaHost:'http://attacker.invalid:11434', ollamaModel:'x' }),
  resolveLlm({ llmProvider:'lmstudio', lmstudioHost:'http://attacker.invalid:1234', lmstudioModel:'x' }),
]).then(([ollama, lmstudio]) => console.log(JSON.stringify({ ollama:ollama.host, lmstudio:lmstudio.host })));
`;
  const resolved = JSON.parse(evalWith({ EGRESS_PROXY_URL: 'http://127.0.0.1:4030' }, code));
  assert.equal(resolved.ollama, 'http://127.0.0.1:4030/ollama');
  assert.equal(resolved.lmstudio, 'http://127.0.0.1:4030/lmstudio');
});

test('OAuth exchange and refresh POST only to fixed proxy token routes', () => {
  const code = `
const seen=[];
global.fetch=async (url) => { seen.push(url); return { ok:true, status:200, text:async()=>'{"access_token":"a","refresh_token":"r","expires_in":3600}' }; };
const codex=require('./src/agent/oauth');
const claude=require('./src/agent/claude-oauth');
(async()=>{
  await codex.exchangeCodeForTokens({ code:'c', codeVerifier:'v', redirectUri:'http://localhost/callback' });
  await codex.refreshTokens({ refreshToken:'r' });
  await claude.exchangeCodeForTokens({ code:'c', state:'s', codeVerifier:'v' });
  await claude.refreshTokens({ refreshToken:'r' });
  console.log(JSON.stringify(seen));
})();
`;
  const seen = JSON.parse(evalWith({ EGRESS_PROXY_URL: 'http://127.0.0.1:4030' }, code));
  assert.deepEqual(seen, [
    'http://127.0.0.1:4030/codex-oauth-token',
    'http://127.0.0.1:4030/codex-oauth-token',
    'http://127.0.0.1:4030/claude-oauth-token',
    'http://127.0.0.1:4030/claude-oauth-token',
  ]);
});

test('explicit per-provider and OpenSWE env overrides cannot bypass proxy mode', () => {
  const cfg = JSON.parse(
    evalWith({
      EGRESS_PROXY_URL: 'http://127.0.0.1:4030',
      CLAUDE_ANTHROPIC_BASE_URL: 'https://direct.example',
      OPENSWE_URL: 'https://openswe-direct.example',
    }, DUMP)
  );
  assert.equal(cfg.claude, 'http://127.0.0.1:4030/anthropic');
  assert.equal(cfg.openswe, 'http://127.0.0.1:4030/openswe');
  // Others still route through the proxy.
  assert.equal(cfg.linear, 'http://127.0.0.1:4030/linear');
});
