import { createHash } from 'node:crypto';
import { DIGEST_PIN, type BundleBase } from '@fleet-local/shared';
import type { Pack, PackRequirements } from './plugins.ts';
import { requirementLines } from './plugins.ts';

// Renders the bundle Dockerfile and derives the identity it is tagged with. Pure:
// no fs, no network, no config, so the golden tests below run in the same
// workspace as the step that calls it, and an identical input always produces a
// byte-identical file — which is what makes the tag content-addressed.

// Bumping this invalidates every previously computed key, which is correct: it
// means the generator changed in a way that can produce a different image from
// the same inputs, so the cached tag must not be trusted.
export const GENERATOR_VERSION = '1';

const ALLOWED = ['RUN', 'ENV', 'WORKDIR'];
// The catalog is reviewed input, but a credential that reaches a Dockerfile
// reaches the build log and the image config, where any tenant can read it.
const SECRETISH = /(api[_-]?key|token|secret|password|BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-)/i;

export interface BundleEntry {
  id: string;
  version: string;
  requirements: PackRequirements;
}

export interface RenderInput {
  base: BundleBase;
  /** `repo@sha256:...` — a digest, never a tag, so the key describes exact bytes. */
  baseRef: string;
  entries: BundleEntry[];
}

export interface RenderResult {
  dockerfile: string;
  dockerignore: string;
  key: string;
  lines: string[];
  errors: string[];
}

const digestOf = (text: string): string => createHash('sha256').update(text).digest('hex');

export const entryId = (entry: BundleEntry): string => `${entry.id}@${entry.version}`;

/** Entries sorted by id, so plugin-pick order cannot change the key or the file. */
export const sortEntries = (entries: BundleEntry[]): BundleEntry[] =>
  [...entries].sort((a, b) => a.id.localeCompare(b.id));

export function bundleKey(input: Pick<RenderInput, 'baseRef' | 'entries'>): string {
  const parts = [input.baseRef, ...sortEntries(input.entries).map((e) => {
    const req = JSON.stringify([e.requirements.dockerfile ?? null, e.requirements.dockerfileAlpine ?? null]);
    return `${entryId(e)}:${req}`;
  }), `generator:${GENERATOR_VERSION}`];
  return digestOf(parts.join('\0'));
}

export function renderBundleDockerfile(input: RenderInput): RenderResult {
  const { base, baseRef } = input;
  const errors: string[] = [];
  // The same rule the chart applies to a Harness image: a tag is not acceptable,
  // because the key has to describe exact bytes for the tag to be content-addressed.
  if (!DIGEST_PIN.test(baseRef)) {
    errors.push(`base image ${baseRef} is not digest-pinned`);
  }
  if (!['apk', 'apt'].includes(base.family)) errors.push(`${base.runtime}: unknown package family ${base.family}`);
  const key = bundleKey(input);

  const entries = sortEntries(input.entries);
  const collected: string[] = [];
  for (const entry of entries) {
    const lines = requirementLines(entry.requirements, base.family);
    if (lines === null) {
      errors.push(
        `${entry.id} has no ${base.family} requirement lines for the ${base.runtime} base` +
          (base.family === 'apk' ? ' (dockerfileAlpine is missing; apt lines will not run on alpine)' : ''),
      );
      continue;
    }
    for (const line of lines) {
      const instruction = line.trim().split(/\s+/)[0]?.toUpperCase();
      if (!ALLOWED.includes(instruction ?? '')) {
        errors.push(`${entry.id}: "${instruction}" is not an allowed requirement line (RUN, ENV, WORKDIR only)`);
        continue;
      }
      if (SECRETISH.test(line)) {
        errors.push(`${entry.id}: requirement line looks like it carries a credential: ${line.slice(0, 48)}…`);
        continue;
      }
      // Every runtime image ends at uid 65532, which cannot read /root. A line
      // that installs there produces an image whose tools are present and whose
      // agent cannot execute them, so it is refused rather than silently moved.
      if (/\/root(\/|\b)/.test(line)) {
        errors.push(`${entry.id}: installs under /root, which uid 65532 cannot read — use UV_TOOL_DIR=/opt/uv`);
        continue;
      }
      if (!collected.includes(line)) collected.push(line);
    }
  }

  // The base contract is re-emitted after the root-run installs: without USER
  // 65532 the agent runs as root inside the sandbox, and without WORKDIR/ENTRYPOINT
  // the adapter never starts. These come from BUNDLE_BASES, never from a pack.
  const adapter = base.adapter ?? `/usr/local/bin/${base.runtime}-runtime`;
  const header = `# fleet-local bundle — generated, do not edit. key=${key.slice(0, 12)}`;
  const lines = errors.length
    ? []
    : [
        header,
        `FROM ${baseRef}`,
        'USER 0:0',
        ...collected,
        'USER 65532:65532',
        'WORKDIR /data',
        `ENTRYPOINT ["${adapter}"]`,
      ];

  return {
    dockerfile: lines.length ? `${lines.join('\n')}\n` : '',
    dockerignore: ['.dockerignore', 'Dockerfile'].join('\n') + '\n',
    key,
    lines: collected,
    errors,
  };
}
