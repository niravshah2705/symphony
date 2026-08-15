'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_EVIDENCE_DIR = path.join(REPOSITORY_ROOT, 'test-results', 'live-evidence');
const ALLOWED_DEPLOY_ENVIRONMENTS = new Set([
  'qa', 'test', 'testing', 'stage', 'staging', 'dev', 'development',
]);
const FORBIDDEN_ENVIRONMENTS = new Set(['prod', 'production', 'live']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;
const SYNTHETIC_CANARY_PATTERN = /(?:qa|test|e2e|synthetic|canary|tenant[-_ ]?[ab])/i;

function requiredString(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required for the live QA suite.`);
  }
  return value.trim();
}

function optionalString(env, name) {
  return typeof env[name] === 'string' ? env[name].trim() : '';
}

function hasProductionMarker(hostname) {
  return hostname.toLowerCase().split(/[.\-_]+/).some((part) => FORBIDDEN_ENVIRONMENTS.has(part));
}

function hasNonProductionMarker(hostname) {
  return hostname.toLowerCase().split(/[.\-_]+/).some((part) => (
    ALLOWED_DEPLOY_ENVIRONMENTS.has(part) || part === 'localhost'
  ));
}

function parseHttpsUrl(value, name, { originOnly = true } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    throw new Error(`${name} must be a valid HTTPS URL.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTPS URL without embedded credentials.`);
  }
  if (!parsed.hostname || hasProductionMarker(parsed.hostname)) {
    throw new Error(`${name} must not target a production-looking host.`);
  }
  if (!hasNonProductionMarker(parsed.hostname)) {
    throw new Error(`${name} hostname must contain an explicit non-production environment marker.`);
  }
  if (parsed.hash || parsed.search) {
    throw new Error(`${name} must not include a query string or fragment.`);
  }
  if (originOnly && parsed.pathname !== '/') {
    throw new Error(`${name} must be an origin without a path.`);
  }
  return originOnly ? parsed.origin : parsed.href;
}

function parseRepository(value) {
  if (!REPOSITORY_PATTERN.test(value) || value.endsWith('.git')) {
    throw new Error('E2E_QA_REPOSITORY must use the OWNER/REPO form.');
  }
  return value;
}

function parseUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical UUID.`);
  }
  return value.toLowerCase();
}

function parseOpaqueId(value, label, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${label} is required.`);
    return '';
  }
  if (typeof value !== 'string' || value.length > 160 || !OPAQUE_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a bounded opaque identifier (maximum 160 characters).`);
  }
  return value;
}

function parseCanary(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256
      || /[\u0000-\u001f\u007f]/.test(value) || !SYNTHETIC_CANARY_PATTERN.test(value)) {
    throw new Error(`${label} must be a synthetic, non-empty canary (maximum 256 characters).`);
  }
  return value.trim();
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

function parseTenant(value, label, {
  requireLinearProject = false,
  requireKnownResources = false,
} = {}) {
  const tenant = plainObject(value, `E2E_QA_FIXTURES_JSON.${label}`);
  const result = {
    organizationId: parseUuid(tenant.organizationId, `${label}.organizationId`),
    projectId: parseUuid(tenant.projectId, `${label}.projectId`),
    canary: parseCanary(tenant.canary, `${label}.canary`),
  };
  const linearProjectId = parseOpaqueId(
    tenant.linearProjectId,
    `${label}.linearProjectId`,
    { required: requireLinearProject },
  );
  const conversationId = parseOpaqueId(tenant.conversationId, `${label}.conversationId`, {
    required: requireKnownResources,
  });
  const terminalRunId = parseOpaqueId(tenant.terminalRunId, `${label}.terminalRunId`, {
    required: requireKnownResources,
  });
  if (linearProjectId) result.linearProjectId = linearProjectId;
  if (conversationId) result.conversationId = conversationId;
  if (terminalRunId) result.terminalRunId = terminalRunId;
  if (tenant.settingsProjectId !== undefined && tenant.settingsProjectId !== '') {
    result.settingsProjectId = parseUuid(tenant.settingsProjectId, `${label}.settingsProjectId`);
  }
  return Object.freeze(result);
}

function parsePipelineTask(value) {
  const task = plainObject(value, 'E2E_QA_FIXTURES_JSON.pipelineTask');
  const title = typeof task.title === 'string' ? task.title.trim() : '';
  const description = typeof task.description === 'string' ? task.description.trim() : '';
  if (!title || title.length > 255) {
    throw new Error('pipelineTask.title must be non-empty and no longer than 255 characters.');
  }
  if (description.length < 20 || description.length > 19_000) {
    throw new Error('pipelineTask.description must contain 20 to 19000 characters.');
  }
  if (!Number.isInteger(task.priority) || task.priority < 0 || task.priority > 4) {
    throw new Error('pipelineTask.priority must be an integer from 0 through 4.');
  }
  return Object.freeze({ title, description, priority: task.priority });
}

function parseFixtures(source, { requireDeploy = false } = {}) {
  let decoded;
  try {
    decoded = JSON.parse(source);
  } catch (_) {
    throw new Error('E2E_QA_FIXTURES_JSON must contain valid JSON.');
  }
  const fixture = plainObject(decoded, 'E2E_QA_FIXTURES_JSON');
  const tenantA = parseTenant(fixture.tenantA, 'tenantA', { requireLinearProject: requireDeploy });
  const tenantB = parseTenant(fixture.tenantB, 'tenantB', { requireKnownResources: true });
  if (tenantA.organizationId === tenantB.organizationId) {
    throw new Error('Tenant A and Tenant B must use different organization UUIDs.');
  }
  if (tenantA.projectId === tenantB.projectId) {
    throw new Error('Tenant A and Tenant B must use different project UUIDs.');
  }
  if (tenantA.canary.toLowerCase() === tenantB.canary.toLowerCase()) {
    throw new Error('Tenant A and Tenant B must use distinct canaries.');
  }
  if (fixture.nonProduction !== true || fixture.disposable !== true) {
    throw new Error('Live QA requires nonProduction:true and disposable:true fixtures.');
  }
  const result = {
    nonProduction: fixture.nonProduction === true,
    disposable: fixture.disposable === true,
    tenantA,
    tenantB,
  };
  if (requireDeploy) result.pipelineTask = parsePipelineTask(fixture.pipelineTask);
  else if (fixture.pipelineTask !== undefined) result.pipelineTask = parsePipelineTask(fixture.pipelineTask);
  return Object.freeze(result);
}

function parseStorageState(filename, label) {
  const absolute = path.resolve(filename);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch (_) {
    throw new Error(`${label} must point to a readable Playwright storage-state file.`);
  }
  if (!stat.isFile()) throw new Error(`${label} must point to a regular file.`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be readable or writable by group/other users (chmod 600).`);
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (_) {
    throw new Error(`${label} must contain valid Playwright storage-state JSON.`);
  }
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
    throw new Error(`${label} is not a Playwright storage-state object.`);
  }
  const hasBrowserState = state.cookies.length > 0 || state.origins.some((origin) => (
    Array.isArray(origin.localStorage) && origin.localStorage.length > 0
  ) || (Array.isArray(origin.indexedDB) && origin.indexedDB.length > 0));
  if (!hasBrowserState) throw new Error(`${label} does not contain a captured browser session.`);
  return absolute;
}

function loadLiveConfig(options = {}, env = process.env) {
  const {
    requireAuth = false,
    requireAuthStates = requireAuth,
    requireDeploy = false,
    requireFixtures = true,
    requireTopology = true,
  } = options;
  const baseUrl = parseHttpsUrl(requiredString(env, 'E2E_QA_BASE_URL'), 'E2E_QA_BASE_URL');
  const settingsValue = optionalString(env, 'E2E_QA_SETTINGS_URL');
  const repositoryValue = optionalString(env, 'E2E_QA_REPOSITORY');
  const deployEnvironmentValue = optionalString(env, 'E2E_QA_DEPLOY_ENV').toLowerCase();
  const deployHealthValue = optionalString(env, 'E2E_QA_DEPLOY_HEALTH_URL');

  if (requireTopology) {
    requiredString(env, 'E2E_QA_SETTINGS_URL');
    requiredString(env, 'E2E_QA_REPOSITORY');
    requiredString(env, 'E2E_QA_DEPLOY_ENV');
    requiredString(env, 'E2E_QA_DEPLOY_HEALTH_URL');
  }
  const settingsUrl = settingsValue ? parseHttpsUrl(settingsValue, 'E2E_QA_SETTINGS_URL') : '';
  const repository = repositoryValue ? parseRepository(repositoryValue) : '';
  const deployHealthUrl = deployHealthValue
    ? parseHttpsUrl(deployHealthValue, 'E2E_QA_DEPLOY_HEALTH_URL', { originOnly: false })
    : '';
  if (deployEnvironmentValue && !ALLOWED_DEPLOY_ENVIRONMENTS.has(deployEnvironmentValue)) {
    throw new Error('E2E_QA_DEPLOY_ENV must name an allow-listed non-production environment.');
  }

  const fixtureSource = optionalString(env, 'E2E_QA_FIXTURES_JSON');
  if (requireFixtures && !fixtureSource) requiredString(env, 'E2E_QA_FIXTURES_JSON');
  const fixtures = fixtureSource ? parseFixtures(fixtureSource, { requireDeploy }) : null;

  const authStateAInput = optionalString(env, 'E2E_QA_TENANT_A_STATE_PATH')
    || path.join(REPOSITORY_ROOT, '.playwright-auth', 'tenant-a.json');
  const authStateBInput = optionalString(env, 'E2E_QA_TENANT_B_STATE_PATH')
    || path.join(REPOSITORY_ROOT, '.playwright-auth', 'tenant-b.json');
  const authStateAPath = requireAuthStates
    ? parseStorageState(authStateAInput, 'E2E_QA_TENANT_A_STATE_PATH')
    : path.resolve(authStateAInput);
  const authStateBPath = requireAuthStates
    ? parseStorageState(authStateBInput, 'E2E_QA_TENANT_B_STATE_PATH')
    : path.resolve(authStateBInput);

  if (requireDeploy) {
    if (env.E2E_ALLOW_FULL_DEPLOY !== 'true') {
      throw new Error('Full deployment is disabled; set E2E_ALLOW_FULL_DEPLOY=true explicitly.');
    }
    if (!deployEnvironmentValue || !ALLOWED_DEPLOY_ENVIRONMENTS.has(deployEnvironmentValue)) {
      throw new Error('Full deployment requires an allow-listed E2E_QA_DEPLOY_ENV.');
    }
    if (!fixtures) throw new Error('Full deployment requires E2E_QA_FIXTURES_JSON.');
  }

  const evidenceDir = path.resolve(optionalString(env, 'E2E_QA_EVIDENCE_DIR') || DEFAULT_EVIDENCE_DIR);
  return Object.freeze({
    baseUrl,
    settingsUrl,
    repository,
    deployEnvironment: deployEnvironmentValue,
    deployHealthUrl,
    fixtures,
    authStateAPath,
    authStateBPath,
    evidenceDir,
  });
}

function parseBootstrapApiAssignment(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 16 * 1024) {
    throw new Error('The SPA config.js response is missing or unexpectedly large.');
  }
  const candidates = source.split(/\r?\n/).filter((line) => /^\s*window\.__API_BASE__\b/.test(line));
  if (candidates.length !== 1) {
    throw new Error('SPA config.js must contain exactly one __API_BASE__ assignment.');
  }
  const match = candidates[0].match(/^\s*window\.__API_BASE__\s*=\s*(['"])([^'"\\]*)\1\s*;\s*$/);
  if (!match) throw new Error('SPA config.js contains an unsafe __API_BASE__ assignment.');
  return match[2].trim();
}

async function resolveBootstrapApiBase(config, fetchImpl = globalThis.fetch) {
  if (!config || typeof config.baseUrl !== 'string') throw new Error('A loaded live config is required.');
  const response = await fetchImpl(`${config.baseUrl}/config.js`, {
    headers: { accept: 'application/javascript, text/javascript;q=0.9, text/plain;q=0.5' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Unable to read the SPA bootstrap configuration (HTTP ${response.status}).`);
  const configured = parseBootstrapApiAssignment(await response.text());
  return configured ? parseHttpsUrl(configured, 'window.__API_BASE__') : config.baseUrl;
}

module.exports = {
  ALLOWED_DEPLOY_ENVIRONMENTS,
  DEFAULT_EVIDENCE_DIR,
  loadLiveConfig,
  loadQaConfig: loadLiveConfig,
  parseBootstrapApiAssignment,
  parseFixtures,
  parseHttpsUrl,
  parseStorageState,
  resolveBootstrapApiBase,
};
