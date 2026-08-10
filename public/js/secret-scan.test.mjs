import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSecrets, REDACTION_PLACEHOLDER } from './secret-scan.mjs';

// Shape-valid but fake secrets — one representative per pattern.
const CASES = [
  { name: 'authorization bearer', secret: 'abcdef1234567890XYZ', input: 'Authorization: Bearer abcdef1234567890XYZ', label: 'Authorization header/token' },
  { name: 'credential assignment', secret: 'SuperSecret123', input: 'password=SuperSecret123', label: 'Credential assignment' },
  { name: 'PEM private key block', secret: 'MIIBOgIBAAJBAKj34', input: '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34\n-----END RSA PRIVATE KEY-----', label: 'Private key' },
  { name: 'PEM header only', secret: '-----BEGIN OPENSSH PRIVATE KEY-----', input: 'here it is: -----BEGIN OPENSSH PRIVATE KEY-----', label: 'Private key' },
  { name: 'github classic token', secret: 'ghp_0123456789abcdefghijABCDEFGHIJ0123', label: 'GitHub token' },
  { name: 'github fine-grained PAT', secret: 'github_pat_0123456789abcdefghijkl', label: 'GitHub fine-grained PAT' },
  { name: 'gitlab token', secret: 'glpat-0123456789abcdefghij', label: 'GitLab token' },
  { name: 'anthropic key', secret: 'sk-ant-api03-AbCdEf0123456789_xyz', label: 'Anthropic API key' },
  { name: 'openai key', secret: 'sk-0123456789abcdefABCDEFGH', label: 'OpenAI API key' },
  { name: 'stripe secret key', secret: 'sk_live_0123456789abcdefABCDEF', label: 'Stripe secret key' },
  { name: 'slack token', secret: 'xoxb-0123456789-abcdefABCDEF', label: 'Slack token' },
  { name: 'slack webhook', secret: 'https://hooks.slack.com/services/T00000000/B00000000/abcdefABCDEF1234567890', label: 'Slack webhook URL' },
  { name: 'aws access key', secret: 'AKIAIOSFODNN7EXAMPLE', label: 'AWS access key ID' },
  { name: 'google api key', secret: 'AIzaSyA0123456789abcdefghijklmnopqrstuv', label: 'Google API key' },
  { name: 'jwt', secret: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', label: 'JSON Web Token (JWT)' },
];

for (const { name, secret, input, label } of CASES) {
  test(`detects and redacts: ${name}`, () => {
    const text = input || `my token is ${secret} keep it safe`;
    const result = scanSecrets(text);

    assert.equal(result.found, true, 'should flag as containing a secret');
    assert.ok(result.types.includes(label), `types should include "${label}", got ${JSON.stringify(result.types)}`);
    assert.ok(result.redacted.includes(REDACTION_PLACEHOLDER), 'redacted output should contain the placeholder');

    // The core security invariant: the secret value never survives, anywhere.
    assert.ok(!result.redacted.includes(secret), 'redacted output must NOT contain the raw secret');
    assert.ok(result.types.every((t) => !t.includes(secret)), 'type labels must NOT contain the raw secret');
  });
}

test('credential assignment keeps the key name, redacts only the value', () => {
  const result = scanSecrets('password=SuperSecret123');
  assert.equal(result.redacted, `password=${REDACTION_PLACEHOLDER}`);
});

test('clean text is returned unchanged with no findings', () => {
  const text = 'Please assess this business idea about a bakery in Amsterdam.';
  const result = scanSecrets(text);
  assert.deepEqual(result, { found: false, types: [], redacted: text });
});

test('redacts multiple distinct secrets in one message', () => {
  const gh = 'ghp_0123456789abcdefghijABCDEFGHIJ0123';
  const aws = 'AKIAIOSFODNN7EXAMPLE';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc-DEF_123';
  const result = scanSecrets(`deploy with ${gh} and ${aws} and ${jwt}`);

  assert.equal(result.found, true);
  assert.ok(!result.redacted.includes(gh));
  assert.ok(!result.redacted.includes(aws));
  assert.ok(!result.redacted.includes(jwt));
  assert.equal(result.types.length, 3);
});

test('does not mutate the input and handles nullish input', () => {
  assert.deepEqual(scanSecrets(null), { found: false, types: [], redacted: '' });
  assert.deepEqual(scanSecrets(undefined), { found: false, types: [], redacted: '' });
  assert.deepEqual(scanSecrets(''), { found: false, types: [], redacted: '' });
});

test('scanning is stable across repeated calls (no shared regex state leak)', () => {
  const text = 'token sk-0123456789abcdefABCDEFGH here';
  const first = scanSecrets(text);
  const second = scanSecrets(text);
  assert.deepEqual(first, second);
});
