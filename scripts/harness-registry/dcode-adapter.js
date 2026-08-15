#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const DEFAULT_CANONICAL_MOUNT = '/opt/ai-fleet/harnesses/deepagent';
const CHROME_DEVTOOLS_MCP_VERSION = '1.6.0';
const CHROME_DEVTOOLS_MCP_ENTRYPOINT = 'vendor/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js';
const SUPPORTED_DCODE_HOOK_EVENTS = new Set([
  'Notification',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact',
  'PreToolUse',
  'SessionEnd',
  'SessionStart',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'UserPromptSubmit',
]);
// Events outside the mapped and known sets are treated as upstream schema drift.
const KNOWN_UNMAPPABLE_CLAUDE_EVENTS = new Set([
  'TeammateIdle',
  'TaskCompleted',
]);
const EXCLUDED_SOURCE_NAMES = new Set([
  '.env',
  '.git',
  '.netrc',
  '.state',
  'auth.json',
  'credentials.json',
  'mcp-tokens',
  'node_modules',
]);
function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
}
function readJson(filePath, label = filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${label}: ${error.message}`);
  }
  return parsed;
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key])])
  );
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(sortJsonValue(value), null, 2)}\n`);
}

function listFiles(directoryPath, predicate = () => true) {
  if (!fs.existsSync(directoryPath)) return [];
  return fs.readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => path.join(directoryPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function validateCanonicalMount(canonicalMount) {
  assertNonEmptyString(canonicalMount, 'canonicalMount');
  if (!path.posix.isAbsolute(canonicalMount)) {
    throw new Error('canonicalMount must be an absolute POSIX path');
  }
  if (path.posix.normalize(canonicalMount) !== canonicalMount || canonicalMount.endsWith('/')) {
    throw new Error('canonicalMount must be normalized and must not end in a slash');
  }
  if (!canonicalMount.startsWith('/opt/ai-fleet/harnesses/')) {
    throw new Error('canonicalMount must be under /opt/ai-fleet/harnesses');
  }
}

function resolveCanonicalMarketplaceRoot(canonicalMount, canonicalMarketplaceRoot) {
  const resolved = canonicalMarketplaceRoot || `${canonicalMount}/marketplace`;
  assertNonEmptyString(resolved, 'canonicalMarketplaceRoot');
  if (!path.posix.isAbsolute(resolved) ||
      path.posix.normalize(resolved) !== resolved || resolved.endsWith('/')) {
    throw new Error('canonicalMarketplaceRoot must be a normalized absolute POSIX path');
  }
  if (!resolved.startsWith(`${canonicalMount}/`)) {
    throw new Error('canonicalMarketplaceRoot must be contained by canonicalMount');
  }
  return resolved;
}

function assertEmptyOrMissingDirectory(directoryPath, label) {
  if (!fs.existsSync(directoryPath)) return;
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory`);
  if (fs.readdirSync(directoryPath).length > 0) {
    throw new Error(`${label} must be empty to avoid mixing stale plugin files`);
  }
}

function copyEccSource(sourceRoot, pluginRoot) {
  fs.cpSync(sourceRoot, pluginRoot, {
    recursive: true,
    filter(sourcePath) {
      if (sourcePath === sourceRoot) return true;
      const name = path.basename(sourcePath);
      return !EXCLUDED_SOURCE_NAMES.has(name) && !name.startsWith('.env.');
    },
  });
}

function parseFrontmatter(markdown, label) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) throw new Error(`${label} must start with YAML frontmatter`);

  const attributes = {};
  const lines = match[1].split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) continue;
    const keyMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!keyMatch) throw new Error(`${label} has unsupported frontmatter line: ${line}`);
    const [, key, rawValue] = keyMatch;
    if (/^[>|][+-]?$/.test(rawValue)) {
      const folded = rawValue.startsWith('>');
      const continuation = [];
      while (index + 1 < lines.length && (lines[index + 1].trim() === '' || /^\s/.test(lines[index + 1]))) {
        index += 1;
        continuation.push(lines[index].replace(/^\s+/, ''));
      }
      attributes[key] = folded ? continuation.join(' ').trim() : continuation.join('\n').trim();
      continue;
    }
    let value = rawValue.trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch (error) {
        throw new Error(`${label} has invalid quoted frontmatter for ${key}: ${error.message}`);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    attributes[key] = value;
  }

  return { attributes, body: match[2] };
}

function slugify(value, label) {
  assertNonEmptyString(value, label);
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`${label} does not contain a usable slug`);
  return slug;
}

function formatDcodeMarkdown(name, description, body) {
  const content = [
    '---',
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    body,
  ].join('\n');
  return content.endsWith('\n') ? content : `${content}\n`;
}

function convertCommands(sourceRoot, pluginRoot) {
  const commandsRoot = path.join(sourceRoot, 'commands');
  const commandFiles = listFiles(commandsRoot, (name) => name.endsWith('.md'));
  if (commandFiles.length === 0) throw new Error('ECC source contains no command markdown files');

  const converted = [];
  const seenNames = new Set();
  for (const commandFile of commandFiles) {
    const fallbackName = path.basename(commandFile, '.md');
    const { attributes, body } = parseFrontmatter(
      fs.readFileSync(commandFile, 'utf8'),
      path.relative(sourceRoot, commandFile)
    );
    const commandName = attributes.name || fallbackName;
    const description = attributes.description;
    assertNonEmptyString(description, `${fallbackName} command description`);
    const skillName = `source-command-${slugify(commandName, `${fallbackName} command name`)}`;
    if (seenNames.has(skillName)) throw new Error(`Duplicate converted command skill: ${skillName}`);
    seenNames.add(skillName);

    const outputPath = path.join(pluginRoot, 'skills', skillName, 'SKILL.md');
    if (fs.existsSync(outputPath)) {
      throw new Error(`Converted command would overwrite an ECC skill: ${skillName}`);
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, formatDcodeMarkdown(skillName, description, body));
    converted.push({ command: fallbackName, skill: skillName });
  }
  return converted;
}

function convertAgents(sourceRoot, dcodeHomeRoot) {
  const agentsRoot = path.join(sourceRoot, 'agents');
  const agentFiles = listFiles(agentsRoot, (name) => name.endsWith('.md'));
  if (agentFiles.length === 0) throw new Error('ECC source contains no agent markdown files');

  const converted = [];
  const seenNames = new Set();
  for (const agentFile of agentFiles) {
    const fallbackName = path.basename(agentFile, '.md');
    const { attributes, body } = parseFrontmatter(
      fs.readFileSync(agentFile, 'utf8'),
      path.relative(sourceRoot, agentFile)
    );
    const name = attributes.name || fallbackName;
    const description = attributes.description;
    assertNonEmptyString(description, `${fallbackName} agent description`);
    const slug = slugify(name, `${fallbackName} agent name`);
    if (seenNames.has(slug)) throw new Error(`Duplicate converted DCode agent: ${slug}`);
    seenNames.add(slug);

    const outputPath = path.join(dcodeHomeRoot, '.deepagents', 'agent', 'agents', slug, 'AGENTS.md');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, formatDcodeMarkdown(name, description, body));
    converted.push({ source: fallbackName, agent: slug });
  }
  return converted;
}

function installGlobalInstructions(sourceRoot, dcodeHomeRoot) {
  const sourcePath = path.join(sourceRoot, '.opencode', 'instructions', 'INSTRUCTIONS.md');
  if (!fs.existsSync(sourcePath)) {
    throw new Error('ECC source is missing .opencode/instructions/INSTRUCTIONS.md');
  }
  const outputPath = path.join(dcodeHomeRoot, '.deepagents', 'agent', 'AGENTS.md');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.copyFileSync(sourcePath, outputPath);
  return outputPath;
}

function validateHookHandler(handler, label) {
  assertPlainObject(handler, label);
  if (handler.type !== 'command') throw new Error(`${label}.type must be command`);
  assertNonEmptyString(handler.command, `${label}.command`);
  if (handler.async !== undefined && typeof handler.async !== 'boolean') {
    throw new Error(`${label}.async must be a boolean when present`);
  }
  if (handler.timeout !== undefined &&
      (typeof handler.timeout !== 'number' || !Number.isFinite(handler.timeout) || handler.timeout <= 0)) {
    throw new Error(`${label}.timeout must be a positive number when present`);
  }
}

function adaptHooks(hookDocument) {
  assertPlainObject(hookDocument, 'ECC hook document');
  assertPlainObject(hookDocument.hooks, 'ECC hook document.hooks');

  const adaptedHooks = {};
  const mapped = [];
  const skipped = [];
  let sourceHandlerCount = 0;

  for (const sourceEvent of Object.keys(hookDocument.hooks).sort()) {
    const sourceEntries = hookDocument.hooks[sourceEvent];
    const isSupported = SUPPORTED_DCODE_HOOK_EVENTS.has(sourceEvent);
    if (!isSupported && !KNOWN_UNMAPPABLE_CLAUDE_EVENTS.has(sourceEvent)) {
      throw new Error(`Unknown Claude hook event: ${sourceEvent}`);
    }
    if (!Array.isArray(sourceEntries)) throw new Error(`hooks.${sourceEvent} must be an array`);

    const adaptedEntries = sourceEntries.map((entry, entryIndex) => {
      const entryLabel = `hooks.${sourceEvent}[${entryIndex}]`;
      assertPlainObject(entry, entryLabel);
      if (entry.matcher !== undefined && typeof entry.matcher !== 'string') {
        throw new Error(`${entryLabel}.matcher must be a string when present`);
      }
      if (!Array.isArray(entry.hooks) || entry.hooks.length === 0) {
        throw new Error(`${entryLabel}.hooks must be a non-empty array`);
      }

      const adaptedHandlers = entry.hooks.map((handler, handlerIndex) => {
        const handlerLabel = `${entryLabel}.hooks[${handlerIndex}]`;
        validateHookHandler(handler, handlerLabel);
        sourceHandlerCount += 1;
        const handlerId = entry.id || `${sourceEvent}:${entryIndex}:${handlerIndex}`;
        const { async: ignoredAsync, ...adaptedHandler } = handler;
        const matcher = entry.matcher || '*';
        if (isSupported) {
          mapped.push({
            dcodeEvent: sourceEvent,
            handlerId,
            matcher,
            sourceEvent,
            sourceWasAsync: ignoredAsync === true,
            sourceTimeoutSeconds: handler.timeout || null,
          });
        } else {
          skipped.push({
            handlerId,
            matcher,
            reason: `DCode has no exact Hooks v2 event for Claude ${sourceEvent}`,
            sourceEvent,
            sourceWasAsync: ignoredAsync === true,
            sourceTimeoutSeconds: handler.timeout || null,
          });
        }
        return adaptedHandler;
      });

      return { ...entry, hooks: adaptedHandlers };
    });
    if (isSupported) adaptedHooks[sourceEvent] = adaptedEntries;
  }

  if (mapped.length + skipped.length !== sourceHandlerCount) {
    throw new Error('Internal hook accounting error: a source handler was silently omitted');
  }

  return {
    adaptedDocument: { ...hookDocument, hooks: adaptedHooks },
    diagnostics: { mapped, skipped, sourceHandlerCount },
  };
}

function pinChromeDevtoolsMcp(sourceRoot, pluginRoot) {
  const sourcePath = path.join(sourceRoot, '.mcp.json');
  const document = readJson(sourcePath, 'ECC .mcp.json');
  assertPlainObject(document, 'ECC .mcp.json');
  assertPlainObject(document.mcpServers, 'ECC .mcp.json.mcpServers');
  assertPlainObject(document.mcpServers['chrome-devtools'], 'chrome-devtools MCP configuration');

  const original = document.mcpServers['chrome-devtools'];
  const originalArgs = Array.isArray(original.args) ? original.args : [];
  const extraArgs = originalArgs.filter((argument) =>
    argument !== '-y' && !/^chrome-devtools-mcp@/.test(argument)
  );
  const rewritten = {
    ...document,
    mcpServers: {
      ...document.mcpServers,
      'chrome-devtools': {
        ...original,
        type: 'stdio',
        command: 'node',
        args: [`\${PLUGIN_ROOT}/${CHROME_DEVTOOLS_MCP_ENTRYPOINT}`, ...extraArgs],
      },
    },
  };
  if (JSON.stringify(rewritten).includes('@latest')) {
    throw new Error('Mutable @latest dependency remains in adapted MCP configuration');
  }

  writeJson(path.join(pluginRoot, '.mcp.json'), rewritten);
  const vendorRoot = path.join(pluginRoot, 'vendor');
  writeJson(path.join(vendorRoot, 'package.json'), {
    name: 'ecc-dcode-vendored-mcp',
    version: '1.0.0',
    private: true,
    dependencies: { 'chrome-devtools-mcp': CHROME_DEVTOOLS_MCP_VERSION },
  });
  writeJson(path.join(vendorRoot, 'vendor-manifest.json'), {
    packages: [{
      entrypoint: CHROME_DEVTOOLS_MCP_ENTRYPOINT,
      name: 'chrome-devtools-mcp',
      version: CHROME_DEVTOOLS_MCP_VERSION,
    }],
  });

  return {
    entrypoint: CHROME_DEVTOOLS_MCP_ENTRYPOINT,
    name: 'chrome-devtools-mcp',
    version: CHROME_DEVTOOLS_MCP_VERSION,
  };
}

function buildPluginManifest(sourceManifest) {
  assertPlainObject(sourceManifest, 'ECC plugin manifest');
  for (const key of ['name', 'version', 'description']) {
    assertNonEmptyString(sourceManifest[key], `ECC plugin manifest.${key}`);
  }
  return {
    name: sourceManifest.name,
    version: sourceManifest.version,
    description: sourceManifest.description,
    author: sourceManifest.author,
    homepage: sourceManifest.homepage,
    repository: sourceManifest.repository,
    license: sourceManifest.license,
    keywords: sourceManifest.keywords,
    skills: ['./skills/'],
    hooks: './hooks/hooks.json',
    mcpServers: './.mcp.json',
  };
}

function buildMarketplaceManifest(pluginManifest) {
  return {
    $schema: 'https://json.schemastore.org/claude-code-marketplace.json',
    name: 'ecc',
    owner: pluginManifest.author || { name: 'ECC' },
    metadata: {
      description: 'ECC adapted for the Deep Agents Code plugin surface',
    },
    plugins: [{
      name: pluginManifest.name,
      source: './plugins/ecc',
      description: pluginManifest.description,
      version: pluginManifest.version,
      author: pluginManifest.author,
      homepage: pluginManifest.homepage,
      repository: pluginManifest.repository,
      license: pluginManifest.license,
      keywords: pluginManifest.keywords,
      strict: false,
    }],
  };
}

function validateMarketplaceManifest(document, marketplaceRoot) {
  assertPlainObject(document, 'DCode marketplace manifest');
  if (document.name !== 'ecc') throw new Error('DCode marketplace must be named ecc');
  if (!Array.isArray(document.plugins) || document.plugins.length !== 1) {
    throw new Error('DCode marketplace must contain exactly one plugin');
  }
  const plugin = document.plugins[0];
  if (plugin.name !== 'ecc' || plugin.source !== './plugins/ecc') {
    throw new Error('DCode marketplace must expose ecc from ./plugins/ecc');
  }
  const resolvedSource = path.resolve(marketplaceRoot, plugin.source);
  const expectedSource = path.resolve(marketplaceRoot, 'plugins', 'ecc');
  if (resolvedSource !== expectedSource || !fs.existsSync(resolvedSource)) {
    throw new Error('DCode marketplace plugin source must resolve inside the staged marketplace');
  }
}

function createArtifactManifest({
  canonicalMount,
  canonicalMarketplaceRoot,
  commandConversions,
  agentConversions,
  hookDiagnostics,
  marketplaceManifest,
  mcpDependency,
  sourceSha,
}) {
  const unmappedEvents = [...new Set(
    hookDiagnostics.skipped
      .map((item) => item.sourceEvent)
  )].sort();
  const limitations = [
    'DCode does not load Claude command or agent directories; commands are converted to skills and agents to DCode AGENTS.md companions.',
    'DCode Hooks v2 is synchronous; async flags are removed while matcher, command, and timeout values are retained.',
  ];
  if (unmappedEvents.length > 0) {
    limitations.push(`Known Claude hook events without exact DCode equivalents were not activated: ${unmappedEvents.join(', ')}.`);
  }

  return {
    schemaVersion: 1,
    harnessId: 'deepagent',
    strategy: 'dcode-plugin',
    compatibility: 'native-with-adapter',
    canonicalMount,
    source: {
      repository: 'https://github.com/affaan-m/ECC.git',
      commit: sourceSha || null,
      version: marketplaceManifest.plugins[0].version,
    },
    marketplace: {
      name: marketplaceManifest.name,
      pluginId: 'ecc@ecc',
      root: canonicalMarketplaceRoot,
      pluginRoot: `${canonicalMarketplaceRoot}/plugins/ecc`,
    },
    capabilities: {
      native: ['skills', 'mcp', 'hooks'],
      companion: ['commands-as-skills', 'subagents', 'instructions'],
    },
    counts: {
      commandsAsSkills: commandConversions.length,
      subagents: agentConversions.length,
      sourceHookHandlers: hookDiagnostics.sourceHandlerCount,
      activatedDcodeHooks: hookDiagnostics.mapped.length,
      skippedHookHandlers: hookDiagnostics.skipped.length,
    },
    dependencies: { chromeDevtoolsMcp: mcpDependency },
    diagnostics: { hooks: hookDiagnostics },
    limitations,
  };
}

function adaptDcodePlugin({
  sourceRoot,
  marketplaceRoot,
  dcodeHomeRoot,
  sourceSha = null,
  canonicalMount = DEFAULT_CANONICAL_MOUNT,
  canonicalMarketplaceRoot = null,
}) {
  for (const [value, label] of [
    [sourceRoot, 'sourceRoot'],
    [marketplaceRoot, 'marketplaceRoot'],
    [dcodeHomeRoot, 'dcodeHomeRoot'],
  ]) {
    assertNonEmptyString(value, label);
    if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  }
  validateCanonicalMount(canonicalMount);
  const effectiveCanonicalMarketplaceRoot = resolveCanonicalMarketplaceRoot(
    canonicalMount, canonicalMarketplaceRoot
  );
  if (sourceSha !== null && !/^[a-f0-9]{40}$/i.test(sourceSha)) {
    throw new Error('sourceSha must be a full 40-character commit SHA');
  }
  if (!fs.statSync(sourceRoot).isDirectory()) throw new Error('sourceRoot must be a directory');
  assertEmptyOrMissingDirectory(marketplaceRoot, 'marketplaceRoot');

  const pluginRoot = path.join(marketplaceRoot, 'plugins', 'ecc');
  fs.mkdirSync(marketplaceRoot, { recursive: true });
  copyEccSource(sourceRoot, pluginRoot);

  const sourcePluginManifest = readJson(
    path.join(sourceRoot, '.claude-plugin', 'plugin.json'),
    'ECC .claude-plugin/plugin.json'
  );
  const pluginManifest = buildPluginManifest(sourcePluginManifest);
  writeJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), pluginManifest);

  const commandConversions = convertCommands(sourceRoot, pluginRoot);
  const agentConversions = convertAgents(sourceRoot, dcodeHomeRoot);
  installGlobalInstructions(sourceRoot, dcodeHomeRoot);

  const sourceHooks = readJson(path.join(sourceRoot, 'hooks', 'hooks.json'), 'ECC hooks/hooks.json');
  const hookAdaptation = adaptHooks(sourceHooks);
  writeJson(path.join(pluginRoot, 'hooks', 'hooks.json'), hookAdaptation.adaptedDocument);

  const mcpDependency = pinChromeDevtoolsMcp(sourceRoot, pluginRoot);
  const marketplaceManifest = buildMarketplaceManifest(pluginManifest);
  const marketplaceManifestPath = path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json');
  writeJson(marketplaceManifestPath, marketplaceManifest);
  validateMarketplaceManifest(readJson(marketplaceManifestPath), marketplaceRoot);

  const artifactManifest = createArtifactManifest({
    canonicalMount,
    canonicalMarketplaceRoot: effectiveCanonicalMarketplaceRoot,
    commandConversions,
    agentConversions,
    hookDiagnostics: hookAdaptation.diagnostics,
    marketplaceManifest,
    mcpDependency,
    sourceSha,
  });
  writeJson(path.join(marketplaceRoot, 'dcode-adapter.json'), artifactManifest);

  return {
    artifactManifest,
    marketplaceRoot,
    pluginRoot,
    dcodeHomeRoot,
  };
}

function replaceStringPrefixes(value, replacements) {
  if (typeof value === 'string') {
    return replacements.reduce(
      (current, [from, to]) => current.split(from).join(to),
      value
    );
  }
  if (Array.isArray(value)) return value.map((item) => replaceStringPrefixes(item, replacements));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      replaceStringPrefixes(key, replacements),
      replaceStringPrefixes(item, replacements),
    ])
  );
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const resolvedRoot = path.resolve(root);
  const files = [];
  function visit(currentPath) {
    const stat = fs.lstatSync(currentPath);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(currentPath);
      const resolvedTarget = path.resolve(path.dirname(currentPath), target);
      const isContained = resolvedTarget === resolvedRoot ||
        resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
      if (path.isAbsolute(target) || !isContained) {
        throw new Error(`DCode state contains an unsafe symbolic link: ${currentPath}`);
      }
      return;
    }
    if (stat.isFile()) {
      files.push(currentPath);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const name of fs.readdirSync(currentPath).sort()) visit(path.join(currentPath, name));
  }
  visit(root);
  return files;
}

function normalizeDcodeStateTree({
  marketplaceRoot,
  dcodeHomeRoot,
  canonicalMount = DEFAULT_CANONICAL_MOUNT,
  canonicalMarketplaceRoot = null,
}) {
  for (const [value, label] of [
    [marketplaceRoot, 'marketplaceRoot'],
    [dcodeHomeRoot, 'dcodeHomeRoot'],
  ]) {
    assertNonEmptyString(value, label);
    if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  }
  validateCanonicalMount(canonicalMount);
  const effectiveCanonicalMarketplaceRoot = resolveCanonicalMarketplaceRoot(
    canonicalMount, canonicalMarketplaceRoot
  );
  const resolvedMarketplaceRoot = path.resolve(marketplaceRoot);
  const resolvedHomeRoot = path.resolve(dcodeHomeRoot);
  const pathMappings = [
    [resolvedMarketplaceRoot, effectiveCanonicalMarketplaceRoot],
    [resolvedHomeRoot, `${canonicalMount}/home`],
  ];
  const replacementsBySource = new Map();
  for (const [sourcePath, destinationPath] of pathMappings) {
    replacementsBySource.set(sourcePath, destinationPath);
    if (fs.existsSync(sourcePath)) {
      replacementsBySource.set(fs.realpathSync.native(sourcePath), destinationPath);
    }
  }
  const replacements = [...replacementsBySource.entries()]
    .sort((left, right) => right[0].length - left[0].length);
  const dcodeConfigRoot = path.join(resolvedHomeRoot, '.deepagents');
  const sensitivePaths = [
    path.join(dcodeConfigRoot, '.env'),
    path.join(dcodeConfigRoot, '.state', 'mcp-tokens'),
  ];
  for (const sensitivePath of sensitivePaths) {
    if (fs.existsSync(sensitivePath)) {
      throw new Error(`Refusing to package sensitive DCode state: ${sensitivePath}`);
    }
  }

  const rewrittenFiles = [];
  for (const filePath of walkFiles(dcodeConfigRoot)) {
    const extension = path.extname(filePath).toLowerCase();
    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) continue;
    const original = buffer.toString('utf8');
    if (!replacements.some(([from]) => original.includes(from))) continue;
    if (extension === '.json') {
      const document = JSON.parse(original);
      const rewritten = replaceStringPrefixes(document, replacements);
      writeJson(filePath, rewritten);
    } else {
      const rewritten = replacements.reduce(
        (content, [from, to]) => content.split(from).join(to),
        original
      );
      fs.writeFileSync(filePath, rewritten);
    }
    const normalized = fs.readFileSync(filePath, 'utf8');
    for (const [forbiddenPrefix] of replacements) {
      if (normalized.includes(forbiddenPrefix)) {
        throw new Error(`Could not normalize staged path in ${filePath}`);
      }
    }
    if (normalized !== original) rewrittenFiles.push(filePath);
  }

  return { rewrittenFiles };
}

function parseCliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function requireCliOption(options, name) {
  assertNonEmptyString(options[name], `--${name}`);
  return path.resolve(options[name]);
}

function cli(argv) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'stage';
  const optionArguments = command === 'stage' && argv[0]?.startsWith('--') ? argv : argv.slice(1);
  const options = parseCliOptions(optionArguments);
  const marketplaceRoot = requireCliOption(options, 'marketplace');
  const dcodeHomeRoot = requireCliOption(options, 'home');
  const canonicalMount = options['canonical-mount'] || DEFAULT_CANONICAL_MOUNT;
  const canonicalMarketplaceRoot = options['canonical-marketplace-root'] || null;

  let result;
  if (command === 'stage') {
    result = adaptDcodePlugin({
      sourceRoot: requireCliOption(options, 'source'),
      marketplaceRoot,
      dcodeHomeRoot,
      sourceSha: options['source-sha'] || null,
      canonicalMount,
      canonicalMarketplaceRoot,
    });
  } else if (command === 'normalize-state') {
    result = normalizeDcodeStateTree({
      marketplaceRoot,
      dcodeHomeRoot,
      canonicalMount,
      canonicalMarketplaceRoot,
    });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(sortJsonValue(result), null, 2)}\n`);
}

if (require.main === module) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`dcode-adapter: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CHROME_DEVTOOLS_MCP_ENTRYPOINT,
  CHROME_DEVTOOLS_MCP_VERSION,
  DEFAULT_CANONICAL_MOUNT,
  adaptDcodePlugin,
  adaptHooks,
  buildMarketplaceManifest,
  convertAgents,
  convertCommands,
  normalizeDcodeStateTree,
  parseFrontmatter,
  validateMarketplaceManifest,
};
