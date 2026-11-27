import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchSecret } from '../src/clients/k8s.ts';

// Regression for the way patchSecret used to write the merge patch:
// `--patch-file /dev/stdin`. kubectl *opens* that path, and Node's child stdio is a
// socketpair — readable on fd 0, not reopenable by path, so the deployed rotation
// loop died with ENXIO ("unable to read patch file: no such device or address").
// Both tests drive the real src/clients/k8s.ts against a fake kubectl on PATH, so
// what they assert is the argv and the file the binary really receives.
const SECRET = 'jt-0123456789abcdef0123456789abcdef';

interface FakeResult {
  argv: string[];
  probe: string;
  error?: unknown;
}

// `script` is the shim body; it is handed the probe prefix and records there what it
// was given. Cleanup runs after the test body, so the assertions can still read it.
async function withFakeKubectl(
  t: { after: (fn: () => void) => void },
  script: (probe: string) => string,
  run: () => Promise<void>,
): Promise<FakeResult> {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-k8s-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = join(dir, 'probe');
  const bin = join(dir, 'kubectl');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${probe}.args'\n${script(probe)}\n`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  let error: unknown;
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    await run();
  } catch (err) {
    error = err;
  } finally {
    process.env.PATH = path;
  }
  const argv = readFileSync(`${probe}.args`, 'utf8').trim().split('\n');
  return error === undefined ? { argv, probe } : { argv, probe, error };
}

test('patchSecret hands kubectl a file it can open by path, never a pipe or an argv value', async (t) => {
  const { argv, probe, error } = await withFakeKubectl(
    t,
    // `head` reads the path the way kubectl does — by name, not through fd 0 — so an
    // implementation that pipes the patch in fails here instead of passing vacuously.
    (p) => `while [ $# -gt 0 ]; do
  if [ "$1" = --patch-file ]; then shift; head -c 200 "$1" > '${p}.body' || exit 3; fi
  shift
done`,
    async () => {
      await patchSecret('litellm-test-default', 'org-test', { data: { QODER_API_KEY: SECRET } });
    },
  );
  assert.ok(error === undefined, 'patchSecret must succeed against a readable patch file');
  assert.deepEqual(JSON.parse(readFileSync(`${probe}.body`, 'utf8')), { data: { QODER_API_KEY: SECRET } });
  assert.match(argv.join(' '), /patch secret litellm-test-default -n org-test --type merge/);
  assert.ok(!argv.includes('/dev/stdin'), 'the patch file must be a real path, not a pipe');
  assert.ok(!argv.some((a) => a.includes(SECRET)), 'the credential must not reach argv — run() echoes argv on failure');
});

test('the patch file is 0600 and is unlinked even when kubectl fails', async (t) => {
  const { probe, error } = await withFakeKubectl(
    t,
    // GNU stat in the Linux image, BSD stat on the macOS dev box.
    (p) => `while [ $# -gt 0 ]; do
  if [ "$1" = --patch-file ]; then shift
    stat -c '%a %n' "$1" > '${p}.stat' 2>/dev/null || stat -f '%Lp %N' "$1" > '${p}.stat'
    cp "$1" '${p}.content'
  fi
  shift
done
exit 1`,
    async () => {
      await assert.rejects(
        () => patchSecret('s', 'ns', { data: { QODER_API_KEY: SECRET } }),
        /kubectl patch secret s/,
      );
    },
  );
  assert.ok(error === undefined, 'the kubectl failure is the only rejection, and it was asserted inside run');
  const [mode, file] = readFileSync(`${probe}.stat`, 'utf8').trim().split(' ');
  assert.equal(mode, '600', 'the patch holds a credential: it must not be readable by others in the pod');
  assert.equal(readFileSync(`${probe}.content`, 'utf8'), JSON.stringify({ data: { QODER_API_KEY: SECRET } }));
  assert.throws(() => statSync(file), 'the temp patch file is unlinked in finally, on the failure path too');
});
