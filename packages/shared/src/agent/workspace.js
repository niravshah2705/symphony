'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CONFIG } = require('../config');
const { RepositoryBroker, buildSafeAgentEnv } = require('./repository-broker');

/**
 * Per-ticket/per-project workspaces for the code-writer agent. Credentialed
 * repository operations are delegated to RepositoryBroker; the checkout only
 * contains a canonical, tokenless origin and the shell receives a small
 * allowlisted environment.
 */

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

/** Stable project workspace name; the id digest prevents same-name collisions. */
function scopedProjectSlug(name, id) {
  const slug = sanitizeSlug(name || id);
  const stableId = String(id || name || 'project');
  const digest = crypto.createHash('sha256').update(stableId).digest('hex').slice(0, 10);
  return `${slug}-${digest}`;
}

/**
 * Absolute per-task workspace path: <root>/<project-slug>/<task-slug>. Distinct
 * per task branch so a project's concurrent tasks never share a working tree,
 * and stable per branch so a retry of the same task reuses (and refreshes) its
 * checkout.
 */
function plannedTaskWorkdir(root, projectSlug, projectId, taskBranch) {
  const slug = scopedProjectSlug(projectSlug, projectId);
  const taskDir = sanitizeSlug(sanitizeBranch(taskBranch));
  return path.join(root, slug, taskDir);
}

// repoParts (repo-reference parsing) is SDK-free and now lives in shared-core so
// the router gateway can parse repo URLs without the agent/workspace tree. It is
// re-exported below, so `@ai-fleet/shared/agent/workspace` callers are unaffected.
const { repoParts } = require('@ai-fleet/shared-core/agent/repo-url');

function createBroker({ root, workDir, branch, parts, repositoryToken, stackCandidates = [], onStep }) {
  return new RepositoryBroker({
    provider: parts.provider,
    repository: parts,
    token: repositoryToken,
    workspaceRoot: root,
    workDir,
    branch,
    stackCandidates,
    label: CONFIG.CODER.prLabel,
    step: onStep,
  });
}

/**
 * Prepare the workspace for a planned task: one checkout PER TASK at
 * <plannedWorkspaceRoot>/<project-slug>/<task-slug>/, so a project's independent
 * tasks can run concurrently without sharing a working tree. The dir is keyed by
 * the task branch, so a retry of the same task reuses (and refreshes) its
 * checkout while a different task gets its own isolated clone. A server-scoped
 * repository broker controls the task branch.
 */
async function preparePlannedWorkspace({
  repoUrl,
  repositoryProvider = 'github',
  projectSlug,
  projectId,
  taskBranch,
  repositoryToken = '',
  stackCandidates = [],
  onStep,
}) {
  const step = typeof onStep === 'function' ? onStep : () => {};
  const slug = scopedProjectSlug(projectSlug, projectId);
  const branch = sanitizeBranch(taskBranch);
  const root = CONFIG.CODER.plannedWorkspaceRoot;
  // Per-task subdirectory keeps a project's concurrent tasks from clobbering each
  // other's checkout/branch; reused only by a retry of the same task branch.
  const workDir = plannedTaskWorkdir(root, projectSlug, projectId, taskBranch);
  const env = buildSafeAgentEnv(process.env, workDir);
  const reused = fs.existsSync(path.join(workDir, '.git'));

  if (!repoUrl) {
    step('No repository configured; using an empty monorepo workspace.');
    fs.mkdirSync(workDir, { recursive: true });
    return { workDir, branch, slug, cloned: false, reused, env, repositoryBroker: null, baseBranch: null, stackedOn: null };
  }

  const parts = repoParts(repoUrl, repositoryProvider);
  if (!parts) throw new Error('Repository must match the selected GitHub or GitLab provider.');
  // Blocker branches (latest-first) the coder derives from unmerged dependencies;
  // the broker stacks the task onto the first present-and-unmerged one.
  const candidateBranches = (Array.isArray(stackCandidates) ? stackCandidates : [])
    .map((name) => sanitizeBranch(name));
  const repositoryBroker = createBroker({
    root,
    workDir,
    branch,
    parts,
    repositoryToken,
    stackCandidates: candidateBranches,
    onStep: step,
  });
  try {
    step(`${reused ? 'Refreshing' : 'Cloning'} ${parts.fullName} through the secure repository broker…`);
    const info = await repositoryBroker.prepare({ shallow: false });
    return {
      workDir,
      branch,
      slug,
      cloned: !reused,
      reused,
      env,
      repositoryBroker,
      baseBranch: info.baseBranch,
      stackedOn: info.stackedOn || null,
    };
  } catch (error) {
    repositoryBroker.dispose();
    throw error;
  }
}

/** Prepare an isolated workspace and scoped branch for one ticket. */
async function prepareWorkspace({
  repoUrl,
  repositoryProvider = 'github',
  repositoryToken = '',
  identifier,
  onStep,
}) {
  const step = typeof onStep === 'function' ? onStep : () => {};
  const safe = sanitizeSlug(identifier || 'ticket');
  const branch = sanitizeBranch(identifier || 'ticket');
  const root = CONFIG.CODER.workspaceRoot;
  const workDir = path.join(root, safe);
  const env = buildSafeAgentEnv(process.env, workDir);
  const reused = fs.existsSync(path.join(workDir, '.git'));

  if (!repoUrl) {
    step('No repository configured; using an empty workspace.');
    fs.mkdirSync(workDir, { recursive: true });
    return { workDir, branch, cloned: false, reused, env, repositoryBroker: null, baseBranch: null };
  }

  const parts = repoParts(repoUrl, repositoryProvider);
  if (!parts) throw new Error('Repository must match the selected GitHub or GitLab provider.');
  const repositoryBroker = createBroker({
    root,
    workDir,
    branch,
    parts,
    repositoryToken,
    onStep: step,
  });
  try {
    step(`${reused ? 'Refreshing' : 'Cloning'} ${parts.fullName} through the secure repository broker…`);
    const info = await repositoryBroker.prepare({ shallow: true });
    return {
      workDir,
      branch,
      cloned: !reused,
      reused,
      env,
      repositoryBroker,
      baseBranch: info.baseBranch,
    };
  } catch (error) {
    repositoryBroker.dispose();
    throw error;
  }
}

module.exports = {
  prepareWorkspace,
  preparePlannedWorkspace,
  sanitizeSlug,
  scopedProjectSlug,
  plannedTaskWorkdir,
  sanitizeBranch,
  repoParts,
};
