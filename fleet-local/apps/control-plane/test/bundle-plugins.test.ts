import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleBase, type BundleBase } from '@fleet-local/shared';
import {
  ALL_PACKS,
  availabilityOf,
  packById,
  packsFor,
  requirementLines,
  selectablePackIds,
} from '../src/bundle/plugins.ts';
import { GENERATED_AT_REVISION } from '../src/bundle/packs.generated.ts';

const base = (runtime: string): BundleBase => bundleBase(runtime)!;
const ids = (runtime: string, want: string): string[] =>
  packsFor(base(runtime))
    .filter((v) => v.availability === want)
    .map((v) => v.pack.id)
    .sort();

test('the mirror carries every pack, with the fields a build reads', () => {
  assert.match(GENERATED_AT_REVISION, /^[a-f0-9]{12}$/);
  assert.equal(ALL_PACKS.length, 9, 'eight plugin packs plus the standalone skill');
  assert.deepEqual(ALL_PACKS.map((p) => p.id), [...ALL_PACKS.map((p) => p.id)].sort(), 'sorted, so the file is byte-stable');
  for (const pack of ALL_PACKS) {
    assert.ok(pack.label.length > 0, pack.id);
    assert.ok(['plugin', 'skill'].includes(pack.kind), pack.id);
    assert.match(pack.version, /\S/, pack.id);
    assert.ok(pack.requirements.dockerfile.length > 0, `${pack.id}: no apt lines`);
    assert.ok(pack.promptAppend.length > 0, pack.id);
    assert.ok(Object.keys(pack.cells).length > 0, `${pack.id}: mirrored no matrix cells`);
    for (const cell of Object.values(pack.cells)) {
      assert.ok(['built', 'bundled', 'declared', 'unsupported'].includes(cell.status), `${pack.id}: ${cell.status}`);
      if (cell.status === 'unsupported') assert.ok(cell.blockedOn || cell.limitations?.length, `${pack.id}: unsupported names no blocker`);
    }
    if (pack.kind === 'plugin') assert.match(pack.dataImage ?? '', /-plugin$/, pack.id);
  }
});

test('claude and codex are the two runtimes with a live plugin story today', () => {
  // Every pack declares codex and claude, and no cell outside those two columns
  // is anything but unsupported — which is the reviewed state of the matrix, not a
  // mirroring bug. Pinned so a catalog change is a deliberate act here too.
  for (const runtime of ['claude', 'codex']) {
    assert.deepEqual(selectablePackIds(base(runtime)).sort(), ALL_PACKS.map((p) => p.id).sort(), runtime);
    assert.deepEqual(ids(runtime, 'offerable'), ALL_PACKS.map((p) => p.id).sort(), runtime);
  }
});

test('a cell blocked on exactly this runtime image is offered, because this build removes the blocker', () => {
  // code-review-graph/dsh is unsupported with blockedOn go/harness/dsh/Dockerfile;
  // the CSV calls that runtime deepseek. Matching only the full path would miss it.
  assert.deepEqual(ids('deepseek', 'unblocks-here'), ['code-review-graph']);
  assert.deepEqual(ids('opencode', 'unblocks-here').sort(), ['egm', 'hallmark']);
  assert.deepEqual(selectablePackIds(base('deepseek')), ['code-review-graph']);
  const verdict = availabilityOf(packById('code-review-graph')!, base('deepseek'));
  assert.match(verdict.reason, /this build is that image/);
});

test('a runtime that is not a matrix column reaches nothing, and says why', () => {
  for (const runtime of ['gemini', 'kilo', 'goose']) {
    assert.equal(base(runtime).matrixColumn, '');
    assert.deepEqual(ids(runtime, 'no-column'), ALL_PACKS.map((p) => p.id).sort(), runtime);
    assert.deepEqual(selectablePackIds(base(runtime)), []);
  }
  // qoder and pi and deepagent are columns, but no pack has been graded against
  // them: not-listed, which is different from blocked and reads differently to an owner.
  for (const runtime of ['qoder', 'pi', 'deepagent']) {
    assert.deepEqual(selectablePackIds(base(runtime)), [], runtime);
    assert.equal(availabilityOf(packById('ecc')!, base(runtime)).availability, 'not-listed');
  }
});

test('an unsupported cell waiting on a different image is never counted as offerable', () => {
  // The four unsupported cells in the catalog each name their own column's image,
  // so no real pack is blocked-elsewhere today. The rule is still what protects a
  // future one, so it is tested against a fabricated cell rather than skipped.
  const egm = packById('egm')!;
  const waitsOnSomethingElse = {
    ...egm,
    cells: { ...egm.cells, claude: { status: 'unsupported' as const, engine: 'claude', blockedOn: 'go/harness/antigravity/Dockerfile' } },
  };
  const verdict = availabilityOf(waitsOnSomethingElse, base('claude'));
  assert.equal(verdict.availability, 'blocked-elsewhere');
  assert.equal(verdict.reason, 'go/harness/antigravity/Dockerfile');
  assert.equal(
    selectablePackIds(base('claude')).includes('egm'),
    true,
    'and the real egm cell is live on claude, so the fabricated one is the only thing blocked',
  );
});

test('requirementLines resolves a family or returns null, never the other family', () => {
  const crg = packById('code-review-graph')!;
  assert.deepEqual(requirementLines(crg.requirements, 'apt'), crg.requirements.dockerfile);
  assert.deepEqual(requirementLines(crg.requirements, 'apk'), crg.requirements.dockerfileAlpine);
  assert.equal(requirementLines({ packages: [], dockerfile: ['RUN x'] }, 'apk'), null);
  assert.equal(requirementLines({ packages: [], dockerfile: ['RUN x'], dockerfileAlpine: [] }, 'apk'), null);
  assert.equal(requirementLines(undefined, 'apt'), null);
  // The point of the split: no mirrored pack may put an apt line on an alpine base
  // or an apk line on a Debian one.
  for (const pack of ALL_PACKS) {
    const apk = requirementLines(pack.requirements, 'apk') ?? [];
    assert.ok(!apk.some((l) => /apt-get/.test(l)), `${pack.id}: apt line in the alpine array`);
    assert.ok(!apk.some((l) => /\/root\//.test(l)), `${pack.id}: /root path the agent cannot read`);
    assert.ok(!pack.requirements.dockerfile.some((l) => /apk add/.test(l)), `${pack.id}: apk line in the default array`);
  }
});
