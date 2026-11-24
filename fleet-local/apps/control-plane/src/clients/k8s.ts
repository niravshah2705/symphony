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

export async function labelResource(
  kind: string,
  name: string,
  namespace: string,
  labels: Record<string, string>,
): Promise<void> {
  const pairs = Object.entries(labels).map(([k, v]) => `${k}=${v}`);
  await kubectl(['label', kind, name, '-n', namespace, '--overwrite', ...pairs]);
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
// as appending a substrate credentialProvider.namespacePolicy).
export async function helmGetValues(release: string, namespace: string): Promise<Record<string, unknown>> {
  const { stdout } = await helm(['get', 'values', release, '-n', namespace, '-o', 'json']);
  return JSON.parse(stdout || '{}') as Record<string, unknown>;
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