'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createChatModel } = require('./llm');
const toolRegistry = require('./tools');
const { installSafeRead } = require('./safe-read');

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

const SKILLS_SRC = path.join(__dirname, 'skills');
const SKILLS_DEST_DIRNAME = '.agent-skills';
const WORKFLOWS_DIR = path.join(__dirname, 'workflows');

/**
 * Copy the named skills from server/agent/skills/ into `destRoot/.agent-skills/`
 * and return their backend-relative paths (e.g. `/.agent-skills/software-planning/`).
 * With no names, installs every available skill (back-compat with the coder's
 * previous "install all" behavior).
 */
function installSkills(destRoot, skillNames) {
  const dest = path.join(destRoot, SKILLS_DEST_DIRNAME);
  const available = fs.readdirSync(SKILLS_SRC).filter((n) => isDir(path.join(SKILLS_SRC, n)));
  const names = Array.isArray(skillNames) && skillNames.length ? skillNames : available;
  const paths = [];
  for (const name of names) {
    const from = path.join(SKILLS_SRC, name);
    if (!isDir(from)) continue; // skip unknown skill names rather than throw
    const to = path.join(dest, name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
    paths.push(`/${SKILLS_DEST_DIRNAME}/${name}/`);
  }
  return paths;
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
    // When an explicit env is supplied (e.g. git credential-helper variables),
    // pass the full env and disable inheritEnv so it isn't clobbered.
    if (opts.env) {
      return new LocalShellBackend({ rootDir, env: opts.env, inheritEnv: false, timeout: opts.timeout || 600 });
    }
    return new LocalShellBackend({ rootDir, inheritEnv: true, timeout: opts.timeout || 600 });
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
  const tools = [...toolRegistry.buildMany(workflow.tools, ctx), ...(extraTools || [])];
  const systemPrompt = typeof workflow.systemPrompt === 'function' ? workflow.systemPrompt(ctx) : workflow.systemPrompt;
  const agent = createDeepAgent({ model: createChatModel(llm), backend: be, skills, tools, systemPrompt });
  return { agent, backend: be, skillPaths: skills, tools };
}

/**
 * Run a workflow agent to completion on a single user message and return the
 * result plus the final assistant text. For repo-less workflows (no backend
 * provided) a scratch dir is created and cleaned up automatically.
 * @returns {Promise<{ result:object, messages:object[], finalText:string }>}
 */
async function runWorkflow({ workflow, llm, userMessage, backend, skillPaths, rootDir, ctx = {}, invokeConfig = {} }) {
  let scratch = null;
  if (!backend && !rootDir) {
    scratch = prepareScratch(workflow);
    rootDir = scratch.rootDir;
    skillPaths = scratch.skillPaths;
  }
  try {
    const extraTools = await require('./mcp').loadMcpTools(workflow.mcp, ctx);
    const { agent } = buildAgent({ workflow, llm, backend, skillPaths, rootDir, ctx, extraTools });
    const config = {
      recursionLimit: workflow.recursionLimit || 24,
      tags: workflow.tags || [],
      ...invokeConfig,
    };
    const result = await agent.invoke({ messages: [{ role: 'user', content: userMessage }] }, config);
    const messages = (result && result.messages) || [];
    return { result, messages, finalText: lastText(result) };
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
