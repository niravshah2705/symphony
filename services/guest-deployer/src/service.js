'use strict';

/**
 * The guest preview service — what the RPCs actually do.
 *
 * A release is always the union of every live preview, never a single guest's
 * files: Firebase swaps a channel's version atomically, so re-releasing the
 * whole set is the only way one visitor's customisation cannot delete another
 * visitor's site. Files are rendered here from the first-party bundle rather
 * than forwarded by the caller, so no browser-supplied body ever becomes site
 * content and the bundle stays the single source of truth.
 */

const crypto = require('node:crypto');

const TOKEN_PATH = (token) => `${token}`;

function createGuestDeployService({ config, releases, hosting, templates, baseOrigin = null, log = () => {}, now = () => Date.now() } = {}) {
  if (!config || !releases || !hosting || !templates) {
    throw new TypeError('createGuestDeployService requires config, releases, hosting and templates');
  }
  const buildGuestRelease = templates.buildGuestRelease;
  const published = { tokens: null, at: 0 };

  function urlFor(token) {
    if (!baseOrigin) return null;
    return `${String(baseOrigin).replace(/\/+$/, '')}/${encodeURIComponent(token)}/`;
  }

  /** Render one ledger entry into its own path prefix. */
  function filesFor(entry) {
    const release = buildGuestRelease({ template: entry.template, variant: entry.variant || {} });
    const prefix = `${TOKEN_PATH(entry.token)}/`;
    return release.files.map((file) => ({ path: `${prefix}${file.path}`, content: file.content }));
  }

  /**
   * Publish the live union. A bundle that no longer builds — an old preview
   * whose template moved on — is dropped from this release and logged: it must
   * not hold every other guest's preview hostage, and the ledger entry is left
   * alone so the next deploy retries it.
   */
  async function publishUnion(reason) {
    const entries = await releases.live();
    const files = [];
    const skipped = [];
    for (const entry of entries) {
      try {
        files.push(...filesFor(entry));
      } catch (error) {
        skipped.push(entry.token);
        log({ level: 'error', op: 'render', token: entry.token, template: entry.template, message: error.message });
      }
    }
    const result = await hosting.publish({ files, allowEmpty: true });
    published.tokens = entries.map((e) => e.token).sort().join(',');
    published.at = now();
    log({ level: 'info', op: 'publish', reason, live: entries.length, files: result.fileCount, skipped: skipped.length });
    return { ...result, live: entries.length, skipped };
  }

  /** Stand up a new preview. The token is minted here and is the only handle anyone gets. */
  async function deploy({ template, variant = {} } = {}) {
    const token = crypto.randomUUID();
    // Render before anything is recorded: a caller cannot store a bundle this
    // image cannot build, or every later release would log it as broken.
    filesFor({ token, template, variant });
    const { entry, evicted } = await releases.add({ token, template, variant });
    for (const t of evicted) log({ level: 'warn', op: 'evict', token: t, reason: 'ledger_at_capacity' });
    const result = await publishUnion('deploy');
    return { token, template: entry.template, expiresAt: entry.expiresAt, url: urlFor(token), ...result, evicted };
  }

  /** Re-release a variant under the SAME token and the SAME expiry. */
  async function redeploy({ token, template, variant = {} } = {}) {
    const current = await releases.get(token);
    if (current) filesFor({ token, template: template || current.template, variant });
    const entry = await releases.update({ token, template, variant });
    const result = await publishUnion('redeploy');
    return { token: entry.token, template: entry.template, expiresAt: entry.expiresAt, url: urlFor(entry.token), ...result };
  }

  async function status(token) {
    const entry = await releases.get(token);
    if (!entry) return null;
    return { token: entry.token, template: entry.template, variant: entry.variant, expiresAt: entry.expiresAt, url: urlFor(entry.token) };
  }

  /** Forget a preview and release the remaining union, so the page really is gone. */
  async function remove(token) {
    const removed = await releases.remove(token);
    if (!removed) return null;
    const result = await publishUnion('remove');
    return { token, ...result };
  }

  /**
   * The expiry sweep is a release, not a delete: a preview the visitor can still
   * open at 23 hours must vanish at 24, and the only way to withdraw it from a
   * hosted site is to release a version that does not contain it.
   */
  async function tick() {
    const entries = await releases.live();
    const tokens = entries.map((e) => e.token).sort().join(',');
    if (published.tokens === tokens) return { published: false, live: entries.length };
    const reason = published.tokens === null ? 'boot' : 'expiry';
    const result = await publishUnion(reason);
    return { published: true, reason, live: entries.length, ...result };
  }

  /** Start the timer only when the process is the server; tests call tick() directly. */
  function startMaintenance(intervalMs) {
    const ms = Number(intervalMs) > 0 ? Number(intervalMs) : 60_000;
    const timer = setInterval(() => {
      tick().catch((error) => log({ level: 'error', op: 'tick', message: error.message }));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  return { deploy, redeploy, status, remove, tick, publishUnion, urlFor, filesFor, startMaintenance };
}

module.exports = { createGuestDeployService, TOKEN_PATH };
