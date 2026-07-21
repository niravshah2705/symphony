'use strict';

const { execTool, platformCmd, defineTool } = require('./exec');

/**
 * Playwright tool — run the project's Playwright end-to-end suite by delegating
 * to the Playwright test runner (`npx playwright test`). No browser-driving
 * logic is re-implemented.
 *
 * For INTERACTIVE browser automation (navigate/click/snapshot), the agent gets
 * the Playwright MCP server's tools instead — enable it with
 * PLAYWRIGHT_MCP_ENABLED=true (see config MCP.playwright + mcp.js). This tool
 * covers the "run the suite" path; the MCP server covers step-by-step control.
 */

const REPORTERS = new Set(['list', 'line', 'dot', 'html', 'json', 'junit', 'github', 'blob']);
const PROJECT_RE = /^[A-Za-z0-9][\w .-]{0,64}$/;

const playwrightTestTool = defineTool(
  {
    name: 'playwright_test',
    description:
      'Run Playwright end-to-end tests (`playwright test`) in the workspace. Optionally filter by project or ' +
      'test-title pattern. Prefer this over invoking browsers directly; for interactive control use the Playwright MCP tools.',
    schema: (z) =>
      z.object({
        dir: z.string().optional().describe('workspace-relative directory containing the Playwright project'),
        project: z.string().optional().describe('Playwright project name (--project)'),
        grep: z.string().optional().describe('only run tests whose title matches this pattern (--grep)'),
        headed: z.boolean().optional().describe('run headed (default: headless)'),
        reporter: z.enum(['list', 'line', 'dot', 'html', 'json', 'junit', 'github', 'blob']).optional().describe('reporter'),
      }),
  },
  async (input, ctx) => {
    const args = ['--no-install', 'playwright', 'test'];
    if (input.project) {
      if (!PROJECT_RE.test(input.project)) throw new Error(`invalid project name: "${input.project}"`);
      args.push(`--project=${input.project}`);
    }
    if (input.grep) args.push('--grep', String(input.grep).slice(0, 200));
    if (input.headed) args.push('--headed');
    if (input.reporter && REPORTERS.has(input.reporter)) args.push(`--reporter=${input.reporter}`);
    return execTool({
      ctx,
      label: 'playwright test',
      command: platformCmd('npx'),
      args,
      dir: input.dir,
      notFoundHint: 'Add Playwright to the project (npm i -D @playwright/test && npx playwright install).',
    });
  }
);

const FACTORIES = Object.freeze({ playwright_test: playwrightTestTool });

module.exports = { FACTORIES, REPORTERS };
