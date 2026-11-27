import test from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLE_BASES, bundleBase, type BundleBase } from '@fleet-local/shared';
import { GENERATOR_VERSION, bundleKey, entryId, renderBundleDockerfile, sortEntries, type BundleEntry } from '../src/bundle/dockerfile.ts';
import { packById } from '../src/bundle/plugins.ts';

const pin = (repo: string, c: string) => `${repo}@sha256:${c.repeat(64)}`;
const base = (runtime: string): BundleBase => bundleBase(runtime)!;

// A pack is mirrored from the catalog, so the tests use real catalog entries where
// the requirement lines are the thing under test, and synthetic ones where only
// the shape matters.
const entry = (id: string, version = '1.0.0', requirements: BundleEntry['requirements'] = { packages: [], dockerfile: ['RUN apt-get install -y git'], dockerfileAlpine: ['RUN apk add --no-cache git'] }): BundleEntry => ({ id, version, requirements });

const render = (runtime: string, entries: BundleEntry[], c = 'a') =>
  renderBundleDockerfile({ base: base(runtime), baseRef: pin(base(runtime).repo, c), entries });

test('an alpine base gets apk lines and never the Debian default', () => {
  const graphify = packById('graphify')!;
  const out = render('claude', [{ id: graphify.id, version: graphify.version, requirements: graphify.requirements }]);
  assert.deepEqual(out.errors, [], out.errors.join('\n'));
  assert.ok(!/apt-get/.test(out.dockerfile), out.dockerfile);
  assert.match(out.dockerfile, /RUN apk add --no-cache git ca-certificates python3 py3-pip/);
  // The data bug these lines exist to prevent: uv installs its tools under the
  // building user's home, and the runtime runs as uid 65532.
  assert.ok(!/\/root\/\.local/.test(out.dockerfile), 'a bundle must not put tools where the agent cannot reach them');
  assert.match(out.dockerfile, /UV_TOOL_DIR=\/opt\/uv/);
});

test('a Debian base keeps its apt lines', () => {
  const crg = packById('code-review-graph')!;
  const out = render('qoder', [{ id: crg.id, version: crg.version, requirements: crg.requirements }]);
  assert.deepEqual(out.errors, [], out.errors.join('\n'));
  assert.match(out.dockerfile, /RUN apt-get update && apt-get install -y --no-install-recommends git/);
  assert.ok(!/apk add/.test(out.dockerfile));
});

test('the base contract is re-emitted after the installs, from the table and not the catalog', () => {
  const out = render('claude', [entry('ecc')]);
  const lines = out.dockerfile.trim().split('\n');
  assert.deepEqual(lines.slice(-3), ['USER 65532:65532', 'WORKDIR /data', 'ENTRYPOINT ["/usr/local/bin/claude-runtime"]']);
  assert.equal(lines[1], `FROM ${pin('ghcr.io/niravshah2705/symphony/claude-runtime', 'a')}`);
  assert.equal(lines[2], 'USER 0:0', 'installs run as root, then the image drops back');
  const byo = render('qoder', [entry('ecc')]);
  assert.match(byo.dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/qoder-runtime"\]/);
});

test('identical inputs give an identical key, and plugin order is not an input', () => {
  const a = render('claude', [entry('ecc'), entry('graphify', '0.9.112')]);
  const b = render('claude', [entry('graphify', '0.9.112'), entry('ecc')]);
  assert.equal(a.key, b.key);
  assert.equal(a.dockerfile, b.dockerfile, 'the file is sorted too, so the tag and the bytes agree');
  assert.match(a.key, /^[a-f0-9]{64}$/);
  assert.match(a.dockerfile, new RegExp(`key=${a.key.slice(0, 12)}`));
});

test('anything that changes the image content changes the key', () => {
  const at = entry('ecc');
  assert.notEqual(bundleKey({ baseRef: pin('r/x', 'a'), entries: [at] }), bundleKey({ baseRef: pin('r/x', 'b'), entries: [at] }), 'base digest');
  assert.notEqual(bundleKey({ baseRef: pin('r/x', 'a'), entries: [at] }), bundleKey({ baseRef: pin('r/x', 'a'), entries: [{ ...at, version: '2.0.0' }] }), 'pack version');
  assert.notEqual(
    bundleKey({ baseRef: pin('r/x', 'a'), entries: [entry('ecc', '1.0.0', { packages: [], dockerfile: ['RUN apt-get install -y git'] })] }),
    bundleKey({ baseRef: pin('r/x', 'a'), entries: [entry('ecc', '1.0.0', { packages: [], dockerfile: ['RUN apt-get install -y curl'] })] }),
    'requirement lines',
  );
  // The empty selection is not the same image as one pack, and the generator
  // version is part of the key so a rule change cannot reuse a cached tag.
  assert.notEqual(bundleKey({ baseRef: pin('r/x', 'a'), entries: [] }), bundleKey({ baseRef: pin('r/x', 'a'), entries: [at] }));
  assert.match(bundleKey({ baseRef: pin('r/x', 'a'), entries: [at] }), /^[a-f0-9]{64}$/);
  assert.ok(GENERATOR_VERSION);
});

test('a base with no digest is refused before a build is paid for', () => {
  const out = renderBundleDockerfile({ base: base('claude'), baseRef: `${base('claude').repo}:2.1.326`, entries: [entry('ecc')] });
  assert.match(out.errors.join('\n'), /not digest-pinned/);
  assert.equal(out.dockerfile, '');
});

test('a pack with no alpine lines is refused rather than given apt on alpine', () => {
  const out = render('claude', [entry('ecc', '1.0.0', { packages: [], dockerfile: ['RUN apt-get install -y git'] })]);
  assert.match(out.errors.join('\n'), /no apk requirement lines for the claude base/);
  assert.match(out.errors.join('\n'), /dockerfileAlpine is missing/);
});

test('only RUN, ENV and WORKDIR get through, and a credential-shaped line never does', () => {
  const refused = ['COPY secrets /etc', 'USER 0:0', 'VOLUME /data', 'ARG FOO=bar', 'ADD http://x/y /'];
  for (const line of refused) {
    const out = render('qoder', [entry('ecc', '1.0.0', { packages: [], dockerfile: [line] })]);
    assert.match(out.errors.join('\n'), /not an allowed requirement line/, line);
  }
  // A RUN that pipes an installer is an allowed instruction: the allowlist is
  // about Dockerfile semantics, not about which commands a pack is trusted to run.
  const ok = render('qoder', [entry('ecc', '1.0.0', { packages: [], dockerfile: ['RUN curl -sf https://x | sh'] })]);
  assert.deepEqual(ok.errors, []);
  for (const line of [
    'RUN echo $LINEAR_API_KEY=abc >> /env',
    'ENV OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx',
    'RUN git clone https://ghp_AAAAAAAAAAAAAAAAAAAA@github.com/x/y',
  ]) {
    const out = render('qoder', [entry('ecc', '1.0.0', { packages: [], dockerfile: [line] })]);
    assert.match(out.errors.join('\n'), /credential/, line);
  }
});

test('a /root path is refused, not rewritten, because the tools would be unreachable', () => {
  const out = render('qoder', [entry('ecc', '1.0.0', { packages: [], dockerfile: ['ENV PATH="/root/.local/bin:${PATH}"'] })]);
  assert.match(out.errors.join('\n'), /uid 65532 cannot read/);
  assert.equal(out.dockerfile, '');
});

test('shared requirement lines are installed once', () => {
  const crg = packById('code-review-graph')!;
  const graphify = packById('graphify')!;
  const out = render('claude', [
    { id: crg.id, version: crg.version, requirements: crg.requirements },
    { id: graphify.id, version: graphify.version, requirements: graphify.requirements },
  ]);
  assert.deepEqual(out.errors, [], out.errors.join('\n'));
  const apk = out.dockerfile.split('\n').filter((l) => l.startsWith('RUN apk add'));
  assert.equal(new Set(apk).size, apk.length, out.dockerfile);
  const envs = out.dockerfile.split('\n').filter((l) => l.startsWith('ENV '));
  assert.equal(new Set(envs).size, envs.length);
});

test('every catalog pack renders clean onto every base whose family it supports', () => {
  // The parity gate: a pack that gained apt lines without alpine lines passes the
  // root validator and fails here, on the claude/codex bases it claims support for.
  for (const b of BUNDLE_BASES) {
    if (b.matrixColumn !== 'claude' && b.matrixColumn !== 'codex') continue;
    for (const id of ['ecc', 'agent-skills', 'superpowers', 'spec-kit', 'graphify', 'code-review-graph', 'hallmark', 'egm', 'security-audit']) {
      const pack = packById(id)!;
      const out = render(b.runtime, [{ id: pack.id, version: pack.version, requirements: pack.requirements }]);
      assert.deepEqual(out.errors, [], `${id} on ${b.runtime}: ${out.errors.join('; ')}`);
      assert.ok(out.dockerfile.endsWith('"]\n'), `${id} on ${b.runtime}: ENTRYPOINT must close the file`);
    }
  }
});

test('sortEntries and entryId are the key-normalising primitives', () => {
  assert.deepEqual(sortEntries([entry('graphify'), entry('ecc')]).map((e) => e.id), ['ecc', 'graphify']);
  assert.equal(entryId(entry('ecc', '2.2.3')), 'ecc@2.2.3');
  // Input order is not mutated: the caller keeps its own selection order for display.
  const input = [entry('graphify'), entry('ecc')];
  sortEntries(input);
  assert.deepEqual(input.map((e) => e.id), ['graphify', 'ecc']);
});
