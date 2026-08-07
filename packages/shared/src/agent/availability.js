'use strict';

const { CONFIG } = require('../config');
const { discoverModels } = require('./model-discovery');
const { repoParts } = require('./workspace');
const { MODEL_ROLES } = require('./model-presets');

// Roles that may be surfaced on a public pause reason (deployment slots plus the
// purpose roles). 'byom' is the canonical BYoM slot; 'local' stays as its legacy
// alias. Anything else is dropped so the UI never shows a stray value.
const KNOWN_PAUSE_ROLES = new Set(['byom', 'local', 'global', ...MODEL_ROLES]);

const PROBE_TIMEOUT_MS = 5000;
const MODEL_ERROR_CODES = new Set([
  'model_unavailable',
  'model_not_found',
  'runtime_auth_unavailable',
  'runtime_auth_setup_failed',
  'runtime_unavailable',
  'authentication_error',
  'permission_error',
  'rate_limit_error',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ETIMEDOUT',
]);
const REPOSITORY_AVAILABILITY_CODES = new Set(['missing_token', 'provider_unavailable']);
const REMOTE_GIT_FAILURE = /(?:authentication failed|could not resolve host|could not read username|could not read from remote repository|unable to access|connection (?:refused|reset|timed?\s*out)|network (?:is unreachable|error)|remote:\s*[^\r\n]*(?:permission denied|not allowed|forbidden)|permission to [^\r\n]+ denied|repository not found|not authorized|requested url returned error:\s*(?:401|403|404|408|429|5\d\d)|http\s*(?:401|403|404|408|429|5\d\d))\b/i;

class AgentAvailabilityError extends Error {
  constructor(resource, message, status = 503, code = `${resource}_unavailable`) {
    super(message);
    this.name = 'AgentAvailabilityError';
    this.resource = resource;
    this.status = status;
    this.code = code;
  }
}

function statusOf(error) {
  const values = [error && error.status, error && error.statusCode, error && error.response && error.response.status];
  return values.map(Number).find(Number.isFinite) || null;
}

function publicAvailabilityMessage(resource, context = {}) {
  if (resource === 'git') {
    const provider = context.provider === 'gitlab' ? 'GitLab' : 'GitHub';
    return `${provider} repository access is unavailable. Check the repository and token in Settings, then resume agent jobs.`;
  }
  const provider = context.provider === 'lmstudio'
    ? 'LM Studio'
    : context.provider === 'omlx'
      ? 'oMLX'
    : context.provider === 'ollama'
      ? 'Ollama'
      : context.provider === 'claude'
        ? 'Claude'
        : context.provider === 'codex'
          ? 'Codex'
          : context.provider === 'huggingface'
            ? 'Hugging Face'
            : context.provider === 'antigravity'
              ? 'Antigravity'
              : 'selected';
  return `The ${provider} model is unavailable. Check the model in Settings, then resume agent jobs.`;
}

function pauseReasonFor(resource, error, context = {}, now = Date.now()) {
  const reason = {
    code: `${resource}-unavailable`,
    resource,
    message: publicAvailabilityMessage(resource, context),
    since: new Date(now).toISOString(),
  };
  if (context.taskIdentifier) reason.taskIdentifier = String(context.taskIdentifier);
  if (KNOWN_PAUSE_ROLES.has(context.role)) reason.role = context.role;
  if (context.provider) reason.provider = String(context.provider);
  if (context.model) reason.model = String(context.model);
  return reason;
}

function isRepositoryAvailabilityError(error) {
  if (!error) return false;
  if (error.resource === 'git') return true;
  if (error.name !== 'RepositoryBrokerError') return false;
  if (REPOSITORY_AVAILABILITY_CODES.has(error.code)) return true;
  const message = String(error.message || '');
  if (error.code === 'provider_error') {
    return /returned (?:401|403|404|408|429|5\d\d)\b/.test(message) || REMOTE_GIT_FAILURE.test(message);
  }
  return error.code === 'git_failed' && REMOTE_GIT_FAILURE.test(message);
}

function isModelAvailabilityError(error) {
  if (!error) return false;
  if (error.resource === 'model') return true;
  // Planner/runtime wrappers use 5xx for both provider outages and ordinary
  // invalid output. Inspect the preserved cause before considering their own
  // status so a malformed response does not pause every queued project.
  if (error.cause && error.cause !== error && isModelAvailabilityError(error.cause)) return true;
  if (error.name === 'AgentError' || error.name === 'AgentRuntimeError') {
    return MODEL_ERROR_CODES.has(error.code);
  }
  const status = statusOf(error);
  if (status && (status === 401 || status === 403 || status === 404 || status === 408 || status === 429 || status >= 500)) {
    return true;
  }
  if (MODEL_ERROR_CODES.has(error.code)) return true;
  const message = String(error.message || error).toLowerCase();
  return /model[^.]{0,80}(not found|not available|unavailable|not loaded)|connection refused|fetch failed|network error|timed?\s*out|unauthorized|forbidden|permission denied|quota|rate limit|http\s*(?:401|403|404|408|429|5\d\d)\b|status(?:\s+code)?\s*[:=]?\s*(?:401|403|404|408|429|5\d\d)\b/.test(message);
}

function selectedModelExists(selected, available) {
  const wanted = String(selected || '').trim();
  if (!wanted) return false;
  const normalize = (value) => String(value || '').trim().replace(/:latest$/i, '');
  return available.some((value) => String(value || '').trim() === wanted || normalize(value) === normalize(wanted));
}

async function probeModelAvailability(llm, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || global.fetch;
  const discoverModelsImpl = dependencies.discoverModelsImpl || discoverModels;
  const timeoutMs = dependencies.timeoutMs || PROBE_TIMEOUT_MS;
  const context = { provider: llm && llm.provider, model: llm && llm.model };
  if (!llm || !llm.provider || !llm.model) {
    throw new AgentAvailabilityError('model', publicAvailabilityMessage('model', context), 400, 'model_not_configured');
  }

  try {
    if (llm.provider === 'ollama' || llm.provider === 'lmstudio' || llm.provider === 'omlx') {
      if (typeof fetchImpl !== 'function' || !llm.host) throw new Error('Local model host is not configured.');
      const path = llm.provider === 'ollama' ? '/api/tags' : '/v1/models';
      const headers = { Accept: 'application/json' };
      if (llm.provider === 'omlx' && llm.apiKey) headers.Authorization = `Bearer ${llm.apiKey}`;
      const response = await fetchImpl(`${String(llm.host).replace(/\/$/, '')}${path}`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw Object.assign(new Error('Local model service rejected the readiness check.'), { status: response.status });
      const body = await response.json();
      const models = llm.provider === 'ollama'
        ? (Array.isArray(body.models) ? body.models : []).map((entry) => entry && (entry.name || entry.model))
        : (Array.isArray(body.data) ? body.data : []).map((entry) => entry && entry.id);
      if (!selectedModelExists(llm.model, models)) {
        throw new AgentAvailabilityError('model', publicAvailabilityMessage('model', context), 404, 'model_not_found');
      }
      return { available: true, provider: llm.provider, model: llm.model };
    }

    if (llm.provider === 'codex' || llm.provider === 'claude') {
      const credentials = llm.provider === 'codex'
        ? { accessToken: llm.accessToken, accountId: llm.accountId }
        : { accessToken: llm.accessToken };
      const discovered = await discoverModelsImpl(llm.provider, {
        backend: llm.backend || CONFIG.OAUTH.backend,
        credentials,
        refresh: true,
        strict: true,
        fetchImpl,
      });
      const model = discovered.models.find((candidate) => candidate.id === llm.model);
      if (!model || (llm.provider === 'codex' && llm.backend === 'api' && model.source !== 'live')) {
        throw new AgentAvailabilityError('model', publicAvailabilityMessage('model', context), 404, 'model_not_found');
      }
      return { available: true, provider: llm.provider, model: llm.model };
    }

    if (llm.provider === 'huggingface') {
      if (typeof fetchImpl !== 'function' || !llm.baseUrl) throw new Error('Hugging Face endpoint is not configured.');
      if (!llm.apiKey) {
        throw new AgentAvailabilityError('model', publicAvailabilityMessage('model', context), 401, 'model_not_configured');
      }
      // Validate the token + connectivity against the router. Its model listing is
      // large and may omit routable models, so we do NOT require the configured
      // model to appear — only that the authenticated call succeeds.
      const response = await fetchImpl(`${String(llm.baseUrl).replace(/\/$/, '')}/models`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${llm.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw Object.assign(new Error('Hugging Face rejected the readiness check.'), { status: response.status });
      return { available: true, provider: llm.provider, model: llm.model };
    }

    if (llm.provider === 'antigravity') {
      if (typeof fetchImpl !== 'function' || !llm.baseUrl) throw new Error('Antigravity endpoint is not configured.');
      if (!llm.apiKey) {
        throw new AgentAvailabilityError('model', publicAvailabilityMessage('model', context), 401, 'model_not_configured');
      }
      // Validate the Gemini API key + connectivity against the OpenAI-compatible
      // endpoint. Gemini's model listing does not always surface every routable
      // model, so we only require the authenticated call to succeed.
      const response = await fetchImpl(`${String(llm.baseUrl).replace(/\/$/, '')}/models`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${llm.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw Object.assign(new Error('Antigravity (Gemini) rejected the readiness check.'), { status: response.status });
      return { available: true, provider: llm.provider, model: llm.model };
    }

    throw new AgentAvailabilityError('model', publicAvailabilityMessage('model', context), 400, 'model_provider_invalid');
  } catch (error) {
    if (error instanceof AgentAvailabilityError) throw error;
    throw new AgentAvailabilityError('model', publicAvailabilityMessage('model', context), statusOf(error) || 503);
  }
}

async function probeRepositoryAvailability(selection, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || global.fetch;
  const timeoutMs = dependencies.timeoutMs || PROBE_TIMEOUT_MS;
  const provider = selection && selection.provider === 'gitlab' ? 'gitlab' : 'github';
  const context = { provider };
  const parts = repoParts(selection && selection.repoRef, provider);
  if (!parts || !selection.token || typeof fetchImpl !== 'function') {
    throw new AgentAvailabilityError('git', publicAvailabilityMessage('git', context), 400, 'git_not_configured');
  }

  const github = provider === 'github';
  const url = github
    ? `https://api.github.com/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}`
    : `https://gitlab.com/api/v4/projects/${encodeURIComponent(parts.fullName)}`;
  const headers = github
    ? {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${selection.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tech-symphony-readiness',
      }
    : { Accept: 'application/json', 'PRIVATE-TOKEN': selection.token, 'User-Agent': 'tech-symphony-readiness' };
  try {
    const response = await fetchImpl(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new AgentAvailabilityError('git', publicAvailabilityMessage('git', context), response.status);
    }
    const body = await response.json();
    if (github && body && body.permissions && body.permissions.push === false) {
      throw new AgentAvailabilityError('git', publicAvailabilityMessage('git', context), 403, 'git_write_unavailable');
    }
    if (!github && body && body.permissions) {
      const projectLevel = Number(body.permissions.project_access && body.permissions.project_access.access_level) || 0;
      const groupLevel = Number(body.permissions.group_access && body.permissions.group_access.access_level) || 0;
      if (Math.max(projectLevel, groupLevel) < 30) {
        throw new AgentAvailabilityError('git', publicAvailabilityMessage('git', context), 403, 'git_write_unavailable');
      }
    }
    return { available: true, provider, repository: parts.fullName };
  } catch (error) {
    if (error instanceof AgentAvailabilityError) throw error;
    throw new AgentAvailabilityError('git', publicAvailabilityMessage('git', context), statusOf(error) || 503);
  }
}

module.exports = {
  AgentAvailabilityError,
  isModelAvailabilityError,
  isRepositoryAvailabilityError,
  pauseReasonFor,
  probeModelAvailability,
  probeRepositoryAvailability,
  publicAvailabilityMessage,
  selectedModelExists,
  statusOf,
};
