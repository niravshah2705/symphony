'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const WORKFLOW = path.resolve(__dirname, '../../.github/workflows/sync-harness-registry.yml');

function workflowText() {
  return fs.readFileSync(WORKFLOW, 'utf8');
}

function jobBlock(source, name) {
  const marker = `\n  ${name}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name} job`);
  const rest = source.slice(start + marker.length);
  const next = rest.search(/^  [a-z][a-z0-9_-]*:\n/m);
  return next === -1 ? rest : rest.slice(0, next);
}

test('harness registry workflow has isolated resolve, seven-leg build, assemble, and publish jobs', () => {
  const source = workflowText();
  const resolve = jobBlock(source, 'resolve');
  const build = jobBlock(source, 'build');
  const assemble = jobBlock(source, 'assemble');
  const publish = jobBlock(source, 'publish');

  assert.match(source, /^permissions: \{\}$/m);
  assert.match(resolve, /build-harness-artifact\.js resolve/);
  assert.match(resolve, /source\.json/);
  assert.match(resolve, /source\.tar\.gz/);
  assert.match(resolve, /name: ecc-resolved-source[\s\S]*include-hidden-files: true/);
  assert.match(build, /needs: resolve/);
  assert.match(build, /fail-fast: false/);
  assert.match(assemble, /needs: build/);
  assert.match(assemble, /build-harness-artifact\.js assemble/);
  assert.match(assemble, /build-harness-artifact\.js verify/);
  assert.match(publish, /needs: assemble/);

  const harnesses = [...build.matchAll(/^\s+- harness: ([a-z0-9-]+)$/gm)].map((match) => match[1]);
  assert.deepEqual(harnesses, [
    'deepagent',
    'codex-sdk',
    'claude-agent-sdk',
    'antigravity-sdk',
    'opencode',
    'pi',
    'oh-my-pi',
  ]);
});

test('only the publish job can mint cloud credentials', () => {
  const source = workflowText();
  const resolve = jobBlock(source, 'resolve');
  const build = jobBlock(source, 'build');
  const assemble = jobBlock(source, 'assemble');
  const publish = jobBlock(source, 'publish');

  assert.doesNotMatch(resolve, /id-token:|secrets\.|google-github-actions\/auth/);
  assert.doesNotMatch(build, /id-token:|secrets\.|google-github-actions\/auth/);
  assert.doesNotMatch(assemble, /id-token:|secrets\.|google-github-actions\/auth/);
  assert.match(publish, /id-token: write/);
  assert.doesNotMatch(publish, /contents: read/);
  assert.match(publish, /google-github-actions\/auth@v2/);
  assert.equal((source.match(/google-github-actions\/auth@v2/g) || []).length, 1);
  assert.equal((source.match(/id-token: write/g) || []).length, 1);

  const validate = publish.indexOf('Validate publish payload');
  const auth = publish.indexOf('Authenticate to Google Cloud');
  assert.ok(validate !== -1 && validate < auth, 'payload must be validated before cloud auth');
  const validateBlock = publish.slice(validate, auth);
  assert.match(validateBlock, /for HARNESS_ID in/);
  assert.match(validateBlock, /sha256sum "\$ARCHIVE"/);
  assert.match(validateBlock, /test "\$INDEX_SHA" = "\$DESCRIPTOR_SHA"/);
  assert.match(validateBlock, /test "\$INDEX_SHA" = "\$ACTUAL_SHA"/);
  assert.match(validateBlock, /test "\$DESCRIPTOR_SIZE" = "\$ACTUAL_SIZE"/);
});

test('matrix provisions only the harness-specific runtimes and publishes registry index last', () => {
  const source = workflowText();
  const build = jobBlock(source, 'build');
  const publish = jobBlock(source, 'publish');

  assert.match(build, /Set up Python for DCode[\s\S]*if: \$\{\{ matrix\.python \}\}[\s\S]*python-version: "3\.13"/);
  assert.match(build, /Set up Bun for Oh My Pi[\s\S]*if: \$\{\{ matrix\.bun \}\}[\s\S]*bun-version: "1\.3\.14"/);
  assert.match(build, /HOME: \$\{\{ runner\.temp \}\}\/harness-home/);
  assert.match(build, /GIT_TERMINAL_PROMPT: "0"/);
  assert.match(build, /build-harness-artifact\.js build/);
  assert.match(build, /name: harness-\$\{\{ matrix\.harness \}\}[\s\S]*include-hidden-files: true/);

  const publishHarnesses = publish.indexOf('rsync -r -d "$STAGING/harnesses" "$DEST/harnesses"');
  const publishInert = publish.indexOf('rsync -r -d "$STAGING/inert" "$DEST/inert"');
  const removePriorIndex = publish.indexOf('gsutil rm "$DEST/registry.json"');
  const publishIndex = publish.indexOf('gsutil cp "$STAGING/registry.json" "$DEST/registry.json"');
  const verifyIndex = publish.indexOf('test "$INDEX_SHA" = "$PUBLISHED_INDEX_SHA"');
  const removeOriginal = publish.indexOf('gsutil -m rm -r "$DEST/original"');
  const removeGeneric = publish.indexOf('gsutil -m rm -r "$DEST/generic"');
  const removeManifest = publish.indexOf('gsutil rm "$LEGACY_POINTER"');
  assert.ok(removePriorIndex !== -1 && removePriorIndex < publishHarnesses);
  assert.ok(publishHarnesses !== -1 && publishHarnesses < publishIndex);
  assert.ok(publishInert !== -1 && publishInert < publishIndex);
  assert.ok(verifyIndex !== -1 && verifyIndex < removeOriginal);
  assert.ok(verifyIndex < removeGeneric);
  assert.ok(verifyIndex < removeManifest);
  assert.doesNotMatch(publish, /rm -r "\$DEST"(?:\s|$)/);
  assert.doesNotMatch(publish, /rsync -r -d "\$STAGING" "\$DEST"/);
});
