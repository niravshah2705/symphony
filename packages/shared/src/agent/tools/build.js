'use strict';

const fs = require('fs');
const path = require('path');
const { execTool, resolveWorkdir, platformCmd, defineTool } = require('./exec');

/**
 * Build tool — compile/build a project by delegating to its native build system
 * (Gradle, Maven, npm scripts, Make, Cargo, Go, Python build), auto-detected
 * from the project files. No build logic is re-implemented here.
 */

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

const gradleCmd = () => (process.platform === 'win32' ? 'gradlew.bat' : './gradlew');

/**
 * Detect candidate build systems in priority order (pure).
 * @returns {Array<{system:string,command:string,args:string[],notFoundHint?:string}>}
 */
function buildSystemsFor(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const out = [];
  if (has('gradlew') || has('build.gradle') || has('build.gradle.kts')) {
    out.push({ system: 'gradle', command: has('gradlew') ? gradleCmd() : 'gradle', args: ['assemble'], notFoundHint: 'Use the Gradle wrapper (gradlew) or install Gradle.' });
  }
  if (has('pom.xml')) out.push({ system: 'maven', command: has('mvnw') ? (process.platform === 'win32' ? 'mvnw.cmd' : './mvnw') : 'mvn', args: ['-q', '-DskipTests', 'package'], notFoundHint: 'Use the Maven wrapper (mvnw) or install Maven.' });
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg && pkg.scripts && pkg.scripts.build) out.push({ system: 'npm', command: platformCmd('npm'), args: ['run', 'build'], notFoundHint: 'Install Node.js (bundles npm).' });
  if (has('Cargo.toml')) out.push({ system: 'cargo', command: 'cargo', args: ['build', '--release'], notFoundHint: 'Install the Rust toolchain (rustup).' });
  if (has('go.mod')) out.push({ system: 'go', command: 'go', args: ['build', './...'], notFoundHint: 'Install Go.' });
  if (has('Makefile') || has('makefile')) out.push({ system: 'make', command: 'make', args: [], notFoundHint: 'Install make (build-essential / Xcode CLT).' });
  if (has('pyproject.toml') || has('setup.py')) out.push({ system: 'python', command: platformCmd('python3'), args: ['-m', 'build'], notFoundHint: 'pip install build.' });
  return out;
}

const projectBuildTool = defineTool(
  {
    name: 'project_build',
    description:
      'Build the project using its native build system (Gradle/Maven/npm/Make/Cargo/Go/Python), auto-detected ' +
      'from the workspace. Prefer this over guessing build commands. Pass `system` to force one when several exist.',
    schema: (z) =>
      z.object({
        dir: z.string().optional().describe('workspace-relative project directory'),
        system: z.enum(['auto', 'gradle', 'maven', 'npm', 'cargo', 'go', 'make', 'python']).optional().describe('force a build system (default: auto)'),
      }),
  },
  async (input, ctx) => {
    const dir = resolveWorkdir(ctx, input.dir);
    const candidates = buildSystemsFor(dir);
    if (!candidates.length) return `No known build system detected in ${dir} (looked for Gradle/Maven/npm build script/Cargo/Go/Make/Python).`;
    const chosen = input.system && input.system !== 'auto' ? candidates.find((c) => c.system === input.system) : candidates[0];
    if (!chosen) return `Build system "${input.system}" not detected in ${dir}. Detected: ${candidates.map((c) => c.system).join(', ')}.`;
    return execTool({ ctx, label: `build (${chosen.system})`, command: chosen.command, args: chosen.args, dir: input.dir, notFoundHint: chosen.notFoundHint });
  }
);

const FACTORIES = Object.freeze({ project_build: projectBuildTool });

module.exports = { FACTORIES, buildSystemsFor, gradleCmd };
