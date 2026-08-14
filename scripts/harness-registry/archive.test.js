'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const {
  assertSafeArchivePath,
  createDeterministicTarGz,
  extractTarGz,
  listTarGz,
  sha256File,
} = require('./archive');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-archive-test-'));
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'home', '.config'), { recursive: true });
  fs.mkdirSync(path.join(source, 'project'), { recursive: true });
  fs.writeFileSync(path.join(source, 'home', '.config', 'plugin.json'), '{"enabled":true}\n');
  fs.writeFileSync(path.join(source, 'project', 'AGENTS.md'), '# Installed\n', { mode: 0o644 });
  fs.writeFileSync(path.join(source, 'project', 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.symlinkSync('../project/AGENTS.md', path.join(source, 'home', 'instructions'));
  return { root, source };
}

test('deterministic archive is byte-identical across mtime changes and extracts safely', (t) => {
  const { root, source } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'first.tar.gz');
  const second = path.join(root, 'second.tar.gz');

  const one = createDeterministicTarGz(source, first);
  const future = new Date('2040-01-02T03:04:05Z');
  fs.utimesSync(path.join(source, 'project', 'AGENTS.md'), future, future);
  fs.utimesSync(path.join(source, 'project'), future, future);
  const two = createDeterministicTarGz(source, second);

  assert.equal(one.sha256, two.sha256);
  assert.deepEqual(fs.readFileSync(first), fs.readFileSync(second));
  assert.equal(one.fileCount, 3);
  assert.equal(sha256File(first), one.sha256);
  assert.deepEqual(
    listTarGz(first).map(({ path: entryPath, type, mode, link }) => ({ entryPath, type, mode, link })),
    [
      { entryPath: 'home', type: '5', mode: 0o755, link: null },
      { entryPath: 'home/.config', type: '5', mode: 0o755, link: null },
      { entryPath: 'home/.config/plugin.json', type: '0', mode: 0o644, link: null },
      { entryPath: 'home/instructions', type: '2', mode: 0o777, link: '../project/AGENTS.md' },
      { entryPath: 'project', type: '5', mode: 0o755, link: null },
      { entryPath: 'project/AGENTS.md', type: '0', mode: 0o644, link: null },
      { entryPath: 'project/run.sh', type: '0', mode: 0o755, link: null },
    ]
  );

  const extracted = path.join(root, 'extracted');
  extractTarGz(first, extracted);
  assert.equal(fs.readFileSync(path.join(extracted, 'project', 'AGENTS.md'), 'utf8'), '# Installed\n');
  assert.equal(fs.readlinkSync(path.join(extracted, 'home', 'instructions')), '../project/AGENTS.md');
  assert.notEqual(fs.statSync(path.join(extracted, 'project', 'run.sh')).mode & 0o111, 0);
});

test('archive creation rejects paths and symlinks that escape the root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-archive-unsafe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'inside'), 'ok');
  fs.symlinkSync('../../etc/passwd', path.join(root, 'escape'));

  assert.throws(
    () => createDeterministicTarGz(root, path.join(root, 'unsafe.tar.gz')),
    /Symlink escapes archive root/
  );
  for (const unsafe of ['/absolute', '../escape', 'safe/../../escape', 'safe//double']) {
    assert.throws(() => assertSafeArchivePath(unsafe), /Unsafe archive path/);
  }
});

test('archive extraction refuses a non-empty destination', (t) => {
  const { root, source } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'rootfs.tar.gz');
  createDeterministicTarGz(source, archive);
  const destination = path.join(root, 'destination');
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'keep'), 'user-data');

  assert.throws(() => extractTarGz(archive, destination), /must be empty/);
  assert.equal(fs.readFileSync(path.join(destination, 'keep'), 'utf8'), 'user-data');
});

test('archive parser rejects a crafted traversal path before extraction', (t) => {
  const { root, source } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const valid = path.join(root, 'valid.tar.gz');
  const crafted = path.join(root, 'crafted.tar.gz');
  const outsideName = `traversal-${path.basename(root)}`;
  const traversalPath = `../${outsideName}`;
  createDeterministicTarGz(source, valid);

  const tar = zlib.gunzipSync(fs.readFileSync(valid));
  tar.fill(0, 0, 100);
  Buffer.from(traversalPath, 'utf8').copy(tar, 0);
  tar.fill(0x20, 148, 156);
  const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  Buffer.from(checksum.toString(8).padStart(6, '0'), 'ascii').copy(tar, 148);
  tar[154] = 0;
  tar[155] = 0x20;
  fs.writeFileSync(crafted, zlib.gzipSync(tar, { level: 9, mtime: 0 }));

  assert.throws(() => listTarGz(crafted), /Unsafe archive path/);
  assert.throws(() => extractTarGz(crafted, path.join(root, 'destination')), /Unsafe archive path/);
  assert.equal(fs.existsSync(path.join(root, '..', outsideName)), false);
});
