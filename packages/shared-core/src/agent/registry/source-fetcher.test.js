'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchMarketplace, resolveMarketplaceUrl, safeRepoName } = require('./source-fetcher');

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fetcher-')));
}

test('resolveMarketplaceUrl prefers explicit url, else derives from repo', () => {
  assert.equal(resolveMarketplaceUrl({ repo: 'o/n', ref: 'x' }), 'https://github.com/o/n.git');
  assert.equal(resolveMarketplaceUrl({ url: 'https://git.example/x.git', ref: 'x' }), 'https://git.example/x.git');
  assert.throws(() => resolveMarketplaceUrl({ ref: 'x' }), /neither url nor repo/);
});

test('safeRepoName is a single safe path segment', () => {
  assert.equal(safeRepoName({ repo: 'uipath/uipath-claude-marketplace' }), 'uipath__uipath-claude-marketplace');
  assert.match(safeRepoName({ url: 'https://x/y.git' }), /^[A-Za-z0-9._-]+$/);
});

test('fetchMarketplace clones the pinned ref via the injected git', () => {
  const work = tmp();
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args.includes('rev-parse')) return 'deadbeefcafebabe0000000000000000deadbeef\n';
    return '';
  };
  const out = fetchMarketplace({ repo: 'o/n', ref: 'v1.2.3' }, { workRoot: work, git });
  assert.equal(out.ref, 'v1.2.3');
  assert.equal(out.sha, 'deadbeefcafebabe0000000000000000deadbeef');
  assert.equal(out.url, 'https://github.com/o/n.git');
  // fetch used the pinned ref, shallow
  const fetch = calls.find((c) => c.includes('fetch'));
  assert.ok(fetch.includes('--depth') && fetch.includes('v1.2.3'));
  assert.ok(calls.some((c) => c.includes('checkout') && c.includes('FETCH_HEAD')));
});

test('fetchMarketplace copies a local file:// marketplace instead of cloning', () => {
  const src = tmp();
  fs.writeFileSync(path.join(src, 'marker.txt'), 'hello');
  const work = tmp();
  let gitCalled = false;
  const out = fetchMarketplace(
    { url: `file://${src}`, ref: 'local' },
    { workRoot: work, git: () => { gitCalled = true; return ''; }, name: 'local-mp' }
  );
  assert.equal(gitCalled, false);
  assert.equal(fs.readFileSync(path.join(out.path, 'marker.txt'), 'utf8'), 'hello');
});
