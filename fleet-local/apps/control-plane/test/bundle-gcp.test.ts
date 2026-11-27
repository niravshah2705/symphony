import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import zlib from 'node:zlib';
import {
  arHost,
  buildId,
  buildRequest,
  bundlePackage,
  bundleTag,
  createTarGz,
  pullRef,
  pushRef,
  registryHostOf,
  registryPath,
  saAssertion,
  signAssertionJwt,
  type BundleTargets,
} from '../src/clients/gcp.ts';

const ar: BundleTargets = {
  gcpProjectId: 'fleet-dev',
  gcpRegion: 'us-central1',
  bundleArRepo: 'fleet-bundles',
  bundleRegistry: 'ar',
  bundlePullHost: '',
};
const kind: BundleTargets = { ...ar, bundleRegistry: 'kind', bundlePullHost: '172.18.0.2:5002' };

test('the ar destination is the regional Artifact Registry host', () => {
  assert.equal(arHost(ar), 'us-central1-docker.pkg.dev');
  assert.equal(bundlePackage('claude'), 'claude-bundle');
  assert.equal(bundleTag('a'.repeat(64)), 'a'.repeat(12));
  assert.equal(
    pushRef(ar, 'claude-bundle', 'abc123def456'),
    'us-central1-docker.pkg.dev/fleet-dev/fleet-bundles/claude-bundle:abc123def456',
  );
  // In ar mode the pull ref is the push ref: the repo is anonymously readable and
  // the node needs no credential.
  assert.equal(pullRef(ar, 'claude-bundle', 'abc123def456'), pushRef(ar, 'claude-bundle', 'abc123def456'));
});

test('kind mode swaps only the host, so the package path survives the mirror', () => {
  assert.equal(pullRef(kind, 'claude-bundle', 'abc123def456'), '172.18.0.2:5002/fleet-dev/fleet-bundles/claude-bundle:abc123def456');
  assert.equal(pushRef(kind, 'claude-bundle', 'abc123def456'), pushRef(ar, 'claude-bundle', 'abc123def456'), 'the build still pushes to AR');
});

test('the build id is deterministic per (org, target) and in the shape the API demands', () => {
  const id = buildId('org-uuid', 'claude:abc123def456');
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(id, buildId('org-uuid', 'claude:abc123def456'));
  assert.notEqual(id, buildId('other-org', 'claude:abc123def456'));
  assert.notEqual(id, buildId('org-uuid', 'claude:999999999999'), 'a different selection is a different build');
});

test('the build request pins the platform, names one image, and interpolates nothing', () => {
  const body = buildRequest({
    id: buildId('org-uuid', 'claude:abc123def456'),
    object: 'bundles/claude-abc123def456.tar.gz',
    pullRef: 'us-central1-docker.pkg.dev/fleet-dev/fleet-bundles/claude-bundle:abc123def456',
    orgId: 'org-uuid',
    key: 'abc123def456'.padEnd(64, '0'),
  });
  assert.equal(body.id, buildId('org-uuid', 'claude:abc123def456'));
  assert.match(body.timeout, /^\d+s$/);
  assert.deepEqual(body.source.storageSource, { bucket: '', object: 'bundles/claude-abc123def456.tar.gz' });
  assert.equal(body.steps.length, 1);
  assert.equal(body.steps[0].name, 'gcr.io/cloud-builders/docker');
  // The args are an argv array, not a shell string, so the ref cannot be a payload.
  assert.deepEqual(body.steps[0].args, ['build', '--platform', 'linux/amd64', '-t', body.images[0], '.']);
  assert.deepEqual(body.images, [body.steps[0].args[4]]);
  assert.ok(body.tags.includes('org/org-uuid'), body.tags.join(','));
  assert.ok(body.options.logging === 'CLOUD_LOGGING_ONLY', 'build logs must not depend on a log bucket the org does not own');
});

test('a tar round-trips through gunzip with valid ustar blocks', () => {
  const files = [{ name: 'Dockerfile', body: 'FROM x\nRUN echo hi\n' }, { name: '.dockerignore', body: 'Dockerfile\n' }];
  const tar = zlib.gunzipSync(createTarGz(files));
  assert.equal(tar.length % 512, 0, 'a tar is whole blocks');
  const blocks: Buffer[] = [];
  for (let i = 0; i < tar.length; i += 512) blocks.push(tar.subarray(i, i + 512));
  // Two trailing zero blocks terminate the archive; Cloud Build rejects a tar without them.
  assert.ok(blocks.at(-1)!.every((b) => b === 0) && blocks.at(-2)!.every((b) => b === 0));

  const header = blocks[0];
  assert.equal(header.subarray(0, 100).toString('utf8').replace(/\0.*/, ''), 'Dockerfile');
  assert.equal(header.subarray(257, 263).toString('ascii'), 'ustar\0');
  assert.equal(header[156], 0x30, "typeflag '0' is a regular file");
  const size = parseInt(header.subarray(124, 136).toString('ascii'), 8);
  assert.equal(size, Buffer.byteLength(files[0].body));
  const stored = parseInt(header.subarray(148, 156).toString('ascii').trim(), 8);
  assert.ok(stored > 0, 'a checksum of zero means the header was never summed');
  // The ustar rule: sum every byte with the checksum field itself set to spaces.
  const scratch = Buffer.from(header);
  scratch.write('        ', 148, 'ascii');
  assert.equal([...scratch].reduce((a, b) => a + b, 0), stored, 'header checksum');

  const data = blocks[1].subarray(0, size);
  assert.equal(data.toString('utf8'), files[0].body);
});

test('the archive is byte-identical for identical inputs, so a resume re-uploads the same context', () => {
  const files = [{ name: 'Dockerfile', body: 'FROM x\n' }];
  assert.deepEqual(createTarGz(files), createTarGz(files));
  assert.notDeepEqual(createTarGz(files), createTarGz([{ ...files[0], body: 'FROM y\n' }]));
});

test('the service account assertion carries the issuer, scope and a short life', () => {
  const key = { client_email: 'bundle@fleet-dev.iam.gserviceaccount.com', private_key: 'x', token_uri: 'https://oauth2.googleapis.com/token' };
  const now = 1_800_000_000_000;
  const { claim, header } = saAssertion(key, now);
  assert.equal(claim.iss, key.client_email);
  assert.equal(claim.aud, key.token_uri);
  assert.equal(claim.scope, 'https://www.googleapis.com/auth/cloud-platform');
  assert.equal((claim.exp as number) - (claim.iat as number), 300);
  assert.equal((claim.exp as number), Math.floor(now / 1000) + 300);
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
});

test('a signed assertion verifies against the key that signed it', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = {
    client_email: 'bundle@fleet-dev.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  };
  const jwt = signAssertionJwt(key, Date.now());
  const [h, c, s] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(h!, 'base64url').toString()).alg, 'RS256');
  assert.equal(JSON.parse(Buffer.from(c!, 'base64url').toString()).iss, key.client_email);
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).end().verify(publicKey, Buffer.from(s!, 'base64url')));
});

test('a repo splits into the host and path a registry V2 URL needs', () => {
  assert.equal(registryHostOf('ghcr.io/niravshah2705/symphony/claude-runtime'), 'ghcr.io');
  assert.equal(registryPath('ghcr.io/niravshah2705/symphony/claude-runtime'), 'niravshah2705/symphony/claude-runtime');
  assert.equal(registryHostOf('localhost:5002/fleet/x'), 'localhost:5002');
  assert.equal(registryPath('localhost:5002/fleet/x'), 'fleet/x');
  assert.equal(registryHostOf('https://index.docker.io/library/node'), 'index.docker.io');
});
