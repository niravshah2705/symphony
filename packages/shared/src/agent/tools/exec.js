'use strict';

const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { CONFIG } = require('../../config');

const execFileP = promisify(execFile);

/**
 * Shared foundation for the developer-tool registry (docker, environments,
 * build, android, security, quality, codegen, playwright). Every tool in
 * `tools/` DELEGATES to a pre-installed standard CLI rather than re-implementing
 * its behaviour — this module is the one safe door those delegations go through.
 *
 * Security posture (see infrastructure-misconfig / secret-leakage checklists):
 *   - Commands run via execFile with an ARGUMENT ARRAY and NEVER a shell string,
 *     so tool inputs can never be interpreted as shell metacharacters (no
 *     command injection). `shell: false` is the default and is asserted.
 *   - The child inherits the real environment (build tools need $HOME/$PATH/
 *     $ANDROID_HOME/$JAVA_HOME) but every credential-looking variable is
 *     STRIPPED first, and any known secret value is REDACTED from returned
 *     output — secrets never reach the model or child processes.
 *   - A tool's optional `dir` is resolved INSIDE the workspace root; traversal
 *     ("../etc") is refused.
 */

const DEFAULT_TIMEOUT_SEC = 900;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

function toolLimits() {
  const t = (CONFIG && CONFIG.TOOLS) || {};
  return {
    timeoutSec: Number(t.timeoutSec) || DEFAULT_TIMEOUT_SEC,
    maxOutputBytes: Number(t.maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES,
  };
}

/** Env variable names whose VALUE is a credential — matched case-insensitively. */
const SECRET_KEY_RE =
  /(TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|APIKEY|API_KEY|_KEY$|SESSION|COOKIE|BEARER|_PAT$|AUTH_|_AUTH$)/i;

/** Non-interactive / reproducible flags forced into every tool subprocess. */
const NONINTERACTIVE_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'Never',
  DEBIAN_FRONTEND: 'noninteractive',
  PIP_DISABLE_PIP_VERSION_CHECK: '1',
  PYTHONUNBUFFERED: '1',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
});

/**
 * Cloud Run exposes the revision service identity through a link-local metadata
 * server. A repository-native test script is untrusted code, so letting that
 * child reach metadata would turn the tester's Firestore/PubSub identity into a
 * credential-exfiltration path. Linux production workers therefore wrap trusted
 * repository commands with a tiny seccomp launcher that permits only AF_UNIX
 * sockets and denies internet/link-local socket creation. Unlike namespace
 * sandboxes, this works without capabilities or user namespaces in Cloud Run.
 * The wrapper is mandatory when `isolateNetwork` is requested; a missing or
 * unsupported sandbox fails closed instead of silently executing with network.
 */
const NETWORK_SANDBOX_COMMAND = 'ai-fleet-network-sandbox';

function networkSandboxInvocation(command, args, opts = {}) {
  if (opts.isolateNetwork !== true) return { command, args };
  const platform = opts.platform || process.platform;
  if (platform !== 'linux') {
    throw new Error('network-isolated commands require a Linux worker');
  }
  return {
    command: opts.networkSandboxCommand || NETWORK_SANDBOX_COMMAND,
    args: [command, ...args],
  };
}

/**
 * Split a base environment into the env a tool subprocess may see and the list
 * of secret values to redact from its output. Inherit-then-strip: keep every
 * variable a real toolchain needs, drop anything that looks like a credential.
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {{ env: Record<string,string>, secrets: string[] }}
 */
function sanitizedToolEnv(baseEnv = process.env) {
  const env = {};
  const secrets = [];
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== 'string') continue;
    if (SECRET_KEY_RE.test(key)) {
      if (value.length >= 4) secrets.push(value);
      continue; // stripped — never forwarded to the child
    }
    env[key] = value;
  }
  return { env: { ...env, ...NONINTERACTIVE_ENV }, secrets };
}

/**
 * Redact known secret values and common credential patterns, then bound length.
 * @param {unknown} text
 * @param {string[]} [secrets]  literal secret values to blank out
 * @param {number} [maxBytes]
 */
function redactSecrets(text, secrets = [], maxBytes) {
  let out = String(text == null ? '' : text);
  for (const secret of secrets) {
    const s = String(secret);
    if (s.length >= 4) out = out.split(s).join('«redacted»');
  }
  out = out
    .replace(/((?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[A-Za-z0-9._~+/=-]{8,}/gi, '$1«redacted»')
    .replace(/((?:private-token|x-api-key|api[_-]?key|access[_-]?token|secret|password|passwd|pwd)["']?\s*[:=]\s*["']?)[^\s'";,&]+/gi, '$1«redacted»')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '«redacted»')
    .replace(/\bglpat-[A-Za-z0-9_-]{16,}\b/g, '«redacted»')
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, '«redacted»')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '«redacted»');
  return truncate(out, maxBytes || toolLimits().maxOutputBytes);
}

/** Bound output to `maxBytes`, keeping the head and tail (errors cluster at the end). */
function truncate(text, maxBytes) {
  const s = String(text == null ? '' : text);
  if (s.length <= maxBytes) return s;
  const head = Math.floor(maxBytes * 0.6);
  const tail = maxBytes - head;
  const dropped = s.length - maxBytes;
  return `${s.slice(0, head)}\n…[truncated ${dropped} chars]…\n${s.slice(s.length - tail)}`;
}

/**
 * Resolve a tool's working directory INSIDE the workspace root carried on ctx.
 * Refuses any `dir` that escapes the root (path traversal).
 * @param {{ cwd?: string, rootDir?: string }} ctx
 * @param {string} [dir] optional subdirectory relative to the root
 * @returns {string} absolute path inside the root
 */
function resolveWorkdir(ctx = {}, dir) {
  const base = path.resolve(ctx.cwd || ctx.rootDir || process.cwd());
  if (!dir) return base;
  const target = path.resolve(base, String(dir));
  const relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`refusing to operate outside the workspace: "${dir}"`);
  }
  return target;
}

/**
 * Run one command with an argument array (never a shell). Resolves with a
 * normalized result and NEVER rejects on non-zero exit — callers format the
 * outcome for the model. Rejects only on programmer error (bad arguments).
 * @returns {Promise<{ ok:boolean, code:(number|null), signal:(string|null),
 *   stdout:string, stderr:string, timedOut:boolean, notFound:boolean }>}
 */
async function runCommand(command, args = [], opts = {}) {
  if (typeof command !== 'string' || !command) throw new Error('runCommand: command must be a non-empty string');
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0'))) {
    throw new Error('runCommand: args must be an array of strings without null bytes');
  }
  const limits = toolLimits();
  const timeoutSec = Number(opts.timeoutSec) || limits.timeoutSec;
  const { env } = opts.env ? { env: opts.env } : sanitizedToolEnv();
  const invocation = networkSandboxInvocation(command, args, opts);
  try {
    const { stdout, stderr } = await execFileP(invocation.command, invocation.args, {
      cwd: opts.cwd,
      env,
      shell: false,
      timeout: timeoutSec * 1000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, code: 0, signal: null, stdout, stderr, timedOut: false, notFound: false };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: false, code: 127, signal: null, stdout: '', stderr: '', timedOut: false, notFound: true };
    }
    return {
      ok: false,
      code: typeof err.code === 'number' ? err.code : null,
      signal: err.signal || null,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : String(err.message || err),
      timedOut: Boolean(err.killed) && err.signal === 'SIGTERM',
      notFound: false,
    };
  }
}

/** Append the platform command-shim suffix (`.cmd`) on Windows for node CLIs. */
function platformCmd(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

/**
 * The DRY core each executing tool calls: resolve cwd, announce progress, run,
 * then return a redacted, bounded, model-readable summary string.
 * @param {object} params
 * @param {object} params.ctx     tool ctx ({ cwd|rootDir, step })
 * @param {string} params.label   short human label for the step line
 * @param {string} params.command executable name
 * @param {string[]} params.args  argument array
 * @param {string} [params.dir]   workspace-relative working directory
 * @param {number} [params.timeoutSec]
 * @param {string} [params.notFoundHint] guidance shown when the CLI is absent
 * @returns {Promise<string>}
 */
async function execTool({ ctx = {}, label, command, args, dir, timeoutSec, notFoundHint }) {
  const step = typeof ctx.step === 'function' ? ctx.step : () => {};
  const cwd = resolveWorkdir(ctx, dir);
  const { env, secrets } = sanitizedToolEnv();
  const printable = `${command} ${args.join(' ')}`.trim();
  step(`🛠️  ${label}: ${printable.slice(0, 120)}`);
  const result = await runCommand(command, args, {
    cwd,
    timeoutSec,
    env,
    isolateNetwork: ctx.isolateNetwork === true,
  });
  if (result.notFound) {
    return `❌ ${label}: \`${command}\` is not installed / not on PATH.\n${notFoundHint || `Install the ${command} CLI (this tool delegates to it) and retry.`}`;
  }
  return formatResult({ label, command, args, cwd, result, secrets });
}

/**
 * Whether a CLI is available on PATH (cheap probe via its version flag).
 * @param {string} command
 * @param {string} [versionArg]  e.g. '--version' (default) or 'version' for `go`
 * @returns {Promise<boolean>}
 */
async function commandExists(command, versionArg = '--version') {
  try {
    const { env } = sanitizedToolEnv();
    const result = await runCommand(command, [versionArg], { env, timeoutSec: 30 });
    return !result.notFound;
  } catch (_) {
    return false;
  }
}

/**
 * Run an ordered list of steps in one working directory, stopping at the first
 * failure. Used by orchestration tools (env/build/android) that chain several
 * standard CLIs. Returns the concatenated, redacted output and overall success.
 * @param {object} params
 * @param {object} params.ctx
 * @param {string} [params.dir]
 * @param {Array<{label:string,command:string,args:string[],timeoutSec?:number,notFoundHint?:string}>} params.steps
 * @param {number} [params.timeoutSec]
 * @returns {Promise<{ ok:boolean, output:string }>}
 */
async function runSequence({ ctx = {}, dir, steps = [], timeoutSec }) {
  const cwd = resolveWorkdir(ctx, dir);
  const { env, secrets } = sanitizedToolEnv();
  const step = typeof ctx.step === 'function' ? ctx.step : () => {};
  const chunks = [];
  for (const s of steps) {
    step(`🛠️  ${s.label}: ${s.command} ${s.args.join(' ')}`.slice(0, 140));
    const result = await runCommand(s.command, s.args, {
      cwd,
      env,
      timeoutSec: s.timeoutSec || timeoutSec,
      isolateNetwork: ctx.isolateNetwork === true,
    });
    if (result.notFound) {
      chunks.push(`❌ ${s.label}: \`${s.command}\` is not installed / not on PATH.\n${s.notFoundHint || `Install ${s.command} and retry.`}`);
      return { ok: false, output: chunks.join('\n\n') };
    }
    chunks.push(formatResult({ label: s.label, command: s.command, args: s.args, cwd, result, secrets }));
    if (!result.ok) return { ok: false, output: chunks.join('\n\n') };
  }
  return { ok: true, output: chunks.join('\n\n') };
}

/** Format a completed command result into the string returned to the model. */
function formatResult({ label, command, args, cwd, result, secrets = [] }) {
  const { maxOutputBytes } = toolLimits();
  const status = result.ok ? '✅ ok' : result.timedOut ? '⏱️ timed out' : `❌ exit ${result.code}${result.signal ? ` (${result.signal})` : ''}`;
  const header = `${status} — ${label}\n$ ${command} ${args.join(' ')}\n(cwd: ${cwd})`;
  const body = [result.stdout, result.stderr].map((s) => (s || '').trim()).filter(Boolean).join('\n');
  const redacted = redactSecrets(body, secrets, maxOutputBytes);
  return redacted ? `${header}\n\n${redacted}` : header;
}

/**
 * Build a LangChain tool factory with lazy langchain/zod requires (matching the
 * registry convention) and a uniform try/catch that returns an error string
 * instead of throwing — one thrown tool must not abort the agent run.
 * @param {{ name:string, description:string, schema:(z:any)=>any }} def
 * @param {(input:object, ctx:object)=>Promise<string>|string} handler
 * @returns {(ctx?:object)=>object} factory usable in the FACTORIES registry
 */
function defineTool(def, handler) {
  return (ctx = {}) => {
    const { tool } = require('@langchain/core/tools');
    const { z } = require('zod');
    return tool(
      async (input) => {
        try {
          return await handler(input || {}, ctx);
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          return `❌ ${def.name} failed: ${redactSecrets(msg)}`;
        }
      },
      { name: def.name, description: def.description, schema: def.schema(z) }
    );
  };
}

module.exports = {
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_MAX_OUTPUT_BYTES,
  SECRET_KEY_RE,
  sanitizedToolEnv,
  redactSecrets,
  truncate,
  resolveWorkdir,
  runCommand,
  networkSandboxInvocation,
  NETWORK_SANDBOX_COMMAND,
  platformCmd,
  commandExists,
  runSequence,
  execTool,
  formatResult,
  defineTool,
  toolLimits,
};
