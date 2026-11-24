'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BILLING_ORG_HEADER, BILLING_ROLE_HEADER, BILLING_USER_HEADER, INTERNAL_TOKEN_HEADER,
  createTrustedCallerMiddleware, resolveTrustedCaller, callerOf,
  deploymentOrgId, isLoopbackPeer, tokensMatch, reportBoot, ORG_ID_RE,
} = require('./trusted-caller');

const DEPLOYMENT_ORG = 'org-deployment';

// Every case names its own config: the profile of the machine running the suite
// must not decide whether a caller is trusted.
function config(over = {}) {
  return {
    BILLING: {
      orgId: DEPLOYMENT_ORG,
      trustedCallerAudience: 'https://billing.internal',
      trustedServiceAccounts: ['gateway@ai-fleet.iam.gserviceaccount.com'],
      ...over.BILLING,
    },
    AUTH: { mode: 'jwt', ...over.AUTH },
  };
}

function req({ headers = {}, peer = '10.128.0.7' } = {}) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), v]));
  return {
    get: (name) => {
      const value = lower.get(String(name).toLowerCase());
      return value === undefined ? '' : String(value);
    },
    socket: { remoteAddress: peer },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a matching internal token is a proof, and the gateway headers are the caller', async () => {
  const caller = await resolveTrustedCaller(
    req({ headers: {
      [INTERNAL_TOKEN_HEADER]: 'sekret',
      [BILLING_ORG_HEADER]: 'org-a',
      [BILLING_ROLE_HEADER]: 'org_admin',
      [BILLING_USER_HEADER]: 'user-1',
    } }),
    { config: config(), env: {}, internalToken: 'sekret' },
  );
  assert.equal(caller.trusted, true);
  assert.equal(caller.proof, 'internal-token');
  assert.equal(caller.orgId, 'org-a');
  assert.equal(caller.isAdmin, true, 'the role header is case-insensitive');
  assert.equal(caller.userId, 'user-1');
});

test('a wrong token, an empty token and an absent header all prove nothing', async () => {
  for (const supplied of ['nope', '', undefined, 'sekretX']) {
    const caller = await resolveTrustedCaller(
      req({ headers: { [INTERNAL_TOKEN_HEADER]: supplied, [BILLING_ORG_HEADER]: 'org-victim' } }),
      { config: config(), env: {}, internalToken: 'sekret' },
    );
    assert.equal(caller.trusted, false, `${String(supplied)} is not the token`);
    assert.equal(caller.orgId, DEPLOYMENT_ORG, 'an unproven socket never addresses a named org');
    assert.equal(caller.isAdmin, false);
    assert.equal(caller.ignoredHeaders, true);
  }
  // With no token configured there is no comparison to make — so no proof either.
  const unset = await resolveTrustedCaller(
    req({ headers: { [INTERNAL_TOKEN_HEADER]: 'anything' } }),
    { config: config(), env: {}, internalToken: '' },
  );
  assert.equal(unset.trusted, false);
});

test('the token comparison is constant-time-shaped and length-gated', () => {
  assert.equal(tokensMatch('abc', 'abc'), true);
  assert.equal(tokensMatch('abc', 'abd'), false);
  assert.equal(tokensMatch('abc', 'abcd'), false, 'a prefix is not a match');
  assert.equal(tokensMatch('abcd', 'abc'), false);
  assert.equal(tokensMatch('whatever', ''), false, 'an unset secret matches nothing');
  assert.equal(tokensMatch(undefined, 'x'), false);
});

test('an ID token signed by a trusted service account is a proof; anything else is not', async () => {
  const seen = [];
  const options = (verifyToken) => ({
    config: config(),
    env: {},
    internalToken: '',
    verifyToken: async (r, o) => {
      seen.push(o);
      return verifyToken(r, o);
    },
  });
  const headers = {
    authorization: 'Bearer tok',
    [BILLING_ORG_HEADER]: 'org-a',
  };

  const good = await resolveTrustedCaller(req({ headers }),
    options(async () => ({ email: 'Gateway@ai-fleet.iam.gserviceaccount.com' })));
  assert.equal(good.trusted, true);
  assert.equal(good.proof, 'gateway-id-token');
  assert.equal(good.orgId, 'org-a');
  assert.deepEqual(seen[0], {
    audience: 'https://billing.internal',
    allowedEmails: ['gateway@ai-fleet.iam.gserviceaccount.com'],
  }, 'the verifier is handed this deployment audience and allow-list');

  const stranger = await resolveTrustedCaller(req({ headers }),
    options(async () => ({ email: 'someone-else@other.iam.gserviceaccount.com' })));
  assert.equal(stranger.trusted, false);
  assert.equal(stranger.orgId, DEPLOYMENT_ORG);
  assert.equal(stranger.unverified, 'id_token_signer_not_trusted');

  const bad = await resolveTrustedCaller(req({ headers }),
    options(async () => { throw new Error('signature mismatch'); }));
  assert.equal(bad.trusted, false);
  assert.match(bad.unverified, /^id_token_rejected:signature mismatch/);

  // An unset audience would make the verifier accept a token minted for anything,
  // so the proof is not even attempted.
  const noAudience = await resolveTrustedCaller(req({ headers }), {
    config: config({ BILLING: { orgId: DEPLOYMENT_ORG, trustedCallerAudience: '', trustedServiceAccounts: [] } }),
    env: {},
    internalToken: '',
    verifyToken: async () => { throw new Error('must not be called'); },
  });
  assert.equal(noAudience.trusted, false);
  assert.equal(noAudience.unverified, 'no_caller_proof');
});

test('loopback is only a proof for the development profile, and only from the socket', async () => {
  const headers = { [BILLING_ORG_HEADER]: 'org-a' };
  const dev = await resolveTrustedCaller(req({ headers, peer: '127.0.0.1' }),
    { config: config({ AUTH: { mode: 'disabled' } }), env: {}, internalToken: '' });
  assert.equal(dev.trusted, true);
  assert.equal(dev.proof, 'local-loopback');
  assert.equal(dev.orgId, 'org-a');

  // The same profile reached from the VPC is not a developer's laptop.
  const lan = await resolveTrustedCaller(req({ headers, peer: '10.128.0.7' }),
    { config: config({ AUTH: { mode: 'disabled' } }), env: {}, internalToken: '' });
  assert.equal(lan.trusted, false);
  assert.equal(lan.orgId, DEPLOYMENT_ORG);

  // And a deployment with auth on trusts its loopback interface no more.
  const prod = await resolveTrustedCaller(req({ headers, peer: '127.0.0.1' }),
    { config: config({ AUTH: { mode: 'jwt' } }), env: {}, internalToken: '' });
  assert.equal(prod.trusted, false);

  assert.equal(isLoopbackPeer(req({ peer: '::1' })), true);
  assert.equal(isLoopbackPeer(req({ peer: '::ffff:127.0.0.1' })), true);
  assert.equal(isLoopbackPeer(req({ peer: '10.0.0.1' })), false);
  assert.equal(isLoopbackPeer({ socket: {} }), false);
  // X-Forwarded-For is a header the gateway writes; reading it here would let any
  // caller claim to be loopback.
  assert.equal(isLoopbackPeer(req({ peer: '10.0.0.1', headers: { 'x-forwarded-for': '127.0.0.1' } })), false);
});

test('a proven caller naming a malformed org id selects nothing', async () => {
  // `|` is the read-cache separator and `/` `?` `%` rewrite a FlexPrice path, and
  // the org id reaches both. A gateway that sends one is broken or hostile.
  for (const named of ['a|b', 'org/../../x', 'org%20a', ''.padEnd(129, 'o'), 'org a']) {
    assert.equal(ORG_ID_RE.test(named), false, `${named} is not an org id shape`);
    const caller = await resolveTrustedCaller(
      req({ headers: { [INTERNAL_TOKEN_HEADER]: 'sekret', [BILLING_ORG_HEADER]: named } }),
      { config: config(), env: {}, internalToken: 'sekret' },
    );
    assert.equal(caller.trusted, false);
    assert.equal(caller.unverified, 'invalid_org_header');
    assert.equal(caller.orgId, DEPLOYMENT_ORG);
  }
  for (const named of ['org-a', 'ORG.a_1:b', '550e8400-e29b-41d4-a716-446655440000', 'org-test-svc']) {
    assert.equal(ORG_ID_RE.test(named), true, `${named} is a real org id shape`);
  }
});

test('a router reached without the middleware has no caller to trust', () => {
  const bare = req({ headers: { [BILLING_ORG_HEADER]: 'org-victim' } });
  const caller = callerOf(bare, { config: config() });
  assert.equal(caller.trusted, false);
  assert.equal(caller.unverified, 'middleware_not_applied');
  assert.equal(caller.orgId, DEPLOYMENT_ORG, 'the headers are not re-derived into an org');

  const proven = { billingCaller: { orgId: 'org-a', trusted: true } };
  assert.equal(callerOf(proven).orgId, 'org-a', 'what the middleware wrote is the only input');
});

test('the middleware scopes, never rejects — and a failed resolution scopes too', async () => {
  const r = req({ headers: { [BILLING_ORG_HEADER]: 'org-victim' } });
  let nextCalls = 0;
  await createTrustedCallerMiddleware({ config: config(), env: {}, internalToken: 'sekret' })(r, {}, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1, 'an unproven request still gets an answer, just a scoped one');
  assert.equal(r.billingCaller.orgId, DEPLOYMENT_ORG);
  assert.equal(r.billingCaller.isAdmin, false, 'which is why the money mutations answer 403');

  const broken = req({ headers: { [BILLING_ORG_HEADER]: 'org-victim' } });
  await createTrustedCallerMiddleware({
    config: config(),
    env: {},
    resolveCaller: async () => { throw new Error('verifier unreachable'); },
  })(broken, {}, () => {});
  assert.equal(broken.billingCaller.trusted, false);
  assert.equal(broken.billingCaller.unverified, 'resolution_failed');
  assert.equal(broken.billingCaller.orgId, DEPLOYMENT_ORG);
  await tick();
});

test('boot says which proofs this deployment will accept', () => {
  const empty = { BILLING: {}, AUTH: { mode: 'jwt' } };
  assert.equal(reportBoot({ config: empty, env: {} }).length, 2);
  assert.deepEqual(reportBoot({
    config: config(), env: {}, internalToken: 'sekret',
  }), [], 'a fully configured deployment says nothing');
  const dev = reportBoot({ config: config({ AUTH: { mode: 'disabled' } }), env: {}, internalToken: 'sekret' });
  assert.equal(dev.length, 1);
  assert.match(dev[0], /AUTH_MODE=disabled/);
  assert.equal(deploymentOrgId(empty), '__shared__', 'a stack with no org of its own addresses the shared one');
});
