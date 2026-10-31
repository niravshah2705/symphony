import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Firebase headers keep ADLC runtime config uncached', () => {
  const firebase = JSON.parse(fs.readFileSync(new URL('../../firebase.json', import.meta.url), 'utf8'));
  const headers = firebase.hosting.headers;
  const configRule = headers.find((rule) => rule.source === '/adlc/config.js');

  assert.deepEqual(configRule?.headers, [
    { key: 'Cache-Control', value: 'no-store' },
  ]);
});

test('ADLC manifest and service worker stay scoped to /adlc/', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.webmanifest', import.meta.url), 'utf8'));
  const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const serviceWorker = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8');

  assert.equal(manifest.start_url, '/adlc/');
  assert.equal(manifest.scope, '/adlc/');
  assert.match(app, /register\('\/adlc\/sw\.js', \{ scope: '\/adlc\/' \}\)/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\('\/adlc\/'\)/);
  assert.doesNotMatch(serviceWorker, /\/js\//);
  const precacheList = serviceWorker.match(/const ASSETS = \[([\s\S]*?)\];/)?.[1] || '';
  assert.doesNotMatch(precacheList, /\/adlc\/config\.js/);
});

test('every clean-URL /adlc/ link resolves to an index.html on disk', () => {
  // Firebase Hosting only matches a trailing-slash URL like /adlc/blog/ against a
  // literal .../blog/index.html file — never a sibling blog.html. Any clean URL
  // added without a matching index.html silently falls through to the site-wide
  // catch-all rewrite and serves the root SPA instead. This test walks every
  // known ADLC page, collects the trailing-slash /adlc/... links it references,
  // and asserts each one has a real index.html at that path.
  const publicDir = fileURLToPath(new URL('../', import.meta.url));
  const pagesToScan = [
    './index.html',
    './blog/index.html',
    './brief/index.html',
    './blog/governance/index.html',
    './blog/isolation/index.html',
    './blog/evidence/index.html',
    './blog/lifecycle/index.html',
    './blog/integration/index.html',
    './blog/getting-started/index.html',
  ];

  const hrefPattern = /href="(\/adlc\/[^"]*\/)"/g;
  const missing = [];

  for (const page of pagesToScan) {
    const html = fs.readFileSync(new URL(page, import.meta.url), 'utf8');
    for (const match of html.matchAll(hrefPattern)) {
      const cleanUrl = match[1];
      const expectedFile = path.join(publicDir, cleanUrl, 'index.html');
      if (!fs.existsSync(expectedFile)) {
        missing.push(`${cleanUrl} (referenced in ${page})`);
      }
    }
  }

  assert.deepEqual(missing, []);
});

test('ADLC deploy config is generated from repo variables without GCS publishing', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');

  assert.match(workflow, /ADLC_TRY_NOW_URL/);
  assert.match(workflow, /ADLC_CANONICAL_ORIGIN/);
  assert.match(workflow, /public\/adlc\/config\.js/);
  assert.doesNotMatch(workflow, /\bgsutil\b/);
  assert.doesNotMatch(workflow, /storage buckets|gcloud storage/i);
});
