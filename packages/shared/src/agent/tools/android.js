'use strict';

const fs = require('fs');
const path = require('path');
const { execTool, resolveWorkdir, defineTool } = require('./exec');

/**
 * Android tool — build an Android project through its Gradle wrapper. Delegates
 * to `./gradlew`; no Android build logic is re-implemented. Requires a local
 * JDK + Android SDK (ANDROID_HOME/ANDROID_SDK_ROOT), which the wrapper resolves.
 */

const GRADLE_TASKS = Object.freeze({
  debug: 'assembleDebug',
  release: 'assembleRelease',
  bundle: 'bundleRelease',
  lint: 'lint',
  test: 'testDebugUnitTest',
});

const gradlewCmd = () => (process.platform === 'win32' ? 'gradlew.bat' : './gradlew');

const androidBuildTool = defineTool(
  {
    name: 'android_build',
    description:
      'Build an Android project via its Gradle wrapper. `variant` maps to a Gradle task: debug→assembleDebug, ' +
      'release→assembleRelease, bundle→bundleRelease, lint→lint, test→testDebugUnitTest. Requires a JDK + Android SDK.',
    schema: (z) =>
      z.object({
        variant: z.enum(['debug', 'release', 'bundle', 'lint', 'test']).optional().describe('build variant (default: debug)'),
        module: z.string().optional().describe('Gradle module to scope the task to, e.g. "app"'),
        dir: z.string().optional().describe('workspace-relative project directory (must contain gradlew)'),
      }),
  },
  async (input, ctx) => {
    const dir = resolveWorkdir(ctx, input.dir);
    if (!fs.existsSync(path.join(dir, 'gradlew')) && process.platform !== 'win32') {
      return `❌ android_build: no Gradle wrapper (gradlew) in ${dir}. Run from the Android project root.`;
    }
    const task = GRADLE_TASKS[input.variant || 'debug'];
    const gradleTask = input.module ? `:${sanitizeModule(input.module)}:${task}` : task;
    return execTool({
      ctx,
      label: `android ${input.variant || 'debug'}`,
      command: gradlewCmd(),
      args: [gradleTask, '--stacktrace'],
      dir: input.dir,
      notFoundHint: 'Ensure the Gradle wrapper is present and a JDK + Android SDK (ANDROID_HOME) are installed.',
    });
  }
);

function sanitizeModule(name) {
  const v = String(name || '').trim().replace(/^:/, '');
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(v)) throw new Error(`invalid Gradle module: "${name}"`);
  return v;
}

const FACTORIES = Object.freeze({ android_build: androidBuildTool });

module.exports = { FACTORIES, GRADLE_TASKS, sanitizeModule };
