'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFirebaseHosting, PREVIEW_HEADERS, hashFile, safePath } = require('./hosting');

const SITE = 'guest-previews';
const VERSION_NAME = `sites/${SITE}/versions/v1`;
const UPLOAD_BASE = `https://upload-firebasehosting.googleapis.com/upload/${VERSION_NAME}/files`;

function fakeHosting({ requiredHashes = [], failOn = null } = {}) {
  const calls = [];
  const logs = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method, headers: opts.headers || {}, body: opts.body });
    if (failOn && url.includes(failOn.path) && opts.method === failOn.method) {
      return { status: failOn.status, text: async () => JSON.stringify({ error: { status: failOn.reason } }) };
    }
    if (opts.method === 'POST' && url.endsWith(':populateFiles')) {
      return { status: 200, text: async () => JSON.stringify({ uploadUrl: UPLOAD_BASE, uploadRequiredHashes: requiredHashes }) };
    }
    if (url.startsWith(UPLOAD_BASE)) {
      return { status: 200, text: async () => JSON.stringify({ previouslyUploaded: false }) };
    }
    if (url.includes('/releases')) {
      return { status: 200, text: async () => JSON.stringify({ name: `sites/${SITE}/channels/live/releases/r1` }) };
    }
    if (url.endsWith(`/sites/${SITE}/versions`)) {
      return { status: 200, text: async () => JSON.stringify({ name: VERSION_NAME, status: 'CREATED' }) };
    }
    return { status: 200, text: async () => JSON.stringify({ status: 'FINALIZED' }) };
  };
  const hosting = createFirebaseHosting({ site: SITE, fetchImpl, getAccessToken: async () => 'opaque-token', log: (entry) => logs.push(entry) });
  return { hosting, calls, logs };
}

test('a release is create, populate, upload, finalize, release — in that order', async () => {
  const files = [
    { path: 'aaa/index.html', content: '<h1>one</h1>' },
    { path: 'bbb/styles.css', content: 'body{color:red}' },
  ];
  const hashes = files.map((f) => hashFile(f.content).hash);
  const { hosting, calls } = fakeHosting({ requiredHashes: [hashes[1]] });

  const result = await hosting.publish({ files });
  assert.deepEqual(result, { versionName: VERSION_NAME, releaseName: `sites/${SITE}/channels/live/releases/r1`, fileCount: 2 });
  assert.deepEqual(calls.map((c) => c.method), ['POST', 'POST', 'POST', 'PATCH', 'POST']);
  assert.equal(calls[0].url, `https://firebasehosting.googleapis.com/v1beta1/sites/${SITE}/versions`);
  assert.equal(calls[1].url, `https://firebasehosting.googleapis.com/v1beta1/${VERSION_NAME}:populateFiles`);
  assert.equal(calls[2].url, `${UPLOAD_BASE}/${hashes[1]}`, 'only the hash the host does not already have is sent');
  assert.ok(calls[3].url.includes('updateMask=status,files'), 'finalize is a status+files patch, not a separate verb');
  assert.ok(calls[4].url.includes(`/channels/live/releases`));
  assert.ok(calls[4].url.includes(`versionName=${encodeURIComponent(VERSION_NAME)}`));

  const populate = JSON.parse(calls[1].body.toString());
  assert.deepEqual(populate.files, { 'aaa/index.html': hashes[0], 'bbb/styles.css': hashes[1] });
  const finalize = JSON.parse(calls[3].body.toString());
  assert.equal(finalize.status, 'FINALIZED');
  assert.deepEqual(finalize.files, [{ path: 'aaa/index.html', hash: hashes[0] }, { path: 'bbb/styles.css', hash: hashes[1] }]);
  for (const call of calls) assert.equal(call.headers.authorization, 'Bearer opaque-token');
});

test('the hardening travels on the version, so it cannot be forgotten per file', async () => {
  const { hosting, calls } = fakeHosting({ requiredHashes: [] });
  await hosting.publish({ files: [{ path: 'aaa/index.html', content: 'x' }] });
  const created = JSON.parse(calls[0].body.toString());
  assert.equal(created.config.headers[0].glob, '**');
  const keys = created.config.headers[0].headers.map((h) => h.key);
  assert.ok(keys.includes('Content-Security-Policy'), 'a generated page must not run as if it were the app origin');
  assert.ok(keys.includes('X-Robots-Tag') && keys.includes('X-Content-Type-Options'));
  assert.deepEqual(Object.fromEntries(created.config.headers[0].headers.map((h) => [h.key, h.value])), Object.fromEntries(PREVIEW_HEADERS.map((h) => [h.key, h.value])));
  assert.match(created.config.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value, /sandbox/);
});

test('a file path is confined before it ever reaches a release', async () => {
  const { hosting } = fakeHosting();
  for (const path of ['../escape', '/absolute', 'a/../../b', 'back\\slash', '', 'x'.repeat(300), 'a//b']) {
    await assert.rejects(() => hosting.publish({ files: [{ path, content: 'x' }] }), (error) => {
      assert.equal(error.code, 'guest_hosting_path_invalid');
      assert.equal(error.status, 400);
      return true;
    }, `${JSON.stringify(path)} must not be publishable`);
  }
  assert.equal(safePath('ok/path-1.html'), 'ok/path-1.html');
  assert.equal(safePath('../../nope'), null);
});

test('listing the same path twice is a build bug, not a silent overwrite', async () => {
  const { hosting } = fakeHosting();
  await assert.rejects(() => hosting.publish({ files: [{ path: 'a/index.html', content: '1' }, { path: 'a/index.html', content: '2' }] }), /listed twice/);
});

test('an empty union is a legal release: withdrawing every preview is what expiry means', async () => {
  const { hosting, calls } = fakeHosting();
  const result = await hosting.publish({ files: [], allowEmpty: true });
  assert.equal(result.fileCount, 0);
  assert.deepEqual(JSON.parse(calls[1].body.toString()).files, {});
  await assert.rejects(() => hosting.publish({ files: [] }), /nothing to publish/);
});

test('a hosting failure is reported as an unusable preview, never as the upstream body', async () => {
  const { hosting, logs } = fakeHosting({ failOn: { path: ':populateFiles', method: 'POST', status: 500, reason: 'INTERNAL' } });
  await assert.rejects(() => hosting.publish({ files: [{ path: 'a/index.html', content: 'x' }] }), (error) => {
    assert.equal(error.code, 'guest_hosting_upload_failed');
    assert.equal(error.status, 502);
    assert.doesNotMatch(error.message, /undefined-token|Bearer/);
    return true;
  });
  assert.equal(logs[0].detail, 'INTERNAL', 'the status code is enough for an operator');
  assert.ok(!logs[0].url.includes('?'), 'a request URL is logged without its query');
});

test('no credential means no attempt: the site is never published anonymously', async () => {
  const calls = [];
  const hosting = createFirebaseHosting({
    site: SITE,
    fetchImpl: async (url, opts) => { calls.push(url); return { status: 200, text: async () => '{}' }; },
    getAccessToken: async () => null,
    log: () => {},
  });
  await assert.rejects(() => hosting.publish({ files: [{ path: 'a/index.html', content: 'x' }] }), (error) => {
    assert.equal(error.code, 'guest_hosting_auth_failed');
    assert.equal(error.status, 503);
    return true;
  });
  assert.deepEqual(calls, []);
});

test('an upload the host refuses stops the release rather than finalizing a half site', async () => {
  const hash = hashFile('x').hash;
  const calls = [];
  const hosting = createFirebaseHosting({
    site: SITE,
    getAccessToken: async () => 'opaque-token',
    log: () => {},
    fetchImpl: async (url, opts = {}) => {
      calls.push({ url, method: opts.method });
      if (url.endsWith(':populateFiles')) return { status: 200, text: async () => JSON.stringify({ uploadUrl: UPLOAD_BASE, uploadRequiredHashes: [hash] }) };
      if (url.startsWith(UPLOAD_BASE)) return { status: 403, text: async () => 'forbidden' };
      return { status: 200, text: async () => JSON.stringify({ name: VERSION_NAME }) };
    },
  });
  await assert.rejects(() => hosting.publish({ files: [{ path: 'a/index.html', content: 'x' }] }), /refused a\/index\.html/);
  assert.ok(!calls.some((c) => c.method === 'PATCH'), 'no finalize, so no release of an incomplete version');
});

test('an upload is sent as multipart with the name the host records', async () => {
  const file = { path: 'aaa/index.html', content: '<h1>one</h1>' };
  const { hosting, calls } = fakeHosting({ requiredHashes: [hashFile(file.content).hash] });
  await hosting.publish({ files: [file] });
  const upload = calls.find((c) => c.url.startsWith(UPLOAD_BASE));
  assert.ok(upload.body instanceof FormData, 'global FormData is what the upload endpoint expects');
  assert.equal(upload.body.get('fileName'), 'aaa/index.html');
  assert.equal(upload.body.get('hash'), hashFile(file.content).hash);
});
