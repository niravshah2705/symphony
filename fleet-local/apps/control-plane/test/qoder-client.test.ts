import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { QoderAuthError, qoder } from '../src/clients/qoder.ts';

const PAT = 'pt-abcdefghijklmnopqrstuvwxyz012345';
const JT = `jt-${'a'.repeat(40)}`;
const JRT = `jrt-${'b'.repeat(40)}`;

interface Call {
  url: string;
  method: string;
  body: string;
}

// Stubs the transport and returns the requests the client made, so a test can assert
// what went on the wire. `responses[i]` answers call i; the last entry repeats.
function stubFetch(t: TestContext, responses: { status: number; body: unknown }[]): Call[] {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  let i = 0;
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    const res = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(typeof res.body === 'string' ? res.body : JSON.stringify(res.body), { status: res.status });
  }) as typeof fetch;
  return calls;
}

test('exchange posts the PAT to the auth host and returns epoch-second expiry', async (t) => {
  const calls = stubFetch(t, [
    {
      status: 200,
      body: {
        token: JT,
        expires_in: 86400000,
        expires_at: '2026-11-27T00:00:00Z',
        refresh_token: JRT,
        refresh_token_expires_in: 172800000,
      },
    },
  ]);
  const set = await qoder.exchange(PAT);
  assert.equal(calls[0].url, 'https://openapi.qoder.sh/api/v1/jobToken/exchange');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { personal_token: PAT });
  assert.equal(set.token, JT);
  assert.equal(set.refreshToken, JRT);
  // The API's expires_in is milliseconds; callers store seconds.
  assert.ok(set.expiresAt - Math.floor(Date.now() / 1000) > 86300, String(set.expiresAt));
  assert.ok(set.refreshExpiresAt! - set.expiresAt > 43000);
});

test('refresh posts the refresh token, not the PAT', async (t) => {
  const calls = stubFetch(t, [{ status: 200, body: { token: JT, expires_in: 86400000 } }]);
  const set = await qoder.refresh(JRT);
  assert.equal(calls[0].url, 'https://openapi.qoder.sh/api/v1/jobToken/refresh');
  assert.deepEqual(JSON.parse(calls[0].body), { refresh_token: JRT });
  // A rotation without a new refresh token leaves the stored one in place, which is
  // why the writer only patches the key it was given.
  assert.equal(set.refreshToken, undefined);
});

// The credential-hygiene regression test. HttpError embeds the response body, and on
// these two endpoints both the request and the response body are secrets, so a
// thrown error must name the status and nothing else.
const failures: [number, unknown][] = [
  [400, { error: { message: `invalid personal_token ${PAT}` } }],
  [401, { code: 'TOKEN_EXPIRE', message: `refresh token ${JRT} rejected` }],
  [500, `upstream echoed the request: {"personal_token":"${PAT}"}`],
];

for (const [status, body] of failures) {
  test(`a ${status} from exchange throws with no credential in the message`, async (t) => {
    stubFetch(t, [{ status, body }]);
    await assert.rejects(
      () => qoder.exchange(PAT),
      (err: unknown) => {
        assert.ok(err instanceof QoderAuthError, `expected QoderAuthError, got ${String(err)}`);
        assert.equal(err.status, status);
        assert.equal(err.operation, 'exchange');
        assert.equal(err.message, `qoder exchange failed: HTTP ${status}`);
        const surfaced = `${err.message} ${JSON.stringify(err)} ${String(err.stack)}`;
        for (const secret of [PAT, JT, JRT]) {
          assert.equal(surfaced.includes(secret), false, `error leaks a credential: ${surfaced}`);
        }
        return true;
      },
    );
  });
}

// A 2xx that is not a job token is a broken contract, not something to write into a
// Secret: the EgressPolicy substitutes whatever lands there as a Bearer value.
test('a response without a jt- token is refused', async (t) => {
  stubFetch(t, [{ status: 200, body: { token: PAT, expires_in: 86400000 } }]);
  await assert.rejects(() => qoder.exchange(PAT), /no job token/);
});

test('falls back to expires_at when the relative lifetime is missing', async (t) => {
  stubFetch(t, [{ status: 200, body: { token: JT, expires_at: new Date(Date.now() + 3600_000).toISOString() } }]);
  const set = await qoder.exchange(PAT);
  assert.ok(set.expiresAt - Math.floor(Date.now() / 1000) > 3500, String(set.expiresAt));
});

test('a missing lifetime yields the documented 24h default', async (t) => {
  stubFetch(t, [{ status: 200, body: { token: JT } }]);
  const set = await qoder.exchange(PAT);
  assert.equal(set.expiresAt - Math.floor(Date.now() / 1000), 86400);
});
