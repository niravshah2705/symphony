'use strict';

const { LLM_GATEWAY_ORG_HEADER } = require('@ai-fleet/shared-core/egress');
const {
  fetchOrgSecrets,
  fetchManagedSecrets,
  fetchOrgEgressConfig,
} = require('./secrets-client');

/**
 * Resolve the credential and trusted target for an egress route. Provider
 * credentials have one source only: the settings S2S resolver. The proxy never
 * falls back to its process environment, because that could silently select a
 * different organization's/platform's key during a resolver outage.
 */

function configuredProxyOrgId(env = process.env) {
  const proxyOrgId = String(env.PROXY_ORG_ID || '').trim();
  const fleetOrgId = String(env.FLEET_ORG_ID || '').trim();
  if (proxyOrgId && fleetOrgId && proxyOrgId !== fleetOrgId) {
    throw new Error('PROXY_ORG_ID and FLEET_ORG_ID must identify the same organization.');
  }
  return proxyOrgId || fleetOrgId;
}

const DEFAULT_ORG_ID = configuredProxyOrgId();
const CACHE_TTL_MS = Number(process.env.PROXY_SECRETS_TTL_MS) || 60000;

class FailClosed extends Error {
  constructor(message) {
    super(message);
    this.name = 'FailClosed';
    this.status = 502;
  }
}

let secretsCache = { scope: '', at: 0, data: null };
let egressConfigCache = { scope: '', at: 0, data: null };

function proxyOrgId(opts = {}) {
  if (opts.orgId !== undefined) return String(opts.orgId || '').trim();
  if (opts.env) return configuredProxyOrgId(opts.env);
  return DEFAULT_ORG_ID;
}

async function resolveSecrets(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const orgId = proxyOrgId(opts);
  const projectId = String(opts.projectId || '').trim().toLowerCase();
  const scope = `${orgId || '__managed__'}:${projectId}`;
  if (secretsCache.data && secretsCache.scope === scope && now - secretsCache.at < CACHE_TTL_MS) {
    return secretsCache.data;
  }
  let data;
  try {
    data = orgId
      ? await fetchOrgSecrets(orgId, opts)
      : await fetchManagedSecrets(opts);
  } catch (error) {
    throw error instanceof FailClosed
      ? error
      : new FailClosed('settings secret resolution failed');
  }
  if (!data || typeof data !== 'object' || !data.secrets || typeof data.secrets !== 'object') {
    throw new FailClosed('settings secret resolution returned no usable payload');
  }
  secretsCache = { scope, at: now, data };
  return data;
}

async function resolveEgressConfig(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const orgId = proxyOrgId(opts);
  if (!orgId) throw new FailClosed('organization egress configuration is unavailable on a shared proxy');
  if (
    egressConfigCache.data
    && egressConfigCache.scope === orgId
    && now - egressConfigCache.at < CACHE_TTL_MS
  ) {
    return egressConfigCache.data;
  }
  let data;
  try {
    data = await fetchOrgEgressConfig(orgId, opts);
  } catch (_) {
    throw new FailClosed('organization egress configuration could not be resolved');
  }
  if (!data || typeof data !== 'object') {
    throw new FailClosed('organization egress configuration is missing');
  }
  egressConfigCache = { scope: orgId, at: now, data };
  return data;
}

function clearCache() {
  secretsCache = { scope: '', at: 0, data: null };
  egressConfigCache = { scope: '', at: 0, data: null };
}

function safeCredential(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (/[\x00\r\n]/.test(text) || text.length > 16384) {
    throw new FailClosed(`${label} is invalid`);
  }
  return text;
}

/** Resolve a vault/settings key. Missing required values always fail closed. */
function resolveStaticKey(secretKey, resolved, options = {}) {
  if (!resolved || !resolved.secrets || typeof resolved.secrets !== 'object') {
    throw new FailClosed('settings secret payload is unavailable');
  }
  const entry = resolved.secrets[secretKey];
  const value = entry && safeCredential(entry.value, `credential "${secretKey}"`);
  if (value) return value;
  if (options.allowMissing && (options.allowCustomerMissing || !entry || entry.source !== 'customer')) {
    return '';
  }
  throw new FailClosed(`required credential "${secretKey}" is not configured`);
}

function normalizeTrustedUpstream(value, label) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (_) {
    throw new FailClosed(`${label} is not a valid URL`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new FailClosed(`${label} is not an allowed URL`);
  }
  return url.toString().replace(/\/$/, '');
}

function normalizeOmlxUpstream(value) {
  return normalizeTrustedUpstream(value, 'OMLX_PROXY_UPSTREAM');
}

function normalizeJiraConfig(config) {
  const rawOrigin = config && (config.jira_origin || config.jiraOrigin);
  const email = safeCredential(config && (config.jira_email || config.jiraEmail), 'Jira account email');
  let url;
  try {
    url = new URL(String(rawOrigin || '').trim());
  } catch (_) {
    throw new FailClosed('Jira origin is not configured');
  }
  const labels = url.hostname.split('.');
  const tenant = labels.length === 3 ? labels[0] : '';
  if (
    url.protocol !== 'https:'
    || labels[1] !== 'atlassian'
    || labels[2] !== 'net'
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tenant)
    || url.port
    || url.username
    || url.password
    || (url.pathname && url.pathname !== '/')
    || url.search
    || url.hash
    || !email
    || email.includes(':')
  ) {
    throw new FailClosed('Jira organization egress configuration is invalid');
  }
  return { origin: `https://${tenant}.atlassian.net`, email };
}

function normalizeSlackWebhook(value) {
  let url;
  try {
    url = new URL(safeCredential(value, 'Slack webhook URL'));
  } catch (error) {
    if (error instanceof FailClosed) throw error;
    throw new FailClosed('Slack webhook URL is not configured');
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'hooks.slack.com'
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || !/^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname)
  ) {
    throw new FailClosed('Slack webhook URL is invalid');
  }
  return url.toString();
}

async function resolveUpstream(route, opts = {}) {
  if (route.upstream) return route.upstream;
  if (route.target === 'omlx') {
    const env = opts.env || process.env;
    return normalizeOmlxUpstream(env.OMLX_PROXY_UPSTREAM);
  }
  if (route.target === 'ollama' || route.target === 'lmstudio' || route.target === 'openswe') {
    const env = opts.env || process.env;
    const name = {
      ollama: 'OLLAMA_PROXY_UPSTREAM',
      lmstudio: 'LMSTUDIO_PROXY_UPSTREAM',
      openswe: 'OPENSWE_PROXY_UPSTREAM',
    }[route.target];
    return normalizeTrustedUpstream(env[name], name);
  }
  if (route.target === 'jira') {
    const config = opts.egressConfig !== undefined
      ? opts.egressConfig
      : await resolveEgressConfig(opts);
    return `${normalizeJiraConfig(config).origin}/rest/api/3`;
  }
  if (route.target === 'slack-webhook') {
    const resolved = opts.resolved !== undefined ? opts.resolved : await resolveSecrets(opts);
    return normalizeSlackWebhook(resolveStaticKey(route.secretKey, resolved));
  }
  throw new FailClosed('egress route has no trusted upstream');
}

async function buildInjection(route, opts = {}) {
  const oauthManager = opts.oauthManager;
  const resolvedSecrets = async () => (
    opts.resolved !== undefined ? opts.resolved : resolveSecrets(opts)
  );
  const headers = {};

  switch (route.auth) {
    case 'claude': {
      const resolved = await resolvedSecrets();
      const apiKey = resolveStaticKey('anthropicApiKey', resolved, { allowMissing: true });
      if (apiKey) return { 'x-api-key': apiKey };
      if (!oauthManager || typeof oauthManager.getClaudeAuth !== 'function') {
        throw new FailClosed('Claude OAuth resolver is unavailable');
      }
      const auth = await oauthManager.getClaudeAuth();
      const accessToken = safeCredential(auth && auth.accessToken, 'Claude access token');
      if (!accessToken) throw new FailClosed('Claude access token is unavailable');
      headers.authorization = `Bearer ${accessToken}`;
      const betaHeader = safeCredential(auth && auth.betaHeader, 'Anthropic beta header');
      if (betaHeader) headers['anthropic-beta'] = betaHeader;
      return headers;
    }
    case 'codex-chatgpt': {
      if (!oauthManager || typeof oauthManager.getCodexAuth !== 'function') {
        throw new FailClosed('Codex OAuth resolver is unavailable');
      }
      const auth = await oauthManager.getCodexAuth();
      const accessToken = safeCredential(auth && auth.accessToken, 'Codex access token');
      if (!accessToken) throw new FailClosed('Codex access token is unavailable');
      headers.authorization = `Bearer ${accessToken}`;
      const accountId = safeCredential(auth && auth.accountId, 'ChatGPT account id');
      if (accountId) headers['chatgpt-account-id'] = accountId;
      return headers;
    }
    case 'codex-api': {
      const resolved = await resolvedSecrets();
      const bundle = resolved.secrets && resolved.secrets.codexTokenBundle;
      if (!(bundle && bundle.value)) {
        const apiKey = resolveStaticKey('openaiApiKey', resolved, { allowMissing: true });
        if (apiKey) return { authorization: `Bearer ${apiKey}` };
      }
      if (!oauthManager || typeof oauthManager.getCodexAuth !== 'function') {
        throw new FailClosed('Codex OAuth resolver is unavailable');
      }
      const auth = await oauthManager.getCodexAuth();
      const accessToken = safeCredential(auth && auth.accessToken, 'Codex access token');
      if (!accessToken) throw new FailClosed('Codex access token is unavailable');
      return { authorization: `Bearer ${accessToken}` };
    }
    case 'git': {
      const key = resolveStaticKey(route.secretKey, await resolvedSecrets());
      const username = safeCredential(route.username, 'git credential username');
      return { authorization: `Basic ${Buffer.from(`${username}:${key}`).toString('base64')}` };
    }
    case 'llm-gateway': {
      const key = resolveStaticKey(route.secretKey, await resolvedSecrets());
      const orgId = safeCredential(
        configuredProxyOrgId(opts.env || process.env),
        'proxy organization id',
      );
      headers.authorization = `Bearer ${key}`;
      if (orgId) headers[LLM_GATEWAY_ORG_HEADER] = orgId;
      return headers;
    }
    case 'jira': {
      const token = resolveStaticKey(route.secretKey, await resolvedSecrets());
      const config = opts.egressConfig !== undefined
        ? opts.egressConfig
        : await resolveEgressConfig(opts);
      const { email } = normalizeJiraConfig(config);
      return { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };
    }
    case 'apiKey': {
      const key = resolveStaticKey(route.secretKey, await resolvedSecrets(), {
        allowMissing: route.optionalCredential === true,
        allowCustomerMissing: route.optionalCredential === true,
      });
      if (!key) return headers; // oMLX is the only explicitly anonymous route.
      if (route.scheme === 'raw') headers.authorization = key;
      else if (route.scheme === 'x-api-key') headers['x-api-key'] = key;
      else if (route.scheme === 'x-goog-api-key') headers['x-goog-api-key'] = key;
      else if (route.scheme === 'private-token') headers['private-token'] = key;
      else headers.authorization = `Bearer ${key}`;
      return headers;
    }
    case 'url-secret':
      return headers;
    case 'none':
      return headers;
    default:
      throw new FailClosed('egress route has no supported authentication policy');
  }
}

async function resolveRoute(route, opts = {}) {
  const upstream = await resolveUpstream(route, opts);
  const headers = await buildInjection(route, opts);
  return { upstream, headers };
}

module.exports = {
  configuredProxyOrgId,
  FailClosed,
  resolveSecrets,
  resolveEgressConfig,
  clearCache,
  resolveStaticKey,
  normalizeTrustedUpstream,
  normalizeOmlxUpstream,
  normalizeJiraConfig,
  normalizeSlackWebhook,
  resolveUpstream,
  buildInjection,
  resolveRoute,
};
