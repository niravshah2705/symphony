'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pathToFileURL } = require('url');
const { CONFIG } = require('../config');
const { SENTINEL_TOKEN } = require('../egress');
const { copySecretFreeJson, isSecretFieldName } = require('@ai-fleet/shared-core/pipeline/contracts');

const execFileP = promisify(execFile);

const PROVIDERS = Object.freeze({
  github: Object.freeze({
    host: 'github.com',
    apiOrigin: 'https://api.github.com',
    username: 'x-access-token',
  }),
  gitlab: Object.freeze({
    host: 'gitlab.com',
    apiOrigin: 'https://gitlab.com',
    username: 'oauth2',
  }),
});

const LIMITS = Object.freeze({
  toolCalls: 64,
  retryBranches: 20,
  titleChars: 240,
  bodyChars: 8_000,
  feedbackItems: 20,
  feedbackChars: 600,
  responseBytes: 1_000_000,
  toolOutputChars: 24_000,
  gitOutputChars: 4_000,
  gitTimeoutMs: 120_000,
  apiTimeoutMs: 20_000,
});

const SAFE_ENV_KEYS = Object.freeze([
  'PATH',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'CI',
]);

const BROKER_TOKEN_ENV = 'TECHSYMPHONY_BROKER_GIT_TOKEN';
const BROKER_HOST_ENV = 'TECHSYMPHONY_BROKER_GIT_HOST';
const BROKER_USER_ENV = 'TECHSYMPHONY_BROKER_GIT_USER';
const FRAMEWORK_SKILLS_EXCLUDE = '/.agent-skills/';
const DEPLOYMENT_MANIFEST = '.ai-fleet/deployment.json';
const DEPLOYMENT_MANIFEST_MAX_BYTES = 32 * 1024;
const DEPLOYMENT_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SECRET_FIELD_RE = /(?:^|[_-])(?:token|secret|password|passwd|pwd|credential|authorization|auth|cookie|session|bearer|pat|key)(?:$|[_-])/i;
const GITHUB_SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMAND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const AVAILABILITY_ERROR_CODES = new Set(['missing_token', 'provider_unavailable']);
const REMOTE_GIT_FAILURE = /(?:authentication failed|could not resolve host|could not read username|could not read from remote repository|unable to access|connection (?:refused|reset|timed?\s*out)|network (?:is unreachable|error)|remote:\s*[^\r\n]*(?:permission denied|not allowed|forbidden)|permission to [^\r\n]+ denied|repository not found|not authorized|requested url returned error:\s*(?:401|403|404|408|429|5\d\d)|http\s*(?:401|403|404|408|429|5\d\d))\b/i;

function isAvailabilityFailure(error) {
  if (!error) return false;
  if (AVAILABILITY_ERROR_CODES.has(error.code)) return true;
  const message = String(error.message || '');
  if (error.code === 'provider_error') {
    return /returned (?:401|403|404|408|429|5\d\d)\b/.test(message) || REMOTE_GIT_FAILURE.test(message);
  }
  return error.code === 'git_failed' && REMOTE_GIT_FAILURE.test(message);
}

// This helper is supplied only with `git -c` in broker-owned child processes.
// It is never persisted in an agent workspace. Git sends the requested host on
// stdin; the helper refuses to release a credential for any other origin.
const BROKER_CREDENTIAL_HELPER =
  `!f() { test "$1" = get || exit 0; host=''; while IFS='=' read -r key value; do test "$key" = host && host="$value"; done; test "$host" = "$${BROKER_HOST_ENV}" || exit 0; test -n "$${BROKER_TOKEN_ENV}" || exit 0; printf 'username=%s\npassword=%s\n' "$${BROKER_USER_ENV}" "$${BROKER_TOKEN_ENV}"; }; f`;

class RepositoryBrokerError extends Error {
  constructor(message, code = 'repository_broker_error') {
    super(message);
    this.name = 'RepositoryBrokerError';
    this.code = code;
  }
}

function cleanText(value, max = Infinity) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function oneLine(value, max = Infinity) {
  return cleanText(value).replace(/\s+/g, ' ').slice(0, max).trim();
}

function redact(value, secrets = []) {
  let text = String(value == null ? '' : value);
  for (const secret of secrets) {
    if (secret) text = text.split(String(secret)).join('***');
  }
  return text
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]+/gi, '$1***')
    .replace(/(private-token\s*[:=]\s*)[^\s,;]+/gi, '$1***')
    .replace(/(password=)[^\s]+/gi, '$1***')
    .slice(0, LIMITS.gitOutputChars);
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function assertScopedPath(root, candidate) {
  if (!isPathInside(root, candidate)) {
    throw new RepositoryBrokerError('Repository workspace is outside its allowed root.', 'workspace_scope');
  }
}

function safeHomeFor(workDir) {
  const digest = crypto.createHash('sha256').update(path.resolve(workDir)).digest('hex').slice(0, 16);
  const home = path.join(os.tmpdir(), 'techsymphony-agent-home', digest);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

/** Minimal environment for the unrestricted LocalShellBackend. */
function buildSafeAgentEnv(baseEnv = process.env, workDir = process.cwd()) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (typeof baseEnv[key] === 'string' && baseEnv[key]) env[key] = baseEnv[key];
  }
  env.HOME = safeHomeFor(workDir);
  env.XDG_CONFIG_HOME = path.join(env.HOME, '.config');
  env.XDG_CACHE_HOME = path.join(env.HOME, '.cache');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'Never';
  return env;
}

function validateBranch(value, name = 'branch') {
  const branch = String(value || '').trim();
  if (
    !branch ||
    branch.length > 120 ||
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    /[\s~^:?*\\\[\]]/.test(branch) ||
    !/^[A-Za-z0-9._/-]+$/.test(branch)
  ) {
    throw new RepositoryBrokerError(`${name} is not a safe Git branch name.`, 'invalid_branch');
  }
  return branch;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deploymentScalar(value, field) {
  if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
    throw new RepositoryBrokerError(`${field} must be a string, finite number, or boolean.`, 'invalid_deployment_manifest');
  }
  const text = String(value);
  if (text.length > 500 || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
    throw new RepositoryBrokerError(`${field} is not a safe bounded CI/CD input.`, 'invalid_deployment_manifest');
  }
  return value;
}

function deploymentSecretField(key) {
  return isSecretFieldName(key) || SECRET_FIELD_RE.test(String(key));
}

/** Validate one fixed repository-owned CI/CD allowlist entry. Repository JSON
 * is data, not a command: no executable, arbitrary URL, ref override, or secret
 * field can enter the deployment broker. */
function normalizeDeploymentManifest(raw, { provider, environment, baseBranch } = {}) {
  if (provider !== 'github') {
    throw new RepositoryBrokerError(
      'Deployment requires the brokered GitHub egress path.',
      'repository_provider_not_brokered',
    );
  }
  if (!isPlainObject(raw) || raw.schemaVersion !== 1 || !isPlainObject(raw.environments)) {
    throw new RepositoryBrokerError('Deployment manifest must use schemaVersion 1 with an environments map.', 'invalid_deployment_manifest');
  }
  const selectedEnvironment = String(environment || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(selectedEnvironment)) {
    throw new RepositoryBrokerError('Deployment environment is invalid.', 'invalid_deployment_environment');
  }
  const entry = raw.environments[selectedEnvironment];
  if (!isPlainObject(entry)) {
    throw new RepositoryBrokerError(`Environment "${selectedEnvironment}" is not allowlisted by ${DEPLOYMENT_MANIFEST}.`, 'deployment_environment_denied');
  }
  const expectedProvider = 'github-actions';
  if (entry.provider !== expectedProvider) {
    throw new RepositoryBrokerError(`Deployment provider must be ${expectedProvider}.`, 'invalid_deployment_manifest');
  }
  const ref = validateBranch(entry.ref || baseBranch, 'deployment ref');
  if (!baseBranch || ref !== baseBranch) {
    throw new RepositoryBrokerError('Deployment ref must equal the broker-scoped base branch.', 'deployment_ref_denied');
  }
  const workflow = String(entry.workflow || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(workflow) || !/\.ya?ml$/i.test(workflow)) {
    throw new RepositoryBrokerError('GitHub deployment workflow must be a workflow YAML filename.', 'invalid_deployment_manifest');
  }
  const inputs = {};
  if (entry.inputs !== undefined && !isPlainObject(entry.inputs)) {
    throw new RepositoryBrokerError('Deployment inputs must be an object.', 'invalid_deployment_manifest');
  }
  for (const [key, value] of Object.entries(entry.inputs || {})) {
    if (!DEPLOYMENT_KEY_RE.test(key) || deploymentSecretField(key)) {
      throw new RepositoryBrokerError('Deployment input key is not allowlisted.', 'invalid_deployment_manifest');
    }
    try {
      inputs[key] = deploymentScalar(copySecretFreeJson(value, `deployment.inputs.${key}`), `inputs.${key}`);
    } catch (_) {
      throw new RepositoryBrokerError('Deployment input contains forbidden credential material.', 'invalid_deployment_manifest');
    }
  }
  const environmentInput = entry.environmentInput == null ? null : String(entry.environmentInput);
  const idempotencyInput = entry.idempotencyInput == null ? null : String(entry.idempotencyInput);
  for (const [field, key] of [['environmentInput', environmentInput], ['idempotencyInput', idempotencyInput]]) {
    if (key && (!DEPLOYMENT_KEY_RE.test(key) || deploymentSecretField(key))) {
      throw new RepositoryBrokerError(`${field} is invalid.`, 'invalid_deployment_manifest');
    }
  }
  if (!idempotencyInput) {
    throw new RepositoryBrokerError(
      'Deployment entries must declare an idempotencyInput for the pipeline command id.',
      'invalid_deployment_manifest',
    );
  }
  if (environmentInput && environmentInput === idempotencyInput) {
    throw new RepositoryBrokerError(
      'environmentInput and idempotencyInput must use distinct workflow inputs.',
      'invalid_deployment_manifest',
    );
  }
  const timeoutSeconds = Math.min(1_800, Math.max(30, Number(entry.timeoutSeconds) || 900));
  return Object.freeze({
    schemaVersion: 1,
    environment: selectedEnvironment,
    provider: expectedProvider,
    workflow,
    ref,
    inputs: Object.freeze(inputs),
    environmentInput,
    idempotencyInput,
    timeoutSeconds,
  });
}

function validateRepository(repository, selectedProvider) {
  const provider = String(selectedProvider || '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) {
    throw new RepositoryBrokerError('Repository provider is not supported.', 'invalid_provider');
  }
  const expected = PROVIDERS[provider];
  if (!repository || repository.provider !== provider) {
    throw new RepositoryBrokerError('Repository provider does not match the selected provider.', 'provider_mismatch');
  }
  let url;
  try {
    url = new URL(repository.https);
  } catch (_) {
    throw new RepositoryBrokerError('Repository URL is invalid.', 'invalid_repository');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== expected.host ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new RepositoryBrokerError('Repository URL is outside the selected provider host.', 'provider_mismatch');
  }
  const owner = String(repository.owner || '');
  const name = String(repository.name || '');
  const fullName = String(repository.fullName || `${owner}/${name}`);
  const segments = fullName.split('/').filter(Boolean);
  const urlRepository = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (
    !name ||
    !owner ||
    fullName !== `${owner}/${name}` ||
    urlRepository !== fullName ||
    segments.length < 2 ||
    (provider === 'github' && segments.length !== 2) ||
    segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..')
  ) {
    throw new RepositoryBrokerError('Repository namespace is invalid.', 'invalid_repository');
  }
  // In egress-proxy mode the REST + git traffic is routed at the sidecar (which
  // injects the PAT) instead of straight to GitHub, so the agent holds no token.
  // The INPUT repo URL is still validated as a real github.com URL above; only
  // the effective apiOrigin/remote are retargeted (github only — the proxy has
  // no GitLab route).
  const proxied = provider === 'github' && Boolean(CONFIG.EGRESS_PROXY_URL);
  const apiOrigin = proxied ? CONFIG.GITHUB_API_ORIGIN : expected.apiOrigin;
  const https = proxied
    ? `${CONFIG.GIT_HTTPS_ORIGIN}/${fullName}.git`
    : `https://${expected.host}/${fullName}.git`;
  return Object.freeze({
    provider,
    host: expected.host,
    apiOrigin,
    owner,
    name,
    fullName,
    https,
  });
}

function resultText(result) {
  if (typeof result === 'string') return result;
  return result && typeof result.stdout === 'string' ? result.stdout : '';
}

function errorText(error) {
  if (!error) return 'Unknown repository operation error.';
  if (typeof error === 'string') return error;
  return [error.message, error.stderr, error.stdout].filter(Boolean).join('\n');
}

function statusFromGithub(checkRuns, combined) {
  const checks = Array.isArray(checkRuns && checkRuns.check_runs) ? checkRuns.check_runs : [];
  const statuses = Array.isArray(combined && combined.statuses) ? combined.statuses : [];
  const checkCount = Number(checkRuns && checkRuns.total_count);
  const statusCount = Number(combined && combined.total_count);
  const complete = checkRuns !== null && combined !== null &&
    (!Number.isFinite(checkCount) || checkCount <= checks.length) &&
    (!Number.isFinite(statusCount) || statusCount <= statuses.length);
  const successfulConclusions = new Set(['success', 'neutral', 'skipped']);
  const pendingChecks = checks.some((item) => item.status !== 'completed');
  const failedChecks = checks.some(
    (item) => item.status === 'completed' && !successfulConclusions.has(item.conclusion)
  );
  const legacyState = statuses.length ? combined.state : 'none';
  const state = !complete
    ? 'unknown'
    : failedChecks || legacyState === 'failure' || legacyState === 'error'
    ? 'failure'
    : pendingChecks || legacyState === 'pending'
      ? 'pending'
      : checks.length || statuses.length
        ? 'success'
        : 'none';
  return {
    state,
    complete,
    checkRuns: checks.slice(0, 20).map((item) => ({
      name: oneLine(item.name, 160),
      status: oneLine(item.status, 40),
      conclusion: item.conclusion ? oneLine(item.conclusion, 40) : null,
      url: typeof item.html_url === 'string' ? item.html_url : null,
    })),
    statuses: statuses.slice(0, 20).map((item) => ({
      context: oneLine(item.context, 160),
      state: oneLine(item.state, 40),
      description: oneLine(item.description, 240),
      url: typeof item.target_url === 'string' ? item.target_url : null,
    })),
  };
}

function normalizeReview(provider, value) {
  if (provider === 'github') {
    return {
      provider,
      id: Number(value.number),
      url: value.html_url || null,
      // The pulls LIST endpoint (pull-request-simple) omits the `merged` boolean
      // and only sets `merged_at`; treat either as merged so a merged PR read
      // from a list is not misclassified as a plain 'closed'.
      state: value.merged || value.merged_at ? 'merged' : value.state || 'unknown',
      title: oneLine(value.title, LIMITS.titleChars),
      sourceBranch: value.head && value.head.ref,
      targetBranch: value.base && value.base.ref,
      headSha: value.head && value.head.sha,
      mergedSha: typeof value.merge_commit_sha === 'string' ? value.merge_commit_sha.toLowerCase() : null,
      draft: Boolean(value.draft),
      mergeable: value.mergeable == null ? null : Boolean(value.mergeable),
      labels: (Array.isArray(value.labels) ? value.labels : [])
        .map((label) => oneLine(typeof label === 'string' ? label : label && label.name, 100))
        .filter(Boolean),
    };
  }
  return {
    provider,
    id: Number(value.iid),
    url: value.web_url || null,
    state: value.state || 'unknown',
    title: oneLine(value.title, LIMITS.titleChars),
    sourceBranch: value.source_branch,
    targetBranch: value.target_branch,
    headSha: value.sha || (value.diff_refs && value.diff_refs.head_sha) || null,
    draft: Boolean(value.draft),
    mergeable: value.detailed_merge_status === 'mergeable',
    detailedMergeStatus: value.detailed_merge_status || null,
    blockingDiscussionsResolved:
      value.blocking_discussions_resolved == null ? null : Boolean(value.blocking_discussions_resolved),
    labels: (Array.isArray(value.labels) ? value.labels : []).map((label) => oneLine(label, 100)).filter(Boolean),
  };
}

function githubSha(value, field = 'GitHub commit SHA') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!GITHUB_SHA_RE.test(normalized)) {
    throw new RepositoryBrokerError(`${field} is not an immutable GitHub SHA.`, 'invalid_artifact_revision');
  }
  return normalized;
}

function receiptIdentifier(value, field, max, { optional = false } = {}) {
  if ((value === null || value === undefined) && optional) return null;
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new RepositoryBrokerError(`${field} is invalid.`, 'invalid_merge_receipt');
  }
  return normalized;
}

function receiptReviewUrl(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = receiptIdentifier(value, 'Review URL', 1_000);
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('unsafe URL');
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (_) {
    throw new RepositoryBrokerError('Review URL is invalid.', 'invalid_merge_receipt');
  }
}

function mergeReceiptPayload(value) {
  const repository = receiptIdentifier(value.repository, 'Receipt repository', 240);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new RepositoryBrokerError('Receipt repository is invalid.', 'invalid_merge_receipt');
  }
  const commandId = receiptIdentifier(value.commandId, 'Receipt command id', 180, { optional: true });
  if (commandId !== null && !COMMAND_ID_RE.test(commandId)) {
    throw new RepositoryBrokerError('Receipt command id is invalid.', 'invalid_merge_receipt');
  }
  return {
    schemaVersion: 1,
    kind: 'repository-merge-receipt',
    source: 'repository-broker',
    provider: 'github',
    repository,
    commandId,
    workItemId: receiptIdentifier(value.workItemId, 'Receipt work item id', 200, { optional: true }),
    branch: validateBranch(value.branch, 'receipt branch'),
    baseBranch: validateBranch(value.baseBranch, 'receipt base branch'),
    reviewId: Number(value.reviewId),
    reviewUrl: receiptReviewUrl(value.reviewUrl),
    headSha: githubSha(value.headSha, 'Review head SHA'),
    mergedSha: githubSha(value.mergedSha, 'Merged commit SHA'),
    commitSha: githubSha(value.commitSha || value.mergedSha, 'Artifact commit SHA'),
    treeSha: githubSha(value.treeSha, 'Artifact tree SHA'),
    reused: value.reused === true,
  };
}

function mergeReceiptDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(mergeReceiptPayload(value))).digest('hex');
}

/** Validate the server-owned receipt again at every trust-boundary crossing.
 * The digest is an integrity guard against accidental projection drift; receipt
 * authority still comes from the in-process broker, never from model output. */
function validateMergeReceipt(value, expected = {}) {
  if (!isPlainObject(value)) {
    throw new RepositoryBrokerError('A broker merge receipt is required.', 'merge_receipt_required');
  }
  const payload = mergeReceiptPayload(value);
  if (!payload.repository || !payload.branch || !payload.baseBranch) {
    throw new RepositoryBrokerError('The broker merge receipt scope is incomplete.', 'invalid_merge_receipt');
  }
  if (!Number.isSafeInteger(payload.reviewId) || payload.reviewId < 1) {
    throw new RepositoryBrokerError('The broker merge receipt review id is invalid.', 'invalid_merge_receipt');
  }
  if (payload.commitSha !== payload.mergedSha) {
    throw new RepositoryBrokerError('The broker artifact does not equal the merged commit.', 'invalid_merge_receipt');
  }
  if (!SHA256_RE.test(String(value.receiptDigest || '')) || value.receiptDigest !== mergeReceiptDigest(payload)) {
    throw new RepositoryBrokerError('The broker merge receipt digest is invalid.', 'invalid_merge_receipt');
  }
  for (const [field, expectedValue] of Object.entries(expected || {})) {
    if (expectedValue !== undefined && expectedValue !== null && payload[field] !== expectedValue) {
      throw new RepositoryBrokerError(`The broker merge receipt ${field} does not match its command scope.`, 'merge_receipt_scope_mismatch');
    }
  }
  return Object.freeze({ ...payload, receiptDigest: value.receiptDigest });
}

/** Provider REST path prefix for a repository (owner/repo for GitHub, project for GitLab). */
function repoApiPath(repository) {
  if (repository.provider === 'github') {
    return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  }
  return `/api/v4/projects/${encodeURIComponent(repository.fullName)}`;
}

/**
 * Hardened forge REST call shared by the broker instance and the stateless
 * stack-reconcile pass. Enforces the same redirect/abort/size/redaction guards
 * regardless of caller, so a lightweight API-only client never bypasses them.
 * `redactSecrets` scrubs the token from any surfaced error text.
 */
async function forgeApiRequest({
  provider,
  repository,
  token,
  method,
  endpoint,
  body,
  fetchImpl = global.fetch,
  allow404 = false,
  withMeta = false,
  redactSecrets = [],
}) {
  if (!token) throw new RepositoryBrokerError('No repository token is configured.', 'missing_token');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.apiTimeoutMs);
  const github = provider === 'github';
  const headers = github
    ? {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tech-symphony-repository-broker',
      }
    : {
        Accept: 'application/json',
        'PRIVATE-TOKEN': token,
        'User-Agent': 'tech-symphony-repository-broker',
      };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const url = `${repository.apiOrigin}${endpoint}`;
  const safe = (value) => redact(value, redactSecrets);
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: controller.signal,
    });
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > LIMITS.responseBytes) {
      throw new RepositoryBrokerError('Repository provider response exceeded the size limit.', 'response_too_large');
    }
    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch (_) {
        data = { message: oneLine(raw, 500) };
      }
    }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      const message = data && (data.message || data.error_description || data.error);
      throw new RepositoryBrokerError(
        `Repository provider returned ${response.status}: ${safe(oneLine(message || 'request failed', 500))}`,
        'provider_error'
      );
    }
    if (withMeta) {
      const header = (name) => response.headers && typeof response.headers.get === 'function'
        ? response.headers.get(name)
        : null;
      const link = header('link') || '';
      const nextPage = header('x-next-page') || '';
      return { data, hasNext: /rel\s*=\s*"?next"?/i.test(link) || Boolean(String(nextPage).trim()) };
    }
    return data;
  } catch (error) {
    if (error instanceof RepositoryBrokerError) throw error;
    throw new RepositoryBrokerError(safe(errorText(error)), 'provider_unavailable');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find the review (PR/MR) for a head branch, newest-open preferred. Optional
 * `base` narrows to a specific target branch. Returns a normalized review or
 * null. Shared by stack-base resolution and the reconcile pass.
 */
async function findReviewByBranch({ provider, repository, token, branch, fetchImpl, base = null }) {
  const api = repoApiPath(repository);
  const request = (endpoint) => forgeApiRequest({
    provider, repository, token, method: 'GET', endpoint, fetchImpl, redactSecrets: [token],
  });
  if (provider === 'github') {
    const params = { state: 'all', head: `${repository.owner}:${branch}`, per_page: '20' };
    if (base) params.base = base;
    const list = await request(`${api}/pulls?${new URLSearchParams(params)}`);
    const items = (Array.isArray(list) ? list : []).filter(
      (item) => item && item.head && item.head.ref === branch && (!base || (item.base && item.base.ref === base))
    );
    const chosen = items.find((item) => item.state === 'open') || items[0] || null;
    return chosen ? normalizeReview('github', chosen) : null;
  }
  const params = { scope: 'all', state: 'all', source_branch: branch, per_page: '20' };
  if (base) params.target_branch = base;
  const list = await request(`${api}/merge_requests?${new URLSearchParams(params)}`);
  const items = (Array.isArray(list) ? list : []).filter(
    (item) => item && item.source_branch === branch && (!base || item.target_branch === base)
  );
  const chosen = items.find((item) => item.state === 'opened') || items[0] || null;
  return chosen ? normalizeReview(provider, chosen) : null;
}

function feedbackWindow(items, cursor = 0) {
  const start = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  const feedback = items.slice(start, start + LIMITS.feedbackItems);
  const next = start + feedback.length;
  return {
    feedback,
    feedbackCursor: start,
    nextFeedbackCursor: next < items.length ? next : null,
    feedbackTotal: items.length,
  };
}

function boundFeedback(items) {
  const limit = LIMITS.feedbackItems * (LIMITS.toolCalls - 8);
  return { items: items.slice(0, limit), complete: items.length <= limit };
}

class RepositoryBroker {
  #token;
  #fetchImpl;
  #execFileImpl;
  #calls = 0;
  #queue = Promise.resolve();
  #disposed = false;
  #feedbackReads = new Map();
  #scopeBranch;
  #availabilityError = null;
  #remoteEmpty = false;
  #stackCandidates = [];
  #stackedOn = null;
  #sleep;
  #deploymentReceipt = null;
  #artifactContext = Object.freeze({ commandId: null, workItemId: null });
  #artifactReceipt = null;
  #pinnedRevision = null;

  constructor({
    provider,
    repository,
    token = '',
    workspaceRoot,
    workDir,
    branch,
    stackCandidates = [],
    label = '',
    step,
    fetchImpl = global.fetch,
    execFileImpl = execFileP,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    stagingRoot,
  }) {
    this.repository = validateRepository(repository, provider);
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.workDir = path.resolve(workDir);
    assertScopedPath(this.workspaceRoot, this.workDir);
    this.branch = validateBranch(branch, 'task branch');
    this.#scopeBranch = this.branch;
    this.baseBranch = null;
    // Ordered blocker branches (latest-first) this task may stack onto. Drop
    // anything unsafe, duplicated, or equal to the task's own branch; the
    // resolution during prepare() picks the first that is present and unmerged.
    const seenCandidates = new Set([this.branch]);
    for (const candidate of Array.isArray(stackCandidates) ? stackCandidates : []) {
      let safe;
      try {
        safe = validateBranch(candidate, 'stack candidate');
      } catch (_) {
        continue;
      }
      if (seenCandidates.has(safe)) continue;
      seenCandidates.add(safe);
      this.#stackCandidates.push(safe);
    }
    this.label = oneLine(label, 100);
    this.step = typeof step === 'function' ? step : () => {};
    // Egress-proxy mode: the agent holds no PAT. Use the sentinel so the broker's
    // `!token` gates pass; the sidecar injects the real credential on egress. The
    // git credential helper is bound to `repository.host` (github.com) while the
    // remote is the proxy origin, so the sentinel is never even offered — git
    // sends no auth and the proxy adds it.
    this.#token = String(token || '') || (CONFIG.EGRESS_PROXY_URL ? SENTINEL_TOKEN : '');
    this.#fetchImpl = fetchImpl;
    this.#execFileImpl = execFileImpl;
    this.#sleep = sleep;
    const privateRoot = path.resolve(stagingRoot || path.join(os.tmpdir(), 'techsymphony-repository-broker'));
    fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    this.stagingDir = fs.mkdtempSync(path.join(privateRoot, 'scope-'));
    fs.chmodSync(this.stagingDir, 0o700);
    this.gitDir = path.join(this.stagingDir, 'repository.git');
  }

  publicInfo() {
    return {
      provider: this.repository.provider,
      repository: this.repository.fullName,
      branch: this.branch,
      baseBranch: this.baseBranch,
      stackedOn: this.#stackedOn,
    };
  }

  /**
   * A credential/network failure returned through the agent-facing tool would
   * otherwise look like ordinary tool output. Expose only the already-redacted
   * broker error so the orchestrator can pause instead of finalizing the task.
   */
  availabilityError() {
    return this.#availabilityError;
  }

  deploymentReceipt() {
    return this.#deploymentReceipt ? JSON.parse(JSON.stringify(this.#deploymentReceipt)) : null;
  }

  /** Bind receipts to server-owned pipeline identity before the model receives
   * the broker tool. Autonomous/non-pipeline callers may leave this unbound,
   * but fixed-pipeline completion requires both values at its outer boundary. */
  bindArtifactContext({ commandId, workItemId } = {}) {
    this.#assertActive();
    const normalizedCommandId = String(commandId || '').trim();
    const normalizedWorkItemId = String(workItemId || '').trim();
    if (!COMMAND_ID_RE.test(normalizedCommandId) || !normalizedWorkItemId || normalizedWorkItemId.length > 200) {
      throw new RepositoryBrokerError('A valid command and work item are required for artifact receipts.', 'invalid_artifact_context');
    }
    if (this.#artifactReceipt) {
      throw new RepositoryBrokerError('Artifact context cannot change after a merge receipt exists.', 'artifact_context_locked');
    }
    this.#artifactContext = Object.freeze({ commandId: normalizedCommandId, workItemId: normalizedWorkItemId });
    return { ...this.#artifactContext };
  }

  artifactReceipt() {
    return this.#artifactReceipt ? JSON.parse(JSON.stringify(this.#artifactReceipt)) : null;
  }

  pinnedRevision() {
    return this.#pinnedRevision ? { ...this.#pinnedRevision } : null;
  }

  async #recordMergeReceipt(review, mergedSha, { reused = false } = {}) {
    if (this.repository.provider !== 'github') {
      throw new RepositoryBrokerError('Immutable pipeline receipts currently require GitHub.', 'repository_provider_not_brokered');
    }
    const commitSha = githubSha(mergedSha, 'Merged commit SHA');
    const commit = await this.#request('GET', `${this.#apiPath()}/commits/${commitSha}`);
    const confirmedCommit = githubSha(commit && commit.sha, 'Confirmed merged commit SHA');
    const treeSha = githubSha(commit && commit.commit && commit.commit.tree && commit.commit.tree.sha, 'Merged tree SHA');
    if (confirmedCommit !== commitSha) {
      throw new RepositoryBrokerError('GitHub confirmed a different merged commit.', 'merge_receipt_mismatch');
    }
    const payload = mergeReceiptPayload({
      repository: this.repository.fullName,
      commandId: this.#artifactContext.commandId,
      workItemId: this.#artifactContext.workItemId,
      branch: review.sourceBranch || this.branch,
      baseBranch: review.targetBranch || this.baseBranch,
      reviewId: review.id,
      reviewUrl: review.url || null,
      headSha: review.headSha,
      mergedSha: commitSha,
      commitSha,
      treeSha,
      reused,
    });
    this.#artifactReceipt = Object.freeze({ ...payload, receiptDigest: mergeReceiptDigest(payload) });
    return this.artifactReceipt();
  }

  /** Refresh the broker-private mirror, prove the immutable commit/tree pair is
   * reachable from the scoped base, then detach the workspace at exactly it. */
  async pinRevision(revision) {
    this.#assertActive();
    if (this.repository.provider !== 'github') {
      throw new RepositoryBrokerError('Immutable pipeline revisions currently require GitHub.', 'repository_provider_not_brokered');
    }
    if (!this.baseBranch) {
      throw new RepositoryBrokerError('Repository broker must be prepared before pinning.', 'repository_not_prepared');
    }
    const commitSha = githubSha(revision && revision.commitSha, 'Artifact commit SHA');
    const treeSha = githubSha(revision && revision.treeSha, 'Artifact tree SHA');
    await this.#prepareBare();
    const commitType = await this.#bare(['cat-file', '-t', commitSha], { allowFailure: true, outputLimit: 100 });
    if (commitType !== 'commit') {
      throw new RepositoryBrokerError('The approved artifact commit is unavailable from the remote.', 'artifact_revision_unavailable');
    }
    const actualTree = githubSha(await this.#bare(['rev-parse', `${commitSha}^{tree}`], { outputLimit: 100 }), 'Resolved artifact tree SHA');
    if (actualTree !== treeSha) {
      throw new RepositoryBrokerError('The approved artifact tree does not match its commit.', 'artifact_tree_mismatch');
    }
    const contained = await this.#bare(
      ['merge-base', '--is-ancestor', commitSha, `refs/remotes/origin/${this.baseBranch}`],
      { allowFailure: true, outputLimit: 100 },
    );
    if (contained === null) {
      throw new RepositoryBrokerError('The approved artifact is not reachable from the scoped base branch.', 'artifact_revision_untrusted');
    }
    await this.#exportRemoteRefs();
    const dirty = await this.#workspaceStatus();
    if (dirty) {
      throw new RepositoryBrokerError('The workspace must be clean before pinning an artifact.', 'workspace_dirty');
    }
    await this.#workspace(['checkout', '--detach', commitSha]);
    const checkedCommit = githubSha(await this.#workspace(['rev-parse', 'HEAD']), 'Checked out artifact SHA');
    const checkedTree = githubSha(await this.#workspace(['rev-parse', 'HEAD^{tree}']), 'Checked out artifact tree SHA');
    if (checkedCommit !== commitSha || checkedTree !== treeSha) {
      throw new RepositoryBrokerError('The workspace did not pin the approved artifact exactly.', 'artifact_checkout_mismatch');
    }
    this.#pinnedRevision = Object.freeze({ commitSha, treeSha });
    this.step(`Repository broker pinned immutable revision ${commitSha.slice(0, 12)}.`);
    return { ...this.#pinnedRevision };
  }

  async #deploymentPlan(environment, revision = this.#pinnedRevision) {
    this.#assertActive();
    this.#assertWorkspace();
    if (!this.baseBranch) {
      throw new RepositoryBrokerError('Repository broker must be prepared before deployment.', 'repository_not_prepared');
    }
    const commitSha = githubSha(revision && revision.commitSha, 'Approved deployment commit SHA');
    const treeSha = githubSha(revision && revision.treeSha, 'Approved deployment tree SHA');
    if (!this.#pinnedRevision || this.#pinnedRevision.commitSha !== commitSha || this.#pinnedRevision.treeSha !== treeSha) {
      throw new RepositoryBrokerError('Deployment revision must equal the broker-pinned tested artifact.', 'deployment_revision_mismatch');
    }
    // The model can mutate its checkout even with a filesystem-only backend.
    // Read the allowlist exclusively from the immutable, broker-verified commit;
    // neither a modified worktree nor a later base-branch update is authority.
    const trustedRef = commitSha;
    const treeEntry = await this.#bare(
      ['ls-tree', trustedRef, '--', DEPLOYMENT_MANIFEST],
      { allowFailure: true, outputLimit: 1_024 },
    );
    if (!treeEntry) {
      throw new RepositoryBrokerError(`Repository does not contain ${DEPLOYMENT_MANIFEST}.`, 'deployment_manifest_missing');
    }
    const match = /^100(?:644|755) blob ([0-9a-f]{40,64})\t\.ai-fleet\/deployment\.json$/.exec(treeEntry);
    if (!match) {
      throw new RepositoryBrokerError('Deployment manifest must be a regular blob in the trusted base ref.', 'invalid_deployment_manifest');
    }
    const blobSize = Number(await this.#bare(['cat-file', '-s', match[1]], { outputLimit: 100 }));
    if (!Number.isSafeInteger(blobSize) || blobSize < 1 || blobSize > DEPLOYMENT_MANIFEST_MAX_BYTES) {
      throw new RepositoryBrokerError('Deployment manifest is not a safe bounded regular file.', 'invalid_deployment_manifest');
    }
    const manifestText = await this.#bare(
      ['show', `${trustedRef}:${DEPLOYMENT_MANIFEST}`],
      { outputLimit: DEPLOYMENT_MANIFEST_MAX_BYTES + 1 },
    );
    let raw;
    try {
      raw = JSON.parse(manifestText);
    } catch (_) {
      throw new RepositoryBrokerError('Deployment manifest is not valid JSON.', 'invalid_deployment_manifest');
    }
    const plan = normalizeDeploymentManifest(raw, {
      provider: this.repository.provider,
      environment,
      baseBranch: this.baseBranch,
    });
    return Object.freeze({ ...plan, commitSha, treeSha, sourceRef: plan.ref });
  }

  #deploymentInputs(plan, commandId) {
    const inputs = { ...plan.inputs };
    if (plan.environmentInput) inputs[plan.environmentInput] = plan.environment;
    if (plan.idempotencyInput) inputs[plan.idempotencyInput] = commandId;
    return inputs;
  }

  #deploymentTag(commandId, commitSha) {
    const correlation = crypto.createHash('sha256')
      .update(`${this.repository.fullName}\0${commandId}\0${commitSha}`)
      .digest('hex')
      .slice(0, 20);
    return `ai-fleet-deploy-${commitSha.slice(0, 12)}-${correlation}`;
  }

  async #deploymentRef(tag, commitSha, { create = false } = {}) {
    const endpoint = `${this.#apiPath()}/git/ref/tags/${encodeURIComponent(tag)}`;
    let current = await this.#request('GET', endpoint, undefined, { allow404: true });
    if (!current && create) {
      let creationError = null;
      try {
        await this.#request('POST', `${this.#apiPath()}/git/refs`, {
          ref: `refs/tags/${tag}`,
          sha: commitSha,
        });
      } catch (error) {
        // Another broker instance may have won the create-if-absent race. The
        // provider ref itself is authority: accept only if a fresh read proves
        // that the exact deterministic tag now points at the approved commit.
        creationError = error;
      }
      current = await this.#request('GET', endpoint, undefined, { allow404: true });
      if (!current) {
        if (creationError) throw creationError;
        throw new RepositoryBrokerError(
          'GitHub did not confirm the immutable deployment ref.',
          'deployment_ref_unavailable',
        );
      }
    }
    if (!current) return null;
    const object = current.object || {};
    if (object.type !== 'commit' || githubSha(object.sha, 'Deployment ref SHA') !== commitSha) {
      throw new RepositoryBrokerError('The immutable deployment ref does not match the approved commit.', 'deployment_revision_mismatch');
    }
    return tag;
  }

  async #immutableDeploymentPlan(plan, commandId) {
    const tag = this.#deploymentTag(commandId, plan.commitSha);
    await this.#deploymentRef(tag, plan.commitSha, { create: true });
    return Object.freeze({ ...plan, ref: tag, commandId });
  }

  async #githubWorkflowRuns(plan) {
    const api = this.#apiPath();
    const query = new URLSearchParams({
      event: 'workflow_dispatch',
      branch: plan.ref,
      per_page: '100',
    });
    const data = await this.#request(
      'GET',
      `${api}/actions/workflows/${encodeURIComponent(plan.workflow)}/runs?${query}`,
    );
    return Array.isArray(data && data.workflow_runs) ? data.workflow_runs : [];
  }

  async #waitForGithubDeployment(plan, state) {
    const deadline = Date.now() + plan.timeoutSeconds * 1_000;
    let runId = state.runId || null;
    while (Date.now() <= deadline) {
      if (!runId) {
        const runs = await this.#githubWorkflowRuns(plan);
        const discovered = runs.find((run) => (
          run
          && !state.beforeIds.includes(String(run.id))
          && String(run.head_branch || '') === plan.ref
          && String(run.head_sha || '').toLowerCase() === plan.commitSha
        ));
        if (discovered) runId = Number(discovered.id);
      }
      if (runId) {
        const run = await this.#request('GET', `${this.#apiPath()}/actions/runs/${runId}`);
        if (String(run && run.head_sha || '').toLowerCase() !== plan.commitSha) {
          throw new RepositoryBrokerError('GitHub ran the deployment at a different commit.', 'deployment_revision_mismatch');
        }
        if (run && run.status === 'completed') {
          await this.#deploymentRef(plan.ref, plan.commitSha);
          const receipt = {
            provider: 'github-actions',
            environment: plan.environment,
            workflow: plan.workflow,
            ref: plan.ref,
            sourceRef: plan.sourceRef,
            commandId: plan.commandId,
            commitSha: plan.commitSha,
            treeSha: plan.treeSha,
            runId,
            url: run.html_url || null,
            status: run.conclusion === 'success' ? 'succeeded' : 'failed',
            conclusion: oneLine(run.conclusion || 'unknown', 80),
          };
          this.#deploymentReceipt = receipt;
          if (receipt.status !== 'succeeded') {
            throw new RepositoryBrokerError(`Allowlisted deployment completed with ${receipt.conclusion}.`, 'deployment_failed');
          }
          return receipt;
        }
      }
      await this.#sleep(2_000);
    }
    const error = new RepositoryBrokerError('Timed out waiting for the allowlisted deployment workflow.', 'deployment_timeout');
    error.retryable = true;
    throw error;
  }

  async #runDeployment(environment, commandId, revision) {
    if (this.#deploymentReceipt && ['succeeded', 'failed'].includes(this.#deploymentReceipt.status)) {
      if (
        this.#deploymentReceipt.commandId !== commandId
        || this.#deploymentReceipt.environment !== environment
        || this.#deploymentReceipt.commitSha !== revision.commitSha
        || this.#deploymentReceipt.treeSha !== revision.treeSha
      ) {
        throw new RepositoryBrokerError('A deployment receipt exists for a different command or revision.', 'deployment_revision_mismatch');
      }
      if (this.#deploymentReceipt.status === 'succeeded') {
        return { ...this.#deploymentReceipt, reused: true };
      }
      throw new RepositoryBrokerError(
        `Allowlisted deployment already completed with ${this.#deploymentReceipt.conclusion || 'failure'}.`,
        'deployment_failed',
      );
    }
    if (!this.#token) throw new RepositoryBrokerError('No repository token is configured.', 'missing_token');
    const trustedPlan = await this.#deploymentPlan(environment, revision);
    if (this.repository.provider === 'github') {
      const plan = await this.#immutableDeploymentPlan(trustedPlan, commandId);
      let state = this.#deploymentReceipt;
      if (state && state.status === 'waiting' && (
        state.commandId !== commandId
        || state.commitSha !== plan.commitSha
        || state.treeSha !== plan.treeSha
        || state.environment !== plan.environment
        || state.workflow !== plan.workflow
        || state.ref !== plan.ref
      )) {
        throw new RepositoryBrokerError(
          'A deployment is already correlated to a different command or revision.',
          'deployment_revision_mismatch',
        );
      }
      if (!state || state.provider !== 'github-actions' || state.status !== 'waiting') {
        const before = await this.#githubWorkflowRuns(plan);
        const existing = before.find((run) => (
          run
          && String(run.head_branch || '') === plan.ref
          && String(run.head_sha || '').toLowerCase() === plan.commitSha
          && Number.isSafeInteger(Number(run.id))
        ));
        state = {
          provider: 'github-actions',
          environment: plan.environment,
          workflow: plan.workflow,
          ref: plan.ref,
          sourceRef: plan.sourceRef,
          commandId,
          commitSha: plan.commitSha,
          treeSha: plan.treeSha,
          runId: existing ? Number(existing.id) : null,
          status: 'waiting',
          beforeIds: before.map((run) => String(run.id)),
        };
        this.#deploymentReceipt = state;
        if (!existing) {
          await this.#request(
            'POST',
            `${this.#apiPath()}/actions/workflows/${encodeURIComponent(plan.workflow)}/dispatches`,
            { ref: plan.ref, inputs: this.#deploymentInputs(plan, commandId) },
          );
        }
      }
      return this.#waitForGithubDeployment(plan, state);
    }
    throw new RepositoryBrokerError('Deployment requires the brokered GitHub egress path.', 'repository_provider_not_brokered');
  }

  /** A separate, deployment-only tool. The ordinary repository_broker exposed
   * to coders intentionally does not gain CI/CD mutation actions. */
  createDeploymentTool({ environment, commandId, revision }) {
    if (this.repository.provider !== 'github') {
      throw new RepositoryBrokerError(
        'Deployment requires the brokered GitHub egress path.',
        'repository_provider_not_brokered',
      );
    }
    const selectedEnvironment = String(environment || '').trim().toLowerCase();
    const idempotencyKey = String(commandId || '').trim();
    if (!COMMAND_ID_RE.test(idempotencyKey)) {
      throw new RepositoryBrokerError('A valid pipeline command id is required.', 'invalid_deployment_command');
    }
    const approvedRevision = {
      commitSha: githubSha(revision && revision.commitSha, 'Approved deployment commit SHA'),
      treeSha: githubSha(revision && revision.treeSha, 'Approved deployment tree SHA'),
    };
    if (
      !this.#pinnedRevision
      || this.#pinnedRevision.commitSha !== approvedRevision.commitSha
      || this.#pinnedRevision.treeSha !== approvedRevision.treeSha
    ) {
      throw new RepositoryBrokerError('Deployment requires the exact broker-pinned tested revision.', 'deployment_revision_mismatch');
    }
    const { tool } = require('@langchain/core/tools');
    const { z } = require('zod');
    return tool(
      async ({ action }) => {
        try {
          const value = await this.#enqueue(async () => {
            const plan = await this.#deploymentPlan(selectedEnvironment, approvedRevision);
            if (action === 'inspect') {
              return { ...plan, inputs: Object.keys(plan.inputs) };
            }
            return this.#runDeployment(selectedEnvironment, idempotencyKey, approvedRevision);
          });
          const receipt = value;
          return JSON.stringify({ ok: true, ...receipt });
        } catch (error) {
          if (isAvailabilityFailure(error)) this.#availabilityError = error;
          return JSON.stringify({ ok: false, code: error && error.code, error: this.#safeError(error) });
        }
      },
      {
        name: 'repository_deployment',
        description:
          'Inspect or execute the single server-scoped, repository-allowlisted CI/CD deployment. ' +
          'The repository, environment, workflow, base ref, inputs, and pipeline command id are fixed; no shell or credential is exposed.',
        schema: z.object({ action: z.enum(['inspect', 'deploy']) }).strict(),
      },
    );
  }

  #assertActive() {
    if (this.#disposed) throw new RepositoryBrokerError('Repository broker scope is closed.', 'scope_closed');
  }

  #safeError(error) {
    return redact(errorText(error), [this.#token]);
  }

  #baseEnv({ auth = false } = {}) {
    const env = buildSafeAgentEnv(process.env, this.stagingDir);
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    env.GIT_TERMINAL_PROMPT = '0';
    env.GCM_INTERACTIVE = 'Never';
    delete env.GIT_ASKPASS;
    delete env.SSH_ASKPASS;
    if (auth && this.#token) {
      env[BROKER_TOKEN_ENV] = this.#token;
      env[BROKER_HOST_ENV] = this.repository.host;
      env[BROKER_USER_ENV] = PROVIDERS[this.repository.provider].username;
    }
    return env;
  }

  async #git(args, {
    cwd = this.stagingDir,
    auth = false,
    allowFailure = false,
    outputLimit = LIMITS.gitOutputChars,
  } = {}) {
    this.#assertActive();
    const config = [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'credential.helper=',
      '-c', 'http.extraHeader=',
      '-c', 'http.proxy=',
      '-c', 'http.sslVerify=true',
    ];
    if (auth) config.push('-c', `credential.helper=${BROKER_CREDENTIAL_HELPER}`);
    try {
      const result = await this.#execFileImpl('git', [...config, ...args], {
        cwd,
        env: this.#baseEnv({ auth }),
        timeout: LIMITS.gitTimeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      return cleanText(resultText(result), outputLimit);
    } catch (error) {
      if (allowFailure) return null;
      throw new RepositoryBrokerError(this.#safeError(error), 'git_failed');
    }
  }

  async #bare(args, options = {}) {
    return this.#git([`--git-dir=${this.gitDir}`, ...args], options);
  }

  async #workspace(args, options = {}) {
    this.#assertWorkspace();
    return this.#git(['-C', this.workDir, ...args], options);
  }

  #assertWorkspace() {
    assertScopedPath(this.workspaceRoot, this.workDir);
    const gitPath = path.join(this.workDir, '.git');
    if (!fs.existsSync(gitPath)) {
      throw new RepositoryBrokerError('Repository workspace is not initialized.', 'workspace_missing');
    }
    const rootReal = fs.realpathSync(this.workspaceRoot);
    const workReal = fs.realpathSync(this.workDir);
    if (!isPathInside(rootReal, workReal)) {
      throw new RepositoryBrokerError('Repository workspace escaped its allowed root.', 'workspace_scope');
    }
    const gitStat = fs.lstatSync(gitPath);
    const gitReal = fs.realpathSync(gitPath);
    if (!gitStat.isDirectory() || !isPathInside(workReal, gitReal)) {
      throw new RepositoryBrokerError('Workspace Git metadata escaped its allowed directory.', 'workspace_scope');
    }
  }

  async #sanitizeWorkspaceConfig() {
    await this.#workspace(['config', '--local', '--unset-all', 'credential.helper'], { allowFailure: true });
    await this.#workspace(['config', '--local', '--unset-all', 'http.extraHeader'], { allowFailure: true });
    await this.#workspace(['config', '--local', '--unset-all', 'http.proxy'], { allowFailure: true });
    await this.#workspace(['config', '--local', '--unset-all', 'remote.origin.proxy'], { allowFailure: true });
    await this.#workspace(['config', 'user.name', 'AI Fleet Agent'], { allowFailure: true });
    await this.#workspace(['config', 'user.email', 'ai-fleet@localhost'], { allowFailure: true });
    const gitDir = fs.realpathSync(path.join(this.workDir, '.git'));
    const infoDir = path.join(this.workDir, '.git', 'info');
    if (fs.existsSync(infoDir)) {
      const infoStat = fs.lstatSync(infoDir);
      if (!infoStat.isDirectory() || infoStat.isSymbolicLink()) {
        throw new RepositoryBrokerError('Workspace Git exclude directory is unsafe.', 'workspace_scope');
      }
    } else {
      fs.mkdirSync(infoDir, { recursive: false, mode: 0o700 });
    }
    if (!isPathInside(gitDir, fs.realpathSync(infoDir))) {
      throw new RepositoryBrokerError('Workspace Git exclude directory escaped its scope.', 'workspace_scope');
    }
    const excludePath = path.join(infoDir, 'exclude');
    if (fs.existsSync(excludePath)) {
      const excludeStat = fs.lstatSync(excludePath);
      if (!excludeStat.isFile() || excludeStat.isSymbolicLink() || !isPathInside(gitDir, fs.realpathSync(excludePath))) {
        throw new RepositoryBrokerError('Workspace Git exclude file is unsafe.', 'workspace_scope');
      }
    }
    const existingExclude = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    const excludeLines = existingExclude.split(/\r?\n/).map((line) => line.trim());
    if (!excludeLines.includes(FRAMEWORK_SKILLS_EXCLUDE)) {
      const separator = existingExclude && !existingExclude.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(excludePath, `${separator}${FRAMEWORK_SKILLS_EXCLUDE}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    this.#assertSafeWorkspaceExclude();
    const configText = fs.readFileSync(path.join(this.workDir, '.git', 'config'), 'utf8');
    if (this.#token && configText.includes(this.#token)) {
      throw new RepositoryBrokerError('Repository credential was found in workspace configuration.', 'credential_persisted');
    }
  }

  async #assertOriginUrl() {
    const remote = await this.#workspace(['remote', 'get-url', 'origin']);
    if (remote.replace(/\.git$/i, '') !== this.repository.https.replace(/\.git$/i, '')) {
      throw new RepositoryBrokerError('Workspace origin does not match the scoped repository.', 'origin_mismatch');
    }
  }

  async #assertCanonicalOrigin() {
    await this.#assertOriginUrl();
    const dangerous = await this.#workspace(
      [
        'config', '--local', '--get-regexp',
        '^(credential\\..*|credential\\.helper|url\\..*\\.insteadof|http\\..*extraheader|http\\.proxy|remote\\.origin\\.proxy|include\\.path|includeif\\..*\\.path|extensions\\.worktreeconfig|core\\.(fsmonitor|sparsecheckout|sparsecheckoutcone|ignorestat|checkstat|excludesfile|worktree)|status\\.showuntrackedfiles|diff\\.ignoresubmodules|submodule\\..*\\.ignore)$',
      ],
      { allowFailure: true }
    );
    if (dangerous) {
      throw new RepositoryBrokerError('Workspace Git configuration contains an unsafe local override.', 'unsafe_git_config');
    }
  }

  #assertSafeWorkspaceExclude() {
    const gitDir = fs.realpathSync(path.join(this.workDir, '.git'));
    const excludePath = path.join(this.workDir, '.git', 'info', 'exclude');
    if (!fs.existsSync(excludePath)) return;
    const stat = fs.lstatSync(excludePath);
    if (!stat.isFile() || stat.isSymbolicLink() || !isPathInside(gitDir, fs.realpathSync(excludePath))) {
      throw new RepositoryBrokerError('Workspace Git exclude file is unsafe.', 'workspace_scope');
    }
    const unsafe = fs.readFileSync(excludePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line !== FRAMEWORK_SKILLS_EXCLUDE);
    if (unsafe.length) {
      throw new RepositoryBrokerError('Workspace Git exclude file contains an untrusted ignore rule.', 'unsafe_git_config');
    }
  }

  async #workspaceStatus() {
    await this.#assertCanonicalOrigin();
    this.#assertSafeWorkspaceExclude();
    const outputLimit = 4 * 1024 * 1024;
    const indexFlags = await this.#workspace(
      ['-c', 'core.fsmonitor=false', 'ls-files', '-v'],
      { outputLimit }
    );
    if (/(^|\n)(?:S|[a-z]) /.test(indexFlags)) {
      throw new RepositoryBrokerError(
        'Workspace index uses skip-worktree or assume-unchanged flags.',
        'unsafe_index_flags'
      );
    }
    const fsmonitorFlags = await this.#workspace(
      ['-c', 'core.fsmonitor=false', 'ls-files', '-f'],
      { outputLimit }
    );
    if (/(^|\n)[a-z] /.test(fsmonitorFlags)) {
      throw new RepositoryBrokerError('Workspace index contains fsmonitor-valid flags.', 'unsafe_index_flags');
    }
    return this.#workspace([
      '-c', 'core.fsmonitor=false',
      '-c', 'core.checkStat=default',
      '-c', 'core.fileMode=true',
      '-c', 'status.showUntrackedFiles=all',
      'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none',
    ]);
  }

  async #prepareBare() {
    if (!fs.existsSync(this.gitDir)) {
      await this.#git(['init', '--bare', this.gitDir]);
    }
    await this.#bare(['remote', 'remove', 'origin'], { allowFailure: true });
    await this.#bare(['remote', 'add', 'origin', this.repository.https]);
    const symref = await this.#bare(['ls-remote', '--symref', 'origin', 'HEAD'], { auth: true });
    const match = symref.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD/m);
    const discoveredBase = validateBranch(match ? match[1] : 'main', 'base branch');
    // The base branch is part of the run scope. Refreshes may update refs but
    // cannot silently retarget a live agent if the provider default changes.
    if (!this.baseBranch) this.baseBranch = discoveredBase;
    await this.#bare(
      ['fetch', '--prune', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
      { auth: true }
    );
    // A brand-new repository has no branches yet. Detect it from the fetched
    // mirror so prepare() can initialize a base branch instead of failing to
    // fork the first task from a ref that does not exist.
    const mirrored = await this.#bare(['for-each-ref', '--count=1', 'refs/remotes/origin/'], { allowFailure: true });
    this.#remoteEmpty = !mirrored || !mirrored.trim();
  }

  /**
   * Initialize an empty remote so task branches have a base to fork from and
   * reviews have a base branch to target. Creates a single empty commit on the
   * scoped base branch and publishes it through the same broker-private,
   * credential-scoped staging path as an ordinary branch push — the agent's
   * hooks/config never run in the credentialed child.
   */
  async #seedEmptyRemote() {
    const hasCommit = await this.#workspace(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true });
    if (hasCommit === null) {
      await this.#workspace(['checkout', '--orphan', this.baseBranch]);
      await this.#workspace(['commit', '--allow-empty', '-m', 'Initialize repository']);
    } else {
      await this.#workspace(['checkout', '-B', this.baseBranch, 'HEAD']);
    }
    await this.#publishBase();
    await this.#bare(
      ['fetch', '--prune', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
      { auth: true }
    );
    await this.#exportRemoteRefs();
    this.#remoteEmpty = false;
  }

  async #publishBase() {
    if (!this.#token) throw new RepositoryBrokerError('No repository token is configured.', 'missing_token');
    const current = await this.#workspace(['branch', '--show-current']);
    if (current !== this.baseBranch) {
      throw new RepositoryBrokerError('Base-branch initialization must run on the scoped base branch.', 'branch_scope');
    }
    const dirty = await this.#workspaceStatus();
    if (dirty) throw new RepositoryBrokerError('Commit all workspace changes before publishing the base branch.', 'workspace_dirty');

    const workspaceGit = path.join(this.workDir, '.git');
    const localUrl = pathToFileURL(workspaceGit).href;
    const headSha = await this.#workspace(['rev-parse', 'HEAD']);
    await this.#bare([
      '-c', 'protocol.file.allow=always',
      'fetch', '--no-tags', localUrl, `+${headSha}:refs/heads/${this.baseBranch}`,
    ]);
    const stagedSha = await this.#bare(['rev-parse', `refs/heads/${this.baseBranch}`]);
    if (stagedSha !== headSha) throw new RepositoryBrokerError('Broker staging SHA did not match base HEAD.', 'sha_mismatch');
    await this.#bare(
      ['push', 'origin', `refs/heads/${this.baseBranch}:refs/heads/${this.baseBranch}`],
      { auth: true }
    );
    this.step(`Repository broker initialized ${this.repository.fullName} on ${this.baseBranch} at ${headSha.slice(0, 12)}.`);
  }

  async #exportRemoteRefs() {
    await this.#assertCanonicalOrigin();
    const stageUrl = pathToFileURL(this.gitDir).href;
    await this.#workspace([
      '-c', 'protocol.file.allow=always',
      'fetch', '--prune', '--no-tags', stageUrl,
      '+refs/remotes/origin/*:refs/remotes/origin/*',
    ]);
  }

  /**
   * Pick a stack base for this task among its blocker branches (latest-first).
   * A candidate qualifies only when its branch exists on the remote and is NOT
   * already merged/contained in the default base — i.e. its work is still open.
   * The first qualifying candidate becomes `baseBranch`, so the existing fork
   * and review-scope machinery targets it. No candidate → the default base is
   * kept unchanged. Best-effort: provider hiccups fall back to a git-ancestry
   * check rather than blocking the run.
   */
  async #resolveStackBase() {
    if (!this.#stackCandidates.length) return;
    const defaultBase = this.baseBranch;
    const skipped = [];
    for (const candidate of this.#stackCandidates) {
      if (candidate === defaultBase) continue;
      const remoteRef = `refs/remotes/origin/${candidate}`;
      const branchExists = await this.#workspace(
        ['show-ref', '--verify', '--quiet', remoteRef],
        { allowFailure: true }
      );
      if (branchExists === null) continue; // blocker never pushed a branch → nothing to stack on

      let review = null;
      try {
        review = await findReviewByBranch({
          provider: this.repository.provider,
          repository: this.repository,
          token: this.#token,
          branch: candidate,
          fetchImpl: this.#fetchImpl,
        });
      } catch (_) {
        // Provider unavailable — defer to the ancestry check below.
      }
      if (review && review.state === 'merged') {
        skipped.push(`${candidate} (merged)`);
        continue;
      }
      // Already contained in the default base (fast-forward/rebase-merged, or an
      // empty branch) → its work has landed, so stacking would target stale work.
      const contained = await this.#workspace(
        ['merge-base', '--is-ancestor', remoteRef, `refs/remotes/origin/${defaultBase}`],
        { allowFailure: true }
      );
      if (contained !== null) {
        skipped.push(`${candidate} (already in ${defaultBase})`);
        continue;
      }

      this.baseBranch = candidate;
      this.#stackedOn = {
        branch: candidate,
        defaultBase,
        dependentBranch: this.branch,
        reviewId: review ? review.id : null,
        reviewUrl: review ? review.url : null,
      };
      const others = this.#stackCandidates.filter((c) => c !== candidate && c !== defaultBase);
      if (others.length) {
        this.step(`Other blockers not folded into this stack: ${others.join(', ')}.`, 'warn');
      }
      this.step(`Stacking ${this.branch} on unmerged blocker branch ${candidate} (default base ${defaultBase}).`);
      return;
    }
    if (skipped.length) {
      this.step(`No open blocker branch to stack on (${skipped.join(', ')}); targeting ${defaultBase}.`);
    }
  }

  async prepare({ shallow = false } = {}) {
    this.#assertActive();
    fs.mkdirSync(this.workspaceRoot, { recursive: true });
    assertScopedPath(this.workspaceRoot, this.workDir);
    const hasGit = fs.existsSync(path.join(this.workDir, '.git'));
    if (hasGit) {
      // Fail before any authenticated network activity when a reused path is
      // actually a checkout of a different repository.
      await this.#assertOriginUrl();
    }
    await this.#prepareBare();

    if (!hasGit) {
      if (fs.existsSync(this.workDir) && fs.readdirSync(this.workDir).length) {
        throw new RepositoryBrokerError('Workspace exists but is not a Git repository.', 'workspace_invalid');
      }
      fs.mkdirSync(path.dirname(this.workDir), { recursive: true });
      const cloneArgs = ['clone', '--no-hardlinks', '--origin', 'origin'];
      if (shallow) cloneArgs.push('--depth', '1');
      cloneArgs.push(this.gitDir, this.workDir);
      await this.#git(cloneArgs, { cwd: this.workspaceRoot });
      await this.#workspace(['remote', 'set-url', 'origin', this.repository.https]);
    }

    await this.#sanitizeWorkspaceConfig();
    await this.#assertCanonicalOrigin();
    await this.#exportRemoteRefs();

    const dirty = await this.#workspaceStatus();
    if (dirty) {
      // The per-project workspace is shared and reused across tasks. A prior run
      // that terminated without committing (crash, turn limit, transient model
      // error) would otherwise brick EVERY later task for this project on this
      // check. The broker is the single writer and every accepted result is
      // committed and pushed before the run ends, so leftover uncommitted changes
      // are abandoned work: discard them and continue from a clean tree instead
      // of failing closed. Committed history is untouched (reset --hard only
      // rewinds the working tree to HEAD; clean -fd drops untracked, not ignored).
      this.step('Discarding uncommitted changes left by an earlier run.', 'warn');
      await this.#workspace(['reset', '--hard']);
      await this.#workspace(['clean', '-fd']);
      const stillDirty = await this.#workspaceStatus();
      if (stillDirty) {
        throw new RepositoryBrokerError('Workspace could not be reset to a clean state.', 'workspace_dirty');
      }
    }
    if (this.#remoteEmpty) await this.#seedEmptyRemote();
    // Retarget the base to an unmerged blocker branch before forking the task
    // branch, so a dependent task builds on (and its PR targets) the blocker's
    // still-open work instead of the default branch it has not landed in yet.
    await this.#resolveStackBase();
    const exists = await this.#workspace(
      ['show-ref', '--verify', '--quiet', `refs/heads/${this.branch}`],
      { allowFailure: true }
    );
    const remoteTaskRef = `refs/remotes/origin/${this.branch}`;
    const remoteExists = await this.#workspace(
      ['show-ref', '--verify', '--quiet', remoteTaskRef],
      { allowFailure: true }
    );
    if (exists !== null) {
      await this.#workspace(['checkout', this.branch]);
      if (remoteExists !== null) {
        const refreshed = await this.#workspace(['merge', '--ff-only', '--no-edit', remoteTaskRef], { allowFailure: true });
        if (refreshed === null) {
          this.step(`Scoped branch ${this.branch} diverged from its remote; the pull skill must merge it.`, 'warn');
        }
      }
    } else if (remoteExists !== null) {
      await this.#workspace(['checkout', '-b', this.branch, remoteTaskRef]);
    } else {
      // Prefer the locally seeded base (empty-remote path) and fall back to the
      // fetched remote base branch for an ordinary repository.
      const baseLocal = await this.#workspace(
        ['show-ref', '--verify', '--quiet', `refs/heads/${this.baseBranch}`],
        { allowFailure: true }
      );
      const baseStart = baseLocal !== null ? this.baseBranch : `refs/remotes/origin/${this.baseBranch}`;
      await this.#workspace(['checkout', '-b', this.branch, baseStart]);
    }
    await this.#sanitizeWorkspaceConfig();
    this.step(`Repository broker ready for ${this.repository.fullName} on ${this.branch}.`);
    return this.publicInfo();
  }

  async fetchRemote() {
    await this.#prepareBare();
    await this.#exportRemoteRefs();
    return { ...this.publicInfo(), fetched: true };
  }

  async #assertCurrentBranch() {
    await this.#assertCanonicalOrigin();
    const current = await this.#workspace(['branch', '--show-current']);
    if (current !== this.branch) {
      throw new RepositoryBrokerError(`Workspace must stay on scoped branch ${this.branch}.`, 'branch_scope');
    }
    return this.#workspace(['rev-parse', 'HEAD']);
  }

  #retryBranch(review, ordinal) {
    const numericId = Number(review && review.id);
    const reviewKey = Number.isSafeInteger(numericId) && numericId > 0
      ? String(numericId)
      : crypto.createHash('sha256')
        .update(`${this.repository.provider}:${this.#scopeBranch}:${review && review.url}:${review && review.state}`)
        .digest('hex')
        .slice(0, 12);
    const suffix = `-retry-${reviewKey}${ordinal > 1 ? `-${ordinal}` : ''}`;
    const prefix = this.#scopeBranch.slice(0, 120 - suffix.length).replace(/[/.]+$/g, '');
    return validateBranch(`${prefix || 'task'}${suffix}`, 'retry branch');
  }

  async #branchRefs(branch) {
    const localRef = `refs/heads/${branch}`;
    const remoteRef = `refs/remotes/origin/${branch}`;
    const local = await this.#workspace(['show-ref', '--verify', '--quiet', localRef], { allowFailure: true });
    const remote = await this.#workspace(['show-ref', '--verify', '--quiet', remoteRef], { allowFailure: true });
    return { local: local !== null, remote: remote !== null, localRef, remoteRef };
  }

  async #canResumeRetryReview(review, terminalReview, refs, currentSha) {
    if (!review.headSha) return false;
    // A clean original branch still at the terminal review head is a fresh
    // restart, so the existing retry is authoritative even when it has moved on.
    if (terminalReview.headSha && terminalReview.headSha === currentSha) return true;
    if (review.headSha === currentSha) return true;

    const comparisonRef = refs.remote ? refs.remoteRef : refs.local ? refs.localRef : null;
    if (!comparisonRef) return false;
    const refSha = await this.#workspace(['rev-parse', comparisonRef], { allowFailure: true });
    if (!refSha || refSha !== review.headSha) return false;
    const unchanged = await this.#workspace(
      ['-c', 'core.fsmonitor=false', '-c', 'core.checkStat=default', 'diff', '--quiet', comparisonRef, 'HEAD', '--'],
      { allowFailure: true }
    );
    return unchanged !== null;
  }

  async #checkoutRetryReview(branch, review, refs) {
    const previous = this.branch;
    let switched;
    if (refs.local) {
      switched = await this.#workspace(['checkout', branch], { allowFailure: true });
      if (switched !== null && refs.remote) {
        switched = await this.#workspace(['merge', '--ff-only', '--no-edit', refs.remoteRef], { allowFailure: true });
      }
    } else if (refs.remote) {
      switched = await this.#workspace(['checkout', '-b', branch, refs.remoteRef], { allowFailure: true });
    } else {
      return false;
    }
    if (switched === null) {
      const restored = await this.#workspace(['checkout', previous], { allowFailure: true });
      if (restored === null) {
        const current = await this.#workspace(['branch', '--show-current'], { allowFailure: true });
        if (current === branch) this.branch = branch;
        throw new RepositoryBrokerError('Could not restore the original scoped branch.', 'branch_scope');
      }
      return false;
    }
    const headSha = await this.#workspace(['rev-parse', 'HEAD'], { allowFailure: true });
    if (!headSha || headSha !== review.headSha) {
      const restored = await this.#workspace(['checkout', previous], { allowFailure: true });
      if (restored === null) {
        this.branch = branch;
        throw new RepositoryBrokerError('Could not restore the original scoped branch.', 'branch_scope');
      }
      return false;
    }
    this.branch = branch;
    this.#feedbackReads.clear();
    return true;
  }

  async #recoverTerminalReview(review) {
    const dirty = await this.#workspaceStatus();
    if (dirty) {
      throw new RepositoryBrokerError('Commit all workspace changes before creating a retry branch.', 'workspace_dirty');
    }

    // Refresh the broker-owned view before choosing a name. The candidate is
    // derived only from the original server-scoped branch and provider review
    // id; callers never get a branch-name input.
    await this.#prepareBare();
    await this.#exportRemoteRefs();
    const currentSha = await this.#workspace(['rev-parse', 'HEAD']);
    for (let ordinal = 1; ordinal <= LIMITS.retryBranches; ordinal += 1) {
      const candidate = this.#retryBranch(review, ordinal);
      const candidateReview = await this.#findReview(candidate);
      const refs = await this.#branchRefs(candidate);
      if (candidateReview) {
        const normalized = await this.#reviewDetails(
          normalizeReview(this.repository.provider, candidateReview),
          candidate
        );
        if (
          ['open', 'opened'].includes(normalized.state) &&
          await this.#canResumeRetryReview(normalized, review, refs, currentSha) &&
          await this.#checkoutRetryReview(candidate, normalized, refs)
        ) {
          this.step(`Resumed existing review on server-scoped retry branch ${candidate}.`, 'warn');
          return { branch: candidate, review: normalized };
        }
        continue;
      }
      if (refs.local || refs.remote) continue;

      await this.#workspace(['checkout', '-b', candidate]);
      const previous = this.branch;
      this.branch = candidate;
      this.#feedbackReads.clear();
      try {
        await this.pushBranch();
      } catch (error) {
        this.step(`Retry branch ${candidate} was selected but could not be published: ${this.#safeError(error)}`, 'warn');
        const restored = await this.#workspace(['checkout', previous], { allowFailure: true });
        if (restored !== null) this.branch = previous;
        // If restoring ever fails, retain the candidate scope because the
        // workspace is already on it; never let broker state target another ref.
        throw error;
      }
      this.step(`Terminal review on ${previous} detected; continuing on server-scoped retry branch ${candidate}.`, 'warn');
      return { branch: candidate, review: null };
    }
    throw new RepositoryBrokerError('No unused server-scoped retry branch is available.', 'retry_branch_exhausted');
  }

  async pushBranch() {
    if (!this.#token) throw new RepositoryBrokerError('No repository token is configured.', 'missing_token');
    const headSha = await this.#assertCurrentBranch();
    const dirty = await this.#workspaceStatus();
    if (dirty) throw new RepositoryBrokerError('Commit all workspace changes before pushing.', 'workspace_dirty');

    // Import the single scoped branch into broker-private bare staging without
    // credentials or hardlinks, then perform the authenticated network push from
    // staging. Agent-controlled hooks/config never run in the credentialed child.
    const workspaceGit = path.join(this.workDir, '.git');
    const localUrl = pathToFileURL(workspaceGit).href;
    await this.#bare([
      '-c', 'protocol.file.allow=always',
      'fetch', '--no-tags', localUrl, `+${headSha}:refs/heads/${this.branch}`,
    ]);
    const stagedSha = await this.#bare(['rev-parse', `refs/heads/${this.branch}`]);
    if (stagedSha !== headSha) throw new RepositoryBrokerError('Broker staging SHA did not match workspace HEAD.', 'sha_mismatch');
    await this.#bare(
      ['push', 'origin', `refs/heads/${this.branch}:refs/heads/${this.branch}`],
      { auth: true }
    );
    this.step(`Repository broker pushed ${this.branch} at ${headSha.slice(0, 12)}.`);
    return { ...this.publicInfo(), pushed: true, headSha };
  }

  #apiPath() {
    return repoApiPath(this.repository);
  }

  async #request(method, endpoint, body, { allow404 = false, withMeta = false } = {}) {
    return forgeApiRequest({
      provider: this.repository.provider,
      repository: this.repository,
      token: this.#token,
      method,
      endpoint,
      body,
      fetchImpl: this.#fetchImpl,
      allow404,
      withMeta,
      redactSecrets: [this.#token],
    });
  }

  async #findReview(branch = this.branch) {
    const scopedBranch = validateBranch(branch, 'review branch');
    const api = this.#apiPath();
    if (this.repository.provider === 'github') {
      const query = new URLSearchParams({
        state: 'all',
        head: `${this.repository.owner}:${scopedBranch}`,
        base: this.baseBranch,
        per_page: '20',
      });
      const list = await this.#request('GET', `${api}/pulls?${query}`);
      const exact = (Array.isArray(list) ? list : []).filter(
        (item) => item && item.head && item.base && item.head.ref === scopedBranch && item.base.ref === this.baseBranch
      );
      return exact.find((item) => item.state === 'open') || exact[0] || null;
    }
    const query = new URLSearchParams({
      scope: 'all',
      state: 'all',
      source_branch: scopedBranch,
      target_branch: this.baseBranch,
      per_page: '20',
    });
    const list = await this.#request('GET', `${api}/merge_requests?${query}`);
    const exact = (Array.isArray(list) ? list : []).filter(
      (item) => item && item.source_branch === scopedBranch && item.target_branch === this.baseBranch
    );
    return exact.find((item) => item.state === 'opened') || exact[0] || null;
  }

  async #applyReviewLabel(id) {
    if (!this.label) return;
    const api = this.#apiPath();
    if (this.repository.provider === 'github') {
      await this.#request('POST', `${api}/issues/${id}/labels`, { labels: [this.label] });
    } else {
      await this.#request('PUT', `${api}/merge_requests/${id}`, { add_labels: this.label });
    }
  }

  async #reviewDetails(review, branch = this.branch) {
    const api = this.#apiPath();
    if (this.repository.provider === 'github') {
      return this.#assertReviewScope(
        normalizeReview('github', await this.#request('GET', `${api}/pulls/${review.id}`)),
        branch
      );
    }
    return this.#assertReviewScope(
      normalizeReview(
        'gitlab',
        await this.#request('GET', `${api}/merge_requests/${review.id}?include_rebase_in_progress=true`)
      ),
      branch
    );
  }

  #assertReviewScope(review, branch = this.branch) {
    if (!review || review.sourceBranch !== branch || review.targetBranch !== this.baseBranch) {
      throw new RepositoryBrokerError(
        'Review source or target branch moved outside the broker scope.',
        'review_scope'
      );
    }
    return review;
  }

  async #mergedReviewHasNoNewWork(review, localSha) {
    const dirty = await this.#workspaceStatus();
    if (dirty) {
      throw new RepositoryBrokerError('Commit or discard workspace changes before resolving a merged review.', 'workspace_dirty');
    }
    if (review.headSha && review.headSha === localSha) return true;

    // A rerun may have merged the refreshed base into the old task branch after
    // the provider squash-merged it. Treat an identical tree as already done,
    // while any effective tree delta is new work that needs a retry review.
    await this.#prepareBare();
    await this.#exportRemoteRefs();
    const unchanged = await this.#workspace(
      ['diff', '--quiet', `refs/remotes/origin/${this.baseBranch}`, 'HEAD', '--'],
      { allowFailure: true }
    );
    return unchanged !== null;
  }

  async openReview({ title, body = '' }) {
    const localSha = await this.#assertCurrentBranch();
    const reviewTitle = oneLine(title, LIMITS.titleChars);
    const reviewBody = cleanText(body, LIMITS.bodyChars);
    if (!reviewTitle) throw new RepositoryBrokerError('A review title is required.', 'invalid_input');
    const existing = await this.#findReview();
    if (existing) {
      let normalized = await this.#reviewDetails(normalizeReview(this.repository.provider, existing));
      if (normalized.state === 'open' || normalized.state === 'opened') {
        let warning = null;
        try {
          await this.#applyReviewLabel(normalized.id);
        } catch (error) {
          warning = `Review reused, but label could not be applied: ${this.#safeError(error)}`;
        }
        return { ...this.publicInfo(), ...normalized, reused: true, labelApplied: !this.label || !warning, warning };
      }
      if (normalized.state === 'merged' && await this.#mergedReviewHasNoNewWork(normalized, localSha)) {
        let warning = null;
        try {
          await this.#applyReviewLabel(normalized.id);
        } catch (error) {
          warning = `Merged review reused, but label could not be applied: ${this.#safeError(error)}`;
        }
        return {
          ...this.publicInfo(),
          ...normalized,
          reused: true,
          alreadyMerged: true,
          labelApplied: !this.label || !warning,
          warning,
        };
      }
      const recovery = await this.#recoverTerminalReview(normalized);
      if (recovery.review) {
        let warning = null;
        try {
          await this.#applyReviewLabel(recovery.review.id);
        } catch (error) {
          warning = `Review resumed, but label could not be applied: ${this.#safeError(error)}`;
        }
        return {
          ...this.publicInfo(),
          ...recovery.review,
          reused: true,
          resumed: true,
          labelApplied: !this.label || !warning,
          warning,
        };
      }
    }

    const api = this.#apiPath();
    let created;
    let warning = null;
    if (this.repository.provider === 'github') {
      created = await this.#request('POST', `${api}/pulls`, {
        title: reviewTitle,
        body: reviewBody,
        head: this.branch,
        base: this.baseBranch,
        draft: false,
      });
    } else {
      created = await this.#request('POST', `${api}/merge_requests`, {
        source_branch: this.branch,
        target_branch: this.baseBranch,
        title: reviewTitle,
        description: reviewBody,
        labels: this.label || undefined,
        remove_source_branch: true,
        squash: true,
      });
    }
    const normalized = this.#assertReviewScope(normalizeReview(this.repository.provider, created));
    try {
      await this.#applyReviewLabel(normalized.id);
    } catch (error) {
      warning = `Review created, but label could not be applied: ${this.#safeError(error)}`;
    }
    this.step(`Repository broker opened ${this.repository.provider === 'github' ? 'PR' : 'MR'} ${normalized.url || normalized.id}.`);
    return { ...this.publicInfo(), ...normalized, reused: false, labelApplied: !this.label || !warning, warning };
  }

  async #optionalRequest(method, endpoint) {
    try {
      return await this.#request(method, endpoint);
    } catch (_) {
      return null;
    }
  }

  async #optionalPagedRequest(endpoint, maxPages = 3) {
    const items = [];
    try {
      for (let page = 1; page <= maxPages; page += 1) {
        const separator = endpoint.includes('?') ? '&' : '?';
        const result = await this.#request('GET', `${endpoint}${separator}page=${page}`, undefined, { withMeta: true });
        if (!result || !Array.isArray(result.data)) return { items, complete: false };
        items.push(...result.data);
        if (!result.hasNext) return { items, complete: true };
      }
      return { items, complete: false };
    } catch (_) {
      return { items, complete: false };
    }
  }

  #feedbackPage(review, items, cursor, recordRead = true) {
    const page = feedbackWindow(items, cursor);
    const key = `${review.provider}:${review.id}:${review.headSha || 'unknown'}`;
    const signature = crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex');
    let record = this.#feedbackReads.get(key);
    if (!record || record.signature !== signature) {
      record = { signature, total: items.length, nextCursor: 0, complete: false };
      this.#feedbackReads.set(key, record);
    }

    // Only the public review_status action records consumption, and only when
    // the caller follows the exact next cursor returned by the previous page.
    // An internal merge refresh or an out-of-order page cannot fill a gap.
    if (recordRead && items.length > 0 && page.feedbackCursor === record.nextCursor) {
      if (page.nextFeedbackCursor === null) record.complete = true;
      else record.nextCursor = page.nextFeedbackCursor;
    }

    const feedbackReadComplete = items.length === 0 || record.complete;
    return {
      ...page,
      feedbackReadComplete,
      expectedFeedbackCursor: feedbackReadComplete ? null : record.nextCursor,
    };
  }

  async #reviewStatus({ cursor = 0 } = {}, recordRead = true) {
    const found = await this.#findReview();
    if (!found) return { ...this.publicInfo(), exists: false };
    const api = this.#apiPath();
    const id = this.repository.provider === 'github' ? found.number : found.iid;
    if (this.repository.provider === 'github') {
      const review = await this.#request('GET', `${api}/pulls/${id}`);
      const normalized = this.#assertReviewScope(normalizeReview('github', review));
      const sha = normalized.headSha;
      const [checkRuns, combined, reviewsPage, issueCommentsPage, reviewCommentsPage] = await Promise.all([
        this.#optionalRequest('GET', `${api}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`),
        this.#optionalRequest('GET', `${api}/commits/${encodeURIComponent(sha)}/status?per_page=100`),
        this.#optionalPagedRequest(`${api}/pulls/${id}/reviews?per_page=100`),
        this.#optionalPagedRequest(`${api}/issues/${id}/comments?per_page=100`),
        this.#optionalPagedRequest(`${api}/pulls/${id}/comments?per_page=100`),
      ]);
      const reviews = reviewsPage.items;
      const issueComments = issueCommentsPage.items;
      const reviewComments = reviewCommentsPage.items;
      const latestByUser = new Map();
      for (const item of Array.isArray(reviews) ? reviews : []) {
        const user = item && item.user && item.user.login;
        if (user) latestByUser.set(user, item);
      }
      const latestReviews = [...latestByUser.values()];
      const feedback = [
        ...reviews.filter((item) => item && item.body).map((item) => ({
          id: String(item.id),
          type: 'review',
          state: item.state || null,
          author: item.user && item.user.login,
          path: null,
          line: null,
          body: cleanText(item.body, LIMITS.feedbackChars),
          url: item.html_url || null,
        })),
        ...[...issueComments, ...reviewComments].filter((item) => item && item.body).map((item) => ({
          id: String(item.id),
          type: item.path ? 'inline_comment' : 'comment',
          author: item.user && item.user.login,
          path: item.path || null,
          line: item.line || item.original_line || null,
          body: cleanText(item.body, LIMITS.feedbackChars),
          url: item.html_url || null,
        })),
      ];
      const boundedFeedback = boundFeedback(feedback);
      return {
        ...normalized,
        exists: true,
        checks: statusFromGithub(checkRuns, combined),
        approvals: latestReviews.filter((item) => item.state === 'APPROVED').length,
        changesRequested: latestReviews.filter((item) => item.state === 'CHANGES_REQUESTED').length,
        feedbackComplete:
          reviewsPage.complete && issueCommentsPage.complete && reviewCommentsPage.complete && boundedFeedback.complete,
        labelApplied: !this.label || normalized.labels.some((label) => label.toLowerCase() === this.label.toLowerCase()),
        ...this.#feedbackPage(normalized, boundedFeedback.items, cursor, recordRead),
      };
    }

    const review = await this.#request('GET', `${api}/merge_requests/${id}?include_rebase_in_progress=true`);
    const normalized = this.#assertReviewScope(normalizeReview('gitlab', review));
    const [pipelinesPage, discussionsPage] = await Promise.all([
      this.#optionalPagedRequest(`${api}/merge_requests/${id}/pipelines?per_page=100`),
      this.#optionalPagedRequest(`${api}/merge_requests/${id}/discussions?per_page=100`),
    ]);
    const pipelines = pipelinesPage.items;
    const discussions = discussionsPage.items;
    const feedback = [];
    for (const discussion of Array.isArray(discussions) ? discussions : []) {
      for (const note of Array.isArray(discussion.notes) ? discussion.notes : []) {
        if (!note || !note.body || note.system) continue;
        feedback.push({
          id: String(discussion.id),
          noteId: String(note.id),
          author: note.author && note.author.username,
          resolved: Boolean(note.resolved),
          body: cleanText(note.body, LIMITS.feedbackChars),
          url: note.web_url || null,
        });
      }
    }
    const pipelineHistory = Array.isArray(pipelines) ? pipelines : [];
    const candidates = [review.head_pipeline, ...pipelineHistory].filter(Boolean);
    const pipeline = candidates.find((item) => item.sha === normalized.headSha) || null;
    const checksComplete = Boolean(pipeline) || (pipelinesPage.complete && candidates.length === 0);
    const boundedFeedback = boundFeedback(feedback);
    const feedbackPage = this.#feedbackPage(normalized, boundedFeedback.items, cursor, recordRead);
    return {
      ...normalized,
      exists: true,
      checks: {
        state: !checksComplete ? 'unknown' : pipeline ? pipeline.status : 'none',
        complete: checksComplete,
        url: pipeline && (pipeline.web_url || null),
        history: (Array.isArray(pipelines) ? pipelines : []).slice(0, 10).map((item) => ({
          id: item.id,
          sha: item.sha,
          status: item.status,
          url: item.web_url || null,
        })),
      },
      feedbackComplete: discussionsPage.complete && boundedFeedback.complete,
      labelApplied: !this.label || normalized.labels.some((label) => label.toLowerCase() === this.label.toLowerCase()),
      ...feedbackPage,
    };
  }

  reviewStatus(input = {}) {
    return this.#reviewStatus(input, true);
  }

  async mergeReview() {
    const status = await this.#reviewStatus({ cursor: 0 }, false);
    if (!status.exists) throw new RepositoryBrokerError('No review exists for the scoped branch.', 'review_missing');
    if (!['open', 'opened'].includes(status.state)) {
      if (status.state === 'merged') {
        const localSha = await this.#assertCurrentBranch();
        if (!await this.#mergedReviewHasNoNewWork(status, localSha)) {
          throw new RepositoryBrokerError('The merged review does not contain the current scoped work.', 'merge_receipt_required');
        }
        const receipt = await this.#recordMergeReceipt(status, status.mergedSha, { reused: true });
        return { ...status, merged: true, reused: true, artifactReceipt: receipt };
      }
      throw new RepositoryBrokerError('The scoped review is not open.', 'review_not_open');
    }
    const localSha = await this.#assertCurrentBranch();
    const dirty = await this.#workspaceStatus();
    if (dirty) {
      throw new RepositoryBrokerError('Commit or discard all workspace changes before merging.', 'workspace_dirty');
    }
    if (!status.headSha || status.headSha !== localSha) {
      throw new RepositoryBrokerError('Review head changed or does not match local HEAD; push and review again.', 'sha_mismatch');
    }
    if (status.feedbackTotal > 0 && status.feedbackReadComplete !== true) {
      throw new RepositoryBrokerError(
        'Read every feedback cursor window in this broker run before merging.',
        'feedback_unread'
      );
    }

    const checkState = status.checks && status.checks.state;
    const githubBlocked = this.repository.provider === 'github' &&
      (status.mergeable !== true || !['success', 'none'].includes(checkState) ||
        status.changesRequested > 0 || status.feedbackComplete !== true || status.labelApplied !== true);
    const gitlabBlocked = this.repository.provider === 'gitlab' &&
      (status.detailedMergeStatus !== 'mergeable' ||
        !['success', 'none'].includes(checkState) ||
        status.blockingDiscussionsResolved === false || status.feedbackComplete !== true || status.labelApplied !== true);
    if (githubBlocked || gitlabBlocked) {
      throw new RepositoryBrokerError('Review is not merge-ready; resolve checks, conflicts, approvals, and discussions first.', 'review_blocked');
    }

    // Re-fetch the provider record immediately before mutation. The list result
    // and earlier status snapshot are not authority if a review was retargeted.
    const finalReview = await this.#reviewDetails(status);
    if (finalReview.state === 'merged') {
      if (!await this.#mergedReviewHasNoNewWork(finalReview, localSha)) {
        throw new RepositoryBrokerError('The merged review does not contain the current scoped work.', 'merge_receipt_required');
      }
      const receipt = await this.#recordMergeReceipt(finalReview, finalReview.mergedSha, { reused: true });
      return { ...status, ...finalReview, merged: true, reused: true, artifactReceipt: receipt };
    }
    if (!['open', 'opened'].includes(finalReview.state)) {
      throw new RepositoryBrokerError('The scoped review is no longer open.', 'review_not_open');
    }
    if (!finalReview.headSha || finalReview.headSha !== localSha || finalReview.headSha !== status.headSha) {
      throw new RepositoryBrokerError('Review head changed before merge; push and review again.', 'sha_mismatch');
    }
    if (
      (this.repository.provider === 'github' && finalReview.mergeable !== true) ||
      (this.repository.provider === 'gitlab' && (
        finalReview.detailedMergeStatus !== 'mergeable' || finalReview.blockingDiscussionsResolved === false
      ))
    ) {
      throw new RepositoryBrokerError('Review became unmergeable before the merge request.', 'review_blocked');
    }

    const api = this.#apiPath();
    let merged;
    if (this.repository.provider === 'github') {
      merged = await this.#request('PUT', `${api}/pulls/${finalReview.id}/merge`, {
        sha: finalReview.headSha,
        merge_method: 'squash',
      });
      if (!merged || merged.merged !== true) {
        throw new RepositoryBrokerError(oneLine(merged && merged.message, 500) || 'GitHub did not merge the pull request.', 'merge_failed');
      }
      const receipt = await this.#recordMergeReceipt(finalReview, merged.sha);
      return {
        ...status,
        merged: true,
        mergedSha: receipt.mergedSha,
        message: oneLine(merged.message, 500),
        artifactReceipt: receipt,
      };
    }
    merged = await this.#request('PUT', `${api}/merge_requests/${finalReview.id}/merge`, {
      sha: finalReview.headSha,
      squash: true,
      should_remove_source_branch: true,
      auto_merge: false,
    });
    if (!merged || merged.state !== 'merged') {
      throw new RepositoryBrokerError(oneLine(merged && merged.merge_error, 500) || 'GitLab did not merge the merge request.', 'merge_failed');
    }
    return { ...status, merged: true, mergedSha: merged.merge_commit_sha || merged.squash_commit_sha || null };
  }

  async #performAction(input) {
    const action = input && input.action;
    if (action === 'info') return this.publicInfo();
    if (action === 'fetch') return this.fetchRemote();
    if (action === 'push') return this.pushBranch();
    if (action === 'open_review') return this.openReview(input);
    if (action === 'review_status') return this.reviewStatus(input);
    if (action === 'merge_review') return this.mergeReview();
    throw new RepositoryBrokerError('Unknown repository broker action.', 'invalid_action');
  }

  #enqueue(operation) {
    const run = async () => {
      this.#assertActive();
      this.#calls += 1;
      if (this.#calls > LIMITS.toolCalls) {
        throw new RepositoryBrokerError('Repository broker call limit reached for this run.', 'call_limit');
      }
      return operation();
    };
    const pending = this.#queue.then(run, run);
    this.#queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  execute(input) {
    return this.#enqueue(() => this.#performAction(input || {}));
  }

  createTool() {
    const { tool } = require('@langchain/core/tools');
    const { z } = require('zod');
    return tool(
      async (input) => {
        try {
          const value = await this.execute(input);
          const output = JSON.stringify({ ok: true, ...value });
          if (output.length > LIMITS.toolOutputChars) {
            return JSON.stringify({ ok: false, code: 'output_limit', error: 'Repository broker output exceeded its limit.' });
          }
          return output;
        } catch (error) {
          if (isAvailabilityFailure(error)) this.#availabilityError = error;
          return JSON.stringify({ ok: false, error: this.#safeError(error), code: error && error.code }).slice(
            0,
            LIMITS.toolOutputChars
          );
        }
      },
      {
        name: 'repository_broker',
        description:
          'Perform one credentialed operation against the single repository, workspace, task branch, and base branch scoped by the server. ' +
          'Use fetch before syncing, push after committing, open_review after push, review_status for CI/review feedback, and merge_review only when ready. ' +
          'When review_status returns nextFeedbackCursor, call it again with that cursor until every bounded feedback window is read. ' +
          'merge_review is blocked until those windows have been read in this broker run and the workspace is clean. ' +
          'You cannot choose a repository, URL, token, branch, refspec, force flag, or review number.',
        schema: z
          .object({
            action: z.enum(['info', 'fetch', 'push', 'open_review', 'review_status', 'merge_review']),
            title: z.string().min(1).max(LIMITS.titleChars).optional(),
            body: z.string().max(LIMITS.bodyChars).optional(),
            cursor: z.number().int().min(0).max(LIMITS.feedbackItems * LIMITS.toolCalls).optional(),
          })
          .strict()
          .superRefine((value, ctx) => {
            if (value.action === 'open_review' && !value.title) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'title is required for open_review', path: ['title'] });
            }
            if (value.action !== 'open_review' && (value.title !== undefined || value.body !== undefined)) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'title/body are only valid for open_review' });
            }
            if (value.action !== 'review_status' && value.cursor !== undefined) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cursor is only valid for review_status', path: ['cursor'] });
            }
          }),
      }
    );
  }

  dispose() {
    if (this.#disposed) return;
    this.#token = '';
    this.#disposed = true;
    fs.rmSync(this.stagingDir, { recursive: true, force: true });
  }
}

module.exports = {
  LIMITS,
  PROVIDERS,
  SAFE_ENV_KEYS,
  DEPLOYMENT_MANIFEST,
  RepositoryBroker,
  RepositoryBrokerError,
  buildSafeAgentEnv,
  validateBranch,
  validateRepository,
  redact,
  forgeApiRequest,
  findReviewByBranch,
  repoApiPath,
  normalizeReview,
  normalizeDeploymentManifest,
  githubSha,
  mergeReceiptDigest,
  validateMergeReceipt,
};
