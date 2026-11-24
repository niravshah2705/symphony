'use strict';

const { test, expect } = require('@playwright/test');

// The same template the gateway hands the browser: a spec that seeds a gate
// node should be proving the shipping cards, not a stand-in of my own writing.
const { DEFAULT_GATE_TEMPLATE } = require('../packages/shared-core/src/workflow-defaults.js');

const USER_ID = 'firebase|workflow-operator';
const PRIMARY_ORG = Object.freeze({
  id: 'org-acme',
  name: 'Acme Platform',
  role: 'ORG_ADMIN',
  projects: [],
});
const SECONDARY_ORG = Object.freeze({
  id: 'org-beta-labs',
  name: 'Beta Labs',
  role: 'ORG_ADMIN',
  projects: [],
});
const STORAGE_PREFIX = 'ai-fleet.workflow-designer.v1:';

const FIREBASE_AUTH_STUB = `
  const user = {
    uid: '${USER_ID}',
    displayName: 'Workflow Operator',
    email: 'workflow@example.com',
    photoURL: '',
    getIdToken: async () => 'browser-access-token',
  };
  export const browserLocalPersistence = {};
  export const browserPopupRedirectResolver = {};
  export function initializeAuth(_app, options) {
    if (options.persistence !== browserLocalPersistence || 'popupRedirectResolver' in options) {
      throw new Error('unexpected eager auth initialization');
    }
    return { currentUser: user };
  }
  export function onAuthStateChanged(_auth, callback) {
    Promise.resolve().then(() => callback(user));
    return () => {};
  }
  export class GoogleAuthProvider { static credential() { return {}; } setCustomParameters() {} }
  export class OAuthProvider { credential() { return {}; } setCustomParameters() {} }
  export async function signInWithCredential() { return { user }; }
  export async function signInWithPopup() { return { user }; }
  export async function signOut() {}
`;

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function workflowStorageKey(organizationId) {
  return `${STORAGE_PREFIX}${organizationId}`;
}

/**
 * The designer's server side, in the test process. Graphs are keyed by the
 * organization header the browser stamps on every request, and PUT is
 * revision-checked exactly like the gateway's /api/workflows routes.
 */
function createWorkflowStore(defaults, initial = {}) {
  const byOrg = new Map(Object.entries(initial).map(([id, graphs]) => [id, graphs.map((g) => ({ ...g }))]));
  const revisions = new Map();
  const revisionFor = (orgId, graph) => {
    const key = `${orgId}:${graph.id}`;
    if (!revisions.has(key)) revisions.set(key, 1);
    return revisions.get(key);
  };
  // The gateway seeds platform defaults into a tenant on read; do the same, so
  // these specs exercise the shared-collection path rather than the fallback.
  const graphsFor = (orgId) => {
    if (!byOrg.has(orgId)) byOrg.set(orgId, defaults.map((graph) => ({ ...graph })));
    return byOrg.get(orgId);
  };
  const list = (orgId) => graphsFor(orgId).map((graph) => ({ ...graph, revision: revisionFor(orgId, graph) }));

  return {
    list,
    graphs: graphsFor,
    read(orgId) {
      // The same shape the gateway returns: no active-workflow id, so the
      // browser's draft decides which graph the canvas opens on.
      return {
        workflows: list(orgId),
        agents: [],
        persona: 'builder',
        displayName: 'Workflow Operator',
        grants: null,
        personas: ['builder'],
        gateTemplate: DEFAULT_GATE_TEMPLATE,
        canAdminDefaults: false,
      };
    },
    create(orgId, graph) {
      const graphs = graphsFor(orgId);
      const clash = graphs.find((item) => item.id === graph.id);
      if (clash) return { conflict: { ...clash, revision: revisionFor(orgId, clash) } };
      byOrg.set(orgId, [...graphs, { ...graph }]);
      revisions.set(`${orgId}:${graph.id}`, 1);
      return { ok: true, workflow: { ...graph, revision: 1 } };
    },
    update(orgId, graph, ifMatch) {
      const graphs = graphsFor(orgId);
      const index = graphs.findIndex((item) => item.id === graph.id);
      if (index < 0) return { missing: true };
      const current = revisionFor(orgId, graphs[index]);
      if (ifMatch != null && ifMatch !== '' && Number(ifMatch) !== current) {
        return { conflict: { ...graphs[index], revision: current } };
      }
      const next = current + 1;
      revisions.set(`${orgId}:${graph.id}`, next);
      byOrg.set(orgId, graphs.map((item, i) => (i === index ? { ...graph } : item)));
      return { ok: true, workflow: { ...graph, revision: next } };
    },
    remove(orgId, id) {
      const graphs = graphsFor(orgId);
      const index = graphs.findIndex((item) => item.id === id);
      if (index < 0) return { missing: true };
      byOrg.set(orgId, graphs.filter((item) => item.id !== id));
      return { ok: true };
    },
    import(orgId, workflows) {
      if (graphsFor(orgId).length) return { imported: 0, skipped: true, workflows: list(orgId) };
      byOrg.set(orgId, workflows.map((graph) => ({ ...graph })));
      for (const graph of workflows) revisions.set(`${orgId}:${graph.id}`, 1);
      return { imported: workflows.length, skipped: false, workflows: list(orgId) };
    },
  };
}

async function installDesignerStubs(page, {
  organizations = [PRIMARY_ORG],
  permissions = { org: 'read' },
  workflows = {},
  // The designer reads the cluster the way the gateway does: a disabled kagent
  // is a normal deployment, so that is the default a spec opts out of.
  kagent = { enabled: false, reason: 'kagent_not_configured' },
  publish = null,
  // The platform-wide component catalog and the LLM preset list. The designer
  // has no fallback vocabulary of its own any more, so a spec that looks at
  // Harness / Model family / Model needs these to answer.
  catalog = {},
  presets = null,
} = {}) {
  const apiMutations = [];
  const workflowApiRequests = [];
  // Full URLs of the workflow GETs: the query string is what a migrating
  // browser sends, and `pathname` alone cannot show it.
  const workflowReadUrls = [];
  const publishes = [];
  const capabilitiesReads = [];
  // The gateway seeds platform defaults into a tenant the first time it is
  // read, so the stub starts from the same example graphs the model ships.
  const { createInitialState } = await import('../public/js/workflow-designer-model.mjs');
  const store = createWorkflowStore(createInitialState().workflows, workflows);

  await page.addInitScript(() => {
    localStorage.setItem('ai-fleet.locale', 'en');
  });
  await page.route('**/vendor/firebase/firebase-app.js', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: 'export function initializeApp() { return {}; }',
  }));
  await page.route('**/vendor/firebase/firebase-auth.js', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: FIREBASE_AUTH_STUB,
  }));
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET') apiMutations.push(`${request.method()} ${pathname}`);
    if (/workflow/i.test(pathname)) workflowApiRequests.push(`${request.method()} ${pathname}`);
    if (/workflow/i.test(pathname) && request.method() === 'GET') workflowReadUrls.push(request.url());

    const organizationHeader = request.headers()['x-ai-fleet-organization-id'] || organizations[0]?.id || '';
    const postedGraph = () => {
      try {
        return JSON.parse(request.postData() || '{}');
      } catch (_) {
        return {};
      }
    };
    if (pathname === '/api/workflows' && request.method() === 'GET') {
      return json(route, store.read(organizationHeader));
    }
    if (pathname === '/api/workflows' && request.method() === 'POST') {
      const created = store.create(organizationHeader, postedGraph());
      if (created.conflict) {
        return json(route, { error: 'Workflow id already exists.', code: 'already_exists', workflow: created.conflict }, 409);
      }
      return json(route, created.workflow, 201);
    }
    if (pathname === '/api/workflows/import') {
      return json(route, store.import(organizationHeader, postedGraph().workflows || []));
    }
    if (pathname === '/api/workflows/kagent/capabilities') {
      capabilitiesReads.push(organizationHeader);
      return json(route, {
        namespace: 'kagent',
        harnesses: [],
        modelConfigs: [],
        remoteMcpServers: [],
        agentTemplates: [],
        ...kagent,
      });
    }
    // The gateway serves these straight from the shipped files
    // (go/harness/runtime-images.csv, agent/registry/model-families.json,
    // agent/llm-presets.json), so the stub mirrors one family per shape the
    // designer has to handle: a claimed provider, an unclaimed family, and a
    // disabled row that must not be offered for a new selection.
    if (pathname === '/api/workflows/catalog') {
      return json(route, {
        harnesses: [{ runtime: 'claude-code', image: 'ghcr.io/x/claude-code', version: '1.2.3' }],
        modelFamilies: [
          { id: 'anthropic', label: 'Anthropic Claude', icon: 'anthropic', providers: ['claude'], order: 10, enabled: true },
          { id: 'byok', label: 'Bring your own model', icon: 'byom', providers: ['ollama'], order: 20, enabled: true },
          { id: 'bedrock', label: 'AWS Bedrock', icon: 'graph', providers: [], order: 30, enabled: true },
          { id: 'vertexai', label: 'Google Vertex AI', icon: 'chart', providers: [], order: 40, enabled: false },
        ],
        modelFamilyProblems: [],
        plugins: [],
        skills: [],
        ...catalog,
      });
    }
    if (pathname === '/api/settings/llm-presets') {
      return json(route, {
        presets: presets === null ? [
          { id: 'claude-opus-4-8', provider: 'claude', model: 'claude-opus-4-8', label: 'Claude Opus' },
          { id: 'ollama-gpt-oss-20b', provider: 'ollama', model: 'gpt-oss:20b', label: 'GPT-OSS 20B' },
        ] : presets,
      });
    }
    const nodePublish = pathname.match(/^\/api\/workflows\/([^/]+)\/nodes\/([^/]+)\/publish$/);
    if (nodePublish) {
      const [, graphId, nodeId] = nodePublish.map(decodeURIComponent);
      // Read the saved graph, the way the gateway renders it: whatever the node
      // looks like here is what the designer managed to persist before asking.
      const graph = store.graphs(organizationHeader).find((item) => item.id === graphId);
      const node = (graph?.nodes || []).find((item) => item.id === nodeId) || {};
      publishes.push({ graphId, nodeId, backend: node.backend || '', env: node.kagentSpec?.env || [] });
      if (publish) return json(route, publish.body, publish.status || 200);
      return json(route, {
        ok: true,
        created: true,
        name: `${graphId}-${nodeId}`,
        namespace: 'kagent',
        backend: 'kagent',
        workflowId: graphId,
        nodeId,
      });
    }
    if (pathname.startsWith('/api/workflows/') && request.method() === 'PUT') {
      const id = decodeURIComponent(pathname.slice('/api/workflows/'.length));
      const saved = store.update(organizationHeader, { ...postedGraph(), id }, request.headers()['if-match']);
      if (saved.conflict) {
        return json(route, { error: 'revision_conflict', code: 'revision_conflict', workflow: saved.conflict }, 409);
      }
      if (saved.missing) return json(route, { error: 'Workflow was not found.' }, 404);
      return json(route, saved.workflow);
    }
    if (pathname.startsWith('/api/workflows/') && request.method() === 'DELETE') {
      const id = decodeURIComponent(pathname.slice('/api/workflows/'.length));
      const gone = store.remove(organizationHeader, id);
      return gone.missing
        ? json(route, { error: 'Workflow was not found.' }, 404)
        : json(route, { ok: true, id });
    }

    if (pathname === '/api/auth/config') {
      return json(route, {
        mode: 'firebase',
        enabled: true,
        provider: 'firebase',
        firebase: {
          apiKey: 'AIzaTESTKEY',
          authDomain: 'demo-proj.firebaseapp.com',
          projectId: 'demo-proj',
        },
      });
    }
    if (pathname === '/api/auth/me') {
      return json(route, {
        authenticated: true,
        role: 'viewer',
        permissions,
        user: {
          sub: USER_ID,
          name: 'Workflow Operator',
          email: 'workflow@example.com',
        },
      });
    }
    if (pathname === '/api/org/me/context') {
      return json(route, {
        user: {
          id: USER_ID,
          email: 'workflow@example.com',
          full_name: 'Workflow Operator',
        },
        organizations,
      });
    }
    if (pathname === '/api/config') {
      return json(route, {
        authenticated: true,
        status: 'shared',
        gatewayUrl: '',
        orgName: organizations[0]?.name || null,
      });
    }
    if (pathname === '/api/locale/suggestions') {
      return json(route, { locale: 'en', recommendedLocale: 'en' });
    }
    if (pathname === '/api/agent/workspace-stream-token') {
      return json(route, { token: 'workflow-stream-token' });
    }
    if (pathname === '/api/agent/workspace-stream') {
      return route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
        },
        body: ': ready\n\n',
      });
    }
    return json(route, {});
  });

  return { apiMutations, workflowApiRequests, workflowReadUrls, store, publishes, capabilitiesReads };
}

async function openDesigner(page, path = '/#/workflows') {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.workflow-page')).toBeVisible();
}

function profileField(form, name) {
  return form.locator('.workflow-field', { hasText: new RegExp(`^${name}`) })
    .locator('input, textarea, select')
    .first();
}

async function selectCanvasNode(page, name) {
  const node = page.locator('.workflow-node').filter({ hasText: name });
  await expect(node).toHaveCount(1);
  await node.focus();
  await node.press('Enter');
  await expect(page.locator('.workflow-inspector .workflow-panel-header')).toContainText(name);
  await expect(node).toBeFocused();
  return node;
}

/**
 * Autosave keeps a draft on this device only; the organization's copy changes
 * when Save is pressed. A test that reads the recorded server state presses it.
 */
async function pressSave(page) {
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
}

/**
 * The designer reads the organization's graphs on open. It must not write
 * anything the operator did not ask for: no import of the built-in examples,
 * no re-create of a graph the server already has. Reads are allowed to include
 * the cluster names behind a kagent binding — looking up a name is not a write.
 */
function expectWorkflowReadsOnly(recording) {
  expect(recording.workflowApiRequests, 'opening the designer loads the shared graphs')
    .toContain('GET /api/workflows');
  const writes = recording.workflowApiRequests.filter((line) => !line.startsWith('GET '));
  expect(writes, 'viewing workflows must never mutate the organization').toEqual([]);
  expect(recording.apiMutations, 'viewing workflows must never mutate the organization').toEqual([]);
}

test('lazy Workflows route renders the selected organization and five realistic examples', async ({ page }) => {
  const assets = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/js/views/') || pathname.startsWith('/styles/')) assets.push(pathname);
  });
  const recording = await installDesignerStubs(page);

  await openDesigner(page);

  await expect(page.locator('.workflow-page')).toHaveAttribute('data-organization-id', PRIMARY_ORG.id);
  await expect(page.locator('.workflow-page')).toHaveAttribute('data-editable', 'true');
  await expect(page.getByRole('heading', { name: 'Acme Platform workflows' })).toBeVisible();
  await expect(page.getByText('Does not execute', { exact: true })).toBeVisible();

  const workflowSelect = page.getByRole('combobox', { name: 'Active workflow' });
  await expect(workflowSelect.locator('option')).toHaveCount(5);
  expect(await workflowSelect.locator('option').allTextContents()).toEqual([
    'Environment release · example',
    'Research to decision · example',
    'Commercial launch · example',
    'Incident response · example',
    'Independent operations · example',
  ]);

  await workflowSelect.selectOption({ label: 'Independent operations · example' });
  await expect(page.locator('.workflow-node')).toHaveCount(4);
  await expect(page.locator('.workflow-node-status')).toHaveCount(4);
  await expect(page.locator('.workflow-node-status')).toHaveText([
    'Standalone', 'Standalone', 'Standalone', 'Standalone',
  ]);
  await expect(page.locator('.workflow-summary')).toContainText('4 independent lanes');
  await expect(page.getByText('4 lanes · 4 standalone', { exact: true })).toBeVisible();

  await expect.poll(() => assets.includes('/js/views/workflows.js')).toBe(true);
  await expect.poll(() => assets.includes('/styles/workflows.css')).toBe(true);
  expect(assets).not.toContain('/js/views/settings.js');
  expect(assets).not.toContain('/styles/settings.css');

  for (const width of [1081, 320]) {
    await page.setViewportSize({ width, height: 760 });
    await expect.poll(() => page.evaluate(() => ({
      documentContained: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      bodyContained: document.body.scrollWidth <= document.body.clientWidth,
      canvasScrollsInternally: (() => {
        const viewport = document.querySelector('.workflow-canvas-viewport');
        return Boolean(viewport && viewport.scrollWidth > viewport.clientWidth);
      })(),
    }))).toEqual({
      documentContained: true,
      bodyContained: true,
      canvasScrollsInternally: true,
    });
  }

  await expectWorkflowReadsOnly(recording);
});

test('organization admin creates a safe custom agent, links nodes, and shares the graph with the organization', async ({ page }) => {
  const recording = await installDesignerStubs(page, {
    organizations: [PRIMARY_ORG, SECONDARY_ORG],
  });
  await openDesigner(page);

  await page.getByRole('button', { name: 'New blank', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Active workflow' })).toContainText('Untitled workflow');
  await expect(page.locator('.workflow-node')).toHaveCount(0);

  await page.getByRole('complementary', { name: 'Workflow inspector' })
    .getByLabel('Name', { exact: true })
    .fill('Immediate persistence flow');
  await page.locator('.workflow-canvas-viewport').evaluate((viewport) => {
    viewport.scrollLeft = 360;
    viewport.scrollTop = 120;
    viewport.dispatchEvent(new Event('scroll'));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('combobox', { name: 'Active workflow' })).toContainText('Immediate persistence flow');
  await expect.poll(() => page.evaluate((key) => {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    return saved?.workflows?.find((workflow) => workflow.id === saved.activeWorkflowId)?.viewport;
  }, workflowStorageKey(PRIMARY_ORG.id))).toMatchObject({ x: 360, y: 120 });

  await page.getByRole('button', { name: 'New custom agent', exact: true }).click();
  const form = page.locator('.workflow-profile-form');
  await expect(form).toBeVisible();
  await profileField(form, 'Name').fill('Observability Steward');
  await profileField(form, 'Category').selectOption('Operations');
  await profileField(form, 'Description').fill('Summarizes service health for release owners.');
  await profileField(form, 'Purpose').fill('Detect regressions and produce a bounded health recommendation.');
  await profileField(form, 'Inputs').fill('Service objectives\nRelease markers');
  await profileField(form, 'Outputs').fill('Health summary\nEscalation recommendation');
  await profileField(form, 'Guardrails').fill('Never include customer data\nState signal confidence');
  await form.locator('details').evaluate((details) => { details.open = true; });
  await profileField(form, 'Runtime').selectOption('deep-agent');
  await profileField(form, 'Model preference').selectOption('balanced');
  await profileField(form, 'Tools').fill('metrics, logs');
  await profileField(form, 'Skills').fill('observability-analysis');
  await form.getByRole('button', { name: 'Create agent', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Add Observability Steward to workflow' })).toBeEnabled();
  await page.getByRole('button', { name: 'Add Observability Steward to workflow' }).click();
  await page.getByRole('button', { name: 'Add Support Agent to workflow' }).click();
  await expect(page.locator('.workflow-node')).toHaveCount(2);

  await selectCanvasNode(page, 'Observability Steward');
  const inspector = page.getByRole('complementary', { name: 'Workflow inspector' });
  const dependencies = inspector.locator('.workflow-inspector-section', { hasText: /^Dependencies/ });
  await dependencies.locator('select').selectOption({ label: 'Support Agent' });
  await dependencies.getByRole('button', { name: 'Add dependency', exact: true }).click();
  await expect(page.locator('.workflow-edge-group')).toHaveCount(1);
  await expect(inspector.locator('.workflow-connection-summary')).toContainText('Support Agent');
  await expect(inspector.locator('.workflow-connection-summary')).toContainText('Observability Steward');

  await selectCanvasNode(page, 'Support Agent');
  const reverseDependencies = inspector.locator('.workflow-inspector-section', { hasText: /^Dependencies/ });
  await reverseDependencies.locator('select').selectOption({ label: 'Observability Steward' });
  await reverseDependencies.getByRole('button', { name: 'Add dependency', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('That connection would create a cycle.');
  await expect(page.locator('.workflow-edge-group')).toHaveCount(1);

  const primaryKey = workflowStorageKey(PRIMARY_ORG.id);
  await expect.poll(() => page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) || 'null');
    const workflow = state?.workflows?.find((item) => item.id === state.activeWorkflowId);
    return {
      customAgents: state?.customAgents?.length ?? -1,
      nodes: workflow?.nodes?.length ?? -1,
      edges: workflow?.edges?.length ?? -1,
    };
  }, primaryKey)).toEqual({ customAgents: 1, nodes: 2, edges: 1 });

  const savedPrimaryState = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), primaryKey);
  expect(savedPrimaryState.customAgents[0]).toMatchObject({
    name: 'Observability Steward',
    runtime: 'deep-agent',
    modelPreference: 'balanced',
    tools: ['metrics', 'logs'],
    skills: ['observability-analysis'],
  });

  // The organization's copy, not just this browser's: the graph the admin drew
  // is what a teammate would load.
  await pressSave(page);
  await expect.poll(() => {
    const shared = recording.store.graphs(PRIMARY_ORG.id).find((graph) => graph.name === 'Immediate persistence flow');
    return shared ? { nodes: shared.nodes.length, edges: shared.edges.length, viewport: shared.viewport } : null;
  }).toMatchObject({ nodes: 2, edges: 1, viewport: { x: 360, y: 120 } });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('heading', { name: 'Acme Platform workflows' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Active workflow' })).toHaveValue(savedPrimaryState.activeWorkflowId);
  await expect(page.locator('.workflow-node')).toHaveCount(2);
  await expect(page.locator('.workflow-edge-group')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add Observability Steward to workflow' })).toBeVisible();

  await page.locator('.account-context-trigger').click();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.locator('#account-organization-select').selectOption(SECONDARY_ORG.id),
  ]);
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('heading', { name: 'Beta Labs workflows' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Observability Steward to workflow' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Active workflow' }).locator('option')).toHaveCount(5);

  // Switching organizations swaps server collections; nothing from Acme reaches
  // Beta Labs, and the browser keeps a separate draft cache per organization.
  const secondaryKey = workflowStorageKey(SECONDARY_ORG.id);
  expect(recording.store.graphs(SECONDARY_ORG.id).map((graph) => graph.name)).not.toContain('Immediate persistence flow');
  await page.getByRole('button', { name: 'New blank', exact: true }).click();
  await expect.poll(() => page.evaluate((key) => Boolean(localStorage.getItem(key)), secondaryKey)).toBe(true);
  await pressSave(page);
  await expect.poll(() => recording.store.graphs(SECONDARY_ORG.id).some((graph) => graph.name === 'Untitled workflow')).toBe(true);
  const isolated = await page.evaluate(([firstKey, secondKey]) => {
    const first = JSON.parse(localStorage.getItem(firstKey));
    const second = JSON.parse(localStorage.getItem(secondKey));
    return {
      firstCustomAgents: first.customAgents.length,
      secondCustomAgents: second.customAgents.length,
      firstActiveName: first.workflows.find((item) => item.id === first.activeWorkflowId)?.name,
      secondActiveName: second.workflows.find((item) => item.id === second.activeWorkflowId)?.name,
    };
  }, [primaryKey, secondaryKey]);
  expect(isolated).toEqual({
    firstCustomAgents: 1,
    secondCustomAgents: 0,
    firstActiveName: 'Immediate persistence flow',
    secondActiveName: 'Untitled workflow',
  });

  expect(recording.workflowApiRequests, 'edits are per-graph writes, never a whole-collection import')
    .not.toContain('POST /api/workflows/import');
});

test('an agent node binds to a runtime and its harness environment survives the round trip', async ({ page }) => {
  const recording = await installDesignerStubs(page);
  await openDesigner(page);

  const selectExample = async () => page.getByRole('combobox', { name: 'Active workflow' })
    .selectOption({ label: 'Independent operations · example' });
  await selectExample();
  await selectCanvasNode(page, 'DevOps readiness');

  const inspector = page.getByRole('complementary', { name: 'Workflow inspector' });
  const runtime = inspector.locator('.workflow-inspector-section', { hasText: /^Runtime binding/ });
  const labelled = (label) => runtime.locator('.workflow-field', { hasText: new RegExp(`^${label}`) }).locator('select');

  // No env editor until the backend can use one: a substrate node has no Harness
  // to render these into, and offering rows that never reach a CR is a promise
  // the publish path would break.
  await expect(inspector.locator('.workflow-inspector-section', { hasText: /^Harness environment/ })).toHaveCount(0);
  await inspector.getByRole('button', { name: 'Kagent (in-cluster CRDs)' }).click();
  await expect(inspector.locator('.workflow-inspector-section', { hasText: /^Harness environment/ })).toBeVisible();

  await labelled('Harness').selectOption('claude-code');
  await labelled('Task tier').selectOption('complex');

  // Model family and Model are served vocabulary (registry/model-families.json +
  // agent/llm-presets.json): the labels, their order, a family marked
  // `enabled: false` staying off the list, and which presets a family claims all
  // come from the catalog — nothing here falls back to a browser-side list.
  const fieldSelect = (label) => runtime.locator('.workflow-field')
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator('select');
  await expect(fieldSelect('Model family').locator('option')).toHaveText([
    'Inherit from the profile', 'Anthropic Claude', 'Bring your own model', 'AWS Bedrock',
  ]);
  await expect(fieldSelect('Model').locator('option')).toHaveText(['Inherit from the profile'],
    'no family is chosen, so no preset belongs to any family yet');
  await fieldSelect('Model family').selectOption('anthropic');
  await expect(fieldSelect('Model').locator('option')).toHaveText([
    'Inherit from the profile', 'Claude Opus · claude-opus-4-8',
  ]);
  await fieldSelect('Model').selectOption('claude-opus-4-8');

  const environment = inspector.locator('.workflow-inspector-section', { hasText: /^Harness environment/ });
  const envRows = environment.locator('.workflow-env-row');
  const scratch = environment.locator('.workflow-env-row--new');
  const dropped = environment.locator('.workflow-env-dropped');
  await expect(envRows).toHaveCount(1, 'the scratch row is the only one, and it is never rebuilt under the caret');

  await scratch.locator('input').nth(0).fill('LOG_LEVEL');
  await scratch.locator('input').nth(1).fill('debug');
  await scratch.locator('input').nth(1).press('Enter');
  await expect(envRows).toHaveCount(2);
  await expect(dropped).toBeEmpty();
  await expect(envRows.first().locator('input').nth(0)).toHaveValue('LOG_LEVEL');
  await expect(scratch.locator('input').nth(0)).toHaveValue('', 'a saved row clears the scratch row');

  // The credential-shaped row is refused rather than saved, and the text stays
  // where it was typed so it can be corrected: clearing it would eat the attempt
  // and an empty message would read as a successful add.
  await scratch.locator('input').nth(0).fill('OPENAI_API_KEY');
  await scratch.locator('input').nth(1).fill('sk-abcdefghijklmnopqrstuvwxyz123456');
  await scratch.locator('input').nth(1).press('Enter');
  await expect(dropped).toContainText('was not saved');
  await expect(scratch.locator('input').nth(0)).toHaveValue('OPENAI_API_KEY');
  await expect(envRows.first().locator('input').nth(0)).toHaveValue('LOG_LEVEL');

  const boundNode = () => (recording.store.graphs(PRIMARY_ORG.id)
    .flatMap((graph) => graph.nodes || []).find((node) => node.id === 'io-devops') || {});
  await pressSave(page);
  await expect.poll(boundNode).toHaveProperty('backend', 'kagent');
  await expect.poll(() => boundNode().taskTier).toBe('complex');
  await expect.poll(() => boundNode().kagentSpec?.env).toEqual([{ name: 'LOG_LEVEL', value: 'debug' }]);
  await expect.poll(() => [boundNode().modelFamily, boundNode().model]).toEqual(['anthropic', 'claude-opus-4-8'],
    'a served family id and a preset model id are what the graph persists');

  // A new document, not a hash change, and with the local draft cache dropped:
  // what the tab shows afterwards can only have come from the server copy.
  await page.evaluate(() => window.localStorage.clear());
  await openDesigner(page, '/?reopen-designer#/workflows');
  await selectExample();
  await selectCanvasNode(page, 'DevOps readiness');
  await expect(inspector.getByRole('button', { name: 'Kagent (in-cluster CRDs)' })).toHaveAttribute('aria-pressed', 'true');
  await expect(labelled('Harness')).toHaveValue('claude-code');
  await expect(fieldSelect('Model family')).toHaveValue('anthropic');
  await expect(fieldSelect('Model')).toHaveValue('claude-opus-4-8');
  await expect(inspector.locator('.workflow-env-row').first().locator('input').nth(0)).toHaveValue('LOG_LEVEL');
  await expect(inspector.locator('.workflow-env-row').first().locator('input').nth(1)).toHaveValue('debug');

  // The card says which runtime a publish would target, because the four
  // standalone lanes look otherwise identical.
  await expect(page.locator('.workflow-node').filter({ hasText: 'DevOps readiness' })).toContainText('kagent · claude-code · complex');
  // and it spells the family the way the registry labels it, not the bare id.
  await expect(page.locator('.workflow-node').filter({ hasText: 'DevOps readiness' })).toContainText('Anthropic Claude');
});

test('a model catalog that cannot be read says so and retries on demand', async ({ page }) => {
  const recording = await installDesignerStubs(page);
  // Registered after the stubs, so this handler wins for the catalog URL: the
  // one read the family/model fields depend on fails, then recovers.
  let catalogDown = true;
  const families = [
    { id: 'anthropic', label: 'Anthropic Claude', icon: 'anthropic', providers: ['claude'], order: 10, enabled: true },
    { id: 'byok', label: 'Bring your own model', icon: 'byom', providers: ['ollama'], order: 20, enabled: true },
  ];
  await page.route('**/api/workflows/catalog', (route) => route.fulfill(catalogDown ? {
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'catalog unavailable' }),
  } : {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ harnesses: [], modelFamilies: families, modelFamilyProblems: [], plugins: [], skills: [] }),
  }));
  await openDesigner(page);
  await page.getByRole('combobox', { name: 'Active workflow' })
    .selectOption({ label: 'Independent operations · example' });
  await selectCanvasNode(page, 'DevOps readiness');

  const runtime = page.getByRole('complementary', { name: 'Workflow inspector' })
    .locator('.workflow-inspector-section', { hasText: /^Runtime binding/ });
  const fieldSelect = (label) => runtime.locator('.workflow-field')
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator('select');
  await expect(fieldSelect('Model family').locator('option')).toHaveText(['Inherit from the profile'],
    'a refused catalog read invents no vocabulary');
  await expect(runtime.getByText('The model catalog could not be read')).toBeVisible();

  catalogDown = false;
  await runtime.getByRole('button', { name: 'Read the catalog again' }).click();
  await expect(fieldSelect('Model family').locator('option')).toHaveText([
    'Inherit from the profile', 'Anthropic Claude', 'Bring your own model',
  ]);
  await expect(runtime.getByText('The model catalog could not be read')).toHaveCount(0);
  expect(recording.apiMutations, 'recovering from a refused read writes nothing').toEqual([]);
});

test('organization members read the shared workflows and cannot change them for anyone', async ({ page }) => {
  const memberOrg = { ...PRIMARY_ORG, role: 'MEMBER' };
  const recording = await installDesignerStubs(page, { organizations: [memberOrg] });

  await openDesigner(page);

  await expect(page.locator('.workflow-page')).toHaveAttribute('data-editable', 'false');
  await expect(page.getByRole('note')).toContainText('Read-only organization view');
  await expect(page.getByRole('button', { name: 'New blank', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Duplicate', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reset examples', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New custom agent', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New context', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add Requirements Agent to workflow' })).toBeDisabled();

  await selectCanvasNode(page, 'Change intake');
  const inspector = page.getByRole('complementary', { name: 'Workflow inspector' });
  await expect(inspector.locator('.workflow-field input').first()).toBeDisabled();
  await expect(inspector.getByRole('button', { name: 'Add dependency', exact: true })).toBeDisabled();
  await expect(inspector.getByRole('button', { name: 'Delete node', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await page.getByRole('combobox', { name: 'Active workflow' }).selectOption({ label: 'Independent operations · example' });
  await page.waitForTimeout(400);
  // Looking is not editing: a member's session sends no write at all, so nobody
  // else's workflow moves because this tab was open.
  await expectWorkflowReadsOnly(recording);
});

test('a teammate saving first surfaces a conflict instead of being overwritten', async ({ page }) => {
  const recording = await installDesignerStubs(page);
  await openDesigner(page);

  await page.getByRole('button', { name: 'New blank', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: 'Workflow inspector' });
  await inspector.getByLabel('Name', { exact: true }).fill('Contested flow');
  await pressSave(page);
  await expect.poll(() => recording.store.graphs(PRIMARY_ORG.id)
    .find((graph) => graph.name === 'Contested flow')).toBeTruthy();

  // A second editor wins the revision while this tab is idle.
  const contested = recording.store.graphs(PRIMARY_ORG.id).find((graph) => graph.name === 'Contested flow');
  recording.store.update(PRIMARY_ORG.id, { ...contested, name: 'Renamed by a teammate' }, 1);

  await inspector.getByLabel('Description', { exact: true }).fill('Edited from the first tab.');
  await pressSave(page);
  await expect(page.locator('.workflow-toolbar-status')).toContainText('Someone saved a newer copy');

  // Last-write-wins is the wrong answer here: the teammate's name stays on the
  // server, and this tab's edit survives as the local draft.
  await expect.poll(() => recording.store.graphs(PRIMARY_ORG.id)
    .find((graph) => graph.id === contested.id).name).toBe('Renamed by a teammate');
  await expect.poll(() => page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) || 'null');
    const workflow = state?.workflows?.find((item) => item.id === state.activeWorkflowId);
    return { name: workflow?.name, description: workflow?.description };
  }, workflowStorageKey(PRIMARY_ORG.id))).toEqual({ name: 'Contested flow', description: 'Edited from the first tab.' });
});

test('a browser holding unsaved v1 graphs migrates them into an empty tenant instead of taking the examples', async ({ page }) => {
  // The whole point of the migrate read: lazy seeding used to answer this load
  // with platform graphs, which made the tenant non-empty and the import below
  // refuse — so a designer's local work could never reach the server.
  await page.addInitScript(([storageKey]) => {
    localStorage.setItem(storageKey, JSON.stringify({
      schemaVersion: 1,
      activeWorkflowId: 'v1-mine',
      workflows: [{
        id: 'v1-mine',
        name: 'My old flow',
        description: 'Designed offline before the tenant existed.',
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [{ id: 'v1-n1', kind: 'agent', refId: 'planning', name: 'Plan', x: 120, y: 120, modelPreference: 'balanced' }],
        edges: [],
      }],
      customAgents: [],
      customContexts: [],
    }));
  }, [workflowStorageKey(PRIMARY_ORG.id)]);

  const recording = await installDesignerStubs(page, { workflows: { [PRIMARY_ORG.id]: [] } });
  await openDesigner(page);

  const workflowSelect = page.getByRole('combobox', { name: 'Active workflow' });
  await expect(workflowSelect.locator('option')).toHaveCount(1);
  await expect(workflowSelect.locator('option')).toContainText('My old flow');
  await expect(page.locator('.workflow-node')).toHaveCount(1);

  expect(recording.workflowReadUrls.join('\n')).toContain('migrate=1');
  expect(recording.workflowApiRequests).toContain('POST /api/workflows/import');
  await expect.poll(() => recording.store.graphs(PRIMARY_ORG.id).map((graph) => graph.id)).toEqual(['v1-mine']);

  // The migrated graph is the tenant now: a later reload takes the normal read
  // and must not import a second copy.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.workflow-page')).toBeVisible();
  await expect(workflowSelect.locator('option')).toHaveCount(1);
  expect(recording.workflowApiRequests.filter((line) => line === 'POST /api/workflows/import')).toHaveLength(1);
});

test('a kagent node offers the names the cluster reported, and publishing saves the graph first', async ({ page }) => {
  const publishing = await installDesignerStubs(page, {
    kagent: {
      enabled: true,
      namespace: 'kagent',
      harnesses: ['my-first-harness', 'codex'],
      modelConfigs: ['default-model-config', 'openrouter-model-config'],
      remoteMcpServers: ['kagent-tool-server'],
    },
  });
  await openDesigner(page);
  const selectExample = () => page.getByRole('combobox', { name: 'Active workflow' })
    .selectOption({ label: 'Independent operations · example' });
  await selectExample();
  await selectCanvasNode(page, 'DevOps readiness');

  const inspector = page.getByRole('complementary', { name: 'Workflow inspector' });
  const cluster = inspector.locator('.workflow-inspector-section', { hasText: /^Cluster bindings/ });
  await expect(inspector.getByRole('button', { name: 'Kagent (in-cluster CRDs)' }).first()).toBeVisible();
  await inspector.getByRole('button', { name: 'Kagent (in-cluster CRDs)' }).click();

  // The namespace answered, so its names are the choices and the platform list
  // is what is not deployed yet. The card says which is which, because a
  // published name that the cluster has never seen fails with nothing to point
  // the operator at.
  await expect(cluster).toContainText('Namespace kagent · 2 harness · 2 ModelConfig · 1 RemoteMCPServer');
  await expect(cluster.locator('.workflow-caps-reread')).toHaveCount(0, 'a cluster that answered is not offering a retry');
  const harnessField = inspector.locator('.workflow-field', { hasText: /^Harness/ });
  await expect(harnessField.locator('option').nth(1)).toHaveText('my-first-harness · in the namespace');
  await expect(harnessField.locator('option', { hasText: 'otel' }))
    .toHaveText('otel', 'a platform harness stays selectable but is not dressed up as deployed');

  const modelConfig = inspector.locator('.workflow-field', { hasText: /^ModelConfig/ }).locator('select');
  await expect(modelConfig.locator('option')).toHaveText([
    'Cluster default (from the Harness)', 'default-model-config', 'openrouter-model-config',
  ]);
  await modelConfig.selectOption('openrouter-model-config');

  const mcp = inspector.locator('.workflow-field', { hasText: /^Remote MCP servers/ });
  await expect(mcp.locator('input[type=checkbox]')).toHaveCount(1);
  await mcp.locator('input[type=checkbox]').check();

  // One read per organization, however many times the inspector is redrawn: the
  // cluster is asked once, not once per keystroke.
  await inspector.locator('.workflow-field', { hasText: /^Task tier/ }).locator('select').selectOption('complex');
  await selectCanvasNode(page, 'Support triage');
  await selectCanvasNode(page, 'DevOps readiness');
  expect(publishing.capabilitiesReads, 'the cluster is read once per organization, not once per keystroke').toEqual([PRIMARY_ORG.id]);

  // A binding the namespace never heard of saves exactly as a known one does —
  // the guardrail is the labelling, not a rejection.
  await modelConfig.selectOption('default-model-config');
  const bound = () => (publishing.store.graphs(PRIMARY_ORG.id)
    .flatMap((graph) => graph.nodes || []).find((node) => node.id === 'io-devops') || {});
  await pressSave(page);
  await expect.poll(bound).toHaveProperty('backend', 'kagent');
  await expect.poll(() => bound().kagentSpec?.modelConfig).toEqual({ name: 'default-model-config' });
  await expect.poll(() => bound().kagentSpec?.tools).toEqual([{ kind: 'mcp', server: 'kagent-tool-server', tools: [] }]);

  // Publishing renders the saved graph, so the graph has to be saved first and
  // the answer has to name the CR the cluster actually holds.
  await inspector.getByRole('button', { name: 'Publish this node to kagent' }).click();
  const result = inspector.locator('.workflow-publish-result');
  // The name is the graph-qualified one the cluster keys on, so two workflows
  // with a node called io-devops cannot both claim to have published.
  await expect(result).toContainText('Created kagent/seed-independent-operations-io-devops.');

  const published = publishing.publishes.at(-1);
  expect(published.graphId).toBe('seed-independent-operations');
  expect(published.nodeId).toBe('io-devops');
  expect(published, 'the runtime receives what the server has, not what this tab still holds').toMatchObject({
    backend: 'kagent',
    env: [],
  });

  // Switching to substrate takes the kagent surface with it: those names mean
  // nothing to an actor, and leaving them on screen would imply they were used.
  await inspector.getByRole('button', { name: 'Substrate (sandbox actors)' }).click();
  await expect(cluster).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: 'Publish this profile to substrate' })).toBeVisible();
});

test('a kagent publish answers 503 when the cluster is not configured, and says so', async ({ page }) => {
  await installDesignerStubs(page, {
    publish: { status: 503, body: { error: 'kagent_not_configured' } },
  });
  await openDesigner(page);
  await page.getByRole('combobox', { name: 'Active workflow' })
    .selectOption({ label: 'Independent operations · example' });
  await selectCanvasNode(page, 'DevOps readiness');

  const inspector = page.getByRole('complementary', { name: 'Workflow inspector' });
  await inspector.getByRole('button', { name: 'Kagent (in-cluster CRDs)' }).click();
  const cluster = inspector.locator('.workflow-inspector-section', { hasText: /^Cluster bindings/ });
  await expect(cluster).toContainText('503', 'an unconfigured deployment says publish will refuse, instead of leaving it a surprise');
  await expect(cluster.locator('.workflow-caps-reread')).toBeVisible();
  await inspector.getByRole('button', { name: 'Publish this node to kagent' }).click();
  await expect(inspector.locator('.workflow-publish-result'))
    .toContainText('no runtime configured', 'the refusal is explained, not just echoed as an error code');
});

test('a decision gate seeds the platform cards and locks approve until every threshold is met', async ({ page }) => {
  const recording = await installDesignerStubs(page);
  await openDesigner(page);

  await page.getByRole('button', { name: 'New blank', exact: true }).click();
  await page.getByRole('button', { name: 'Add Decision gate to workflow' }).click();
  await pressSave(page);

  const gateNode = page.locator('.workflow-node[data-node-kind="gate"]');
  await expect(gateNode).toHaveCount(1);
  await expect(gateNode.locator('.workflow-node-kind')).toHaveText('Decision gate');
  // The shipping template carries pass rates from its own review; a gate added
  // to a new workflow has not been reviewed, so it must not arrive approved.
  await expect(gateNode.locator('.workflow-node-footer')).toContainText('6 cards \u00b7 6 not assessed');

  await gateNode.dblclick();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.workflow-gate-heading')).toHaveText('Specs Gate');
  await expect(dialog.locator('.workflow-gate-card')).toHaveCount(6);
  await expect(dialog.getByRole('button', { name: 'Add assessment card' })).toBeHidden();
  const approve = dialog.getByRole('button', { name: 'Allow to move further' });
  await expect(approve).toBeDisabled();
  await expect(dialog.locator('.workflow-gate-summary')).toContainText('0 of 6 cards met \u00b7 6 not assessed yet.');

  // Each card has its own bar (85 / 100 / 80 / 75 / 80 / 100), so the gate is
  // met when all six clear theirs — one good average does not approve a lane.
  const cards = dialog.locator('.workflow-gate-card');
  for (let index = 0; index < 6; index += 1) {
    const card = cards.nth(index);
    await expect(card.locator('.workflow-gate-card-status')).toHaveText('Not assessed');
    const threshold = card.locator('input[aria-label="Required threshold percent"]');
    await card.locator('input[aria-label="Current pass rate percent"]').fill(await threshold.inputValue());
  }
  await expect(dialog.locator('.workflow-gate-summary')).toContainText('All 6 cards met their thresholds');
  await expect(cards.first().locator('.workflow-gate-card-status')).toHaveAttribute('data-met', 'true');
  await expect(approve).toBeEnabled();

  const savedGate = () => {
    for (const graph of recording.store.graphs(PRIMARY_ORG.id)) {
      const node = (graph.nodes || []).find((item) => item.kind === 'gate');
      if (node) {
        return {
          template: node.gateRef,
          titles: (node.gateConfig?.cards || []).map((card) => card.title),
          bars: (node.gateConfig?.cards || []).map((card) => card.threshold),
          assessed: (node.gateConfig?.cards || []).filter((card) => card.passRate != null).length,
        };
      }
    }
    return null;
  };
  // Nothing has been reviewed yet, so the graph that saved holds the template's
  // criteria with no pass rate on any card.
  await expect.poll(savedGate).toMatchObject({
    template: 'gate-template-v1',
    titles: ['Business Analysis', 'Cloud Selection', 'Cost Analysis', 'Business Metrics', 'Revenue Model', 'Timeline Defined'],
    bars: [85, 100, 80, 75, 80, 100],
    assessed: 0,
  });

  await approve.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(gateNode.locator('.workflow-node-footer')).toContainText('6 cards met');
  await pressSave(page);
  await expect.poll(savedGate).toMatchObject({ assessed: 6 });

  // Cancel and Escape both discard the draft: the dialog edits a copy, and the
  // only writer of the graph is the path that already does revision checks.
  await gateNode.dblclick();
  await dialog.locator('input[aria-label="Assessment card title"]').first().fill('Renamed, then cancelled');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(savedGate().titles[0]).toBe('Business Analysis');

  await gateNode.dblclick();
  await dialog.locator('input[aria-label="Current pass rate percent"]').first().fill('0');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(savedGate().assessed).toBe(6);
});

test('an untitled card is refused by the gate review instead of deleting the gate', async ({ page }) => {
  const recording = await installDesignerStubs(page);
  await openDesigner(page);

  await page.getByRole('button', { name: 'New blank', exact: true }).click();
  await page.getByRole('button', { name: 'Add Decision gate to workflow' }).click();
  const gateNode = page.locator('.workflow-node[data-node-kind="gate"]');
  await pressSave(page);

  await gateNode.dblclick();
  const dialog = page.getByRole('dialog');
  await dialog.locator('.workflow-gate-card').first()
    .locator('.workflow-gate-card-remove').click();
  await expect(dialog.locator('.workflow-gate-card')).toHaveCount(5);

  // Strip every title: the model would drop all five cards, then the node.
  const titles = dialog.locator('input[aria-label="Assessment card title"]');
  for (let index = 0; index < 5; index += 1) await titles.nth(index).fill('');
  await expect(dialog.locator('.workflow-gate-blocked')).toHaveCount(2);
  await expect(dialog.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Allow to move further' })).toBeDisabled();

  const savedTitles = () => {
    for (const graph of recording.store.graphs(PRIMARY_ORG.id)) {
      const node = (graph.nodes || []).find((item) => item.kind === 'gate');
      if (node) return (node.gateConfig?.cards || []).map((card) => card.title);
    }
    return null;
  };
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(gateNode).toHaveCount(1);
  // What the graph holds is still the six titled cards: the untitled draft was
  // refused in the dialog, so nothing reached the server that would have deleted
  // the gate it belongs to.
  await expect.poll(savedTitles).toEqual([
    'Business Analysis', 'Cloud Selection', 'Cost Analysis', 'Business Metrics', 'Revenue Model', 'Timeline Defined',
  ]);
});

test('a member can read a gate review, and opening it writes nothing', async ({ page }) => {
  const memberOrg = { ...PRIMARY_ORG, role: 'MEMBER' };
  const { createInitialState } = await import('../public/js/workflow-designer-model.mjs');
  const graph = createInitialState().workflows[0];
  graph.nodes.push({
    id: 'gate-read', kind: 'gate', name: 'Specs gate', x: 120, y: 560,
    description: 'Reviewed before this lane continues.',
    gateConfig: DEFAULT_GATE_TEMPLATE,
  });
  const recording = await installDesignerStubs(page, {
    organizations: [memberOrg],
    workflows: { [memberOrg.id]: [graph] },
  });
  await openDesigner(page);

  const gateNode = page.locator('.workflow-node[data-node-kind="gate"]');
  await expect(gateNode).toHaveCount(1);
  await selectCanvasNode(page, 'Specs gate');
  const inspector = page.getByRole('complementary', { name: 'Workflow inspector' });
  await expect(inspector.locator('.workflow-gate-verdict')).toContainText('All 6 cards met their thresholds');
  await expect(inspector.getByRole('button', { name: 'Open gate review' })).toBeDisabled();

  // Reading the gate is allowed; changing it is not, so no control in the
  // dialog is live and no save is offered at all.
  await gateNode.dblclick();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.workflow-gate-card')).toHaveCount(6);
  await expect(dialog.locator('input[aria-label="Current pass rate percent"]').first()).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Remove card' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Add assessment card' })).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Allow to move further' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  expectWorkflowReadsOnly(recording);
});

test('an authenticated user without an organization is routed to organization onboarding', async ({ page }) => {
  const recording = await installDesignerStubs(page, { organizations: [] });

  const response = await page.goto('/#/workflows', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();

  await expect(page).toHaveURL(/#\/organization$/);
  await expect(page.getByRole('heading', { name: 'Organization & projects' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create an organization' })).toBeVisible();
  await expect(page.locator('.workflow-designer')).toHaveCount(0);
  // With no active organization there is no tenant to read graphs for.
  expect(recording.workflowApiRequests).toEqual([]);
});
