'use strict';

/**
 * Firebase Hosting release client.
 *
 * One release per publish: a version is created, the union of the live preview
 * files is added to it, the version is finalized, and the channel is released to
 * it. Firebase swaps the channel's version atomically, so a guest never sees a
 * half-written site and a preview that has aged out simply stops being in the
 * next union.
 *
 * The hardening headers are set on the version, not on the files: an unauthenticated
 * visitor's generated page must not be indexed, must not be sniffed, and must not be
 * able to reach the application origin as if it were same-origin. `sandbox
 * allow-scripts` keeps the demo interactive while denying it anything a document
 * could otherwise touch — storage, forms, top-level navigation, same-origin reads.
 */

const zlib = require('node:zlib');
const crypto = require('node:crypto');

const API_ROOT = 'https://firebasehosting.googleapis.com/v1beta1';
const HOSTING_SCOPE = 'https://www.googleapis.com/auth/firebase';
const MAX_FILES = 512;

const PREVIEW_HEADER_GLOB = '**';
const PREVIEW_HEADERS = Object.freeze([
  { key: 'Content-Security-Policy', value: 'sandbox allow-scripts' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
]);

class GuestHostingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** sha256 of the gzipped bytes — the hash Hosting identifies a file by. */
function hashFile(content) {
  const gz = zlib.gzipSync(Buffer.from(content));
  return { hash: crypto.createHash('sha256').update(gz).digest('hex'), gzipped: gz };
}

/** A site path is derived from server-issued values; refuse anything that escapes its prefix. */
function safePath(p) {
  if (typeof p !== 'string' || !p.length || p.length > 256 || p.startsWith('/') || p.includes('\\')) return null;
  const segments = p.split('/');
  if (segments.some((s) => !s.length || s === '.' || s === '..' || !/^[A-Za-z0-9._@+ -]+$/.test(s))) return null;
  return segments.join('/');
}

function createFirebaseHosting({ site, channel = 'live', fetchImpl = globalThis.fetch, getAccessToken = null, log = () => {} } = {}) {
  if (!site || typeof site !== 'string') throw new TypeError('createFirebaseHosting requires a hosting site name');
  if (typeof fetchImpl !== 'function') throw new TypeError('createFirebaseHosting requires fetch');
  let tokenProvider = getAccessToken;

  async function accessToken() {
    if (!tokenProvider) {
      const { GoogleAuth } = require('google-auth-library');
      const client = await new GoogleAuth({ scopes: [HOSTING_SCOPE] }).getClient();
      tokenProvider = async () => {
        const t = await client.getAccessToken();
        return t && t.token ? t.token : null;
      };
    }
    const token = await tokenProvider();
    if (!token) throw new GuestHostingError(503, 'guest_hosting_auth_failed', 'The preview host could not be authenticated.');
    return token;
  }

  async function request(method, url, body, opts = {}) {
    const token = await accessToken();
    const headers = { authorization: `Bearer ${token}`, ...opts.headers };
    let payload;
    if (body === undefined || body === null) payload = undefined;
    else if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
      payload = body;
      if (!headers['content-type']) headers['content-type'] = 'application/octet-stream';
    } else {
      payload = Buffer.from(JSON.stringify(body));
      headers['content-type'] = headers['content-type'] || 'application/json';
    }
    const res = await fetchImpl(url, { method, headers, body: payload });
    const text = res && typeof res.text === 'function' ? await res.text() : '';
    if (!res || res.status < 200 || res.status >= 300) {
      const detail = safeReason(text);
      log({ level: 'error', op: method, url: redact(url), status: res ? res.status : 0, detail });
      throw new GuestHostingError(502, opts.failureCode || 'guest_hosting_request_failed', `The preview host could not ${opts.what || 'complete'} (HTTP ${res ? res.status : 0}).`);
    }
    return text ? JSON.parse(text) : {};
  }

  /**
   * @param {{files: Array<{path: string, content: string|Buffer}>}} input the
   *   complete union of what the site should serve; anything not listed is gone.
   */
  async function publish(input) {
    const files = normaliseFiles(input && input.files, Boolean(input && input.allowEmpty));
    const siteName = `sites/${site}`;
    const version = await request('POST', `${API_ROOT}/${siteName}/versions`, { config: { headers: [{ glob: PREVIEW_HEADER_GLOB, headers: PREVIEW_HEADERS }] } }, { what: 'create a preview version', failureCode: 'guest_hosting_version_failed' });
    const versionName = version && version.name;
    if (!versionName) throw new GuestHostingError(502, 'guest_hosting_version_failed', 'The preview host did not return a version.');

    const populate = await request('POST', `${API_ROOT}/${versionName}:populateFiles`, { files: Object.fromEntries(files.map((f) => [f.path, f.hash])) }, { what: 'register the preview files', failureCode: 'guest_hosting_upload_failed' });
    await upload(populate, files);

    await request('PATCH', `${API_ROOT}/${versionName}?updateMask=status,files`, { status: 'FINALIZED', files: files.map(({ path, hash }) => ({ path, hash })) }, { what: 'finalize the preview version', failureCode: 'guest_hosting_finalize_failed' });

    const release = await request('POST', `${API_ROOT}/${siteName}/channels/${encodeURIComponent(channel)}/releases?versionName=${encodeURIComponent(versionName)}`, { message: 'guest demo previews' }, { what: 'release the preview', failureCode: 'guest_hosting_release_failed' });
    log({ level: 'info', op: 'release', version: versionName, release: release && release.name, files: files.length });
    return { versionName, releaseName: release && release.name, fileCount: files.length };
  }

  /** Only the hashes Hosting does not already have are sent. */
  async function upload(populate, files) {
    const required = new Set(Array.isArray(populate && populate.uploadRequiredHashes) ? populate.uploadRequiredHashes : []);
    const base = populate && typeof populate.uploadUrl === 'string' ? populate.uploadUrl : null;
    const pending = files.filter((f) => required.has(f.hash));
    if (!pending.length) return;
    if (!base) throw new GuestHostingError(502, 'guest_hosting_upload_failed', 'The preview host did not provide an upload URL.');
    for (const file of pending) {
      const res = await uploadOne(`${base}/${file.hash}`, file);
      if (!res || res.status < 200 || res.status >= 300) {
        const detail = safeReason(res && res.body);
        log({ level: 'error', op: 'upload', path: file.path, status: res ? res.status : 0, detail });
        throw new GuestHostingError(502, 'guest_hosting_upload_failed', `The preview host refused ${file.path} (HTTP ${res ? res.status : 0}).`);
      }
    }
  }

  async function uploadOne(url, file) {
    const form = new FormData();
    form.append('file', new Blob([file.gzipped], { type: 'application/octet-stream' }), file.path);
    form.append('fileName', file.path);
    form.append('hash', file.hash);
    const token = await accessToken();
    const res = await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    const body = res && typeof res.text === 'function' ? await res.text() : '';
    return { status: res ? res.status : 0, body };
  }

  function normaliseFiles(list, allowEmpty = false) {
    if (!Array.isArray(list) || (!list.length && !allowEmpty)) {
      throw new GuestHostingError(400, 'guest_hosting_no_files', 'There is nothing to publish.');
    }
    if (list.length > MAX_FILES) throw new GuestHostingError(502, 'guest_hosting_too_many_files', `A preview release may hold at most ${MAX_FILES} files.`);
    const out = [];
    const seen = new Set();
    for (const item of list) {
      const path = safePath(item && item.path);
      if (!path) throw new GuestHostingError(400, 'guest_hosting_path_invalid', 'A preview file path is not valid.');
      if (seen.has(path)) throw new GuestHostingError(400, 'guest_hosting_path_duplicate', `The preview file ${path} is listed twice.`);
      seen.add(path);
      const content = item.content;
      if (typeof content !== 'string' && !Buffer.isBuffer(content) && !(content instanceof Uint8Array)) {
        throw new GuestHostingError(400, 'guest_hosting_content_invalid', `The preview file ${path} has no content.`);
      }
      const { hash, gzipped } = hashFile(content);
      out.push({ path, hash, gzipped });
    }
    return out;
  }

  return { publish, normaliseFiles, safePath, hashFile, GuestHostingError };
}

/** Google error bodies are JSON with a status; anything else is dropped, not echoed. */
function safeReason(text) {
  if (typeof text !== 'string' || !text) return '';
  try {
    const parsed = JSON.parse(text);
    const status = parsed && parsed.error && parsed.error.status;
    return typeof status === 'string' ? status.slice(0, 64) : '';
  } catch {
    return '';
  }
}

/** The release URL carries no secret, but a log line is not where a query string belongs. */
function redact(url) {
  return String(url).split('?')[0];
}

module.exports = { createFirebaseHosting, GuestHostingError, PREVIEW_HEADERS, PREVIEW_HEADER_GLOB, HOSTING_SCOPE, API_ROOT, MAX_FILES, hashFile, safePath };
