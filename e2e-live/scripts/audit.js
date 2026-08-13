#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const { loadLiveConfig, parseHttpsUrl, resolveBootstrapApiBase } = require('../support/config');
const { normalizeDeploymentManifest } = require('../../packages/shared/src/agent/repository-broker');

const EXPECTED_OPERATOR_PERMISSIONS = Object.freeze({
  workspace: 'write', planning: 'write', insights: 'write', settings: 'read', org: 'write',
});
const EXPECTED_VIEWER_PERMISSIONS = Object.freeze({
  workspace: 'read', planning: 'read', insights: 'read', settings: 'read', org: 'read',
});
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const MAX_RESPONSE_BYTES = 1024 * 1024;

function contextHeaders(token, fixture) {
  return {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'x-ai-fleet-organization-id': fixture.organizationId,
    'x-ai-fleet-project-id': fixture.projectId,
  };
}

async function readBoundedJson(response, label) {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} returned an unexpectedly large response.`);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch (_) {
    throw new Error(`${label} did not return JSON.`);
  }
}

async function requestJson(baseUrl, pathname, {
  method = 'GET', headers = {}, body, expectedStatuses = [200], fetchImpl = globalThis.fetch,
} = {}) {
  const target = new URL(pathname, `${String(baseUrl).replace(/\/+$/, '')}/`);
  const origin = new URL(baseUrl).origin;
  if (target.origin !== origin || (!target.pathname.startsWith('/api/') && target.pathname !== '/healthz')) {
    throw new Error('Audit requests must remain on the configured gateway origin.');
  }
  const response = await fetchImpl(target.href, {
    method,
    headers: { accept: 'application/json', ...headers },
    ...(body === undefined ? {} : {
      body: JSON.stringify(body),
      headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  const data = await readBoundedJson(response, pathname);
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${method} ${pathname} failed with HTTP ${response.status}.`);
  }
  return { status: response.status, data };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function noElevatedClaims(value, pathName = 'identity') {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z]/gi, '').toLowerCase();
    if (normalizedKey.includes('super') && nested !== false && nested !== null && nested !== ''
        && nested !== 0 && nested !== 'false') {
      throw new Error(`${pathName} exposes a forbidden super-user claim.`);
    }
    if (nested && typeof nested === 'object') noElevatedClaims(nested, `${pathName}.${key}`);
  }
}

function validateIdentity(me, context, tenant, expectedRole) {
  assert(me && me.authenticated === true, 'The QA browser state is not authenticated.');
  const role = String(me.role || '').toLowerCase();
  assert(role !== 'admin' && !role.startsWith('super'), 'QA sessions must not use admin or super-user roles.');
  assert(role === expectedRole || (expectedRole === 'viewer-or-operator' && ['viewer', 'operator'].includes(role)),
    `The QA identity has an unexpected application role.`);
  const expectedPermissions = role === 'operator' ? EXPECTED_OPERATOR_PERMISSIONS : EXPECTED_VIEWER_PERMISSIONS;
  assert(Object.entries(expectedPermissions).every(([domain, level]) => me.permissions?.[domain] === level),
    'The QA identity permissions do not match its least-privilege role.');
  noElevatedClaims(me);
  noElevatedClaims(context);
  assert(context && context.user && context.user.is_super_admin !== true,
    'The QA identity must not be an organization super-admin.');
  const organizations = Array.isArray(context && context.organizations) ? context.organizations : [];
  const organization = organizations.find((item) => String(item.id) === tenant.organizationId);
  assert(organization, 'The expected QA organization is absent from the authenticated context.');
  assert(!organizations.some((item) => String(item.id) !== tenant.organizationId),
    'A QA identity must be provisioned in exactly one isolated organization.');
  assert(Array.isArray(organization.projects)
    && organization.projects.some((item) => String(item.id) === tenant.projectId),
  'The expected QA project is absent from the authenticated context.');
  return role;
}

async function browserSession(browser, config, storageState) {
  const context = await browser.newContext({ baseURL: config.baseUrl, storageState });
  const page = await context.newPage();
  try {
    const requestPromise = page.waitForRequest((request) => {
      try {
        return new URL(request.url()).pathname === '/api/auth/me'
          && /^Bearer\s+\S+$/i.test(request.headers().authorization || '');
      } catch (_) { return false; }
    }, { timeout: 30_000 });
    await page.goto('/#/agent', { waitUntil: 'domcontentloaded' });
    await page.locator('.auth-user').waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(async () => {
      const auth = await import('/js/auth.js');
      const apiModule = await import('/js/api.js');
      await auth.ensureFreshToken();
      await apiModule.api.getCurrentUser();
    });
    const request = await requestPromise;
    const token = (request.headers().authorization || '').replace(/^Bearer\s+/i, '');
    assert(token, 'The browser did not emit a bearer-authenticated /api/auth/me request.');
    const apiBaseUrl = parseHttpsUrl(new URL(request.url()).origin, 'authenticated gateway origin');
    return { token, apiBaseUrl };
  } finally {
    await context.close();
  }
}

function normalizeRepository(value) {
  return String(value || '').trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git\/?$/i, '').replace(/\/$/, '').toLowerCase();
}

function hasCanary(value, canary) {
  try { return JSON.stringify(value).toLowerCase().includes(canary.toLowerCase()); } catch (_) { return false; }
}

function ownContextHeaders(session, fixture) {
  return contextHeaders(session.token, fixture);
}

async function auditTenantReadiness(session, config) {
  const tenant = config.fixtures.tenantA;
  const headers = ownContextHeaders(session, tenant);
  const settings = await requestJson(session.apiBaseUrl, '/api/settings', { headers });
  assert(settings.data?.planningConfigured === true, 'Tenant A planning provider is not configured.');
  assert(settings.data?.repositoryConfigured === true, 'Tenant A repository provider is not configured.');
  assert(normalizeRepository(settings.data?.repositoryUrl) === config.repository.toLowerCase(),
    'Tenant A repository does not match E2E_QA_REPOSITORY.');

  const eula = await requestJson(session.apiBaseUrl, '/api/eula', { headers });
  assert(eula.data?.accepted === true, 'Tenant A has not accepted the current EULA.');
  const billing = await requestJson(session.apiBaseUrl, '/api/billing/summary', { headers });
  assert(Number(billing.data?.balancePaise) > 0, 'Tenant A must have a positive synthetic billing balance.');

  const businesses = await requestJson(session.apiBaseUrl, '/api/businesses', { headers });
  const linked = (Array.isArray(businesses.data?.businesses) ? businesses.data.businesses : []).find((item) => (
    String(item.projectId) === tenant.linearProjectId
      && normalizeRepository(item.repo) === config.repository.toLowerCase()
  ));
  assert(linked, 'Tenant A has no business linked to the allow-listed repository and Linear project.');

  const encodedProject = encodeURIComponent(tenant.linearProjectId);
  const milestones = await requestJson(session.apiBaseUrl, `/api/projects/${encodedProject}/milestones`, { headers });
  const milestoneList = Array.isArray(milestones.data?.milestones) ? milestones.data.milestones : [];
  assert(milestoneList.length > 0, 'Tenant A Linear project must contain at least one milestone.');
  const board = await requestJson(session.apiBaseUrl, `/api/issues/board/${encodedProject}`, { headers });
  const issueMilestones = new Set();
  for (const column of Array.isArray(board.data?.columns) ? board.data.columns : []) {
    for (const issue of Array.isArray(column?.issues) ? column.issues : []) {
      if (issue?.projectMilestone?.id) issueMilestones.add(String(issue.projectMilestone.id));
    }
  }
  assert(milestoneList.every((item) => item?.id && item?.name && issueMilestones.has(String(item.id))),
    'Every Tenant A milestone must be named and contain at least one issue.');
  return {
    settingsStatus: settings.status,
    eulaStatus: eula.status,
    billingStatus: billing.status,
    businessesStatus: businesses.status,
    milestonesStatus: milestones.status,
    allMilestonesPopulated: true,
  };
}

function githubHeaders() {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'ai-fleet-live-e2e-audit',
  };
  const token = String(process.env.E2E_QA_REPO_READ_TOKEN || '').trim();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function githubRequest(config, suffix, fetchImpl = globalThis.fetch) {
  const base = `https://api.github.com/repos/${config.repository}`;
  const target = new URL(suffix, `${base}/`);
  if (target.origin !== 'https://api.github.com'
      || (target.pathname !== `/repos/${config.repository}`
        && !target.pathname.startsWith(`/repos/${config.repository}/`))) {
    throw new Error('GitHub audit path escaped the configured repository.');
  }
  const response = await fetchImpl(target.href, {
    headers: githubHeaders(), redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  const payload = await readBoundedJson(response, `GitHub ${suffix || 'repository'}`);
  assert(response.status === 200, `GitHub repository audit failed with HTTP ${response.status}.`);
  return { status: response.status, payload };
}

async function githubContent(config, contentPath, fetchImpl = globalThis.fetch, ref = '') {
  const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const { status, payload } = await githubRequest(config, `contents/${contentPath}${suffix}`, fetchImpl);
  assert(payload && payload.encoding === 'base64' && typeof payload.content === 'string',
    'GitHub content response was not a base64 file.');
  const decoded = Buffer.from(payload.content.replace(/\s/g, ''), 'base64');
  assert(decoded.length > 0 && decoded.length <= MAX_RESPONSE_BYTES, 'GitHub content file is empty or too large.');
  return { status, text: decoded.toString('utf8') };
}

async function auditRepository(config, fetchImpl = globalThis.fetch) {
  const repository = await githubRequest(config, '', fetchImpl);
  const baseBranch = String(repository.payload?.default_branch || '');
  assert(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(baseBranch) && !baseBranch.includes('..'),
    'The QA repository default branch is missing or unsafe.');
  const manifestFile = await githubContent(config, '.ai-fleet/deployment.json', fetchImpl, baseBranch);
  let manifest;
  try { manifest = JSON.parse(manifestFile.text); } catch (_) { throw new Error('Deployment manifest is not JSON.'); }
  const deployment = normalizeDeploymentManifest(manifest, {
    provider: 'github', environment: config.deployEnvironment, baseBranch,
  });
  const workflow = await githubContent(
    config,
    `.github/workflows/${deployment.workflow}`,
    fetchImpl,
    deployment.ref,
  );
  assert(workflow.text.trim().length > 0 && /(?:^|\n)\s*(?:on|['"]on['"]):/m.test(workflow.text),
    'The allow-listed GitHub Actions workflow is empty or malformed.');
  return {
    repositoryStatus: repository.status,
    manifestStatus: manifestFile.status,
    workflowStatus: workflow.status,
    canonicalManifestValidated: true,
  };
}

function auditRecord(status, extra = {}) {
  return Object.freeze({ status, ...extra });
}

function writeAudit(filename, payload) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filename);
  if (process.platform !== 'win32') fs.chmodSync(filename, 0o600);
}

async function runAudit({ fetchImpl = globalThis.fetch, launch = (options) => chromium.launch(options) } = {}) {
  const config = loadLiveConfig({ requireAuth: true, requireDeploy: false });
  const filename = path.join(config.evidenceDir, 'audit.json');
  const checks = {};
  const startedAt = new Date().toISOString();
  let browser;
  try {
    const bootstrapApiBase = await resolveBootstrapApiBase(config, fetchImpl);
    const health = await requestJson(bootstrapApiBase, '/healthz', { fetchImpl });
    assert(health.data?.status === 'ok', 'Gateway health response is not ok.');
    checks.gatewayHealth = auditRecord('passed', { httpStatus: health.status });
    const authConfig = await requestJson(bootstrapApiBase, '/api/auth/config', { fetchImpl });
    assert(authConfig.data && authConfig.data.enabled === true, 'Firebase authentication is not enabled.');
    checks.authenticationConfig = auditRecord('passed', { httpStatus: authConfig.status });

    const denied = await requestJson(bootstrapApiBase, '/api/pipeline/runs', {
      method: 'POST', body: { audit: 'anonymous-denial' }, expectedStatuses: [401], fetchImpl,
    });
    assert(denied.data?.code === 'authentication_required', 'Anonymous pipeline denial has an unexpected code.');
    checks.anonymousPipeline = auditRecord('passed', { httpStatus: denied.status });

    browser = await launch({ channel: 'chrome', headless: true });
    const sessionA = await browserSession(browser, config, config.authStateAPath);
    const sessionB = await browserSession(browser, config, config.authStateBPath);
    const meA = await requestJson(sessionA.apiBaseUrl, '/api/auth/me', {
      headers: ownContextHeaders(sessionA, config.fixtures.tenantA), fetchImpl,
    });
    const contextA = await requestJson(sessionA.apiBaseUrl, '/api/org/me/context', {
      headers: { authorization: `Bearer ${sessionA.token}` }, fetchImpl,
    });
    const roleA = validateIdentity(meA.data, contextA.data, config.fixtures.tenantA, 'operator');
    checks.tenantAIdentity = auditRecord('passed', {
      httpStatus: meA.status,
      expectedLeastPrivilegeRole: roleA === 'operator',
    });
    const meB = await requestJson(sessionB.apiBaseUrl, '/api/auth/me', {
      headers: ownContextHeaders(sessionB, config.fixtures.tenantB), fetchImpl,
    });
    const contextB = await requestJson(sessionB.apiBaseUrl, '/api/org/me/context', {
      headers: { authorization: `Bearer ${sessionB.token}` }, fetchImpl,
    });
    const roleB = validateIdentity(meB.data, contextB.data, config.fixtures.tenantB, 'viewer-or-operator');
    checks.tenantBIdentity = auditRecord('passed', {
      httpStatus: meB.status,
      expectedLeastPrivilegeRole: ['viewer', 'operator'].includes(roleB),
    });

    const ownB = await requestJson(sessionB.apiBaseUrl,
      `/api/org/projects/${encodeURIComponent(config.fixtures.tenantB.projectId)}`, {
        headers: ownContextHeaders(sessionB, config.fixtures.tenantB), fetchImpl,
      });
    assert(hasCanary(ownB.data, config.fixtures.tenantB.canary), 'Tenant B positive control does not contain its synthetic canary.');
    checks.tenantBPositiveControl = auditRecord('passed', { httpStatus: ownB.status });
    const cross = await requestJson(sessionA.apiBaseUrl,
      `/api/org/projects/${encodeURIComponent(config.fixtures.tenantB.projectId)}`, {
        headers: ownContextHeaders(sessionA, config.fixtures.tenantA), expectedStatuses: [403, 404], fetchImpl,
      });
    assert(!hasCanary(cross.data, config.fixtures.tenantB.canary), 'Cross-tenant denial disclosed Tenant B canary data.');
    checks.tenantAExclusion = auditRecord('passed', { httpStatus: cross.status });

    if (config.fixtures.tenantB.conversationId) {
      const conversation = await requestJson(sessionB.apiBaseUrl,
        `/api/agent/conversations/${encodeURIComponent(config.fixtures.tenantB.conversationId)}`, {
          headers: ownContextHeaders(sessionB, config.fixtures.tenantB), fetchImpl,
        });
      const deniedConversation = await requestJson(sessionA.apiBaseUrl,
        `/api/agent/conversations/${encodeURIComponent(config.fixtures.tenantB.conversationId)}`, {
          headers: ownContextHeaders(sessionA, config.fixtures.tenantA), expectedStatuses: [403, 404], fetchImpl,
        });
      assert(!hasCanary(deniedConversation.data, config.fixtures.tenantB.canary), 'Conversation denial disclosed Tenant B data.');
      checks.tenantBConversationIsolation = auditRecord('passed', {
        positiveHttpStatus: conversation.status, deniedHttpStatus: deniedConversation.status,
      });
    }
    if (config.fixtures.tenantB.terminalRunId) {
      const runPath = `/api/pipeline/runs/${encodeURIComponent(config.fixtures.tenantB.terminalRunId)}`;
      const run = await requestJson(sessionB.apiBaseUrl, runPath, {
        headers: ownContextHeaders(sessionB, config.fixtures.tenantB), fetchImpl,
      });
      assert(TERMINAL_RUN_STATUSES.has(String(run.data?.run?.status || run.data?.status || '')),
        'Tenant B pipeline positive control is not terminal.');
      const deniedRun = await requestJson(sessionA.apiBaseUrl, runPath, {
        headers: ownContextHeaders(sessionA, config.fixtures.tenantA), expectedStatuses: [403, 404], fetchImpl,
      });
      checks.tenantBRunIsolation = auditRecord('passed', {
        positiveHttpStatus: run.status, deniedHttpStatus: deniedRun.status,
      });
    }

    const readiness = await auditTenantReadiness(sessionA, config);
    checks.tenantAReadiness = auditRecord('passed', readiness);
    const repository = await auditRepository(config, fetchImpl);
    checks.repository = auditRecord('passed', repository);
    const result = { result: 'passed', startedAt, completedAt: new Date().toISOString(), checks };
    writeAudit(filename, result);
    return { filename, result };
  } catch (error) {
    writeAudit(filename, {
      result: 'failed', startedAt, completedAt: new Date().toISOString(), checks,
      error: 'A live QA prerequisite failed; inspect the failing audit step in console output.',
    });
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

if (require.main === module) {
  runAudit().then(({ filename }) => {
    process.stdout.write(`Live QA audit passed. Sanitized results: ${filename}\n`);
  }).catch((error) => {
    process.stderr.write(`Live QA audit failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  auditRepository,
  auditTenantReadiness,
  noElevatedClaims,
  normalizeRepository,
  requestJson,
  runAudit,
  validateIdentity,
  writeAudit,
};
