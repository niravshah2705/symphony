import { createHash, createSign } from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { config } from '../config.ts';
import { fetchJson, HttpError } from './http.ts';

// Everything this feature needs from GCP, over fetch: a service-account token,
// a Cloud Build create/get, a GCS context upload, and a registry digest read-back.
//
// The read-back is the reason this file exists at all. Every ref that reaches a
// Harness CR has to be a digest, and a digest that was *assumed* rather than read
// from the registry is a Harness that cannot pull — an ImagePullBackOff that shows
// up as a broken chat, minutes after the build reported success. So each of the
// three registries is asked the same way (Docker Registry V2 HEAD + the
// Docker-Content-Digest header) and the answer is compared to what the build
// claimed. A retag changes the manifest digest, so no step is allowed to carry a
// digest forward from a previous answer.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// cloud-platform is the broad scope; it is narrowed by what the SA is *granted*,
// not by the scope string, and the grant list is in SETUP-ENVIRONMENT.md.
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

// ---------------------------------------------------------------- identity

/**
 * The destination coordinates. Passed in by the caller (`config` in production,
 * a literal in tests) rather than read from the module-level singleton, because
 * an image reference is the one value in this pipeline whose correctness the
 * Harness CR depends on, and a builder that can be asserted without env is the
 * cheap way to know it.
 */
export interface BundleTargets {
  gcpProjectId: string;
  gcpRegion: string;
  bundleArRepo: string;
  bundleRegistry: 'ar' | 'kind';
  bundlePullHost: string;
}

export const arHost = (cfg: BundleTargets): string => `${cfg.gcpRegion}-docker.pkg.dev`;

/** The AR/kind package name a runtime's bundles live under. */
export const bundlePackage = (runtime: string): string => `${runtime}-bundle`;

/** The tag is the content-addressed key, so an identical selection is the same tag. */
export const bundleTag = (key: string): string => key.slice(0, 12);

/** Where Cloud Build pushes. Always the real registry, never the node-facing host. */
export function pushRef(cfg: BundleTargets, name: string, tag: string): string {
  return `${arHost(cfg)}/${cfg.gcpProjectId}/${cfg.bundleArRepo}/${name}:${tag}`;
}

/**
 * What the cluster pulls. In `ar` mode that is the same ref, made reachable by
 * granting `allUsers` reader on the repo; in `kind` mode it is the mirror host,
 * because a kind node has no GCP identity to pull with.
 */
export function pullRef(cfg: BundleTargets, name: string, tag: string): string {
  if (cfg.bundleRegistry === 'kind') {
    return `${cfg.bundlePullHost}/${cfg.gcpProjectId}/${cfg.bundleArRepo}/${name}:${tag}`;
  }
  return pushRef(cfg, name, tag);
}

/**
 * Cloud Build's own id for one (org, target). Deterministic on purpose: a process
 * that dies between the POST and the first poll must resume the build it started,
 * not pay for a second one. 32 lowercase hex is the shape the API demands.
 */
export function buildId(orgId: string, target: string): string {
  return createHash('sha1').update(`${orgId}\0${target}`).digest('hex').slice(0, 32);
}

// ------------------------------------------------------- service account auth

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

export function readServiceAccount(path = config.gcpSaKeyPath): ServiceAccountKey {
  if (!fs.existsSync(path)) {
    throw new Error(`GCP service account key not found at ${path} — mount it as a Secret file (deploy/bff/deployment.yaml)`);
  }
  const json = JSON.parse(fs.readFileSync(path, 'utf8')) as Partial<ServiceAccountKey>;
  if (!json.client_email || !json.private_key) throw new Error(`${path} is not a service account JSON key (needs client_email and private_key)`);
  return json as ServiceAccountKey;
}

export interface SignedAssertion {
  header: { alg: string; typ: string };
  claim: Record<string, unknown>;
}

/** The JWT assertion for one token exchange. Split out so the claims are testable. */
export function saAssertion(key: ServiceAccountKey, now: number, lifetimeSeconds = 300): SignedAssertion {
  return {
    header: { alg: 'RS256', typ: 'JWT' },
    claim: {
      iss: key.client_email,
      scope: SCOPE,
      aud: key.token_uri ?? TOKEN_URL,
      exp: Math.floor((now + lifetimeSeconds * 1000) / 1000),
      iat: Math.floor(now / 1000),
    },
  };
}

const b64url = (buf: Buffer): string => buf.toString('base64url');

export function signAssertionJwt(key: ServiceAccountKey, now = Date.now()): string {
  const { header, claim } = saAssertion(key, now);
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(claim)))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).end().sign(key.private_key);
  return `${signingInput}.${b64url(signature)}`;
}

/** A cached OAuth access token for the bundle service account. */
export async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value;
  const key = readServiceAccount();
  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: signAssertionJwt(key),
  });
  const res = await fetch(key.token_uri ?? TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text, key.token_uri ?? TOKEN_URL);
  const token = JSON.parse(text) as { access_token: string; expires_in: number };
  cachedToken = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
  return cachedToken.value;
}

/** Handful for tests and for a forced re-auth after a long idle gap. */
export function forgetToken(): void {
  cachedToken = null;
}

// ---------------------------------------------------------- build context tar

export interface TarFile {
  name: string;
  body: string;
}

// Cloud Build's source is a tarball in a bucket, and this build context is two
// small text files. Writing the USTAR blocks here rather than adding a tar
// dependency keeps the BFF image as-deployed (node + helm + kubectl only) and
// makes the bytes deterministic, which is what lets a resumed run re-upload the
// identical context.
function tarHeader(file: TarFile, byteLength: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(file.name.slice(0, 100), 0, 'utf8');
  header.write('0000644\0', 100, 'ascii'); // mode: readable, not setuid, not writable by group
  header.write('0000000\0', 108, 'ascii'); // uid
  header.write('0000000\0', 116, 'ascii'); // gid
  header.write(byteLength.toString(8).padStart(11, '0') + '\0', 124, 'ascii'); // size
  header.write('00000000000\0', 136, 'ascii'); // mtime: epoch, so the archive is reproducible
  header.write('        ', 148, 'ascii'); // checksum placeholder while summing
  header.write('0', 156, 'ascii'); // typeflag: regular file
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return header;
}

export function createTarGz(files: TarFile[]): Uint8Array<ArrayBuffer> {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const body = Buffer.from(file.body, 'utf8');
    if (body.length > 0o7777777) throw new Error(`${file.name}: too large for a ustar header`);
    blocks.push(tarHeader(file, body.length));
    // Data is padded to the 512-byte block boundary; a short final block is not
    // valid tar and Cloud Build rejects the whole source.
    if (body.length % 512) blocks.push(body, Buffer.alloc(512 - (body.length % 512)));
    else blocks.push(body);
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks terminate the archive
  // mtime is accepted by Node's gzip at runtime but is missing from ZlibOptions;
  // without it the header carries the current time and identical inputs would
  // produce different bytes, which breaks the resume-re-uploads-the-same-context
  // guarantee the test asserts.
  // The copy into a fresh ArrayBuffer-backed view is what lets the result be a
  // Blob part: a Buffer is typed over ArrayBufferLike, which includes
  // SharedArrayBuffer, and the fetch BodyInit types refuse that.
  return new Uint8Array(zlib.gzipSync(Buffer.concat(blocks), { mtime: 0 } as zlib.ZlibOptions));
}

// --------------------------------------------------------------- Cloud Build

export interface BuildRequestBody {
  id: string;
  timeout: string;
  options: { logging: string; machineType: string };
  source: { storageSource: { bucket: string; object: string } };
  steps: { name: string; args: string[] }[];
  images: string[];
  tags: string[];
  substitutions: Record<string, string>;
}

/**
 * The build spec. The Dockerfile is referenced, never interpolated: the only
 * values that reach the request are a fixed builder image, a digest-pinned
 * pull ref, and the org/tag names, and every one of them is validated by
 * bundle/steps before this is called. A model- or owner-authored string is not
 * concatenated into a shell anywhere in this pipeline.
 */
export function buildRequest(input: { id: string; bucket?: string; object: string; pullRef: string; orgId: string; key: string }): BuildRequestBody {
  const name = input.pullRef;
  const tag = bundleTag(input.key);
  return {
    id: input.id,
    timeout: `${Math.ceil(config.bundleBuildTimeoutMs / 1000)}s`,
    options: { logging: 'CLOUD_LOGGING_ONLY', machineType: 'E2_HIGHCPU_8' },
    source: { storageSource: { bucket: input.bucket ?? config.bundleStageBucket, object: input.object } },
    steps: [
      {
        name: 'gcr.io/cloud-builders/docker',
        // Single platform: a multi-platform manifest list would give the kind
        // mirror a different digest than the one this build reports.
        args: ['build', '--platform', 'linux/amd64', '-t', name, '.'],
      },
    ],
    images: [name],
    tags: ['fleet-local', 'bundle', `org/${input.orgId}`, `key/${tag}`],
    substitutions: { _PULL_REF: name, _KEY: tag },
  };
}

const buildsUrl = (): string => `https://cloudbuild.googleapis.com/v1/projects/${config.gcpProjectId}/locations/${config.gcpRegion}/builds`;

export interface CloudBuild {
  id: string;
  status: 'QUEUED' | 'WORKING' | 'SUCCESS' | 'FAILURE' | 'INTERNAL_ERROR' | 'TIMEOUT' | 'CANCELLED' | string;
  results?: { images?: { name: string; digest?: string; pushTiming?: unknown }[] };
  finishTime?: string;
  errorMessage?: string;
  logsUrl?: string;
}

export async function createBuild(body: BuildRequestBody): Promise<CloudBuild> {
  return fetchJson<CloudBuild>(buildsUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}` },
    body,
    timeoutMs: 30_000,
  });
}

/** 404 is a real answer here: a build id this project never created. */
export async function getBuild(id: string): Promise<CloudBuild | null> {
  const url = `${buildsUrl()}/${encodeURIComponent(id)}`;
  try {
    return await fetchJson<CloudBuild>(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

/** Context upload for the build. `uploadType=media` is the single-call path. */
export async function uploadContext(object: string, gzip: Uint8Array<ArrayBuffer>): Promise<void> {
  if (!config.bundleStageBucket) throw new Error('BUNDLE_STAGE_BUCKET is required: Cloud Build reads its context from a bucket, not from the request body');
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(config.bundleStageBucket)}/o?uploadType=media&name=${encodeURIComponent(object)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/gzip' },
    body: new Blob([gzip], { type: 'application/gzip' }),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text, url);
}

// ---------------------------------------------------- registry digest read-back

export interface DigestOptions {
  /** `http` for the in-cluster kind registry, which has no TLS on the host port. */
  scheme?: 'https' | 'http';
  /** Anonymous for ghcr public images; the caller decides what token to present. */
  token?: string;
}

async function headDigest(host: string, path: string, ref: string, opts: DigestOptions): Promise<string | null> {
  const url = `${opts.scheme ?? 'https'}://${host}/v2/${path}/manifests/${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    method: 'HEAD',
    headers: {
      Accept: MANIFEST_ACCEPT,
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
  });
  if (res.status === 404 || res.status === 401) return null;
  if (!res.ok) throw new HttpError(res.status, await res.text(), url);
  return res.headers.get('docker-content-digest');
}

/** ghcr.io, for the base runtime images: public, so the token is anonymous. */
export async function ghcrDigest(repoPath: string, tag: string): Promise<string | null> {
  let token: string | undefined;
  try {
    const res = await fetchJson<{ token?: string }>(
      `https://ghcr.io/token?scope=repository:${encodeURIComponent(repoPath)}:pull&service=ghcr.io`,
    );
    token = res.token;
  } catch {
    // A public image answers without a token; a failure here is not fatal, the
    // manifest request below is the one that decides.
  }
  return headDigest('ghcr.io', repoPath, tag, { token });
}

/** Artifact Registry, with the bundle service account's token. */
export async function arDigest(path: string, ref: string): Promise<string | null> {
  return headDigest(arHost(config), path, ref, { token: await accessToken() });
}

/** A local registry the cluster nodes use (kind mode), reached over plain http. */
export async function localDigest(host: string, path: string, ref: string): Promise<string | null> {
  return headDigest(host, path, ref, { scheme: 'http' });
}

/** `repo:tag` or `repo@sha256:...` -> the repo path component a registry V2 URL wants. */
export function registryPath(repo: string): string {
  const withoutScheme = repo.replace(/^(https?:\/\/)?/, '');
  const slash = withoutScheme.indexOf('/');
  return slash === -1 ? withoutScheme : withoutScheme.slice(slash + 1);
}

export function registryHostOf(repo: string): string {
  const withoutScheme = repo.replace(/^(https?:\/\/)?/, '');
  const slash = withoutScheme.indexOf('/');
  return slash === -1 ? 'docker.io' : withoutScheme.slice(0, slash);
}
