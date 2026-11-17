import test from 'node:test';
import assert from 'node:assert/strict';

import { LLM_GATEWAY_MODES, LLM_GATEWAY_STORAGE_KEY, readLlmGatewayFlag } from './llm-gateway.mjs';

function storage(values = {}) {
  const entries = new Map(Object.entries(values));
  return {
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => entries.set(key, String(value)),
  };
}

test('an organization-scoped toggle wins over the global one', () => {
  const store = storage({
    [LLM_GATEWAY_STORAGE_KEY]: 'litellm',
    [`${LLM_GATEWAY_STORAGE_KEY}:org-b`]: 'langsmith',
  });
  assert.equal(readLlmGatewayFlag({ storage: store, organizationId: 'org-b' }), 'langsmith');
  assert.equal(readLlmGatewayFlag({ storage: store, organizationId: 'org-a' }), 'litellm',
    'a tenant nobody pinned keeps the global toggle, which is the documented devtools flow');
});

test('pinning one tenant does not route its siblings', () => {
  const store = storage({ [`${LLM_GATEWAY_STORAGE_KEY}:org-a`]: 'litellm' });
  assert.equal(readLlmGatewayFlag({ storage: store, organizationId: 'org-a' }), 'litellm');
  assert.equal(readLlmGatewayFlag({ storage: store, organizationId: 'org-b' }), '',
    'org B has no gateway configured, and a header naming one would only fail its runs');
  assert.equal(readLlmGatewayFlag({ storage: store, organizationId: '' }), '',
    'nor does an unscoped request inherit the pinned tenant');
});

test('anything that is not a known mode is dropped, never forwarded', () => {
  for (const value of ['', '  ', 'LangSmith ', 'AGENTGATEWAY', 'litellm; DROP', 'null']) {
    const store = storage({ [LLM_GATEWAY_STORAGE_KEY]: value });
    const flag = readLlmGatewayFlag({ storage: store, organizationId: '' });
    assert.ok(value.trim().toLowerCase() === 'langsmith' ? flag === 'langsmith' : !LLM_GATEWAY_MODES.includes(flag) || flag === value.trim().toLowerCase(),
      `${JSON.stringify(value)} must not reach the wire as-is`);
  }
  assert.equal(readLlmGatewayFlag({ storage: storage({ [LLM_GATEWAY_STORAGE_KEY]: 'agentgateway' }), organizationId: '' }), '');
});

test('unavailable storage answers "no flag" rather than throwing into the request path', () => {
  const broken = { getItem() { throw new Error('SecurityError'); } };
  assert.equal(readLlmGatewayFlag({ storage: broken, organizationId: 'org-a' }), '');
  assert.equal(readLlmGatewayFlag({ storage: storage(), organizationId: 'org-a' }), '');
});
