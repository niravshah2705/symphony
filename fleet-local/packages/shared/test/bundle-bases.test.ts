import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUNDLE_BASES, BUNDLE_STEPS, bundleAdapter, bundleTarget, type BundleBase } from '../src/index.ts';

// The repo root, for the cross-checks against the sources this table copies. In
// the BFF image these files do not exist (deploy/bff/Dockerfile builds only the
// fleet-local workspace), so every source assertion is guarded by existence and
// the invariants below still run.
const ROOT = path.resolve(import.meta.dirname, '../../../..');
const CSV = path.join(ROOT, 'go/harness/runtime-images.csv');
const CATALOG = path.join(ROOT, 'packages/shared-core/src/agent/registry/plugin-catalog.json');

const byRuntime = new Map<string, BundleBase>(BUNDLE_BASES.map((b) => [b.runtime, b]));

test('the base list is unique per runtime and self-consistent about the adapter', () => {
  assert.equal(new Set(BUNDLE_BASES.map((b) => b.runtime)).size, BUNDLE_BASES.length);
  for (const base of BUNDLE_BASES) {
    assert.match(base.repo, /^[^/]+(\/[^/]+)+$/, `${base.runtime}: repo carries no tag or digest`);
    assert.doesNotMatch(base.repo, /[:@]/, `${base.runtime}: repo must be addressed separately from its pin`);
    assert.match(base.version, /^\d/, `${base.runtime}: version is the CSV version column`);
    // The chart requires workload.command on byo and forbids it on the native
    // engines, so exactly one of these two shapes is renderable.
    if (base.harnessType === 'byo') {
      assert.match(bundleAdapter(base), /^\/usr\/local\/bin\/[a-z0-9-]+-runtime$/, `${base.runtime}: adapter path`);
    } else {
      assert.equal(base.adapter, undefined, `${base.runtime}: ${base.harnessType} is a native engine and takes no command`);
    }
  }
});

test('the alpine bases are exactly the two that install with apk', () => {
  assert.deepEqual(BUNDLE_BASES.filter((b) => b.family === 'apk').map((b) => b.runtime), ['claude', 'codex']);
});

test('only a dispatchable runtime can carry a bundle the owner will actually chat against', () => {
  // docs/RUNTIME_IMAGES.md: the other rows have no AgentTemplate.spec key and no
  // controller translator, so they are buildable but not runnable. The set is
  // pinned here so a base cannot be flipped to dispatchable without that gap closing.
  assert.deepEqual(BUNDLE_BASES.filter((b) => b.dispatchable).map((b) => b.runtime).sort(), ['claude', 'codex', 'qoder']);
  for (const base of BUNDLE_BASES) {
    assert.ok(base.label.length > 0, base.runtime);
  }
});

test('the target is content addressed, so a new selection is a new run', () => {
  assert.equal(bundleTarget('claude', 'a'.repeat(64)), `claude:${'a'.repeat(12)}`);
  // A different key is a different target; the same key from a different runtime
  // is still a different target, because the base image is part of the input.
  assert.notEqual(bundleTarget('claude', 'a'.repeat(64)), bundleTarget('codex', 'a'.repeat(64)));
});

test('every current row of go/harness/runtime-images.csv has a base, with the same repo and version', (t) => {
  if (!fs.existsSync(CSV)) return t.skip(`${CSV} is not in this checkout`);
  const rows = fs
    .readFileSync(CSV, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.split(','))
    .filter((cols) => cols[6] === 'true');
  const current = rows.map((cols) => cols[0]);
  assert.deepEqual(current.sort(), BUNDLE_BASES.map((b) => b.runtime).sort(), 'the table and the CSV cover different runtimes');
  for (const cols of rows) {
    const [runtime, dockerfile, image, version] = cols;
    const base = byRuntime.get(runtime)!;
    assert.equal(base.repo, image, runtime);
    assert.equal(base.version, version, runtime);
    // The path matters beyond provenance: an unsupported matrix cell names the
    // runtime Dockerfile it is blocked on, and that string is matched here.
    assert.equal(base.dockerfile, dockerfile, runtime);
    assert.ok(fs.existsSync(path.join(ROOT, dockerfile)), `${runtime}: ${dockerfile} is not in the checkout`);
  }
});

test('the package family matches what the runtime Dockerfile actually uses', (t) => {
  if (!fs.existsSync(CSV)) return t.skip('the CSV locates the Dockerfiles');
  for (const base of BUNDLE_BASES) {
    const row = fs
      .readFileSync(CSV, 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => line.split(','))
      .find((cols) => cols[0] === base.runtime && cols[6] === 'true');
    if (!row) continue;
    const dockerfile = path.join(ROOT, row[1]);
    if (!fs.existsSync(dockerfile)) continue;
    const src = fs.readFileSync(dockerfile, 'utf8');
    // Match the package manager, not `RUN apt-get`: a Dockerfile installs with a
    // line-continued shell block, so the command is often not at a line start.
    const usesApt = /\bapt-get\b/.test(src);
    const usesApk = /\bapk add\b/.test(src);
    assert.notEqual(usesApt, usesApk, `${base.runtime}: Dockerfile must use exactly one package manager`);
    assert.equal(base.family, usesApt ? 'apt' : 'apk', `${base.runtime}: family must follow its Dockerfile`);
    // The bundle generator re-emits these two lines after the root-run installs,
    // so a base that stops ending this way needs the generator changed too.
    assert.match(src, /^USER 65532:65532$/m, `${base.runtime}: uid 65532 contract`);
    assert.match(src, /^WORKDIR \/data$/m, `${base.runtime}: workspace contract`);
  }
});

test('every matrix column a base claims exists, and agrees with its harness type', async (t) => {
  if (!fs.existsSync(CATALOG)) return t.skip(`${CATALOG} is not in this checkout`);
  // MATRIX_COLUMNS is declared in the root workspace's plugin-catalog.js, which
  // this workspace cannot import (separate npm workspaces, and absent from the BFF
  // image). Requiring it by path in a checkout is what keeps the join key honest.
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { MATRIX_COLUMNS, STATUSES } = require(path.join(ROOT, 'packages/shared-core/src/agent/registry/plugin-catalog.js'));
  const claimed = BUNDLE_BASES.filter((b) => b.matrixColumn !== '').map((b) => b.matrixColumn);
  assert.ok(claimed.length >= 6, 'most bases should join a catalog column, so an almost-empty list is a mistake');
  for (const base of BUNDLE_BASES) {
    // A base with no column reaches no pack: gemini installs @google/gemini-cli,
    // which is not the antigravity column, and kilo and goose are in no column.
    if (base.matrixColumn === '') continue;
    const column = MATRIX_COLUMNS[base.matrixColumn];
    assert.ok(column, `${base.runtime}: ${base.matrixColumn} is not a catalog column`);
    // engine null is deepagent, which the chart renders as byo with an adapter —
    // the plan's resolution of the "deepagent maps to no engine" question.
    const expected = column.engine === null ? 'byo' : column.engine;
    assert.equal(base.harnessType, expected, `${base.runtime}: ${base.matrixColumn} is engine ${column.engine}`);
    for (const pack of JSON.parse(fs.readFileSync(CATALOG, 'utf8')).plugins) {
      const cell = pack.harnesses[base.matrixColumn];
      if (!cell) continue;
      assert.ok(STATUSES.includes(cell.status), `${pack.id}/${base.matrixColumn}: unknown status`);
    }
  }
});
