'use strict';

// Bind this test process to a throwaway, unpinned shared file store before the
// config/store modules are loaded.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-store-'));
process.env.STORE_BACKEND = 'file';
process.env.AI_FLEET_DATA_DIR = DATA_DIR;
delete process.env.STORE_NAMESPACE;
delete process.env.FLEET_ORG_ID;
delete process.env.AIFLEET_ORG_ID;
delete process.env.PROXY_ORG_ID;

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('./store');
const {
  runWithWorkspaceContext,
  workspaceOrganizationKey,
} = require('./store/workspace-context');

async function inWorkspace(context, fn) {
  return runWithWorkspaceContext(context, async () => {
    await store.initStore();
    return fn();
  });
}

test('unscoped calls retain the historical legacy store', async () => {
  await store.initStore();
  store.patchSettings({ repositoryUrl: 'legacy-repository' });
  assert.equal(store.getSettings().repositoryUrl, 'legacy-repository');
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'store.json')), true);

  await inWorkspace({ organizationId: 'org:alpha' }, () => {
    assert.notEqual(store.getSettings().repositoryUrl, 'legacy-repository');
  });

  assert.equal(store.getSettings().repositoryUrl, 'legacy-repository');
});

test('concurrent organizations use independent physical stores and mirrors', async () => {
  await Promise.all([
    inWorkspace({ organizationId: 'org:alpha', projectId: 'project:a' }, async () => {
      store.patchSettings({ repositoryUrl: 'alpha-repository' });
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(store.getSettings().repositoryUrl, 'alpha-repository');
    }),
    inWorkspace({ organizationId: 'org:beta', projectId: 'project:b' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      store.patchSettings({ repositoryUrl: 'beta-repository' });
      await new Promise((resolve) => setTimeout(resolve, 2));
      assert.equal(store.getSettings().repositoryUrl, 'beta-repository');
    }),
  ]);

  assert.equal(
    await inWorkspace({ organizationId: 'org:alpha' }, () => store.getSettings().repositoryUrl),
    'alpha-repository',
  );
  assert.equal(
    await inWorkspace({ organizationId: 'org:beta' }, () => store.getSettings().repositoryUrl),
    'beta-repository',
  );

  const files = fs.readdirSync(path.join(DATA_DIR, 'workspaces')).sort();
  assert.deepEqual(files, [
    `${workspaceOrganizationKey('org:alpha')}.json`,
    `${workspaceOrganizationKey('org:beta')}.json`,
  ].sort());
  assert.equal(files.some((name) => name.includes('alpha') || name.includes('beta')), false);
});

test('native projects inside one organization share its operational store', async () => {
  await inWorkspace({ organizationId: 'org:project-shared', projectId: 'project:one' }, () => {
    store.setAgentConfig({ maxProjectsPerRun: 2 });
  });
  const value = await inWorkspace(
    { organizationId: 'org:project-shared', projectId: 'project:two' },
    () => store.getAgentConfig().maxProjectsPerRun,
  );
  assert.equal(value, 2);
});

test('explicit billing and EULA APIs always use the global legacy backend', async () => {
  await store.initStore();
  store.upsertBillingAccount('org:billing-b', { balancePaise: 12345 });
  store.recordEulaOrgDecision('org:eula-b', { status: 'accepted', version: '1.0.0' });

  await inWorkspace({ organizationId: 'org:alpha' }, () => {
    assert.equal(store.getBillingAccount('org:billing-b').balancePaise, 12345);
    assert.equal(store.getEulaOrg('org:eula-b').status, 'accepted');
    store.addUsageRecord({ orgId: 'org:billing-b', inputTokens: 1 });
    store.recordEulaDecision('user:global', { status: 'accepted', version: '1.0.0' });
  });

  assert.equal(store.listUsageRecords({ orgId: 'org:billing-b' }).length, 1);
  assert.equal(store.getEulaUser('user:global').status, 'accepted');
});

test('an org-pinned shared job still uses its hashed org backend', async () => {
  const previous = process.env.FLEET_ORG_ID;
  process.env.FLEET_ORG_ID = 'org:ephemeral-job';
  try {
    await inWorkspace({ organizationId: 'org:ephemeral-job' }, () => {
      store.patchSettings({ repositoryUrl: 'ephemeral-job-repository' });
    });
    assert.equal(
      fs.existsSync(path.join(
        DATA_DIR,
        'workspaces',
        `${workspaceOrganizationKey('org:ephemeral-job')}.json`,
      )),
      true,
    );
    assert.throws(
      () => runWithWorkspaceContext({ organizationId: 'org:other-job' }, () => store.getSettings()),
      (error) => error.code === 'workspace_organization_mismatch',
    );
  } finally {
    if (previous === undefined) delete process.env.FLEET_ORG_ID;
    else process.env.FLEET_ORG_ID = previous;
  }
});

test('a pinned namespace retains the legacy location and rejects another org', () => {
  const { spawnSync } = require('node:child_process');
  const pinnedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-pinned-'));
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const store = require('./store');
    const { runWithWorkspaceContext } = require('./store/workspace-context');
    (async () => {
      await runWithWorkspaceContext({ organizationId: 'org:pinned' }, async () => {
        await store.initStore();
        store.patchSettings({ repositoryUrl: 'pinned-repository' });
      });
      let mismatch = '';
      try {
        runWithWorkspaceContext({ organizationId: 'org:other' }, () => store.getSettings());
      } catch (error) {
        mismatch = error.code;
      }
      process.stdout.write(JSON.stringify({
        mismatch,
        legacyExists: fs.existsSync(path.join(process.env.AI_FLEET_DATA_DIR, 'store.json')),
        workspaceDirExists: fs.existsSync(path.join(process.env.AI_FLEET_DATA_DIR, 'workspaces')),
      }));
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env: {
      ...process.env,
      STORE_BACKEND: 'file',
      AI_FLEET_DATA_DIR: pinnedDir,
      STORE_NAMESPACE: 'tenant123',
      FLEET_ORG_ID: 'org:pinned',
      AIFLEET_ORG_ID: '',
      PROXY_ORG_ID: '',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    mismatch: 'workspace_organization_mismatch',
    legacyExists: true,
    workspaceDirExists: false,
  });
});

test('concurrent Firestore context initialization is deduplicated per backend', () => {
  const { spawnSync } = require('node:child_process');
  const script = `
    const firestore = require('./store/firestore-backend');
    const initCounts = Object.create(null);
    firestore.create = ({ rootCollection, seed }) => {
      let mirror = seed();
      return {
        read: () => mirror,
        write: (next) => { mirror = next; return next; },
        init: async () => {
          initCounts[rootCollection] = (initCounts[rootCollection] || 0) + 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
      };
    };
    const store = require('./store');
    const { runWithWorkspaceContext } = require('./store/workspace-context');
    (async () => {
      await Promise.all([
        runWithWorkspaceContext({ organizationId: 'org:a' }, () => Promise.all([store.initStore(), store.initStore()])),
        runWithWorkspaceContext({ organizationId: 'org:b' }, () => Promise.all([store.initStore(), store.initStore()])),
      ]);
      process.stdout.write(JSON.stringify(initCounts));
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env: {
      ...process.env,
      STORE_BACKEND: 'firestore',
      STORE_NAMESPACE: '',
      FLEET_ORG_ID: '',
      AIFLEET_ORG_ID: '',
      PROXY_ORG_ID: '',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const counts = JSON.parse(result.stdout);
  assert.equal(counts.aifleet, 1);
  assert.equal(Object.keys(counts).length, 3);
  assert.equal(Object.values(counts).every((count) => count === 1), true);
  assert.equal(Object.keys(counts).some((key) => key.includes('org:a') || key.includes('org:b')), false);
});
