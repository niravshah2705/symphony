'use strict';

/**
 * DeepSeek Harness (`@deepseek-ai/dsh`). Drives the `dsh` agent runtime in its
 * one-shot **headless** mode (`dsh --profile headless "<task>"`): the runtime
 * boots the coding persona + tool bundle, runs the task to quiescence, prints
 * the final assistant text to stdout, and exits 0 (success) / non-zero (failure,
 * message on stderr). There is no Node driver-SDK, so this adapter spawns the
 * runtime as a subprocess — the same shape the reference Python SDK uses.
 *
 * SECURITY: the subprocess env is rebuilt from `buildSafeAgentEnv` (every
 * token/key/secret-shaped and non-whitelisted var stripped); only the scoped
 * DeepSeek model config + DSH_* runtime pointers are re-added, so the child sees
 * exactly one credential and no ambient secrets. Provider-neutral (like
 * DeepAgent): the model route is whatever `options.llm` resolves to (DeepSeek
 * cloud or a local Ollama), reached over the OpenAI-compatible wire.
 *
 * MOUNT-DISK SEAM: `resolveDshBin` points at an EXTERNAL runtime binary via
 * `DSH_BIN` (a mounted "pluggable runtime disk", resolved under
 * `DSH_RUNTIME_DIR`). The heavy `@deepseek-ai/dsh` tree is deliberately NOT baked
 * into the coder/planner image — that is the whole point of the mount disk. As a
 * convenience, an OPTIONAL locally-installed `@deepseek-ai/dsh` is used when
 * present (dev), so the runtime is never a hard image dependency.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { buildSafeAgentEnv } = require('../repository-broker');
const registry = require('./registry');
const {
  AgentRuntimeError,
  assertWorkingDirectory,
  cleanSystemPrompt,
  reasoningEffort,
  normalizeUsage,
  assistantMessagesFromText,
  wrapExecutionError,
} = require('./contract');

const ID = 'deepseek';
const LABEL = 'DeepSeek Harness';
const PACKAGE = '@deepseek-ai/dsh';
const DEFAULT_PROFILE = 'headless';
const DEFAULT_PROVIDER = 'deepseek-official';
const DEFAULT_RUNTIME_DIR = '/opt/dsh-runtime';

/** Map the shared reasoning-effort vocabulary onto what dsh accepts. */
function dshReasoningEffort(value) {
  const effort = reasoningEffort(value);
  if (!effort) return undefined;
  if (effort === 'minimal') return 'low';
  if (effort === 'xhigh') return 'high';
  return effort; // low | medium | high
}

function removeEphemeralHome(home) {
  if (!home) return;
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch (_) {
    // Cleanup must not replace the run result/error. The home is uniquely named
    // and holds only this run's dsh profile/session scratch.
  }
}

/**
 * Resolve the `dsh` runtime invocation from env (the mount-disk seam):
 *   1. `DSH_BIN`            — explicit path to an external runtime (a mounted disk).
 *   2. `DSH_RUNTIME_DIR`    — arch-named self-contained binary under the mount.
 *   3. bundled `@deepseek-ai/dsh` — its `dsh` bin (a Node script), run via node.
 * Returns `{ command, prefixArgs }` where a `.js` entry is launched with the
 * current Node binary and a self-contained exe is launched directly. Throws
 * `runtime_unavailable` when nothing resolvable/executable is found.
 */
function resolveDshBin(env = process.env) {
  const explicit = String(env.DSH_BIN || '').trim();
  if (explicit) {
    // Fail fast when the pointer names a disk that is not mounted (reference
    // docker-entrypoint does the same `[ ! -x "$DSH_BIN" ]` check).
    if (!fs.existsSync(explicit)) {
      throw new AgentRuntimeError(
        `The DeepSeek dsh runtime binary was not found at DSH_BIN=${explicit}. `
        + 'Mount the runtime disk or unset DSH_BIN to use the bundled runtime.',
        'runtime_unavailable',
        503
      );
    }
    return commandFor(explicit);
  }

  const runtimeDir = String(env.DSH_RUNTIME_DIR || '').trim() || DEFAULT_RUNTIME_DIR;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const archBin = path.join(runtimeDir, `deepseek-harness-sdk-runtime-linux-${arch}`);
  if (isExecutable(archBin)) return commandFor(archBin);

  const bundled = bundledDshScript();
  if (bundled) return { command: process.execPath, prefixArgs: [bundled] };

  throw new AgentRuntimeError(
    `The DeepSeek dsh runtime is unavailable. Mount the runtime disk (set DSH_BIN, `
    + `or DSH_RUNTIME_DIR=${runtimeDir} with the arch binary) — the ${PACKAGE} runtime `
    + 'is intentionally not baked into the image. For local dev, `npm i @deepseek-ai/dsh`.',
    'runtime_unavailable',
    503
  );
}

/** Split a resolved binary path into a spawn command, launching `.js` via node. */
function commandFor(binPath) {
  if (/\.[cm]?js$/i.test(binPath)) return { command: process.execPath, prefixArgs: [binPath] };
  return { command: binPath, prefixArgs: [] };
}

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/** Resolve the bundled `@deepseek-ai/dsh` CLI entry (its package.json `bin.dsh`). */
function bundledDshScript() {
  try {
    const manifestPath = require.resolve(`${PACKAGE}/package.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const bin = manifest.bin && (typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.dsh);
    if (!bin) return null;
    const entry = path.resolve(path.dirname(manifestPath), bin);
    return fs.existsSync(entry) ? entry : null;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve the mandatory, isolated DSH_HOME for one run. Precedence:
 *   1. an explicit caller `DSH_HOME` (honored as-is, persisted),
 *   2. the materialized registry artifact's `home/.dsh` (persisted skill/profile
 *      seed — see `materializeArtifactHome`),
 *   3. a private 0700 temp home, removed after the run.
 * dsh never auto-discovers `~/.dsh`, so this is always explicit.
 */
function resolveDshHome(env = process.env, artifactRoot = null) {
  const explicit = String(env.DSH_HOME || '').trim();
  if (explicit) {
    fs.mkdirSync(explicit, { recursive: true });
    return { home: explicit, ephemeral: false };
  }
  if (artifactRoot) {
    const home = path.join(artifactRoot, 'home', '.dsh');
    fs.mkdirSync(home, { recursive: true });
    return { home, ephemeral: false };
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'techsymphony-dsh-home-'));
  fs.chmodSync(home, 0o700);
  return { home, ephemeral: true };
}

/**
 * Lazily materialize this harness's registry artifact (skills/profile seed) on
 * first use when the mount is enabled; a no-op (returns null) when it is off.
 * Fail-open: a registry hiccup degrades to an ephemeral home rather than failing
 * a run that the bundled runtime could still serve.
 */
async function materializeArtifactHome(env) {
  try {
    const { ensureHarnessArtifact } = require('@ai-fleet/shared-core/agent/registry/materialize');
    return await ensureHarnessArtifact(ID, { env });
  } catch (_) {
    return null;
  }
}

/**
 * Default runner: spawn the dsh runtime headless and resolve its final text.
 * Materializes the profile once per DSH_HOME (offline `--dump-default-config`,
 * as the reference entrypoint does), then runs `--profile <profile> "<task>"`.
 * Swappable via `options.loaders.deepseek` for tests (no real subprocess).
 */
function defaultRunDsh({ command, prefixArgs, profile, task, env, cwd, signal }) {
  return new Promise((resolve, reject) => {
    const profileDir = path.join(env.DSH_HOME, 'profiles', profile);
    const materialize = fs.existsSync(profileDir)
      ? Promise.resolve()
      : runOnce(command, [...prefixArgs, '--profile', profile, '--dump-default-config'], { env, cwd })
        .catch(() => {}); // best-effort; boot below reports a real failure

    materialize.then(() => {
      const child = spawn(command, [...prefixArgs, '--profile', profile, task], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const onAbort = () => child.kill('SIGTERM');
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (error) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(error);
      });
      child.on('close', (code) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (code === 0) {
          resolve({ finalText: stdout.trim(), usage: null, sessionId: null, raw: { code, stdout, stderr } });
          return;
        }
        const detail = stderr.trim() || stdout.trim() || `dsh exited with code ${code}`;
        reject(new Error(detail));
      });
    }, reject);
  });
}

/** Run a short offline dsh subcommand to completion, ignoring its stdout. */
function runOnce(command, args, { env, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(stderr.trim() || `dsh setup exited with code ${code}`))));
  });
}

/** Pick the run transport: a caller-injected runner (tests) or the real spawn. */
async function resolveRunner(loaders) {
  const custom = loaders && loaders[ID];
  if (typeof custom === 'function') return custom();
  return defaultRunDsh;
}

async function executeDeepseek(options, prompt) {
  const llm = options.llm;
  if (!llm || !llm.model) {
    throw new AgentRuntimeError(
      'DeepSeek harness requires a model selection.',
      'runtime_provider_mismatch',
      400
    );
  }
  // dsh speaks the OpenAI-compatible wire. Providers whose credential is a raw
  // OAuth access token for a bespoke backend (Codex ChatGPT, Claude) cannot ride
  // that path, so reject them rather than mis-route the run.
  if (llm.provider === 'claude' || (llm.provider === 'codex' && llm.backend === 'chatgpt')) {
    throw new AgentRuntimeError(
      `DeepSeek harness does not support the ${llm.provider} model slot.`,
      'runtime_provider_mismatch',
      400
    );
  }

  const cwd = assertWorkingDirectory(options.rootDir);
  const resolved = resolveDshBin(options.env || process.env);
  const runDsh = await resolveRunner(options.loaders);
  const artifactRoot = await materializeArtifactHome(options.env || process.env);
  const home = resolveDshHome(options.env || process.env, artifactRoot);

  try {
    // Rebuild a sanitized env, then re-add ONLY the scoped DeepSeek model config
    // and dsh runtime pointers (buildSafeAgentEnv strips them as secret-shaped).
    const env = buildSafeAgentEnv(options.env || process.env, cwd);
    env.DSH_HOME = home.home;
    env.HARNESS_WORKSPACE = cwd;
    env.DSH_PROVIDER = (options.env && options.env.DSH_PROVIDER) || DEFAULT_PROVIDER;
    if (resolved.command !== process.execPath) env.DSH_BIN = resolved.command;
    const runtimeDir = (options.env && options.env.DSH_RUNTIME_DIR) || '';
    if (runtimeDir) env.DSH_RUNTIME_DIR = runtimeDir;
    if (llm.baseUrl) env.DEEPSEEK_BASE_URL = llm.baseUrl;
    // Ollama accepts any non-empty key; proxy mode supplies the sentinel here.
    env.DEEPSEEK_API_KEY = llm.apiKey || llm.accessToken || 'ollama';
    env.DEEPSEEK_MODEL = llm.model;

    // dsh headless submits the task as a user message and has no separate
    // system-prompt channel, so fold the trusted rules into the task (as
    // Antigravity does). The dispatcher has already prepended the
    // workflow-pattern block to `prompt`.
    const systemPrompt = cleanSystemPrompt(options.systemPrompt, options.ctx);
    const task = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;

    const out = await runDsh({
      command: resolved.command,
      prefixArgs: resolved.prefixArgs,
      profile: (options.env && options.env.DSH_PROFILE) || DEFAULT_PROFILE,
      task,
      env,
      cwd,
      signal: options.signal,
      reasoningEffort: dshReasoningEffort(llm.reasoningEffort),
    });

    const finalText = String((out && out.finalText) || '');
    return {
      runtime: ID,
      provider: llm.provider,
      model: llm.model,
      workflowPattern: options.workflowPattern,
      result: (out && out.raw) || out,
      messages: assistantMessagesFromText(finalText),
      finalText,
      usage: normalizeUsage(out && out.usage),
      // dsh reports token metering internally but the headless one-shot surface
      // emits only the final text, so no billed amount is available here.
      costUsd: null,
      sessionId: (out && out.sessionId) || null,
    };
  } catch (error) {
    throw wrapExecutionError(LABEL, error);
  } finally {
    if (home.ephemeral) removeEphemeralHome(home.home);
  }
}

registry.register(registry.builtinDefinition(ID, () => executeDeepseek));

module.exports = {
  executeDeepseek,
  resolveDshBin,
  resolveDshHome,
  dshReasoningEffort,
  bundledDshScript,
};
