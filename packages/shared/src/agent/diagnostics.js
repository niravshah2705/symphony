'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CONFIG } = require('../config');

const DEFAULT_TIMEOUT_MS = 1800;
const MAX_TIMEOUT_MS = 5000;

function boundedTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(250, Math.round(number)));
}

function configuredToken(tokens) {
  return Boolean(tokens && typeof tokens === 'object' && (tokens.accessToken || tokens.refreshToken));
}

function validHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch (_) {
    return null;
  }
}

function endpoint(base, pathname) {
  const url = validHttpUrl(base);
  if (!url) return null;
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  return url.toString();
}

async function probe(url, dependencies = {}) {
  if (!url) return { status: 'not-configured', summary: 'No valid endpoint is configured.' };
  const fetchFn = dependencies.fetch || globalThis.fetch;
  if (typeof fetchFn !== 'function') return { status: 'unavailable', summary: 'HTTP diagnostics are unavailable.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), boundedTimeout(dependencies.timeoutMs));
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.body && typeof response.body.cancel === 'function') {
      await response.body.cancel().catch(() => {});
    }
    return response.ok
      ? { status: 'healthy', summary: 'Endpoint responded successfully.', details: { httpStatus: response.status } }
      : { status: 'attention', summary: 'Endpoint responded with an error status.', details: { httpStatus: response.status } };
  } catch (_) {
    return { status: 'unavailable', summary: 'Endpoint could not be reached within the diagnostic timeout.' };
  } finally {
    clearTimeout(timer);
  }
}

function packageAvailable(name, resolver = require.resolve, dependencies = {}) {
  try {
    resolver(name);
    return true;
  } catch (error) {
    // Some ESM-only packages intentionally omit a default `exports` target.
    // Node reports ERR_PACKAGE_PATH_NOT_EXPORTED even though the package is
    // installed, so fall back to locating its package manifest without loading it.
    if (!error || error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') return false;
    const resolvePaths = dependencies.resolvePaths || require.resolve.paths;
    const existsSync = dependencies.existsSync || fs.existsSync;
    const searchPaths = typeof resolvePaths === 'function' ? resolvePaths(name) : [];
    const segments = String(name).split('/').filter(Boolean);
    if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) return false;
    return (searchPaths || []).some((directory) =>
      existsSync(path.join(directory, ...segments, 'package.json'))
    );
  }
}

function check(id, label, status, summary, action, details) {
  const result = { id, label, status, summary, action };
  if (details && Object.keys(details).length) result.details = details;
  return result;
}

function integrationChecks(settings) {
  const planningProvider = ['linear', 'jira', 'asana'].includes(settings.planningProvider)
    ? settings.planningProvider
    : 'linear';
  const planningConfigured = planningProvider === 'linear'
    ? Boolean(settings.linearApiKey)
    : planningProvider === 'jira'
      ? Boolean(settings.jiraBaseUrl && settings.jiraEmail && settings.jiraApiToken)
      : Boolean(settings.asanaWorkspaceId && settings.asanaAccessToken);

  const repositoryProvider = settings.repositoryProvider === 'gitlab' ? 'gitlab' : 'github';
  const repositoryConfigured = Boolean(
    settings.repositoryUrl && (repositoryProvider === 'gitlab' ? settings.gitlabToken : settings.githubToken)
  );
  const tracingConfigured = Boolean(
    settings.langsmithTracing && settings.langsmithApiKey && settings.langsmithProject
  );

  return [
    check(
      'planning-integration',
      'Project planning',
      planningConfigured ? 'healthy' : 'attention',
      planningConfigured ? `${planningProvider} is configured.` : `${planningProvider} needs configuration.`,
      planningConfigured ? 'No action needed.' : 'Complete the selected planning connector in Settings.',
      { provider: planningProvider, credentialVerified: false }
    ),
    check(
      'repository-integration',
      'Repository',
      repositoryConfigured ? 'healthy' : 'attention',
      repositoryConfigured ? `${repositoryProvider} is configured.` : `${repositoryProvider} needs a repository and token.`,
      repositoryConfigured ? 'No action needed.' : 'Add the repository and matching access token in Settings.',
      { provider: repositoryProvider, credentialVerified: false }
    ),
    check(
      'langsmith-integration',
      'Tracing and cost',
      tracingConfigured ? 'healthy' : 'attention',
      tracingConfigured ? 'LangSmith tracing is configured.' : 'LangSmith tracing is not ready.',
      tracingConfigured ? 'Use Analytics to verify incoming traces.' : 'Enable tracing and add a project and API key in Settings.',
      { credentialVerified: false }
    ),
  ];
}

function sdkChecks(settings, resolver) {
  const localProvider = settings.localLlmProvider === 'lmstudio' ? 'lmstudio' : 'ollama';
  const localReady = localProvider === 'lmstudio'
    ? Boolean(settings.lmstudioHost && settings.lmstudioModel)
    : Boolean(settings.ollamaHost && settings.ollamaModel);
  const codexAuth = configuredToken(settings.codexTokens);
  const claudeAuth = configuredToken(settings.claudeTokens);
  const definitions = [
    {
      id: 'deepagents-sdk',
      label: 'Deep Agents SDK',
      packageName: 'deepagents',
      authReady: localReady || codexAuth || claudeAuth,
      action: 'Configure at least one local or hosted model runtime in Settings.',
    },
    {
      id: 'codex-sdk',
      label: 'Codex SDK',
      packageName: '@openai/codex-sdk',
      authReady: codexAuth,
      action: 'Install the Codex SDK and sign in with Codex in Settings.',
    },
    {
      id: 'claude-sdk',
      label: 'Claude Agent SDK',
      packageName: '@anthropic-ai/claude-agent-sdk',
      authReady: claudeAuth,
      action: 'Install the Claude Agent SDK and sign in with Claude in Settings.',
    },
  ];

  return definitions.map((definition) => {
    const installed = packageAvailable(definition.packageName, resolver);
    const ready = installed && definition.authReady;
    return check(
      definition.id,
      definition.label,
      ready ? 'healthy' : 'attention',
      ready
        ? 'Package and runtime credentials are configured.'
        : !installed
          ? 'SDK package is not installed.'
          : 'SDK package is installed but runtime credentials are not configured.',
      ready ? 'Run a traced agent call to verify provider access.' : definition.action,
      { installed, authConfigured: definition.authReady, credentialVerified: false }
    );
  });
}

async function serviceChecks(services, dependencies) {
  const definitions = [
    ['planner-service', 'Planner service', endpoint(services.plannerUrl, '/api/agent/status')],
    ['coder-service', 'Coder service', endpoint(services.coderUrl, '/api/coder')],
  ];
  return Promise.all(definitions.map(async ([id, label, url]) => {
    const result = await probe(url, dependencies);
    return check(
      id,
      label,
      result.status,
      result.summary,
      result.status === 'healthy' ? 'No action needed.' : `Start or inspect the ${label.toLowerCase()}.`,
      result.details
    );
  }));
}

async function localModelCheck(settings, dependencies) {
  const provider = settings.localLlmProvider === 'lmstudio' ? 'lmstudio' : 'ollama';
  const base = provider === 'lmstudio' ? settings.lmstudioHost : settings.ollamaHost;
  const model = provider === 'lmstudio' ? settings.lmstudioModel : settings.ollamaModel;
  const url = endpoint(base, provider === 'lmstudio' ? '/v1/models' : '/api/tags');
  if (!model || !url) {
    return check(
      'local-model',
      'Local model',
      'attention',
      `${provider} needs a valid host and model.`,
      'Complete the local model configuration in Settings.',
      { provider, configured: false }
    );
  }
  const result = await probe(url, dependencies);
  return check(
    'local-model',
    'Local model',
    result.status,
    result.status === 'healthy' ? `${provider} is reachable.` : result.summary,
    result.status === 'healthy' ? 'Run a local enrichment to verify the selected model.' : `Start ${provider} and verify its host in Settings.`,
    { provider, configured: true, credentialVerified: false, ...(result.details || {}) }
  );
}

function reportStatus(checks) {
  if (checks.some((item) => item.status === 'unavailable')) return 'degraded';
  if (checks.some((item) => item.status === 'attention' || item.status === 'not-configured')) return 'attention';
  return 'healthy';
}

/** Build a secret-free diagnostic snapshot. Credentials are presence checks only. */
async function runDiagnostics(settings = {}, dependencies = {}) {
  const services = dependencies.services || CONFIG.SERVICES;
  const resolver = dependencies.resolvePackage || require.resolve;
  const [serviceResults, modelResult] = await Promise.all([
    serviceChecks(services, dependencies),
    localModelCheck(settings, dependencies),
  ]);
  const checks = [
    ...serviceResults,
    modelResult,
    ...integrationChecks(settings),
    ...sdkChecks(settings, resolver),
  ];
  return {
    status: reportStatus(checks),
    generatedAt: new Date(dependencies.now || Date.now()).toISOString(),
    note: 'Credential readiness is configuration-only; this report never returns or logs secrets.',
    checks,
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  endpoint,
  probe,
  packageAvailable,
  integrationChecks,
  sdkChecks,
  runDiagnostics,
};
