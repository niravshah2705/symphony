'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { CONFIG } = require('../config');

const execFileP = promisify(execFile);

const SKILLS_SRC = path.join(__dirname, 'skills');
const SKILLS_DEST_DIRNAME = '.agent-skills';

/**
 * Isolated per-ticket git workspace lifecycle for the code-writer agent
 * (equivalent to Symphony's workspace root + after_create clone hook). Each
 * ticket gets its own clone under CONFIG.CODER.workspaceRoot so runs never
 * touch each other or the user's repos.
 */

async function run(cmd, args, cwd) {
  const { stdout } = await execFileP(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/**
 * Copy the standard code skills into the workspace so the LocalShellBackend
 * (rooted at the workspace) can load them. Returns backend-relative skill paths.
 */
function installSkills(workDir) {
  const dest = path.join(workDir, SKILLS_DEST_DIRNAME);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(SKILLS_SRC, dest, { recursive: true });
  const names = fs
    .readdirSync(SKILLS_SRC)
    .filter((n) => fs.statSync(path.join(SKILLS_SRC, n)).isDirectory());
  return names.map((n) => `/${SKILLS_DEST_DIRNAME}/${n}/`);
}

/**
 * Prepare an isolated workspace for a ticket. Clones repoUrl (shallow) on first
 * use, reuses the existing dir on continuation, and installs the code skills.
 * @returns {Promise<{workDir:string, skillPaths:string[], cloned:boolean, reused:boolean}>}
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

  const skillPaths = installSkills(workDir);
  return { workDir, skillPaths, cloned, reused };
}

module.exports = { prepareWorkspace, installSkills, SKILLS_DEST_DIRNAME };
