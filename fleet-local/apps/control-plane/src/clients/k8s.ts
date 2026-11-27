import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Thin, injection-safe wrappers around the helm/kubectl binaries bundled in the
// BFF image. Arguments are passed as an array (no shell), so tenant-derived names
// never become shell metacharacters. Manifests go in over stdin.

export interface RunResult {
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || err.message}`));
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

export const kubectl = (args: string[], stdin?: string) => run('kubectl', args, stdin);
export const helm = (args: string[], stdin?: string) => run('helm', args, stdin);

export async function applyManifest(yaml: string): Promise<void> {
  await kubectl(['apply', '-f', '-'], yaml);
}

export async function getJson<T = unknown>(kind: string, name: string, namespace?: string): Promise<T | undefined> {
  const args = ['get', kind, name, '-o', 'json'];
  if (namespace) args.push('-n', namespace);
  try {
    const { stdout } = await kubectl(args);
    return JSON.parse(stdout) as T;
  } catch {
    return undefined;
  }
}

// Every object of a kind across all namespaces, filtered by label. The reader that
// needs cluster-wide state (which tenants exist, from their own labelled Secrets)
// must not have to know a namespace list, and `getJson` above is single-object only.
export async function listJson<T = unknown>(kind: string, labelSelector: string): Promise<T[]> {
  try {
    const { stdout } = await kubectl(['get', kind, '-A', '-l', labelSelector, '-o', 'json']);
    const parsed = JSON.parse(stdout) as { items?: T[] };
    return parsed.items ?? [];
  } catch {
    return [];
  }
}

// Merge-patch a Secret's data and annotations. applyManifest is deliberately not
// used for this: `kubectl apply -f` submits a whole object, so a manifest that
// lists two keys silently deletes every other key in the Secret — including the
// LiteLLM virtual key the tenant cannot function without.
//
// The patch goes through a 0600 temp file rather than stdin: `kubectl patch` has no
// stdin form (`-p` would put the credential in argv, and run() echoes the argv on
// failure), and `--patch-file /dev/stdin` cannot work here — kubectl *opens* the
// path, and reopening Node's stdio socketpair fails with ENXIO ("unable to read
// patch file: no such device or address"), which is how this was found. A file keeps
// the value out of argv and out of every log line, and it is unlinked in finally.
export async function patchSecret(
  name: string,
  namespace: string,
  patch: { data?: Record<string, string>; annotations?: Record<string, string> },
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (patch.data) body.data = patch.data;
  if (patch.annotations) body.metadata = { annotations: patch.annotations };
  const dir = mkdtempSync(join(tmpdir(), 'fleet-patch-'));
  try {
    const file = join(dir, 'patch.json');
    writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    await kubectl(['patch', 'secret', name, '-n', namespace, '--type', 'merge', '--patch-file', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function labelResource(
  kind: string,
  name: string,
  namespace: string,
  labels: Record<string, string>,
): Promise<void> {
  const pairs = Object.entries(labels).map(([k, v]) => `${k}=${v}`);
  await kubectl(['label', kind, name, '-n', namespace, '--overwrite', ...pairs]);
}

// --- teardown ---
//
// Every delete here is written to be safe to retry, because the offboarding machine
// resumes at the first step that did not report done — and a step that reported
// done before the process died may still be re-run by an operator. "--gone is
// already what we wanted" is the whole idempotency story.

export async function deleteResource(kind: string, name: string, namespace?: string): Promise<void> {
  const args = ['delete', kind, name, '--ignore-not-found=true'];
  if (namespace) args.push('-n', namespace);
  await kubectl(args);
}

export async function deleteAll(kind: string, namespace: string, labelSelector: string): Promise<void> {
  await kubectl(['delete', kind, '-n', namespace, '-l', labelSelector, '--ignore-not-found=true']);
}

// True when the resource is absent. A timeout is reported as false rather than
// thrown: a namespace stuck in Terminating is a fact the caller has to see, and
// the machine must not wedge on it.
export async function waitForGone(
  kind: string,
  name: string,
  namespace?: string,
  timeoutSeconds = 120,
): Promise<boolean> {
  const args = ['wait', '--for=delete', `${kind}/${name}`, `--timeout=${timeoutSeconds}s`];
  if (namespace) args.push('-n', namespace);
  try {
    await kubectl(args);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/^error: timed out/.test(message) || message.includes('timed out')) return false;
    throw err;
  }
}

// Returns false when the release was already gone, so the caller can record which
// of the two it did. Anything else (a helm failure, not a missing release) throws.
export async function helmUninstall(release: string, namespace: string): Promise<boolean> {
  try {
    await helm(['uninstall', release, '-n', namespace]);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isMissingRelease(message)) return false;
    throw err;
  }
}

export function isMissingRelease(message: string): boolean {
  return /release: not found|not found|Error: uninstall: Release not loaded/i.test(message);
}

// helm upgrade --install with --wait=false; callers poll readiness explicitly so a
// slow tenant render never blocks the onboarding machine's retry budget. Nested
// values go through a temp JSON file (-f), which helm accepts verbatim.
export async function helmUpgradeInstall(opts: {
  release: string;
  chart: string;
  namespace: string;
  values?: Record<string, unknown>;
  version?: string;
  reuseValues?: boolean;
}): Promise<void> {
  const args = ['upgrade', '--install', opts.release, opts.chart, '-n', opts.namespace, '--wait=false'];
  if (opts.version) args.push('--version', opts.version);
  if (opts.reuseValues) args.push('--reuse-values');
  let dir: string | undefined;
  try {
    if (opts.values) {
      dir = mkdtempSync(join(tmpdir(), 'fleet-helm-'));
      const file = join(dir, 'values.json');
      writeFileSync(file, JSON.stringify(opts.values));
      args.push('-f', file);
    }
    await helm(args);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

// Current user-supplied values of a release (for read-modify-write patches such
// as appending a substrate credentialProvider.namespacePolicy). A release with no
// user values prints the literal `null`, which JSON.parse hands back as null and
// every property read then throws on — the normalisation belongs here, at the one
// place that knows the wire format.
export async function helmGetValues(release: string, namespace: string): Promise<Record<string, unknown>> {
  const { stdout } = await helm(['get', 'values', release, '-n', namespace, '-o', 'json']);
  return (JSON.parse(stdout || '{}') ?? {}) as Record<string, unknown>;
}

export async function waitForReady(kind: string, name: string, namespace: string, timeoutSeconds = 120): Promise<void> {
  await kubectl([
    'wait',
    `--for=condition=Ready`,
    `${kind}/${name}`,
    '-n',
    namespace,
    `--timeout=${timeoutSeconds}s`,
  ]);
}