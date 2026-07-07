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

module.exports = { prepareWorkspace };
