'use strict';

/**
 * Tiny, dependency-free argument parser. The repo hand-rolls process.argv in
 * every scripts/*.js (no commander/yargs installed), so the CLI keeps that
 * convention. Supports positionals plus `--flag`, `--flag value`, and
 * `--flag=value`. A bare `--flag` (end of argv or followed by another `--flag`)
 * is a boolean `true`. Everything after a lone `--` is treated as positional.
 *
 * @param {string[]} argv tokens (already sliced past the command name)
 * @returns {{ _: string[], flags: Record<string, string|boolean> }}
 */
function parseArgs(argv = []) {
  const positionals = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (typeof token === 'string' && token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
        continue;
      }
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
      continue;
    }

    positionals.push(token);
  }

  return { _: positionals, flags };
}

module.exports = { parseArgs };
