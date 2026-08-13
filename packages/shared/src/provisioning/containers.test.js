'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  splitEnv,
  extractSourceService,
  extractSourceJob,
  mergeServiceScaling,
  cloneContainers,
} = require('./containers');

// A shared source service with an ingress container + an egress-proxy sidecar.
const SOURCE_SVC = {
  template: {
    scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
    volumes: [{ name: 'skills' }],
    executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN1',
    maxInstanceRequestConcurrency: 10,
    containers: [
      {
        image: 'registry/planner:sha',
        ports: [{ containerPort: 8080 }],
        env: [
          { name: 'PLANNER_PORT', value: '8080' },
          { name: 'LINEAR_API_KEY', valueSource: { secretKeyRef: { secret: 'linear-api-key', version: 'latest' } } },
        ],
        resources: { limits: { cpu: '1', memory: '512Mi' } },
        volumeMounts: [{ name: 'skills', mountPath: '/skills' }],
      },
      {
        image: 'registry/proxy:sha',
        // sidecar: no ports
        env: [
          { name: 'PROXY_PORT', value: '4030' },
          { name: 'SETTINGS_URL', value: 'https://settings.shared' },
          { name: 'GITHUB_TOKEN', valueSource: { secretKeyRef: { secret: 'github-token', version: 'latest' } } },
          { name: 'INTERNAL_API_TOKEN', valueSource: { secretKeyRef: { secret: 'internal-api-token', version: 'latest' } } },
        ],
        resources: { limits: { cpu: '1', memory: '256Mi' } },
      },
    ],
  },
};

test('splitEnv separates secret (value-source) env from plain env', () => {
  const { secretEnv, plainEnv } = splitEnv(SOURCE_SVC.template.containers[1].env);
  assert.deepEqual(plainEnv, { PROXY_PORT: '4030', SETTINGS_URL: 'https://settings.shared' });
  assert.equal(secretEnv.length, 2);
  assert.equal(secretEnv[0].name, 'GITHUB_TOKEN');
});

test('extractSourceService captures ALL containers + volumes', () => {
  const src = extractSourceService(SOURCE_SVC);
  assert.equal(src.containers.length, 2);
  assert.deepEqual(src.scaling, { minInstanceCount: 0, maxInstanceCount: 1 });
  assert.equal(src.volumes[0].name, 'skills');
  assert.equal(src.executionEnvironment, 'EXECUTION_ENVIRONMENT_GEN1');
  assert.equal(src.maxInstanceRequestConcurrency, 10);
});

test('mergeServiceScaling preserves source scaling and applies an explicit pipeline cap', () => {
  const source = { minInstanceCount: 0, maxInstanceCount: 5 };
  assert.deepEqual(mergeServiceScaling(source), source);
  assert.deepEqual(
    mergeServiceScaling(source, 1),
    { minInstanceCount: 0, maxInstanceCount: 1 },
  );
  assert.deepEqual(mergeServiceScaling(undefined), { minInstanceCount: 0 });
});

test('cloneContainers propagates the sidecar to the tenant stack', () => {
  const src = extractSourceService(SOURCE_SVC);
  const containers = cloneContainers(
    src.containers,
    {
      image: 'registry/planner:sha',
      port: 8080,
      env: { STORE_NAMESPACE: 'tabc123', PLANNER_PORT: '8080' },
      sidecarEnv: { STORE_NAMESPACE: 'tabc123', PROXY_ORG_ID: 'org-uuid' },
    },
    { withPorts: true }
  );

  // BOTH containers are present (the bug was cloning only containers[0]).
  assert.equal(containers.length, 2);

  // Primary: tenant env + ports + its own secret env.
  const primary = containers[0];
  assert.deepEqual(primary.ports, [{ containerPort: 8080 }]);
  assert.deepEqual(primary.resources, { limits: { cpu: '1', memory: '512Mi' } });
  const primaryEnv = Object.fromEntries(primary.env.filter((e) => !e.valueSource).map((e) => [e.name, e.value]));
  assert.equal(primaryEnv.STORE_NAMESPACE, 'tabc123');
  assert.ok(primary.env.some((e) => e.name === 'LINEAR_API_KEY' && e.valueSource));

  // Sidecar: NO ports, source secret env preserved, tenant patch overlaid on
  // its source plain env (SETTINGS_URL kept, PROXY_ORG_ID added).
  const sidecar = containers[1];
  assert.equal(sidecar.ports, undefined);
  assert.equal(sidecar.image, 'registry/proxy:sha');
  assert.deepEqual(sidecar.resources, { limits: { cpu: '1', memory: '256Mi' } });
  const sidecarEnv = Object.fromEntries(sidecar.env.filter((e) => !e.valueSource).map((e) => [e.name, e.value]));
  assert.equal(sidecarEnv.SETTINGS_URL, 'https://settings.shared');
  assert.equal(sidecarEnv.PROXY_ORG_ID, 'org-uuid');
  assert.equal(sidecarEnv.STORE_NAMESPACE, 'tabc123');
  assert.ok(sidecar.env.some((e) => e.name === 'GITHUB_TOKEN' && e.valueSource));
  assert.ok(sidecar.env.some((e) => e.name === 'INTERNAL_API_TOKEN' && e.valueSource));
});

test('cloneContainers for a JOB gives the primary no ports', () => {
  const jobContainers = SOURCE_SVC.template.containers.map((container, index) => ({
    ...container,
    resources: index === 0
      ? { limits: { cpu: '2', memory: '4Gi' } }
      : { limits: { cpu: '1', memory: '512Mi' } },
  }));
  const jobSource = {
    template: { template: { volumes: [], executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2', containers: jobContainers } },
  };
  const src = extractSourceJob(jobSource);
  const containers = cloneContainers(src.containers, { image: 'registry/coder:sha', env: {}, sidecarEnv: {} }, { withPorts: false });
  assert.equal(containers.length, 2);
  assert.equal(containers[0].ports, undefined);
  assert.deepEqual(containers[0].resources, { limits: { cpu: '2', memory: '4Gi' } });
  assert.deepEqual(containers[1].resources, { limits: { cpu: '1', memory: '512Mi' } });
});

test('single-container source (no sidecar) still clones cleanly', () => {
  const single = { template: { containers: [SOURCE_SVC.template.containers[0]] } };
  const src = extractSourceService(single);
  const containers = cloneContainers(src.containers, { image: 'x', port: 8080, env: {} }, { withPorts: true });
  assert.equal(containers.length, 1);
  assert.deepEqual(containers[0].ports, [{ containerPort: 8080 }]);
});
