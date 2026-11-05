'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GUARDRAIL_VERSION,
  METADATA_DENY_CIDR,
  defaultGuardrailSpec,
  normalizeGuardrailSpec,
  validateGuardrailSpec,
} = require('./spec');

test('default spec is valid and deny-by-default with metadata SSRF blocked', () => {
  const spec = defaultGuardrailSpec();
  assert.equal(spec.version, GUARDRAIL_VERSION);
  assert.equal(spec.enforcement, 'deny-by-default');
  assert.ok(spec.egress.denyCidrs.includes(METADATA_DENY_CIDR));
  assert.equal(spec.tools.denyAll, true);
  assert.deepEqual(validateGuardrailSpec(spec), { ok: true, errors: [] });
});

test('normalize always re-adds the metadata deny CIDR and coerces to a valid spec', () => {
  const spec = normalizeGuardrailSpec({ egress: { denyCidrs: ['10.0.0.0/8'] } });
  assert.ok(spec.egress.denyCidrs.includes(METADATA_DENY_CIDR));
  assert.ok(spec.egress.denyCidrs.includes('10.0.0.0/8'));
  assert.deepEqual(validateGuardrailSpec(spec), { ok: true, errors: [] });
});

test('normalize handles null/garbage input by returning the default', () => {
  assert.deepEqual(normalizeGuardrailSpec(null), defaultGuardrailSpec());
  assert.deepEqual(normalizeGuardrailSpec('nonsense'), defaultGuardrailSpec());
});

test('normalize dedupes host lists and keeps caller-provided allowlist', () => {
  const spec = normalizeGuardrailSpec({ egress: { allowHosts: ['a.com', 'a.com', '', ' b.com '] } });
  assert.deepEqual(spec.egress.allowHosts, ['a.com', 'b.com']);
});

test('validate rejects a spec that drops the metadata deny rule or bad runtime class', () => {
  const bad = { ...defaultGuardrailSpec(), egress: { denyCidrs: [] } };
  const res = validateGuardrailSpec(bad);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes(METADATA_DENY_CIDR)));

  const badRc = normalizeGuardrailSpec({});
  badRc.runtimeClass = 'kvm';
  assert.equal(validateGuardrailSpec(badRc).ok, false);
});

test('normalize clamps a bogus egress port to a safe default', () => {
  const spec = normalizeGuardrailSpec({ egress: { ports: [{ proto: 'tcp', port: 'nope' }] } });
  assert.equal(Number.isFinite(spec.egress.ports[0].port), true);
  assert.equal(spec.egress.ports[0].proto, 'TCP');
});
