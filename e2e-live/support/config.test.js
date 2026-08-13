'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  loadLiveConfig,
  parseBootstrapApiAssignment,
  parseFixtures,
  resolveBootstrapApiBase,
} = require('./config');

const UUIDS = Object.freeze({
  orgA: '11111111-1111-4111-8111-111111111111',
  projectA: '22222222-2222-4222-8222-222222222222',
  orgB: '33333333-3333-4333-8333-333333333333',
  projectB: '44444444-4444-4444-8444-444444444444',
});

function fixture(overrides = {}) {
  return {
    nonProduction: true,
    disposable: true,
    tenantA: {
      organizationId: UUIDS.orgA,
      projectId: UUIDS.projectA,
      linearProjectId: 'linear-qa-a',
      canary: 'E2E_TENANT_A_CANARY',
    },
    tenantB: {
      organizationId: UUIDS.orgB,
      projectId: UUIDS.projectB,
      canary: 'E2E_TENANT_B_CANARY',
      conversationId: 'conv_qa_b',
      terminalRunId: 'run_qa_b',
    },
    pipelineTask: {
      title: 'Update QA canary',
      description: 'Change only the disposable synthetic QA deployment canary.',
      priority: 2,
    },
    ...overrides,
  };
}

function storageState(directory, name) {
  const filename = path.join(directory, name);
  fs.writeFileSync(filename, JSON.stringify({
    cookies: [],
    origins: [{ origin: 'https://qa.example.test', localStorage: [{ name: 'firebase', value: 'session' }] }],
  }), { mode: 0o600 });
  fs.chmodSync(filename, 0o600);
  return filename;
}

function environment(directory, additions = {}) {
  return {
    E2E_QA_BASE_URL: 'https://qa.example.test',
    E2E_QA_SETTINGS_URL: 'https://qa-settings.example.test',
    E2E_QA_REPOSITORY: 'owner/disposable-qa',
    E2E_QA_DEPLOY_ENV: 'qa',
    E2E_QA_DEPLOY_HEALTH_URL: 'https://qa-app.example.test/healthz',
    E2E_QA_FIXTURES_JSON: JSON.stringify(fixture()),
    E2E_QA_TENANT_A_STATE_PATH: storageState(directory, 'a.json'),
    E2E_QA_TENANT_B_STATE_PATH: storageState(directory, 'b.json'),
    ...additions,
  };
}

test('loadLiveConfig returns the canonical typed shape for read-only checks', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = loadLiveConfig({ requireAuth: true }, environment(directory));
  assert.deepEqual(Object.keys(config), [
    'baseUrl', 'settingsUrl', 'repository', 'deployEnvironment', 'deployHealthUrl',
    'fixtures', 'authStateAPath', 'authStateBPath', 'evidenceDir',
  ]);
  assert.equal(config.baseUrl, 'https://qa.example.test');
  assert.equal(config.fixtures.tenantB.settingsProjectId, undefined);
  assert.equal(config.authStateAPath, path.join(directory, 'a.json'));
});

test('the deploy gate requires exact opt-in and explicitly disposable fixtures', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-deploy-gate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = environment(directory);
  assert.throws(() => loadLiveConfig({ requireDeploy: true }, env), /E2E_ALLOW_FULL_DEPLOY=true/);
  assert.throws(() => loadLiveConfig({ requireDeploy: true }, {
    ...env,
    E2E_ALLOW_FULL_DEPLOY: 'TRUE',
  }), /E2E_ALLOW_FULL_DEPLOY=true/);
  const enabled = loadLiveConfig({ requireDeploy: true }, { ...env, E2E_ALLOW_FULL_DEPLOY: 'true' });
  assert.equal(enabled.fixtures.disposable, true);
  assert.throws(() => parseFixtures(JSON.stringify(fixture({ disposable: false })), { requireDeploy: true }),
    /disposable:true/);
});

test('fixture parsing rejects non-UUID tenant IDs and shared canaries', () => {
  assert.throws(() => parseFixtures(JSON.stringify(fixture({
    tenantA: { ...fixture().tenantA, organizationId: 'qa-org-a' },
  }))), /canonical UUID/);
  assert.throws(() => parseFixtures(JSON.stringify(fixture({
    tenantB: { ...fixture().tenantB, canary: 'E2E_TENANT_A_CANARY' },
  }))), /distinct canaries/);
  assert.throws(() => parseFixtures(JSON.stringify(fixture({
    tenantB: { ...fixture().tenantB, conversationId: '' },
  }))), /conversationId is required/);
  assert.throws(() => parseFixtures(JSON.stringify(fixture({ disposable: false }))),
    /disposable:true/);
});

test('production-looking deployment inputs fail before browser or network work', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-prod-gate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => loadLiveConfig({}, environment(directory, {
    E2E_QA_BASE_URL: 'https://app.production.example.com',
  })), /production-looking/);
  assert.throws(() => loadLiveConfig({}, environment(directory, {
    E2E_QA_DEPLOY_ENV: 'prod',
  })), /allow-listed non-production/);
  assert.throws(() => loadLiveConfig({}, environment(directory, {
    E2E_QA_BASE_URL: 'https://app.example.com',
  })), /explicit non-production/);
});

test('bootstrap config parser accepts only one literal assignment without eval', async () => {
  assert.equal(parseBootstrapApiAssignment(
    "// Example: window.__API_BASE__='https://example.invalid';\nwindow.__API_BASE__='';\n(() => {})();",
  ), '');
  assert.equal(parseBootstrapApiAssignment('window.__API_BASE__ = "https://qa-api.example.test";'),
    'https://qa-api.example.test');
  assert.throws(() => parseBootstrapApiAssignment('window.__API_BASE__ = getApi();'), /unsafe/);
  assert.throws(() => parseBootstrapApiAssignment(
    "window.__API_BASE__='https://a.example.test';\nwindow.__API_BASE__='https://b.example.test';",
  ), /exactly one/);

  const sameOrigin = await resolveBootstrapApiBase({ baseUrl: 'https://qa.example.test' }, async () => ({
    ok: true,
    status: 200,
    text: async () => "window.__API_BASE__='';",
  }));
  assert.equal(sameOrigin, 'https://qa.example.test');
  await assert.rejects(resolveBootstrapApiBase({ baseUrl: 'https://qa.example.test' }, async () => ({
    ok: true,
    status: 200,
    text: async () => "window.__API_BASE__='https://prod.example.test';",
  })), /production-looking/);
});
