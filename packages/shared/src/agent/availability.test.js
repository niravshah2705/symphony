'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AgentAvailabilityError,
  isModelAvailabilityError,
  isRepositoryAvailabilityError,
  pauseReasonFor,
  probeModelAvailability,
  probeRepositoryAvailability,
} = require('./availability');
const { AgentError } = require('./plan');
const { RepositoryBrokerError } = require('./repository-broker');
const { AgentRuntimeError } = require('./runtimes');

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('pause reasons expose a stable, nontechnical UI contract', () => {
  const reason = pauseReasonFor(
    'git',
    new Error('git push https://token@example.test failed with 403'),
    { provider: 'gitlab', taskIdentifier: 'ENG-9' },
    Date.UTC(2026, 6, 17)
  );
  assert.deepEqual(reason, {
    code: 'git-unavailable',
    resource: 'git',
    message: 'GitLab repository access is unavailable. Check the repository and token in Settings, then resume agent jobs.',
    since: '2026-07-17T00:00:00.000Z',
    taskIdentifier: 'ENG-9',
    provider: 'gitlab',
  });
  assert.doesNotMatch(JSON.stringify(reason), /token@example|git push|403/);
});

test('repository preflight converts provider 403 into a sanitized availability error', async () => {
  let request;
  await assert.rejects(
    () => probeRepositoryAvailability(
      { provider: 'github', repoRef: 'acme/app', token: 'stored-secret' },
      {
        fetchImpl: async (url, options) => {
          request = { url, options };
          return response(403, { message: 'raw provider detail' });
        },
      }
    ),
    (error) => {
      assert.ok(error instanceof AgentAvailabilityError);
      assert.equal(error.resource, 'git');
      assert.equal(error.status, 403);
      assert.doesNotMatch(error.message, /raw provider detail|stored-secret/);
      return true;
    }
  );
  assert.equal(request.url, 'https://api.github.com/repos/acme/app');
  assert.equal(request.options.headers.Authorization, 'Bearer stored-secret');
  assert.equal(request.options.redirect, 'error');
});

test('repository preflight requires write permission before dispatch', async () => {
  await assert.rejects(
    () => probeRepositoryAvailability(
      { provider: 'github', repoRef: 'acme/app', token: 'stored-secret' },
      { fetchImpl: async () => response(200, { permissions: { pull: true, push: false } }) }
    ),
    (error) => error && error.code === 'git_write_unavailable' && error.status === 403
  );
});

test('local model preflight verifies that the selected model is loaded', async () => {
  await assert.rejects(
    () => probeModelAvailability(
      { provider: 'ollama', host: 'http://localhost:11434', model: 'wanted:latest' },
      { fetchImpl: async () => response(200, { models: [{ name: 'another:latest' }] }) }
    ),
    (error) => error && error.resource === 'model' && error.code === 'model_not_found'
  );

  const ready = await probeModelAvailability(
    { provider: 'lmstudio', host: 'http://localhost:1234', model: 'local-coder' },
    { fetchImpl: async () => response(200, { data: [{ id: 'local-coder' }] }) }
  );
  assert.deepEqual(ready, { available: true, provider: 'lmstudio', model: 'local-coder' });
});

test('model classifier recognizes hosted authorization and network availability failures', () => {
  assert.equal(isModelAvailabilityError({ status: 403 }), true);
  assert.equal(isModelAvailabilityError({ code: 'ECONNREFUSED' }), true);
  assert.equal(
    isModelAvailabilityError(new AgentError('Plan failed validation.', 502, { code: 'model_output_invalid' })),
    false,
  );
  assert.equal(
    isModelAvailabilityError(new AgentError('Model call failed.', 502, {
      code: 'model_call_failed',
      cause: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
    })),
    true,
  );
  assert.equal(
    isModelAvailabilityError(new AgentRuntimeError(
      'SDK execution failed.',
      'runtime_execution_failed',
      502,
      { cause: new Error('Request failed with HTTP 403') },
    )),
    true,
  );
  assert.equal(isModelAvailabilityError(new Error('ordinary workflow assertion failed')), false);
});

test('repository classifier distinguishes remote outages from local workflow errors', () => {
  assert.equal(
    isRepositoryAvailabilityError(
      new RepositoryBrokerError('Repository provider returned 403.', 'provider_error'),
    ),
    true,
  );
  assert.equal(
    isRepositoryAvailabilityError(
      new RepositoryBrokerError('Unable to access remote: connection refused.', 'git_failed'),
    ),
    true,
  );
  for (const code of ['workspace_dirty', 'review_blocked', 'invalid_input', 'branch_scope', 'git_failed']) {
    const message = code === 'git_failed' ? 'fatal: .git/index: Permission denied' : `ordinary ${code} failure`;
    assert.equal(
      isRepositoryAvailabilityError(new RepositoryBrokerError(message, code)),
      false,
      `${code} must not pause every project`,
    );
  }
});
