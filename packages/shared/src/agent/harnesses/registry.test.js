'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registryModule = require('./registry');
const { createHarnessRegistry } = registryModule;
const { createRuntimeDispatcher } = require('./dispatch');

function definition(overrides = {}) {
  const stages = overrides.stages || ['planning'];
  return {
    id: 'fixture-harness',
    label: 'Fixture Harness',
    harnessName: 'fixture',
    packageName: '@fixture/harness',
    requiresProvider: null,
    availability: 'available',
    capabilities: overrides.capabilities || [...stages],
    stages,
    brokeredStages: overrides.brokeredStages || [],
    createExecutor: () => async () => ({ runtime: 'fixture-harness', finalText: 'ok' }),
    ...overrides,
  };
}

test('HarnessDefinition validation rejects incomplete and malformed metadata', () => {
  const malformed = [
    null,
    definition({ id: 'Fixture-Harness' }),
    definition({ id: ' fixture-harness' }),
    definition({ label: '' }),
    definition({ harnessName: 'Fixture Name' }),
    definition({ packageName: ' @fixture/harness' }),
    (() => { const value = definition(); delete value.requiresProvider; return value; })(),
    definition({ requiresProvider: 'OpenAI' }),
    definition({ availability: 'experimental' }),
    definition({ capabilities: { planning: true } }),
    definition({ capabilities: ['planning', 'unknown'] }),
    definition({ stages: [] }),
    definition({ stages: ['planning', 'planning'] }),
    definition({ stages: ['build'] }),
    definition({ stages: ['planning', 'coding'], capabilities: ['planning'] }),
    definition({ stages: ['planning'], capabilities: ['planning', 'coding'] }),
    definition({ brokeredStages: ['coding'] }),
    definition({ brokeredStages: ['planning', 'planning'] }),
    definition({ createExecutor: null }),
  ];

  for (const value of malformed) {
    const isolated = createHarnessRegistry();
    assert.throws(
      () => isolated.register(value),
      (error) => error.code === 'invalid_harness_definition',
    );
  }
});

test('registration clones and freezes complete definitions and rejects duplicates', () => {
  const isolated = createHarnessRegistry();
  const input = definition({
    stages: ['planning', 'coding'],
    capabilities: ['planning', 'coding', 'streaming'],
    brokeredStages: ['planning'],
  });
  assert.equal(isolated.register(input), 'fixture-harness');
  const registered = isolated.get('fixture-harness');

  assert.equal(Object.isFrozen(registered), true);
  assert.equal(Object.isFrozen(registered.capabilities), true);
  assert.equal(Object.isFrozen(registered.stages), true);
  assert.equal(Object.isFrozen(registered.brokeredStages), true);
  assert.notEqual(registered.stages, input.stages);
  input.stages.push('testing');
  assert.deepEqual(registered.stages, ['planning', 'coding']);
  assert.throws(() => { registered.label = 'changed'; }, TypeError);
  assert.throws(
    () => isolated.register(definition()),
    (error) => error.code === 'duplicate_harness_definition',
  );
});

test('sealed registries remain readable and reject every later registration', () => {
  const isolated = createHarnessRegistry();
  isolated.register(definition());
  isolated.seal();
  assert.equal(isolated.isSealed(), true);
  assert.equal(isolated.get('fixture-harness').label, 'Fixture Harness');
  assert.throws(
    () => isolated.register(definition({ id: 'later-harness' })),
    (error) => error.code === 'harness_registry_sealed',
  );
});

test('dispatcher passes explicit construction dependencies to createExecutor', async () => {
  const isolated = createHarnessRegistry();
  const deps = Object.freeze({ service: { name: 'trusted-dependency' } });
  let receivedDeps = null;
  isolated.register(definition({
    createExecutor(factoryDeps) {
      receivedDeps = factoryDeps;
      return async (options, prompt) => ({
        runtime: options.runtime,
        provider: options.llm.provider,
        model: options.llm.model,
        workflowPattern: options.workflowPattern,
        finalText: `${factoryDeps.service.name}:${prompt}`,
        messages: [],
        usage: null,
        costUsd: null,
        sessionId: null,
      });
    },
  }));
  isolated.seal();

  const execute = createRuntimeDispatcher(isolated);
  const result = await execute({
    runtime: 'fixture-harness',
    workflow: 'planning',
    prompt: 'run',
    llm: { provider: 'fixture', model: 'model' },
    trace: false,
  }, deps);

  assert.equal(receivedDeps, deps);
  assert.equal(result.finalText, 'trusted-dependency:run');
});

test('throwing executor factories run inside tracing and normalized error handling', async () => {
  const isolated = createHarnessRegistry();
  let factoryCalls = 0;
  let traceStarted = false;
  isolated.register(definition({
    createExecutor() {
      factoryCalls += 1;
      throw new Error('factory exploded');
    },
  }));
  isolated.seal();

  const execute = createRuntimeDispatcher(isolated);
  await assert.rejects(
    () => execute({
      runtime: 'fixture-harness',
      workflow: 'planning',
      prompt: 'run',
      llm: { provider: 'fixture', model: 'model' },
      getCurrentRunTree: () => ({ metadata: {} }),
      traceFactory(fn) {
        traceStarted = true;
        assert.equal(factoryCalls, 0, 'factory must not run before trace construction');
        return fn;
      },
    }, { dependency: true }),
    (error) => error.code === 'runtime_execution_failed'
      && /Fixture Harness execution failed: factory exploded/.test(error.message),
  );
  assert.equal(traceStarted, true);
  assert.equal(factoryCalls, 1);
});

test('stage and broker constraints replace the blanket coding fallback', () => {
  const isolated = createHarnessRegistry();
  isolated.register(definition({
    id: 'deepagent',
    label: 'DeepAgent',
    harnessName: 'deepagent',
    packageName: 'deepagents',
    stages: ['planning', 'coding', 'testing', 'deployment'],
    capabilities: ['planning', 'coding', 'testing', 'deployment', 'streaming', 'subagents'],
    brokeredStages: ['planning', 'coding', 'testing', 'deployment'],
  }));
  isolated.register(definition({
    id: 'sdk-harness',
    requiresProvider: 'sdk',
    stages: ['planning', 'coding', 'testing'],
    capabilities: ['planning', 'coding', 'testing'],
    brokeredStages: ['planning', 'testing'],
  }));
  isolated.seal();

  const llm = { provider: 'sdk' };
  // Legacy coding remains broker-required by default, so existing callers keep
  // the observable DeepAgent fallback.
  assert.deepEqual(
    isolated.resolveAgentRuntime('sdk-harness', llm, { workflow: 'coding', strict: true }),
    {
      requestedRuntime: 'sdk-harness',
      runtime: 'deepagent',
      stage: 'coding',
      brokered: true,
      fallbackReason: 'workflow_requires_broker',
    },
  );
  // A caller that explicitly has an unbrokered coding stage may use an SDK that
  // declares coding support.
  assert.equal(
    isolated.effectiveAgentRuntime('sdk-harness', llm, {
      workflow: 'coding',
      brokered: false,
      strict: true,
    }),
    'sdk-harness',
  );
  assert.equal(
    isolated.resolveAgentRuntime('sdk-harness', llm, { workflow: 'deployment', strict: true }).fallbackReason,
    'stage_unsupported',
  );
  assert.equal(
    isolated.effectiveAgentRuntime('sdk-harness', llm, {
      workflow: 'planning',
      brokered: true,
      strict: true,
    }),
    'sdk-harness',
  );
  assert.throws(
    () => isolated.effectiveAgentRuntime('sdk-harness', llm, { stage: 'build', strict: true }),
    (error) => error.code === 'invalid_agent_stage',
  );
});

test('built-in bootstrap seals one registry shared by compatibility views', () => {
  const runtimes = require('./index');
  const catalog = require('@ai-fleet/shared-core/agent/harness-catalog.json');
  const available = catalog.harnesses.filter((entry) => entry.availability === 'available');
  const expectedIds = available.map((entry) => entry.id);

  assert.equal(runtimes.registry.isSealed(), true);
  assert.deepEqual(runtimes.registry.ids(), expectedIds);
  assert.deepEqual(Object.keys(runtimes.RUNTIMES), expectedIds);
  assert.deepEqual(Object.keys(runtimes.HARNESS_LABELS), expectedIds);
  assert.deepEqual(runtimes.runtimeCatalog().map(({ id }) => id), expectedIds);
  assert.equal(Object.isFrozen(runtimes.RUNTIMES), true);
  assert.equal(Object.isFrozen(runtimes.HARNESS_LABELS), true);
  assert.equal(Object.isFrozen(runtimes.runtimeCatalog()), true);

  for (const metadata of available) {
    const registered = runtimes.registry.get(metadata.id);
    assert.deepEqual(
      {
        id: registered.id,
        label: registered.label,
        harnessName: registered.harnessName,
        packageName: registered.packageName,
        requiresProvider: registered.requiresProvider,
        availability: registered.availability,
        capabilities: [...registered.capabilities],
        stages: [...registered.stages],
        brokeredStages: [...registered.brokeredStages],
      },
      metadata,
    );
  }
  assert.throws(
    () => runtimes.registry.register(definition({ id: 'late-harness' })),
    (error) => error.code === 'harness_registry_sealed',
  );
});
