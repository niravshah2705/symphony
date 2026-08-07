'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { resolveSkillsSrc } = require('../config');
const { createChatModel } = require('./llm');
const toolRegistry = require('./tools');
const { installSafeRead } = require('./safe-read');
const { createFsArgNormalizerMiddleware } = require('./fs-arg-normalizer');
const { buildSafeAgentEnv } = require('./repository-broker');
const { executeAgentRuntime, normalizeAgentRuntime, effectiveAgentRuntime } = require('./runtimes');
const { applyPolicyToWorkflow, filterSkillPaths } = require('./settings-policy');

/**
 * Workflow-driven deep-agent framework.
 *
 * Both the planning and coding agents are the SAME machine configured by a
 * declarative *workflow file* (server/agent/workflows/<name>.workflow.js). A
 * workflow declares which SKILLS to load, which TOOLS to attach, the backend
 * kind, the system prompt, and run limits. This module turns that descriptor
 * into a live `deepagents` agent and runs it, so the deepagents wiring lives in
 * one place instead of being copy-pasted per agent.
 *
 * Backends:
 *   - 'filesystem' — FilesystemBackend (read/write files, NO shell). Used by the
 *     planner: it only needs its skills on disk + the web_search tool, so denying
 *     shell removes an unnecessary capability (ai-prompt-injection: least tools).
 *   - 'shell'      — LocalShellBackend (fs + shell). Used by the coder, rooted at
 *     an isolated git workspace.
 *
 * Workflow shape:
 *   { name, description, backend: 'filesystem'|'shell', skills: string[],
 *     tools: string[], systemPrompt: string | (ctx)=>string,
 *     recursionLimit?: number, tags?: string[], shellTimeoutSec?: number }
 */

const SKILLS_DEST_DIRNAME = '.agent-skills';
const SKILLS_OWNER_MARKER = '.tech-symphony-managed';
const SKILLS_OWNER_MARKER_CONTENT = 'tech-symphony-agent-skills-v1\n';
const WORKFLOWS_DIR = path.join(__dirname, 'workflows');

/**
 * Copy the named skills from the configured skills source into
 * `destRoot/.agent-skills/` and return their backend-relative paths (e.g.
 * `/.agent-skills/software-planning/`). With no names, installs every available
 * skill (back-compat with the coder's previous "install all" behavior).
 *
 * The source directory is resolved per call from config (resolveSkillsSrc): the
 * vendored `skills/` dir by default, or a version-pinned gcsfuse mount subdir
 * (`$SKILLS_ROOT/$SKILLS_VERSION`) in the cloud. See packages/shared/src/config.js.
 */
function installSkills(destRoot, skillNames) {
  const skillsSrc = resolveSkillsSrc();
  const root = path.resolve(destRoot);
  const rootStat = lstatOrNull(root);
  if (!rootStat || !rootStat.isDirectory()) {
    throw new Error(`Skill destination root is not a directory: ${root}`);
  }
  const realRoot = fs.realpathSync(root);
  const dest = path.join(realRoot, SKILLS_DEST_DIRNAME);
  const available = fs.readdirSync(skillsSrc).filter((n) => isDir(path.join(skillsSrc, n)));
  const names = Array.isArray(skillNames) && skillNames.length ? skillNames : available;
  for (const name of names) validateSkillName(name);

  const tracked = trackedSkillPaths(root);
  if (tracked.length) {
    throw new Error(
      `Refusing to install framework skills over tracked project files in ${SKILLS_DEST_DIRNAME}: ${tracked.slice(0, 3).join(', ')}`
    );
  }

  claimSkillsDirectory(dest, realRoot);
  const paths = [];
  for (const name of new Set(names)) {
    const from = path.join(skillsSrc, name);
    if (!isDir(from)) continue; // skip unknown skill names rather than throw
    assertNoSymlinks(from);
    const to = path.join(dest, name);
    assertContained(realRoot, to);
    assertNoSymlinks(to);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
    paths.push(`/${SKILLS_DEST_DIRNAME}/${name}/`);
  }
  return paths;
}

function validateSkillName(name) {
  if (
    typeof name !== 'string'
    || !name
    || name === '.'
    || name === '..'
    || path.basename(name) !== name
    || name.includes('/')
    || name.includes('\\')
  ) {
    throw new Error(`Invalid skill name: ${String(name)}`);
  }
}

function trackedSkillPaths(root) {
  try {
    const output = execFileSync('git', ['-C', root, 'ls-files', '--', SKILLS_DEST_DIRNAME], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch (_) {
    // Scratch workspaces are intentionally not Git repositories.
    return [];
  }
}

function claimSkillsDirectory(dest, realRoot) {
  const existing = lstatOrNull(dest);
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link skill destination: ${dest}`);
    }
    if (!existing.isDirectory()) {
      throw new Error(`Refusing non-directory skill destination: ${dest}`);
    }
    assertContained(realRoot, fs.realpathSync(dest));
    assertNoSymlinks(dest);
    const marker = path.join(dest, SKILLS_OWNER_MARKER);
    const markerStat = lstatOrNull(marker);
    if (!markerStat || markerStat.isSymbolicLink() || !markerStat.isFile()) {
      throw new Error(`Refusing project-owned skill directory without a valid ownership marker: ${dest}`);
    }
    if (fs.readFileSync(marker, 'utf8') !== SKILLS_OWNER_MARKER_CONTENT) {
      throw new Error(`Refusing skill directory with an invalid ownership marker: ${dest}`);
    }
    return;
  }

  assertContained(realRoot, dest);
  fs.mkdirSync(dest);
  assertContained(realRoot, fs.realpathSync(dest));
  fs.writeFileSync(path.join(dest, SKILLS_OWNER_MARKER), SKILLS_OWNER_MARKER_CONTENT, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

function assertContained(realRoot, candidate) {
  const relative = path.relative(realRoot, path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing to install skills outside destination root: ${candidate}`);
  }
}

function assertNoSymlinks(target) {
  const stat = lstatOrNull(target);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing symbolic link inside skill destination: ${target}`);
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(target)) {
    assertNoSymlinks(path.join(target, entry));
  }
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

/** Build the backend for a workflow kind, rooted at `rootDir`. */
function buildBackend(kind, rootDir, opts = {}) {
  const { FilesystemBackend, LocalShellBackend } = require('deepagents');
  if (kind === 'shell') {
    // The shell never inherits the service environment. Re-sanitize even an
    // explicitly supplied env so repository/API credentials cannot reach agent
    // commands through a future caller by mistake.
    const env = buildSafeAgentEnv(opts.env || process.env, rootDir);
    return new LocalShellBackend({ rootDir, env, inheritEnv: false, timeout: opts.timeout || 600 });
  }
  return new FilesystemBackend({ rootDir });
}

/** Load a workflow descriptor by name from workflows/<name>.workflow.js. */
function loadWorkflow(name) {
  const file = path.join(WORKFLOWS_DIR, `${name}.workflow.js`);
  if (!fs.existsSync(file)) {
    throw new Error(`Unknown workflow "${name}" (expected ${file}).`);
  }
  return require(file);
}

/**
 * Prepare an isolated scratch directory for a workflow that has no repo of its
 * own (e.g. the planner). Installs the workflow's skills there so a
 * FilesystemBackend rooted at the dir can load them. Returns a cleanup fn.
 */
function prepareScratch(workflow) {
  const rootDir = path.join(os.tmpdir(), 'techsym-agent', `${workflow.name}-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(rootDir, { recursive: true });
  const skillPaths = installSkills(rootDir, workflow.skills);
  const cleanup = () => fs.rmSync(rootDir, { recursive: true, force: true });
  return { rootDir, skillPaths, cleanup };
}

/**
 * Build a deep agent from a workflow. Callers either pass a prepared
 * `{ backend, skillPaths }` (the coder, rooted at its git workspace) or a
 * `rootDir` for the framework to root a fresh backend + install skills into.
 */
function buildAgent({ workflow, llm, backend, skillPaths, rootDir, ctx = {}, extraTools = [], env }) {
  const { createDeepAgent } = require('deepagents');
  let skills = skillPaths;
  let be = backend;
  if (!be) {
    if (!rootDir) throw new Error('buildAgent needs a backend or a rootDir.');
    skills = skills || installSkills(rootDir, workflow.skills);
    be = buildBackend(workflow.backend, rootDir, { timeout: workflow.shellTimeoutSec, env });
  }
  // Guard read_file against Anthropic's content-block rules: unrecognized/binary
  // files must not be sent as non-PDF `document` blocks (invalid_request_error).
  be = installSafeRead(be);
  // Settings-service ENFORCEMENT: prune this workflow's tools/skills by the
  // caller's EFFECTIVE include/exclude policy (services/settings resolves the
  // org→project→user cascade; `ctx.effectivePolicy` is threaded in by the
  // caller). Absent policy → allow-all (local single-user; no regression).
  const effective = ctx.effectivePolicy;
  const effectiveWorkflow = applyPolicyToWorkflow(workflow, effective, { toolDomains: toolRegistry.TOOL_DOMAIN });
  skills = filterSkillPaths(skills, effective);
  const tools = [...toolRegistry.buildMany(effectiveWorkflow.tools, ctx), ...(extraTools || [])];
  const systemPrompt = typeof workflow.systemPrompt === 'function' ? workflow.systemPrompt(ctx) : workflow.systemPrompt;
  // Repair mis-keyed filesystem tool calls (e.g. read_file with `path` instead
  // of `file_path`) before they hit the tool's schema — a single wrong key
  // otherwise aborts the whole deep-agent run. See fs-arg-normalizer.js.
  const middleware = [createFsArgNormalizerMiddleware()];
  const agent = createDeepAgent({ model: createChatModel(llm), backend: be, skills, tools, systemPrompt, middleware });
  return { agent, backend: be, skillPaths: skills, tools };
}

/**
 * Run a workflow agent to completion on a single user message and return the
 * result plus the final assistant text. For repo-less workflows (no backend
 * provided) a scratch dir is created and cleaned up automatically.
 * @returns {Promise<{ result:object, messages:object[], finalText:string }>}
 */
async function runWorkflow({
  workflow,
  llm,
  userMessage,
  backend,
  skillPaths,
  rootDir,
  ctx = {},
  invokeConfig = {},
  runtime = 'deepagent',
  workflowPattern = 'sequential',
  env,
}) {
  let scratch = null;
  if (!backend && !rootDir) {
    scratch = prepareScratch(workflow);
    rootDir = scratch.rootDir;
    skillPaths = scratch.skillPaths;
  }
  try {
    const requestedRuntime = normalizeAgentRuntime(runtime, { strict: true });
    const runtimeId = effectiveAgentRuntime(requestedRuntime, llm, {
      strict: true,
      workflow: workflow.name,
      effectivePolicy: ctx.effectivePolicy || null,
    });
    const config = {
      recursionLimit: workflow.recursionLimit || 24,
      tags: workflow.tags || [],
      ...invokeConfig,
    };
    let deepAgentInvoke;
    if (runtimeId === 'deepagent') {
      const extraTools = await require('./mcp').loadMcpTools(workflow.mcp, ctx);
      const { agent } = buildAgent({ workflow, llm, backend, skillPaths, rootDir, ctx, extraTools, env });
      deepAgentInvoke = (prompt, tracedConfig) => {
        // The runtime wrapper owns the LangSmith root run id. Passing the same
        // id into the nested LangGraph invocation would create a duplicate run.
        const childConfig = { ...tracedConfig };
        delete childConfig.runId;
        return agent.invoke({ messages: [{ role: 'user', content: prompt }] }, childConfig);
      };
    }
    return executeAgentRuntime({
      runtime: requestedRuntime,
      workflowPattern,
      prompt: userMessage,
      workflow: workflow.name,
      llm,
      rootDir,
      backendKind: workflow.backend,
      systemPrompt: workflow.systemPrompt,
      maxTurns: workflow.recursionLimit || 24,
      ctx,
      env,
      invokeConfig: config,
      tags: workflow.tags || [],
      deepAgentInvoke,
      lastText,
    });
  } finally {
    if (scratch) scratch.cleanup();
  }
}

/** Normalize message content (string or content-block array) to plain text. */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('');
  return '';
}

/**
 * Text of a chat message, tolerant of REASONING models. Some models (e.g. LM
 * Studio's ornith) emit their answer as reasoning tokens and leave `content`
 * empty, putting the visible text in `additional_kwargs.reasoning_content`. When
 * `content` is blank we fall back to that so downstream parsing still sees the
 * answer, regardless of the JSON mode.
 */
function messageText(msg) {
  if (!msg) return '';
  const primary = contentToText(msg.content);
  if (primary && primary.trim()) return primary;
  const ak = msg.additional_kwargs || {};
  return contentToText(ak.reasoning_content || ak.reasoning || '');
}

function lastText(result) {
  const messages = (result && result.messages) || [];
  return messageText(messages[messages.length - 1]);
}

module.exports = {
  installSkills,
  buildBackend,
  loadWorkflow,
  prepareScratch,
  buildAgent,
  runWorkflow,
  contentToText,
  messageText,
  lastText,
  SKILLS_DEST_DIRNAME,
};
