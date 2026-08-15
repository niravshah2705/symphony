'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLOCK_BYTES = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK_BYTES);

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function assertSafeArchivePath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) {
    throw new Error(`Invalid archive path: ${JSON.stringify(value)}`);
  }
  const normalized = path.posix.normalize(value);
  if (
    value.startsWith('/')
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized !== value.replace(/\/$/, '')
  ) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(value)}`);
  }
  return value;
}

function collectEntries(root, options = {}) {
  const rootPath = fs.realpathSync(root);
  const exclude = typeof options.exclude === 'function' ? options.exclude : () => false;
  const entries = [];

  function walk(absolute, relative) {
    const stat = fs.lstatSync(absolute);
    const rel = toPosix(relative);
    if (rel && exclude(rel, stat)) return;

    if (stat.isDirectory()) {
      if (rel) entries.push({ absolute, path: assertSafeArchivePath(rel), type: 'directory', stat });
      const children = fs.readdirSync(absolute).sort((a, b) => a.localeCompare(b, 'en'));
      for (const child of children) walk(path.join(absolute, child), path.join(relative, child));
      return;
    }

    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      if (target.startsWith('/') || target.includes('\0')) {
        throw new Error(`Unsafe symlink target in archive: ${rel} -> ${target}`);
      }
      const resolved = path.resolve(path.dirname(absolute), target);
      if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) {
        throw new Error(`Symlink escapes archive root: ${rel} -> ${target}`);
      }
      entries.push({ absolute, path: assertSafeArchivePath(rel), type: 'symlink', link: target, stat });
      return;
    }

    if (!stat.isFile()) throw new Error(`Unsupported archive entry type: ${absolute}`);
    entries.push({ absolute, path: assertSafeArchivePath(rel), type: 'file', stat });
  }

  walk(rootPath, '');
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function writeText(header, offset, length, value) {
  const bytes = Buffer.from(String(value), 'utf8');
  if (bytes.length > length) throw new Error(`Tar header value is too long: ${value}`);
  bytes.copy(header, offset);
}

function writeOctal(header, offset, length, value) {
  const text = Math.max(0, Number(value)).toString(8).padStart(length - 1, '0');
  if (text.length > length - 1) throw new Error(`Tar numeric value is too large: ${value}`);
  writeText(header, offset, length - 1, text);
  header[offset + length - 1] = 0;
}

function splitTarPath(relativePath) {
  const bytes = Buffer.byteLength(relativePath);
  if (bytes <= 100) return { name: relativePath, prefix: '' };
  const slashIndexes = [];
  for (let i = 0; i < relativePath.length; i += 1) {
    if (relativePath[i] === '/') slashIndexes.push(i);
  }
  for (let i = slashIndexes.length - 1; i >= 0; i -= 1) {
    const prefix = relativePath.slice(0, slashIndexes[i]);
    const name = relativePath.slice(slashIndexes[i] + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Path cannot be represented in a portable ustar archive: ${relativePath}`);
}

function tarHeader(entry) {
  const header = Buffer.alloc(BLOCK_BYTES);
  const names = splitTarPath(entry.path);
  writeText(header, 0, 100, names.name);
  const executable = (entry.stat.mode & 0o111) !== 0;
  const mode = entry.type === 'directory' ? 0o755 : entry.type === 'symlink' ? 0o777 : executable ? 0o755 : 0o644;
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.type === 'file' ? entry.stat.size : 0);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.type === 'directory' ? 0x35 : entry.type === 'symlink' ? 0x32 : 0x30;
  if (entry.type === 'symlink') writeText(header, 157, 100, entry.link);
  writeText(header, 257, 6, 'ustar\0');
  writeText(header, 263, 2, '00');
  writeText(header, 345, 155, names.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, '0');
  writeText(header, 148, 6, checksumText);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function createDeterministicTarGz(root, outputFile, options = {}) {
  const entries = collectEntries(root, options);
  const chunks = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry));
    if (entry.type !== 'file') continue;
    const body = fs.readFileSync(entry.absolute);
    chunks.push(body);
    const padding = (BLOCK_BYTES - (body.length % BLOCK_BYTES)) % BLOCK_BYTES;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(ZERO_BLOCK, ZERO_BLOCK);
  const tar = Buffer.concat(chunks);
  const gzip = zlib.gzipSync(tar, { level: 9, mtime: 0 });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, gzip);
  return {
    path: outputFile,
    sha256: sha256File(outputFile),
    sizeBytes: gzip.length,
    fileCount: entries.filter((entry) => entry.type === 'file').length,
    entryCount: entries.length,
  };
}

function readString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  const boundedEnd = end === -1 || end > offset + length ? offset + length : end;
  return buffer.subarray(offset, boundedEnd).toString('utf8').trimEnd();
}

function readOctal(buffer, offset, length) {
  const value = readString(buffer, offset, length).trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw new Error(`Malformed tar octal value: ${JSON.stringify(value)}`);
  return Number.parseInt(value, 8);
}

function parseTar(archive) {
  const tar = zlib.gunzipSync(fs.readFileSync(archive));
  const entries = [];
  const seen = new Set();
  let offset = 0;
  while (offset + BLOCK_BYTES <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_BYTES);
    if (header.equals(ZERO_BLOCK)) break;

    const storedChecksum = readOctal(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== actualChecksum) {
      throw new Error(`Invalid tar header checksum at byte ${offset}`);
    }

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    assertSafeArchivePath(entryPath);
    if (seen.has(entryPath)) throw new Error(`Duplicate tar entry: ${entryPath}`);
    seen.add(entryPath);

    const size = readOctal(header, 124, 12);
    const mode = readOctal(header, 100, 8);
    const typeFlag = String.fromCharCode(header[156] || 0x30);
    const link = readString(header, 157, 100);
    const bodyStart = offset + BLOCK_BYTES;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > tar.length) throw new Error(`Truncated tar entry: ${entryPath}`);

    if (typeFlag === '2') {
      const linkDestination = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), link));
      if (
        !link
        || link.startsWith('/')
        || linkDestination === '..'
        || linkDestination.startsWith('../')
      ) {
        throw new Error(`Unsafe archived symlink: ${entryPath} -> ${link}`);
      }
    } else if (!['0', '5', '\0'].includes(typeFlag)) {
      throw new Error(`Unsupported tar entry type ${JSON.stringify(typeFlag)} at ${entryPath}`);
    }
    entries.push({
      path: entryPath,
      size,
      mode,
      type: typeFlag,
      link: link || null,
      body: typeFlag === '0' || typeFlag === '\0' ? tar.subarray(bodyStart, bodyEnd) : null,
    });
    offset = bodyStart + Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;
  }
  if (offset > tar.length) throw new Error(`Truncated tar archive: ${archive}`);
  return entries;
}

function listTarGz(archive) {
  return parseTar(archive).map(({ body: ignoredBody, ...entry }) => entry);
}

function assertNoSymlinkParent(root, destination) {
  const relative = path.relative(root, destination);
  let cursor = root;
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    if (!segment) continue;
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`Archive entry traverses a symlink parent: ${destination}`);
    }
  }
}

function extractTarGz(archive, destination) {
  const entries = parseTar(archive);
  if (fs.existsSync(destination) && fs.readdirSync(destination).length !== 0) {
    throw new Error(`Archive destination must be empty: ${destination}`);
  }
  fs.mkdirSync(destination, { recursive: true });
  const root = fs.realpathSync(destination);

  // Materialize ordinary entries first, then links. This prevents a link from
  // becoming a parent directory for a later file in a crafted archive.
  for (const entry of entries.filter((item) => item.type !== '2')) {
    const target = path.resolve(root, ...entry.path.split('/'));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Archive entry escapes destination: ${entry.path}`);
    }
    assertNoSymlinkParent(root, target);
    if (entry.type === '5') {
      fs.mkdirSync(target, { recursive: true, mode: entry.mode || 0o755 });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.body, { mode: entry.mode || 0o644 });
    }
  }
  for (const entry of entries.filter((item) => item.type === '2')) {
    const target = path.resolve(root, ...entry.path.split('/'));
    assertNoSymlinkParent(root, target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(entry.link, target);
  }
  return entries.map(({ body: ignoredBody, ...entry }) => entry);
}

module.exports = {
  assertSafeArchivePath,
  collectEntries,
  createDeterministicTarGz,
  extractTarGz,
  listTarGz,
  sha256File,
};
