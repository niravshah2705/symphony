import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.ts';
import { QoderAuthError, type QoderTokenSet } from '../src/clients/qoder.ts';
import { ensureQoderToken, rotateQoderTokens, type QoderSecretState, type QoderTenantRef, type QoderTokenDeps } from '../src/credentials/qoderTokens.ts';

// The Secret keys are config, not literals in the module, so the test drives the
// defaults the deployed ConfigMap sets (deploy/bff/configmap.yaml).
const TOKEN_KEY = config.qoderApiKeyEnv;
const PAT_KEY = config.qoderPatSecretKey;
const REFRESH_KEY = config.qoderRefreshSecretKey;
assert.equal(TOKEN_KEY, 'QODER_API_KEY');
assert.equal(PAT_KEY, 'QODER_PAT');
assert.equal(REFRESH_KEY, 'QODER_REFRESH_TOKEN');

const ref: QoderTenantRef = { namespace: 'org-demo', secretName: 'litellm-demo-default', orgId: 'org-uuid' };
const b64 = (s: string) => Buffer.from(s).toString('base64');
const NOW = 1_700_000_000_000;
const NOW_S = Math.floor(NOW / 1000);
const SKEW = 21600;

const set = (over: Partial<QoderTokenSet> = {}): QoderTokenSet => ({
  token: `jt-${'a'.repeat(40)}`,
  expiresAt: NOW_S + 86400,
  ...over,
});

interface Harness {
  deps: QoderTokenDeps;
  secret: QoderSecretState;
  writes: { data: Record<string, string>; annotations: Record<string, string> }[];
  exchanges: string[];
  refreshes: string[];
}

function harness(
  secret: Partial<QoderSecretState>,
  over: { status?: string; mint?: QoderTokenSet; refresh?: QoderTokenSet; refreshError?: Error } = {},
): Harness {
  const full: QoderSecretState = { data: secret.data ?? {}, annotations: secret.annotations ?? {} };
  const h: Harness = {
    secret: full,
    writes: [],
    exchanges: [],
    refreshes: [],
    deps: {
      listTenants: async () => [ref],
      readSecret: async () => full,
      writeSecret: async (_ref, patch) => {
        h.writes.push(patch);
        Object.assign(full.data, patch.data);
        Object.assign(full.annotations, patch.annotations);
      },
      status: async () => over.status ?? 'active',
      exchange: async (pat) => {
        h.exchanges.push(pat);
        return over.mint ?? set();
      },
      refresh: async (token) => {
        h.refreshes.push(token);
        if (over.refreshError) throw over.refreshError;
        return over.refresh ?? set();
      },
      now: () => NOW,
      skewSeconds: () => SKEW,
    },
  };
  return h;
}

const secretWith = (over: Partial<Record<string, string>> = {}, annotations: Record<string, string> = {}) => ({
  data: { [PAT_KEY]: b64('pt-secretvalue'), ...over },
  annotations,
});

test('a live job token well inside its lifetime is left alone', async () => {
  const h = harness(
    secretWith({ [TOKEN_KEY]: b64('jt-existing') }, { 'fleet.local/qoder-token-expires-at': String(NOW_S + 43200) }),
  );
  assert.deepEqual(await ensureQoderToken(ref, h.deps), { ...ref, action: 'fresh' });
  assert.equal(h.writes.length, 0);
  assert.equal(h.exchanges.length, 0);
  assert.equal(h.refreshes.length, 0);
});

test('inside the rotation skew, the token is renewed', async () => {
  const h = harness(
    secretWith({ [TOKEN_KEY]: b64('jt-existing'), [REFRESH_KEY]: b64('jrt-old') }, {
      'fleet.local/qoder-token-expires-at': String(NOW_S + SKEW - 60),
    }),
  );
  assert.equal((await ensureQoderToken(ref, h.deps)).action, 'refreshed');
  assert.deepEqual(h.refreshes, ['jrt-old']);
  assert.equal(h.exchanges.length, 0, 'a refreshable token must not burn the PAT path');
});

test('a first run exchanges the PAT and records the state on the Secret', async () => {
  const mint = set({ token: `jt-${'c'.repeat(40)}`, refreshToken: 'jrt-new', refreshExpiresAt: NOW_S + 172800 });
  const h = harness(secretWith(), { mint });
  assert.equal((await ensureQoderToken(ref, h.deps)).action, 'exchanged');
  assert.deepEqual(h.exchanges, ['pt-secretvalue']);
  assert.equal(h.writes[0].data[TOKEN_KEY], b64(mint.token));
  assert.deepEqual(h.writes[0].data[REFRESH_KEY], b64('jrt-new'));
  assert.equal(h.writes[0].annotations['fleet.local/qoder-token-expires-at'], String(mint.expiresAt));
  assert.equal(h.writes[0].annotations['fleet.local/qoder-refresh-expires-at'], String(mint.refreshExpiresAt));
  assert.ok(h.writes[0].annotations['fleet.local/qoder-token-synced-at']);
});

test('no PAT, no Secret, and a non-active org are all skips, not failures', async () => {
  const noPat = harness({ data: {}, annotations: {} });
  assert.deepEqual(await ensureQoderToken(ref, noPat.deps), { ...ref, action: 'skipped', reason: 'no_pat' });

  const missing = harness(secretWith());
  missing.deps.readSecret = async () => undefined;
  assert.deepEqual(await ensureQoderToken(ref, missing.deps), { ...ref, action: 'skipped', reason: 'no_secret' });

  // DISABLE IS A GATE, NOT A TEARDOWN: stop rotating, keep the Secret (and the
  // agent) intact so re-enabling works without reseeding.
  const disabled = harness(secretWith(), { status: 'disabled' });
  assert.deepEqual(await ensureQoderToken(ref, disabled.deps), { ...ref, action: 'skipped', reason: 'org_disabled' });
  assert.equal(disabled.writes.length, 0);
});

test('a rejected refresh falls back to the PAT exactly once', async () => {
  const h = harness(
    secretWith({ [TOKEN_KEY]: b64('jt-expired'), [REFRESH_KEY]: b64('jrt-stale') }, {
      'fleet.local/qoder-token-expires-at': String(NOW_S - 10),
    }),
    { refreshError: new QoderAuthError('refresh', 401) },
  );
  assert.equal((await ensureQoderToken(ref, h.deps)).action, 'exchanged');
  assert.deepEqual(h.refreshes, ['jrt-stale']);
  assert.deepEqual(h.exchanges, ['pt-secretvalue']);
});

test('a server-side refresh failure does not spend the PAT', async () => {
  const h = harness(
    secretWith({ [TOKEN_KEY]: b64('jt-expired'), [REFRESH_KEY]: b64('jrt-ok') }, {
      'fleet.local/qoder-token-expires-at': String(NOW_S - 10),
    }),
    { refreshError: new QoderAuthError('refresh', 503) },
  );
  await assert.rejects(() => ensureQoderToken(ref, h.deps), /HTTP 503/);
  assert.equal(h.exchanges.length, 0, 'a 5xx is a failing endpoint, not an expired credential');
  assert.equal(h.writes.length, 0);
});

test('a stale refresh token goes straight to exchange', async () => {
  const h = harness(
    secretWith({ [REFRESH_KEY]: b64('jrt-dead') }, {
      'fleet.local/qoder-token-expires-at': String(NOW_S - 10),
      'fleet.local/qoder-refresh-expires-at': String(NOW_S - 10),
    }),
  );
  assert.equal((await ensureQoderToken(ref, h.deps)).action, 'exchanged');
  assert.equal(h.refreshes.length, 0);
});

test('a rotation preserves Secret keys the loop does not own', async () => {
  const h = harness(secretWith({ key: b64('sk-litellm-virtual-key'), [TOKEN_KEY]: b64('jt-expired') }, {
    'fleet.local/qoder-token-expires-at': String(NOW_S - 10),
    'helm.sh/resource-policy': 'keep',
  }));
  await ensureQoderToken(ref, h.deps);
  assert.equal(h.writes[0].data.key, undefined, 'the patch must not re-emit unrelated keys');
  assert.equal(h.writes[0].annotations['helm.sh/resource-policy'], 'keep', 'unrelated annotations survive the merge');
});

test('one tenant failing does not stop the sweep, and prints no credential', async () => {
  const other: QoderTenantRef = { ...ref, namespace: 'org-other', secretName: 'litellm-other-default', orgId: 'org-2' };
  const third: QoderTenantRef = { ...ref, namespace: 'org-third', secretName: 'litellm-third-default', orgId: 'org-3' };
  const h = harness(secretWith());
  h.deps.listTenants = async () => [ref, other, third];
  h.deps.readSecret = async (r) => {
    if (r.namespace === 'org-other') throw new QoderAuthError('exchange', 401);
    return h.secret;
  };
  const real = console.error;
  const printed: string[] = [];
  console.error = (...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  };
  try {
    const results = await rotateQoderTokens(h.deps);
    // The failing tenant is dropped from the report; the sweep continues to the next.
    assert.deepEqual(results.map((r) => r.namespace), ['org-demo', 'org-third']);
  } finally {
    console.error = real;
  }
  assert.equal(printed.length, 1, printed.join('\n'));
  assert.match(printed[0], /org-other\/litellm-other-default/);
  assert.equal(/pt-|jt-|jrt-/.test(printed[0]), false, printed[0]);
});
