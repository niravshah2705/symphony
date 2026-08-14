'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const sources = {
  bootstrap: read('deploy/gcp/bootstrap.sh'),
  manual: read('deploy/gcp/deploy.sh'),
  Firebase: read('.github/workflows/deploy.yml'),
  'Cloud Build': read('cloudbuild.yaml'),
};

function normalizeShell(source, cloudBuild = false) {
  return (cloudBuild ? source.replaceAll('$$', '$') : source)
    .replaceAll('${GOOGLE_ANALYTICS_MEASUREMENT_ID}', '$GOOGLE_ANALYTICS_MEASUREMENT_ID')
    .replaceAll('${GATEWAY_URL}', '$GATEWAY_URL');
}

function runtimeConfigLines(source, cloudBuild = false) {
  const normalized = normalizeShell(source, cloudBuild);
  const validation = normalized.indexOf('GOOGLE_ANALYTICS_MEASUREMENT_ID must be empty');
  const start = normalized.indexOf("printf '%s\\n' \\", validation);
  const target = normalized.indexOf('config.js', start);
  assert.ok(validation >= 0 && start > validation && target > start, 'missing runtime config block');
  const end = normalized.indexOf('\n', target);
  const block = normalized.slice(start, end === -1 ? normalized.length : end);
  return [...block.matchAll(/^\s*"([^"]+)" \\$/gm)].map((match) => match[1]);
}

test('deploy entry points share the blank/valid/invalid GA4 id contract', () => {
  const accepted = (value) => value === '' || /^G-[A-Z0-9]+$/.test(value);
  assert.equal(accepted(''), true);
  assert.equal(accepted('G-ABC123XYZ9'), true);
  assert.equal(accepted('UA-123456-1'), false);

  const validation = 'if [[ -n "$GOOGLE_ANALYTICS_MEASUREMENT_ID" && ! "$GOOGLE_ANALYTICS_MEASUREMENT_ID" =~ ^G-[A-Z0-9]+$ ]]; then';
  for (const [name, source] of Object.entries(sources)) {
    assert.ok(normalizeShell(source, name === 'Cloud Build').includes(validation), `${name} validation drifted`);
  }
});

test('manual, Firebase, and Cloud Build deploys generate identical runtime config', () => {
  const expected = [
    "window.__API_BASE__='$GATEWAY_URL';",
    "window.__GA_MEASUREMENT_ID__='$GOOGLE_ANALYTICS_MEASUREMENT_ID';",
    "(()=>{const link=document.createElement('link');link.rel='preconnect';link.href=window.__API_BASE__;link.crossOrigin='anonymous';document.head.appendChild(link);})();",
  ];

  assert.deepEqual(runtimeConfigLines(sources.manual), expected);
  assert.deepEqual(runtimeConfigLines(sources.Firebase), expected);
  assert.deepEqual(runtimeConfigLines(sources['Cloud Build'], true), expected);
});

test('blank or unset bootstrap input removes a stale repo variable and gh failures remain fatal', () => {
  assert.match(
    sources.bootstrap,
    /^GOOGLE_ANALYTICS_MEASUREMENT_ID="\$\{GOOGLE_ANALYTICS_MEASUREMENT_ID:-\}"$/m,
  );
  assert.match(sources.bootstrap, /^set -euo pipefail$/m);

  const start = sources.bootstrap.indexOf('if [ -n "$GOOGLE_ANALYTICS_MEASUREMENT_ID" ]; then');
  const end = sources.bootstrap.indexOf('\n  [ -n "${EMAIL_SMTP_HOST:-}"', start);
  assert.ok(start >= 0 && end > start, 'missing GitHub analytics-variable reconciliation');
  const block = sources.bootstrap.slice(start, end);

  const set = block.indexOf('gh variable set GOOGLE_ANALYTICS_MEASUREMENT_ID');
  const list = block.indexOf('gh variable list --repo "$REPO" --json name --jq');
  const match = block.indexOf('grep -Fxq GOOGLE_ANALYTICS_MEASUREMENT_ID');
  const remove = block.indexOf('gh variable delete GOOGLE_ANALYTICS_MEASUREMENT_ID');
  assert.ok(set >= 0 && list > set && match > list && remove > match);
  assert.doesNotMatch(block, /\|\| true/);
});

test('manual and Cloud Build GCS deploys match Firebase no-store config policy', () => {
  const firebase = JSON.parse(read('firebase.json'));
  const configRule = firebase.hosting.headers.find(({ source }) => source === '/config.js');
  assert.deepEqual(configRule?.headers, [{ key: 'Cache-Control', value: 'no-store' }]);

  for (const [name, source] of [['manual', sources.manual], ['Cloud Build', sources['Cloud Build']]]) {
    const publish = source.indexOf('gsutil -m rsync');
    const noStore = source.indexOf('gsutil setmeta -h "Cache-Control:no-store"', publish);
    assert.ok(publish >= 0 && noStore > publish, `${name} must set config metadata after upload`);
    const command = source.slice(noStore, source.indexOf('\n', noStore));
    assert.match(command, /config\.js/);
    assert.doesNotMatch(command, /\|\| true/);
  }
});
