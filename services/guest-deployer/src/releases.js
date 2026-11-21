'use strict';

/**
 * The preview ledger — which guest previews are live right now.
 *
 * It is the deployer's own file, not a workspace store: a preview belongs to no
 * organization, so it must not be reachable through any org-keyed backend. The
 * ledger is what the union release is built from, so it is also the thing that
 * enforces the retention window — an entry that has aged out is dropped on every
 * read, and the next release therefore stops serving it.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const GUEST_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEDGER_VERSION = 1;
const MAX_LIVE_RELEASES = 1000;

class GuestReleaseError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requireToken(token) {
  if (typeof token !== 'string' || !GUEST_TOKEN.test(token)) {
    throw new GuestReleaseError(400, 'guest_preview_token_invalid', 'That preview address is not valid.');
  }
  return token;
}

function createGuestReleases({ dataDir, retentionMs, now = () => Date.now(), maxLive = MAX_LIVE_RELEASES } = {}) {
  if (!dataDir || !path.isAbsolute(dataDir)) throw new TypeError('createGuestReleases requires an absolute dataDir');
  if (!(Number(retentionMs) > 0)) throw new TypeError('createGuestReleases requires a positive retentionMs');
  const ledgerPath = path.join(dataDir, 'releases.json');
  const fresh = () => ({ version: LEDGER_VERSION, releases: [] });
  let entries = null;
  let writeChain = Promise.resolve();

  function isLive(entry, at) {
    return Boolean(entry && entry.token && Date.parse(entry.expiresAt) > at);
  }

  /**
   * A corrupt or unreadable ledger is treated as empty rather than fatal: the
   * previews that were pointing at it are served from the last release until the
   * next one, and the only way back to a working deploy is to start recording
   * from scratch. Nothing is deleted on disk — the next save overwrites it.
   */
  async function load(at) {
    try {
      const raw = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
      const releases = Array.isArray(raw?.releases) ? raw.releases : [];
      entries = new Map(releases.filter((entry) => isLive(entry, at)).map((entry) => [entry.token, normalize(entry)]));
    } catch {
      entries = new Map();
    }
    return entries;
  }

  function normalize(entry) {
    return {
      token: entry.token,
      template: String(entry.template || ''),
      variant: entry.variant && typeof entry.variant === 'object' ? entry.variant : {},
      createdAt: String(entry.createdAt || ''),
      updatedAt: String(entry.updatedAt || ''),
      expiresAt: String(entry.expiresAt || ''),
    };
  }

  /** Serialised so two overlapping releases cannot interleave a partial write. */
  function persist() {
    const body = JSON.stringify({ version: LEDGER_VERSION, releases: [...entries.values()] }, null, 2);
    writeChain = writeChain.then(async () => {
      await fs.mkdir(dataDir, { recursive: true });
      const tmp = `${ledgerPath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, `${body}\n`, { mode: 0o600 });
      await fs.rename(tmp, ledgerPath);
    });
    return writeChain;
  }

  /** Record a preview and return the entry. Over capacity, the soonest to expire goes. */
  async function add({ token, template, variant = {} } = {}) {
    requireToken(token);
    const at = now();
    const map = entries || (await load(at));
    const entry = normalize({
      token,
      template,
      variant,
      createdAt: new Date(at).toISOString(),
      updatedAt: new Date(at).toISOString(),
      expiresAt: new Date(at + Number(retentionMs)).toISOString(),
    });
    map.set(token, entry);
    const evicted = [];
    const live = [...map.values()].sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
    while (map.size > Number(maxLive)) {
      const [oldest] = live.filter((candidate) => map.has(candidate.token));
      if (!oldest) break;
      map.delete(oldest.token);
      evicted.push(oldest.token);
    }
    await persist();
    return { entry, evicted };
  }

  /**
   * A customisation replaces the files a preview serves, never its lifetime: the
   * expiry from the first deploy is what the visitor was told, and re-clicking
   * must not buy more retention.
   */
  async function update({ token, template, variant = {} } = {}) {
    requireToken(token);
    const at = now();
    const map = entries || (await load(at));
    const existing = map.get(token);
    if (!existing || !isLive(existing, at)) {
      throw new GuestReleaseError(410, 'guest_preview_expired', 'This preview is no longer available.');
    }
    const entry = normalize({ ...existing, template: template || existing.template, variant, updatedAt: new Date(at).toISOString() });
    map.set(token, entry);
    await persist();
    return entry;
  }

  async function get(token) {
    requireToken(token);
    const at = now();
    const map = entries || (await load(at));
    const entry = map.get(token);
    return entry && isLive(entry, at) ? entry : null;
  }

  /** Every unexpired preview, oldest expiry first — the order the union is built in. */
  async function live() {
    const at = now();
    const map = entries || (await load(at));
    const kept = [...map.values()].filter((entry) => isLive(entry, at));
    if (kept.length !== map.size) {
      for (const entry of [...map.values()]) if (!isLive(entry, at)) map.delete(entry.token);
      await persist();
    }
    return kept.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async function remove(token) {
    requireToken(token);
    const map = entries || (await load(now()));
    const had = map.delete(token);
    if (had) await persist();
    return had;
  }

  return { add, update, get, live, remove, requireToken, ledgerPath, GuestReleaseError };
}

module.exports = { createGuestReleases, GuestReleaseError, requireToken, GUEST_TOKEN, MAX_LIVE_RELEASES, LEDGER_VERSION };
