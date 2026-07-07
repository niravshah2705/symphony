'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { CONFIG } = require('../config');

const execFileP = promisify(execFile);

/**
 * Isolated per-ticket git workspace lifecycle for the code-writer agent
 * (equivalent to Symphony's workspace root + after_create clone hook). Each
 * ticket gets its own clone under CONFIG.CODER.workspaceRoot so runs never
 * touch each other or the user's repos.
 *
 * Skills are installed into the workspace by the agent framework (which knows
 * the coding workflow's skill list), not here.
 */

async function run(cmd, args, cwd) {
  const { stdout } = await execFileP(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function git(args, cwd, env) {
  const { stdout } = await execFileP('git', args, { cwd, env, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/**
 * Git credential helper that supplies the token from the GH_TOKEN env var at
 * call time. Persisted into the repo config so the coding agent's own git ops
 * (push/pull) authenticate too — WITHOUT ever writing the token into .git/config
 * (secret-leakage checklist: never store credentials in repo config/URLs).
 */
const GIT_CREDENTIAL_HELPER =
  "!f() { test \"$1\" = get && printf 'username=x-access-token\\npassword=%s\\n' \"$GH_TOKEN\"; }; f";

/** Slug for a filesystem dir — lowercased, alnum + hyphen only (no path traversal). */
function sanitizeSlug(name) {
  const s = String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'project';
}

/** git-safe branch name from an untrusted task shortname (command-injection guard). */
function sanitizeBranch(name) {
  const b = String(name || '')
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\.\.+/g, '-')
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .slice(0, 80);
  return b || 'task';
}

/**
 * Parse a GitHub repo reference into owner/name + a tokenless https URL. Accepts a
 * bare `owner/name`, an https URL, or an ssh URL — all resolved to a github.com
 * https URL (so an operator-supplied repo can't point clones at an arbitrary host).
 */
function repoParts(repoUrl) {
  const s = String(repoUrl || '').trim();
  const SEG = '[A-Za-z0-9_.-]+';
  // Bare "owner/name".
  let m = s.match(new RegExp(`^(${SEG})/(${SEG}?)(?:\\.git)?$`));
  if (m) return { owner: m[1], name: m[2], https: `https://github.com/${m[1]}/${m[2]}.git` };
  // https:// or git@ URL.
  m = s.match(/[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (m) return { owner: m[1], name: m[2], https: `https://github.com/${m[1]}/${m[2]}.git` };
  return null;
}

function scrub(text, secret) {
  const s = String(text || '');
  return secret ? s.split(secret).join('***') : s;
}

/**
 * Prepare the MONOREPO workspace for a planned task: one clone per project at
 * <plannedWorkspaceRoot>/<project-slug>/ (reused across the project's tasks), then
 * create/checkout a per-task branch off the default branch. Token auth is via the
 * env-based credential helper; the token is never written to config/URLs/logs.
 * @returns {Promise<{ workDir:string, branch:string, slug:string, cloned:boolean, env:object }>}
 */
async function preparePlannedWorkspace({ repoUrl, projectSlug, taskBranch, githubToken, onStep }) {
  const step = typeof onStep === 'function' ? onStep : () => {};
  const slug = sanitizeSlug(projectSlug);
  const branch = sanitizeBranch(taskBranch);
  const root = CONFIG.CODER.plannedWorkspaceRoot;
  const workDir = path.join(root, slug);
  const parts = repoParts(repoUrl);
  const env = { ...process.env };
  if (githubToken) env.GH_TOKEN = githubToken;

  const hasGit = fs.existsSync(path.join(workDir, '.git'));
  let cloned = false;
  try {
    if (!hasGit) {
      fs.mkdirSync(root, { recursive: true });
      if (!parts) {
        step('No valid CODER_REPO_URL; using an empty monorepo workspace.');
        fs.mkdirSync(workDir, { recursive: true });
      } else {
        step(`Cloning ${parts.owner}/${parts.name} into monorepo workspace ${workDir}…`);
        await git(['-c', `credential.helper=${GIT_CREDENTIAL_HELPER}`, 'clone', parts.https, workDir], root, env);
        // Persist the helper (NOT the token) so the agent's push/pull authenticate.
        await git(['-C', workDir, 'config', 'credential.helper', GIT_CREDENTIAL_HELPER], root, env);
        cloned = true;
      }
    } else {
      step(`Reusing monorepo workspace ${workDir}.`);
    }

    if (fs.existsSync(path.join(workDir, '.git'))) {
      await git(['-C', workDir, 'fetch', 'origin', '--prune'], root, env).catch(() => {});
      const headRef = await git(['-C', workDir, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], root, env).catch(() => '');
      const base = (headRef.trim().replace(/^origin\//, '')) || 'main';
      await git(['-C', workDir, 'checkout', base], root, env).catch(() => {});
      await git(['-C', workDir, 'pull', '--ff-only', 'origin', base], root, env).catch(() => {});
      const exists = await git(['-C', workDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root, env).then(() => true).catch(() => false);
      if (exists) {
        await git(['-C', workDir, 'checkout', branch], root, env);
      } else {
        await git(['-C', workDir, 'checkout', '-b', branch, base], root, env);
      }
      step(`On branch ${branch} (monorepo ${slug}).`);
    }
  } catch (err) {
    step(`Monorepo workspace setup issue: ${scrub(err && err.message, githubToken)}`, 'warn');
  }

  return { workDir, branch, slug, cloned, env };
}

/**
 * Prepare an isolated workspace for a ticket. Clones repoUrl (shallow) on first
 * use, reuses the existing dir on continuation.
 * @returns {Promise<{workDir:string, cloned:boolean, reused:boolean}>}
 */
async function prepareWorkspace({ repoUrl, identifier, onStep }) {
  const step = typeof onStep === 'function' ? onStep : () => {};
  const safe = String(identifier || 'ticket').replace(/[^A-Za-z0-9._-]/g, '-');
  const workDir = path.join(CONFIG.CODER.workspaceRoot, safe);
  const reused = fs.existsSync(workDir);
  let cloned = false;

  if (!reused) {
    fs.mkdirSync(workDir, { recursive: true });
    if (repoUrl) {
      step(`Cloning ${repoUrl} into an isolated workspace…`);
      await run('git', ['clone', '--depth', '1', repoUrl, '.'], workDir);
      cloned = true;
    } else {
      step('No CODER_REPO_URL configured; using an empty workspace.');
    }
  } else {
    step(`Reusing existing workspace at ${workDir}.`);
  }

  return { workDir, cloned, reused };
}

module.exports = { prepareWorkspace, preparePlannedWorkspace, sanitizeSlug, sanitizeBranch, repoParts };
