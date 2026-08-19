import assert from 'node:assert/strict';
import fs from 'node:fs';
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

test('ADLC deploy config is generated from repo variables without GCS publishing', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');

  assert.match(workflow, /ADLC_TRY_NOW_URL/);
  assert.match(workflow, /ADLC_CANONICAL_ORIGIN/);
  assert.match(workflow, /public\/adlc\/config\.js/);
  assert.doesNotMatch(workflow, /\bgsutil\b/);
  assert.doesNotMatch(workflow, /storage buckets|gcloud storage/i);
});
