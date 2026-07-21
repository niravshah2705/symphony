'use strict';

const fs = require('fs');
const path = require('path');
const { execTool, resolveWorkdir, commandExists, platformCmd, defineTool } = require('./exec');

/**
 * Security tools — run established scanners over the workspace. Everything
 * delegates to a pre-installed scanner (Trivy, npm audit, pip-audit, Semgrep,
 * gitleaks, TruffleHog); we never re-implement detection rules.
 *
 * Secret hygiene: the secret scanner is invoked in REDACT mode (gitleaks
 * `--redact`, TruffleHog `--only-verified`) and all tool output additionally
 * passes through the registry's secret redactor, so found secrets are not
 * echoed verbatim to the model.
 */

/** Pick a dependency/vuln scanner given availability + detected ecosystem. */
async function pickVulnScanner(dir, requested) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const scanners = {
    trivy: { command: 'trivy', args: ['fs', '--scanners', 'vuln,misconfig,secret', '--exit-code', '0', '.'], hint: 'Install Trivy (https://aquasecurity.github.io/trivy).' },
    'npm-audit': { command: platformCmd('npm'), args: ['audit'], hint: 'Install Node.js (bundles npm).' },
    'pip-audit': { command: 'pip-audit', args: [], hint: 'pip install pip-audit.' },
    semgrep: { command: 'semgrep', args: ['scan', '--config', 'auto', '--error'], hint: 'Install Semgrep (pip install semgrep).' },
  };
  if (requested && requested !== 'auto') return { key: requested, ...scanners[requested] };
  if (await commandExists('trivy')) return { key: 'trivy', ...scanners.trivy };
  if (has('package.json')) return { key: 'npm-audit', ...scanners['npm-audit'] };
  if ((has('requirements.txt') || has('pyproject.toml')) && (await commandExists('pip-audit'))) return { key: 'pip-audit', ...scanners['pip-audit'] };
  if (await commandExists('semgrep')) return { key: 'semgrep', ...scanners.semgrep };
  return { key: 'npm-audit', ...scanners['npm-audit'] }; // last resort; reports "not installed" cleanly
}

const securityScanTool = defineTool(
  {
    name: 'security_scan',
    description:
      'Scan the workspace for dependency vulnerabilities and misconfigurations using the best available scanner ' +
      '(Trivy, npm audit, pip-audit, or Semgrep). Prefer this over ad-hoc grepping for CVEs.',
    schema: (z) =>
      z.object({
        dir: z.string().optional().describe('workspace-relative directory'),
        scanner: z.enum(['auto', 'trivy', 'npm-audit', 'pip-audit', 'semgrep']).optional().describe('force a scanner (default: auto)'),
      }),
  },
  async (input, ctx) => {
    const dir = resolveWorkdir(ctx, input.dir);
    const s = await pickVulnScanner(dir, input.scanner);
    return execTool({ ctx, label: `security scan (${s.key})`, command: s.command, args: s.args, dir: input.dir, notFoundHint: s.hint });
  }
);

const secretScanTool = defineTool(
  {
    name: 'secret_scan',
    description:
      'Scan the workspace for committed secrets/credentials with gitleaks or TruffleHog (run in redacted mode). ' +
      'Use before opening a PR to catch leaked keys.',
    schema: (z) => z.object({ dir: z.string().optional().describe('workspace-relative directory') }),
  },
  async (input, ctx) => {
    if (await commandExists('gitleaks', 'version')) {
      return execTool({ ctx, label: 'secret scan (gitleaks)', command: 'gitleaks', args: ['detect', '--no-banner', '--redact', '--source', '.'], dir: input.dir });
    }
    return execTool({
      ctx,
      label: 'secret scan (trufflehog)',
      command: 'trufflehog',
      args: ['filesystem', '.', '--only-verified', '--no-update'],
      dir: input.dir,
      notFoundHint: 'Install gitleaks (preferred) or TruffleHog to scan for committed secrets.',
    });
  }
);

const FACTORIES = Object.freeze({ security_scan: securityScanTool, secret_scan: secretScanTool });

module.exports = { FACTORIES, pickVulnScanner };
