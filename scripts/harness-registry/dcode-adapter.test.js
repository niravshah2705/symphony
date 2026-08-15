'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CHROME_DEVTOOLS_MCP_ENTRYPOINT,
  CHROME_DEVTOOLS_MCP_VERSION,
  DEFAULT_CANONICAL_MOUNT,
  adaptDcodePlugin,
  adaptHooks,
  normalizeDcodeStateTree,
} = require('./dcode-adapter');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeFixture(root) {
  writeJson(path.join(root, '.claude-plugin', 'plugin.json'), {
    name: 'ecc',
    version: '2.2.0',
    description: 'ECC test plugin',
    author: { name: 'ECC' },
    homepage: 'https://ecc.tools',
    repository: 'https://github.com/affaan-m/ECC',
    license: 'MIT',
    keywords: ['agents'],
    commands: ['./commands/'],
  });
  writeFile(path.join(root, 'skills', 'existing', 'SKILL.md'), [
    '---',
    'name: existing',
    'description: Existing skill',
    '---',
    '',
    'Existing instructions.',
    '',
  ].join('\n'));
  writeFile(path.join(root, 'commands', 'build-fix.md'), [
    '---',
    'description: "Repair build errors deterministically."',
    'argument-hint: optional target',
    '---',
    '',
    '# Build Fix',
    '',
    'Keep this command body.',
    '',
  ].join('\n'));
  writeFile(path.join(root, 'agents', 'reviewer.md'), [
    '---',
    'name: reviewer',
    'description: Review changes carefully.',
    'tools:',
    '  - Read',
    '  - Grep',
    '  - Glob',
    'model: opus',
    'color: blue',
    '---',
    '',
    '# Reviewer',
    '',
    'Keep this agent body.',
    '',
  ].join('\n'));
  writeFile(
    path.join(root, '.opencode', 'instructions', 'INSTRUCTIONS.md'),
    '# ECC Instructions\n\nAlways verify changes.\n'
  );
  writeFile(path.join(root, 'scripts', 'hooks', 'session.js'), "'use strict';\n");
  writeJson(path.join(root, 'hooks', 'hooks.json'), {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    hooks: {
      PreToolUse: [{
        id: 'pre:check',
        matcher: 'Bash',
        hooks: [{
          type: 'command',
          command: 'node scripts/hooks/session.js pre',
          async: true,
          timeout: 10,
        }],
      }],
      SessionStart: [{
        id: 'session:start',
        matcher: '*',
        hooks: [{ type: 'command', command: 'node scripts/hooks/session.js start' }],
      }],
      Stop: [{
        id: 'stop:save',
        matcher: '*',
        hooks: [{
          type: 'command',
          command: 'node scripts/hooks/session.js stop',
          async: true,
          timeout: 7,
        }],
      }],
    },
  });
  writeJson(path.join(root, '.mcp.json'), {
    mcpServers: {
      'chrome-devtools': {
        command: 'npx',
        args: ['-y', 'chrome-devtools-mcp@latest', '--isolated'],
      },
    },
  });
  writeFile(path.join(root, '.env'), 'SECRET=must-not-copy\n');
  writeFile(path.join(root, '.env.example'), 'SECRET=also-must-not-copy\n');
  writeFile(path.join(root, 'node_modules', 'not-packaged', 'index.js'), 'throw new Error();\n');
}

function makeOutputRoots(parent, name) {
  return {
    marketplaceRoot: path.join(parent, name, 'marketplace'),
    dcodeHomeRoot: path.join(parent, name, 'home'),
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('stages a deterministic full-surface DCode ECC adapter', (context) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dcode-adapter-test-'));
  context.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const sourceRoot = path.join(temporaryRoot, 'source');
  makeFixture(sourceRoot);

  const firstRoots = makeOutputRoots(temporaryRoot, 'first');
  const secondRoots = makeOutputRoots(temporaryRoot, 'second');
  const first = adaptDcodePlugin({
    sourceRoot,
    ...firstRoots,
    sourceSha: 'a'.repeat(40),
  });
  adaptDcodePlugin({
    sourceRoot,
    ...secondRoots,
    sourceSha: 'a'.repeat(40),
  });

  const firstPlugin = path.join(firstRoots.marketplaceRoot, 'plugins', 'ecc');
  const commandSkill = fs.readFileSync(
    path.join(firstPlugin, 'skills', 'source-command-build-fix', 'SKILL.md'),
    'utf8'
  );
  assert.match(commandSkill, /name: "source-command-build-fix"/);
  assert.match(commandSkill, /description: "Repair build errors deterministically\."/);
  assert.match(commandSkill, /Keep this command body\./);

  const agent = fs.readFileSync(
    path.join(firstRoots.dcodeHomeRoot, '.deepagents', 'agent', 'agents', 'reviewer', 'AGENTS.md'),
    'utf8'
  );
  assert.match(agent, /name: "reviewer"/);
  assert.match(agent, /description: "Review changes carefully\."/);
  assert.match(agent, /Keep this agent body\./);
  assert.doesNotMatch(agent, /(?:tools|model|color):/);
  assert.equal(
    fs.readFileSync(
      path.join(firstRoots.dcodeHomeRoot, '.deepagents', 'agent', 'AGENTS.md'),
      'utf8'
    ),
    '# ECC Instructions\n\nAlways verify changes.\n'
  );

  const pluginManifest = readJson(path.join(firstPlugin, '.claude-plugin', 'plugin.json'));
  assert.deepEqual(pluginManifest.skills, ['./skills/']);
  assert.equal(pluginManifest.hooks, './hooks/hooks.json');
  assert.equal(pluginManifest.mcpServers, './.mcp.json');
  assert.equal(pluginManifest.commands, undefined);

  const stagedHooks = readJson(path.join(firstPlugin, 'hooks', 'hooks.json'));
  const stagedHandlers = Object.values(stagedHooks.hooks)
    .flatMap((entries) => entries)
    .flatMap((entry) => entry.hooks);
  assert.equal(stagedHandlers.some((handler) => Object.hasOwn(handler, 'async')), false);
  assert.ok(stagedHandlers.every((handler) => handler.command.startsWith('node scripts/hooks/session.js')));
  assert.equal(fs.existsSync(path.join(firstRoots.dcodeHomeRoot, '.deepagents', 'hooks.json')), false);

  const mcp = readJson(path.join(firstPlugin, '.mcp.json'));
  assert.deepEqual(mcp.mcpServers['chrome-devtools'], {
    args: [`\${PLUGIN_ROOT}/${CHROME_DEVTOOLS_MCP_ENTRYPOINT}`, '--isolated'],
    command: 'node',
    type: 'stdio',
  });
  const vendorPackage = readJson(path.join(firstPlugin, 'vendor', 'package.json'));
  assert.equal(vendorPackage.dependencies['chrome-devtools-mcp'], CHROME_DEVTOOLS_MCP_VERSION);
  assert.equal(JSON.stringify(mcp).includes('@latest'), false);

  assert.equal(fs.existsSync(path.join(firstPlugin, '.env')), false);
  assert.equal(fs.existsSync(path.join(firstPlugin, '.env.example')), false);
  assert.equal(fs.existsSync(path.join(firstPlugin, 'node_modules')), false);

  assert.deepEqual(first.artifactManifest.capabilities, {
    native: ['skills', 'mcp', 'hooks'],
    companion: ['commands-as-skills', 'subagents', 'instructions'],
  });
  assert.equal(first.artifactManifest.strategy, 'dcode-plugin');
  assert.equal(first.artifactManifest.compatibility, 'native-with-adapter');
  assert.deepEqual(first.artifactManifest.counts, {
    commandsAsSkills: 1,
    subagents: 1,
    sourceHookHandlers: 3,
    activatedDcodeHooks: 3,
    skippedHookHandlers: 0,
  });
  assert.deepEqual(first.artifactManifest.diagnostics.hooks.skipped, []);
  assert.match(first.artifactManifest.limitations.at(-1), /async flags are removed/);

  for (const relativePath of [
    '.claude-plugin/marketplace.json',
    'dcode-adapter.json',
    'plugins/ecc/.claude-plugin/plugin.json',
    'plugins/ecc/.mcp.json',
    'plugins/ecc/hooks/hooks.json',
    'plugins/ecc/skills/source-command-build-fix/SKILL.md',
    'plugins/ecc/vendor/package.json',
  ]) {
    assert.equal(
      fs.readFileSync(path.join(firstRoots.marketplaceRoot, relativePath), 'utf8'),
      fs.readFileSync(path.join(secondRoots.marketplaceRoot, relativePath), 'utf8'),
      `${relativePath} should be deterministic`
    );
  }
});

test('accounts for every mapped and known-unmappable hook handler', () => {
  const result = adaptHooks({
    hooks: {
      PostToolUseFailure: [{
        matcher: '*',
        hooks: [
          { type: 'command', command: 'one', async: true },
          { type: 'command', command: 'two' },
        ],
      }],
      PostToolUse: [{
        id: 'post:supported',
        matcher: 'Edit',
        hooks: [{ type: 'command', command: 'three' }],
      }],
      TaskCompleted: [{
        id: 'task:unsupported',
        matcher: '*',
        hooks: [{ type: 'command', command: 'four' }],
      }],
    },
  });

  assert.equal(result.diagnostics.sourceHandlerCount, 4);
  assert.equal(result.diagnostics.mapped.length, 3);
  assert.equal(result.diagnostics.skipped.length, 1);
  assert.equal(result.diagnostics.mapped.length + result.diagnostics.skipped.length, 4);
  assert.equal(result.diagnostics.skipped[0].handlerId, 'task:unsupported');
  assert.equal(result.adaptedDocument.hooks.TaskCompleted, undefined);
  assert.equal(
    Object.values(result.adaptedDocument.hooks)
      .flatMap((entries) => entries)
      .flatMap((entry) => entry.hooks)
      .some((handler) => Object.hasOwn(handler, 'async')),
    false
  );
});

test('preserves matchers on DCode-native plugin hooks', () => {
  const result = adaptHooks({
    hooks: {
      PostToolUseFailure: [{
        id: 'skill:error',
        matcher: 'Skill',
        hooks: [{ type: 'command', command: 'track-skill-error' }],
      }],
    },
  });

  assert.equal(result.diagnostics.mapped.length, 1);
  assert.equal(result.diagnostics.skipped.length, 0);
  assert.equal(result.diagnostics.mapped[0].handlerId, 'skill:error');
  assert.equal(result.adaptedDocument.hooks.PostToolUseFailure[0].matcher, 'Skill');
  assert.equal(
    result.adaptedDocument.hooks.PostToolUseFailure[0].hooks[0].command,
    'track-skill-error'
  );
});

test('fails closed on unknown or malformed hook structures', () => {
  assert.throws(
    () => adaptHooks({
      hooks: {
        FutureEvent: [{ matcher: '*', hooks: [{ type: 'command', command: 'run' }] }],
      },
    }),
    /Unknown Claude hook event: FutureEvent/
  );
  assert.throws(
    () => adaptHooks({
      hooks: {
        Stop: [{ matcher: '*', hooks: [{ type: 'prompt', prompt: 'run' }] }],
      },
    }),
    /type must be command/
  );
  assert.throws(
    () => adaptHooks({ hooks: { Stop: [{ matcher: '*', hooks: [] }] } }),
    /must be a non-empty array/
  );
});

test('normalizes installed DCode state paths to the canonical mount', (context) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dcode-state-test-'));
  context.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const marketplaceRoot = path.join(temporaryRoot, 'marketplace');
  const dcodeHomeRoot = path.join(temporaryRoot, 'home');
  fs.mkdirSync(marketplaceRoot, { recursive: true });
  const statePath = path.join(dcodeHomeRoot, '.deepagents', '.state', 'plugins.json');
  writeJson(statePath, {
    marketplaces: [{ install_location: marketplaceRoot }],
    plugins: [{
      installPath: path.join(fs.realpathSync.native(marketplaceRoot), 'plugins', 'ecc'),
      home: dcodeHomeRoot,
    }],
  });
  writeFile(
    path.join(dcodeHomeRoot, '.deepagents', 'config.toml'),
    `plugin_root = "${marketplaceRoot}/plugins/ecc"\n`
  );

  const result = normalizeDcodeStateTree({ marketplaceRoot, dcodeHomeRoot });
  assert.equal(result.rewrittenFiles.length, 2);
  const state = readJson(statePath);
  assert.equal(state.marketplaces[0].install_location, `${DEFAULT_CANONICAL_MOUNT}/marketplace`);
  assert.equal(
    state.plugins[0].installPath,
    `${DEFAULT_CANONICAL_MOUNT}/marketplace/plugins/ecc`
  );
  assert.equal(state.plugins[0].home, `${DEFAULT_CANONICAL_MOUNT}/home`);
  assert.equal(
    fs.readFileSync(path.join(dcodeHomeRoot, '.deepagents', 'config.toml'), 'utf8'),
    `plugin_root = "${DEFAULT_CANONICAL_MOUNT}/marketplace/plugins/ecc"\n`
  );
});

test('supports a marketplace nested inside the canonical home copy root', (context) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dcode-nested-marketplace-test-'));
  context.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const sourceRoot = path.join(temporaryRoot, 'source');
  const dcodeHomeRoot = path.join(temporaryRoot, 'rootfs', 'home');
  const marketplaceRoot = path.join(
    dcodeHomeRoot,
    '.deepagents',
    'marketplaces',
    'ecc-source'
  );
  const canonicalMarketplaceRoot =
    `${DEFAULT_CANONICAL_MOUNT}/home/.deepagents/marketplaces/ecc-source`;
  makeFixture(sourceRoot);

  const result = adaptDcodePlugin({
    sourceRoot,
    marketplaceRoot,
    dcodeHomeRoot,
    sourceSha: 'b'.repeat(40),
    canonicalMarketplaceRoot,
  });
  assert.equal(result.artifactManifest.marketplace.root, canonicalMarketplaceRoot);
  assert.equal(
    result.artifactManifest.marketplace.pluginRoot,
    `${canonicalMarketplaceRoot}/plugins/ecc`
  );
  assert.equal(fs.existsSync(path.join(dcodeHomeRoot, '.deepagents', 'hooks.json')), false);
  const pluginHooks = readJson(path.join(marketplaceRoot, 'plugins', 'ecc', 'hooks', 'hooks.json'));
  assert.ok(pluginHooks.hooks.PreToolUse);

  const statePath = path.join(dcodeHomeRoot, '.deepagents', '.state', 'plugins.json');
  writeJson(statePath, {
    marketplace: marketplaceRoot,
    plugin: path.join(marketplaceRoot, 'plugins', 'ecc'),
    home: dcodeHomeRoot,
  });
  normalizeDcodeStateTree({
    marketplaceRoot,
    dcodeHomeRoot,
    canonicalMarketplaceRoot,
  });
  const state = readJson(statePath);
  assert.equal(state.marketplace, canonicalMarketplaceRoot);
  assert.equal(state.plugin, `${canonicalMarketplaceRoot}/plugins/ecc`);
  assert.equal(state.home, `${DEFAULT_CANONICAL_MOUNT}/home`);
});

test('refuses to package DCode credentials or OAuth state', (context) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dcode-secret-test-'));
  context.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const marketplaceRoot = path.join(temporaryRoot, 'marketplace');
  const dcodeHomeRoot = path.join(temporaryRoot, 'home');
  writeFile(path.join(dcodeHomeRoot, '.deepagents', '.env'), 'OPENAI_API_KEY=secret\n');

  assert.throws(
    () => normalizeDcodeStateTree({ marketplaceRoot, dcodeHomeRoot }),
    /Refusing to package sensitive DCode state/
  );
});

test('allows contained package links and rejects escaping DCode state links', (context) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dcode-link-test-'));
  context.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const marketplaceRoot = path.join(temporaryRoot, 'marketplace');
  const dcodeHomeRoot = path.join(temporaryRoot, 'home');
  const packageRoot = path.join(dcodeHomeRoot, '.deepagents', 'vendor', 'node_modules');
  writeFile(path.join(packageRoot, 'tool', 'bin.js'), 'process.exit(0);\n');
  fs.mkdirSync(path.join(packageRoot, '.bin'), { recursive: true });
  fs.symlinkSync('../tool/bin.js', path.join(packageRoot, '.bin', 'tool'));

  assert.doesNotThrow(() => normalizeDcodeStateTree({ marketplaceRoot, dcodeHomeRoot }));
  fs.symlinkSync(temporaryRoot, path.join(dcodeHomeRoot, '.deepagents', 'escape'));
  assert.throws(
    () => normalizeDcodeStateTree({ marketplaceRoot, dcodeHomeRoot }),
    /unsafe symbolic link/
  );
});
