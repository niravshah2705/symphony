'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { CONFIG, namespaceCollection } = require('./config');

// Runs a snippet in a child process with the given env so STORE_NAMESPACE (read
// once at module load) can be varied. Returns trimmed stdout.
function withEnv(env, expr) {
  const script = `const { CONFIG, namespaceCollection } = require('./config'); process.stdout.write(String((${expr})));`;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('default (no STORE_NAMESPACE): collections keep their exact global names', () => {
  // The test process itself has no STORE_NAMESPACE set.
  assert.equal(CONFIG.STORE_NAMESPACE, '');
  assert.equal(namespaceCollection('aifleet'), 'aifleet');
  assert.equal(namespaceCollection('aifleet_events'), 'aifleet_events');
});

test('STORE_NAMESPACE set: collections are suffixed with __<ns>', () => {
  assert.equal(
    withEnv({ STORE_NAMESPACE: 't3f9a1b2c4d5' }, "namespaceCollection('aifleet')"),
    'aifleet__t3f9a1b2c4d5'
  );
  assert.equal(
    withEnv({ STORE_NAMESPACE: 't3f9a1b2c4d5' }, "namespaceCollection('aifleet_events')"),
    'aifleet_events__t3f9a1b2c4d5'
  );
});

test('STORE_NAMESPACE is sanitized to a Firestore-safe collection suffix', () => {
  // Strips path chars / underscores / uppercase — no injection into the path.
  assert.equal(withEnv({ STORE_NAMESPACE: 'Bad/../Name__X' }, 'CONFIG.STORE_NAMESPACE'), 'badnamex');
  assert.equal(
    withEnv({ STORE_NAMESPACE: 'Bad/../Name__X' }, "namespaceCollection('aifleet')"),
    'aifleet__badnamex'
  );
});

test('empty/whitespace STORE_NAMESPACE falls back to the global collection', () => {
  assert.equal(withEnv({ STORE_NAMESPACE: '   ' }, "namespaceCollection('aifleet')"), 'aifleet');
});
