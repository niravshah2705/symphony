'use strict';

/**
 * Four-CR renderer for a kagent plugin agent.
 *
 * kagent needs four objects to run one plugin-carrying agent, and they are
 * paired in exactly one way:
 *
 *   ModelConfig   which model, which credential
 *   Harness       which engine, which runtime image, which Substrate capacity
 *   AgentTemplate what the agent does: model, prompt, skills, plugins
 *   Agent         binds templateRef + harnessRef — the only place the two meet
 *
 * `deploy/kagent/ecc-plugin/ecc-agent.yaml` (PR #307) is the hand-written
 * reference for the shape. This module exists so the other packs cannot drift
 * from it, so that the rendered set is checkable against the catalog (same
 * skills, same version, same pin), and so a local build and CI emit byte-equal
 * documents apart from the digest line that `scripts/stamp-plugin-digest.sh`
 * rewrites.
 *
 * The rules enforced here are kagent's, restated because a violation is a
 * `kubectl apply` rejection with a message that does not point at the cause:
 *   - `oci:` digest-pinned is the only plugin source that reaches Ready under
 *     Agent Substrate; `git:` needs a full 40-hex commit and crashes the
 *     golden-snapshot builder, which has no egress.
 *   - attaching a plugin does not enable its skills; the list is explicit and
 *     capped at 50.
 *   - Harness engine is the enum kagent|codex|claude|byo; `byo` requires a
 *     digest-pinned workload image and a command.
 *   - env is capped at 32 vars of 32768 chars and reserves the CA-bundle names.
 *   - a plugin's own mcp.json is read by the kagent engine only.
 */

const {
  CATALOG,
  MATRIX_COLUMNS,
  SKILLS_MAX,
  PROMPT_APPEND_MAX,
  ENV_VARS_MAX,
  ENV_VALUE_MAX,
  RESERVED_ENV,
  enabledSkills,
  findPlugin,
} = require('./plugin-catalog');

const { SKILLS, findSkill } = require('./skill-catalog');

const API_VERSION = 'api.kagent.dev/v1alpha3';
const OCI_PINNED = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;
const NAME = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const NAME_MAX = 63;

/** Reserved for the codex engine on top of the CA names kagent reserves always. */
const CODEX_RESERVED_ENV = Object.freeze([
  'CODEX_HOME', 'OPENAI_API_KEY', 'AWS_REGION', 'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
]);

const MODEL_DEFAULTS = Object.freeze({
  nameSuffix: 'model',
  provider: 'OpenAI',
  model: 'gemini-3.6-flash',
  apiKeySecret: 'litellm-secrets',
  apiKeySecretKey: 'LITELLM_MASTER_KEY',
  baseUrl: 'http://litellm.litellm.svc.cluster.local:4000/v1',
  apiFormat: 'responses',
  stream: true,
});

/** A cluster-local placeholder the stamping step replaces; never applied as-is. */
const DIGEST_PLACEHOLDER = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

function assertName(value, label) {
  if (!NAME.test(value) || value.length > NAME_MAX) {
    throw new Error(`${label} "${value}" is not a valid Kubernetes name (lowercase alnum and hyphens, ${NAME_MAX} max)`);
  }
  return value;
}

/**
 * The four object names for a (plugin, cliKey) pair. Deterministic from the
 * inputs so two runs cannot produce different documents.
 */
function crNames(pluginId, cliKey, options = {}) {
  const base = `${pluginId}-${cliKey}`;
  assertName(base, 'resource name prefix');
  return {
    modelConfig: options.modelConfigName || `${base}-${MODEL_DEFAULTS.nameSuffix}`,
    harness: options.harnessName || base,
    template: options.templateName || `${base}-template`,
    agent: options.agentName || `${base}-agent`,
  };
}

function validateEnv(env) {
  const entries = Object.entries(env || {});
  if (entries.length > ENV_VARS_MAX) {
    throw new Error(`Harness env has ${entries.length} vars, over the ${ENV_VARS_MAX} an Actor is capped at`);
  }
  for (const [name, value] of entries) {
    if (RESERVED_ENV.includes(name)) throw new Error(`Harness env ${name} is reserved by kagent`);
    if (String(value).length > ENV_VALUE_MAX) throw new Error(`Harness env ${name} exceeds ${ENV_VALUE_MAX} chars`);
  }
  return entries;
}

/**
 * Build the four-CR structure for one plugin on one harness column.
 *
 * @param {object}  params
 * @param {object}  params.plugin        a catalog record
 * @param {string}  params.cliKey        a matrix column key, or `kagent`
 * @param {string}  [params.namespace=kagent]
 * @param {string}  [params.ociRef]      `<repo>@sha256:<digest>`; the placeholder
 *                                        digest is used when omitted so the
 *                                        document stays applicable-shape but
 *                                        visibly unstamped
 * @param {string}  [params.workloadImage] digest-pinned runtime image for a byo engine
 * @param {string[]} [params.command]    entrypoint for a byo engine
 * @param {object}  [params.env]         literal Harness env as name -> value
 * @param {object}  [params.model]       overrides for MODEL_DEFAULTS
 * @param {string}  [params.source]      `oci` (default) or `git` — git is only
 *                                        correct when Substrate is not in play
 * @returns {{pluginId:string, cliKey:string, engine:string, names:object, documents:object[]}}
 */
function buildCrSet({
  plugin,
  cliKey,
  namespace = 'kagent',
  ociRef = null,
  workloadImage = null,
  command = null,
  env = null,
  workerPool = 'kagent-default',
  snapshotLocation = 's3://ate-snapshots/kagent/',
  model = {},
  source = 'oci',
} = {}) {
  if (!plugin || !plugin.id) throw new Error('buildCrSet requires a catalog plugin record');
  const entry = (plugin.harnesses || {})[cliKey];
  if (!entry) throw new Error(`catalog has no ${plugin.id}/${cliKey} row`);
  if (entry.status === 'unsupported') {
    throw new Error(`${plugin.id}/${cliKey} is unsupported (${entry.blockedOn ? `blocked on ${entry.blockedOn}` : 'no runtime'})`);
  }

  const engine = entry.engine;
  if (!['kagent', 'codex', 'claude', 'byo'].includes(engine)) {
    throw new Error(`${plugin.id}/${cliKey}: engine "${engine}" is outside kagent's enum kagent|codex|claude|byo`);
  }
  if (engine === 'byo' && !workloadImage) {
    throw new Error(`${plugin.id}/${cliKey}: the byo engine requires a digest-pinned workload.image`);
  }
  if (engine === 'byo' && !(Array.isArray(command) && command.length > 0)) {
    throw new Error(`${plugin.id}/${cliKey}: the byo engine requires an entrypoint command`);
  }
  // Two halves of one rule: the bundle's mcp.json is read by the kagent engine
  // and by nothing else. A kagent row that turns it off ships a server nothing
  // binds, and a codex/claude row that turns it on claims a binding that cannot
  // happen — both are silent, so refuse them here.
  if (plugin.bundle.mcp && engine === 'kagent' && entry.mcp !== true) {
    throw new Error(`${plugin.id}/${cliKey}: an mcp-carrying bundle must bind its server on the kagent engine`);
  }
  if (plugin.bundle.mcp && engine !== 'kagent' && entry.mcp === true) {
    throw new Error(`${plugin.id}/${cliKey}: the ${engine} engine does not read a bundle mcp.json; bind a RemoteMCPServer tool instead`);
  }

  const skills = enabledSkills(plugin);
  if (skills.length === 0) throw new Error(`${plugin.id}: no enabled skills to mount`);
  if (skills.length > SKILLS_MAX) throw new Error(`${plugin.id}: ${skills.length} enabled skills exceeds ${SKILLS_MAX}`);
  const prompt = String(plugin.promptAppend || '');
  if (prompt.length > PROMPT_APPEND_MAX) throw new Error(`${plugin.id}: promptAppend exceeds ${PROMPT_APPEND_MAX} chars`);

  const names = crNames(plugin.id, cliKey);
  const cfg = { ...MODEL_DEFAULTS, ...model };
  const repoRef = ociRef || `${plugin.bundle.image}@${DIGEST_PLACEHOLDER}`;
  if (source === 'oci' && !OCI_PINNED.test(repoRef)) {
    throw new Error(`${plugin.id}/${cliKey}: plugin source "${repoRef}" is not digest-pinned; a bare tag is rejected`);
  }
  if (source === 'git') {
    if (!GIT_COMMIT.test(plugin.upstream.commit)) {
      throw new Error(`${plugin.id}/${cliKey}: git source needs a full 40-hex commit`);
    }
    if (engine !== 'kagent' && engine !== 'byo') {
      // Not a kagent rejection per se: under Agent Substrate the golden-snapshot
      // Actor fetches git itself, has no egress, and crashes. Refuse the
      // combination rather than documenting a crash.
      throw new Error(`${plugin.id}/${cliKey}: a git plugin source crashes the Substrate snapshot builder; publish ${repoRef.split('@')[0]} as an OCI artifact instead`);
    }
  }

  if (workloadImage && !OCI_PINNED.test(workloadImage)) {
    throw new Error(`${plugin.id}/${cliKey}: workload image "${workloadImage}" is not digest-pinned`);
  }
  if (command && command.length > 32) {
    throw new Error(`${plugin.id}/${cliKey}: command has ${command.length} entries, over the 32 kagent allows`);
  }
  // Omitting the block makes the Harness follow the installed release default;
  // naming an image pins the runtime, which is what a published pack wants.
  const pinnedRuntime = workloadImage || HARNESS_IMAGES[engine] || null;
  const harnessWorkload = pinnedRuntime
    ? { image: pinnedRuntime, ...(command ? { command } : {}) }
    : null;

  const documents = [
    modelConfigDoc({ names, namespace, cfg, engine }),
    harnessDoc({ names, namespace, engine, workload: harnessWorkload, env, workerPool, snapshotLocation }),
    {
      apiVersion: API_VERSION,
      kind: 'AgentTemplate',
      metadata: { name: names.template, namespace },
      spec: {
        description: `${plugin.label} (${plugin.upstream.repository}@${plugin.upstream.commit.slice(0, 12)}), version ${plugin.bundle.version}, mounted read-only from a digest-pinned OCI artifact.`,
        modelConfig: { name: names.modelConfig },
        systemPrompt: systemPrompt(plugin, cliKey, skills),
        plugins: [
          {
            source: source === 'git'
              ? { git: { url: plugin.upstream.url.replace(/\.git$/, ''), commit: plugin.upstream.commit } }
              : { oci: repoRef },
            skills,
          },
        ],
      },
    },
    agentDoc({ names, namespace, displayName: `${plugin.label} ${cliKey} Agent` }),
  ];

  return { pluginId: plugin.id, cliKey, engine, names, ociRef: repoRef, documents };
}

/**
 * Build the four-CR set for a standalone skill — the shape used by packs that
 * ship one `SKILL.md` directory and no plugin manifest.
 *
 * Three differences from buildCrSet, and no others:
 *   - the template carries `spec.skills[]` entries, not `spec.plugins[]`, so the
 *     runtime offers the skill without a plugin bundle or an enable list;
 *   - the entry names a `path:` inside the artifact, because the image root is
 *     not the skill directory;
 *   - the artifact's version is the pinned commit, since an unversioned upstream
 *     has no release string to put in the tag.
 *
 * @param {object}  params
 * @param {object}  params.skill        a skill-catalog record
 * @param {string}  params.cliKey
 * @param {string}  [params.namespace=kagent]
 * @param {string}  [params.ociRef]
 * @param {string}  [params.workloadImage]
 * @param {string[]} [params.command]
 * @param {object}  [params.env]
 * @param {object}  [params.model]
 */
function buildSkillCrSet({
  skill,
  cliKey,
  namespace = 'kagent',
  ociRef = null,
  workloadImage = null,
  command = null,
  env = null,
  workerPool = 'kagent-default',
  snapshotLocation = 's3://ate-snapshots/kagent/',
  model = {},
} = {}) {
  if (!skill || !skill.id) throw new Error('buildSkillCrSet requires a skill-catalog record');
  const entry = (skill.harnesses || {})[cliKey];
  if (!entry) throw new Error(`skill catalog has no ${skill.id}/${cliKey} row`);
  if (entry.status === 'unsupported') {
    throw new Error(`${skill.id}/${cliKey} is unsupported (${entry.blockedOn ? `blocked on ${entry.blockedOn}` : 'no runtime'})`);
  }
  const engine = entry.engine;
  if (!['kagent', 'codex', 'claude', 'byo'].includes(engine)) {
    throw new Error(`${skill.id}/${cliKey}: engine "${engine}" is outside kagent's enum kagent|codex|claude|byo`);
  }
  if (engine === 'byo' && !workloadImage) {
    throw new Error(`${skill.id}/${cliKey}: the byo engine requires a digest-pinned workload.image`);
  }
  if (engine === 'byo' && !(Array.isArray(command) && command.length > 0)) {
    throw new Error(`${skill.id}/${cliKey}: the byo engine requires an entrypoint command`);
  }
  // A standalone skill declares no servers: an mcp.json in the artifact would be
  // unread, and on the kagent engine it would silently outrank a bound server.
  if (entry.mcp === true) {
    throw new Error(`${skill.id}/${cliKey}: a standalone skill declares no mcp.json; package it as a plugin to bind a server`);
  }

  const prompt = String(skill.promptAppend || '');
  if (prompt.length > PROMPT_APPEND_MAX) throw new Error(`${skill.id}: promptAppend exceeds ${PROMPT_APPEND_MAX} chars`);
  if (command && command.length > 32) {
    throw new Error(`${skill.id}/${cliKey}: command has ${command.length} entries, over the 32 kagent allows`);
  }

  const names = crNames(skill.id, cliKey);
  const cfg = { ...MODEL_DEFAULTS, ...model };
  const repoRef = ociRef || `${skill.artifact.image}@${DIGEST_PLACEHOLDER}`;
  if (!OCI_PINNED.test(repoRef)) {
    throw new Error(`${skill.id}/${cliKey}: skill source "${repoRef}" is not digest-pinned; a bare tag is rejected`);
  }
  const pinnedRuntime = workloadImage || HARNESS_IMAGES[engine] || null;
  const harnessWorkload = pinnedRuntime
    ? { image: pinnedRuntime, ...(command ? { command } : {}) }
    : null;

  const documents = [
    modelConfigDoc({ names, namespace, cfg, engine }),
    harnessDoc({ names, namespace, engine, workload: harnessWorkload, env, workerPool, snapshotLocation }),
    {
      apiVersion: API_VERSION,
      kind: 'AgentTemplate',
      metadata: { name: names.template, namespace },
      spec: {
        description: `${skill.label} (${skill.upstream.repository}@${skill.upstream.commit.slice(0, 12)}), attached as a standalone skill from a digest-pinned OCI artifact.`,
        modelConfig: { name: names.modelConfig },
        systemPrompt: skillSystemPrompt(skill, cliKey),
        // `path` is the directory kagent reads the skill name out of, so it has
        // to be the artifact's own skills/<id> — not a guess at a subpath.
        skills: [{ name: skill.id, source: { oci: repoRef, path: skill.artifact.skillPath } }],
      },
    },
    agentDoc({ names, namespace, displayName: `${skill.label} ${cliKey} Agent` }),
  ];

  return { skillId: skill.id, cliKey, engine, names, ociRef: repoRef, documents };
}

function modelConfigDoc({ names, namespace, cfg, engine }) {
  const modelProviderBlock = { baseUrl: cfg.baseUrl };
  // The codex runtime posts to /v1/responses; chatCompletions is its CRD default
  // and its own runtime never calls that path.
  if (engine === 'codex') modelProviderBlock.apiFormat = cfg.apiFormat;
  return {
    apiVersion: API_VERSION,
    kind: 'ModelConfig',
    metadata: { name: names.modelConfig, namespace },
    spec: {
      provider: cfg.provider,
      model: cfg.model,
      apiKeySecret: cfg.apiKeySecret,
      apiKeySecretKey: cfg.apiKeySecretKey,
      [providerBlockKey(cfg.provider)]: modelProviderBlock,
      stream: cfg.stream,
      allowedNamespaces: { from: 'Same' },
    },
  };
}

function harnessDoc({ names, namespace, engine, workload, env, workerPool, snapshotLocation }) {
  return {
    apiVersion: API_VERSION,
    kind: 'Harness',
    metadata: { name: names.harness, namespace },
    spec: {
      [engine]: {},
      ...(workload ? { workload } : {}),
      ...(Object.keys(env || {}).length
        ? { env: validateEnvForEngine(env, engine).map(([name, value]) => ({ name, value })) }
        : {}),
      substrate: {
        // The most common Ready failure is ResolvedRefs/WorkerPoolNotFound.
        workerPoolRef: { name: workerPool },
        snapshotPolicy: { location: snapshotLocation },
      },
    },
  };
}

function agentDoc({ names, namespace, displayName }) {
  return {
    apiVersion: API_VERSION,
    kind: 'Agent',
    metadata: {
      name: names.agent,
      namespace,
      annotations: { 'kagent.dev/display-name': displayName },
    },
    spec: {
      template: { ref: { name: names.template } },
      harnessRef: { name: names.harness },
      egressPolicyRefs: [],
    },
  };
}

function validateEnvForEngine(env, engine) {
  const entries = validateEnv(env);
  if (engine === 'codex') {
    for (const [name] of entries) {
      if (CODEX_RESERVED_ENV.includes(name)) throw new Error(`the codex engine reserves the env name ${name}`);
    }
  }
  return entries;
}

/**
 * Codex accepts nothing in the openAI block but baseUrl and apiFormat, so the
 * provider block key follows the provider name lower-cased on the first letter
 * only — `OpenAI` becomes `openAI`, `Anthropic` becomes `anthropic`.
 */
function providerBlockKey(provider) {
  if (provider === 'OpenAI') return 'openAI';
  if (provider === 'AzureOpenAI') return 'azureOpenAI';
  return provider.charAt(0).toLowerCase() + provider.slice(1);
}

/**
 * The prompt the template ships with. The plugin's `promptAppend` is the part
 * that came from the catalog, so a test can prove the catalog text reached the
 * cluster object rather than being paraphrased per pack.
 *
 * No absolute mount path is named: Substrate chooses where a bundle lands, and a
 * prompt that guesses one teaches the agent to reach for a path that 404s.
 */
function systemPrompt(plugin, cliKey, skills) {
  return [
    `You are an engineering agent running inside Agent Substrate on the ${cliKey} harness.`,
    `The ${plugin.label} plugin (${plugin.bundle.version}) is mounted read-only, and these`,
    `skills are enabled for you: ${skills.join(', ')}.`,
    plugin.promptAppend.trim(),
    'Say which skill you are using before you rely on it. Never write a credential into a',
    'file, a command you echo, or a trace you export.',
  ].join(' ');
}

/**
 * The same composition for a standalone skill, which has no enable list: the
 * artifact is the skill, and SKILL.md points at the reference files beside it.
 */
function skillSystemPrompt(skill, cliKey) {
  return [
    `You are an engineering agent running inside Agent Substrate on the ${cliKey} harness.`,
    `The ${skill.label} skill is mounted read-only; open its SKILL.md and the reference files`,
    `beside it rather than answering from memory of them.`,
    skill.promptAppend.trim(),
    'Say which skill you are using before you rely on it. Never write a credential into a',
    'file, a command you echo, or a trace you export.',
  ].join(' ');
}

// The digest kagent's installed release resolves to for the codex engine.
// Pinned because a Harness that names only a tag silently changes the agent's
// runtime underneath a published pack. claude has no known-good digest here,
// so that Harness omits the workload block and follows the release default.
const HARNESS_IMAGES = Object.freeze({
  codex: 'ghcr.io/kagent-dev/kagent/codex-harness@sha256:7da600c1bc342b31bccb281dd9a48c6bdbf33d80a20f89e69128f052858fe9f3',
});

// ------------------------------------------------------------------- emitter
// Written by hand rather than pulled from a YAML dependency, so the bytes a
// developer stamps are the bytes CI stamps and nothing about the formatting
// depends on an installed package version.

const LONG_LINE = 76;

// A reference the stamping step rewrites with sed has to stay on one line: fold
// it and the continuation line survives the substitution as a stray scalar. Same
// for anything a human greps for in a manifest review.
const LITERAL_KEYS = new Set([
  'oci', 'image', 'url', 'baseUrl', 'location', 'path', 'commit', 'version',
  'apiKeySecret', 'apiKeySecretKey',
]);

function scalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  if (text === '') return '\"\"';
  // Anything a parser could read as a flow mapping, a reference or a number is
  // quoted; digests and URLs are the common cases.
  if (/^[a-z][a-z0-9]*$/i.test(text)) return text;
  return `'${text.replace(/'/g, "\'")}'`;
}

/** Wrap a sentence into folded-scalar lines no longer than LONG_LINE. */
function foldLines(text) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && `${line} ${word}`.length > LONG_LINE) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * `key: >-` with the content indented deeper than the key — a block scalar at
 * the key's own indentation would be read as a nested mapping.
 */
function emitFolded(key, text, indent) {
  const pad = ' '.repeat(indent + 2);
  return `${' '.repeat(indent)}${key}: >-\n${foldLines(text).map((l) => `${pad}${l}`).join('\n')}`;
}

function isLongString(value) {
  return typeof value === 'string' && value.length > LONG_LINE;
}

function emitMap(map, indent = 0) {
  const pad = ' '.repeat(indent);
  const out = [];
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === 'string' && LITERAL_KEYS.has(key)) {
      out.push(`${pad}${key}: ${scalar(value)}`);
      continue;
    }
    if (isLongString(value)) {
      out.push(emitFolded(key, value, indent));
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length === 0) out.push(`${pad}${key}: {}`);
      else out.push(`${pad}${key}:\n${emitMap(value, indent + 2)}`);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        out.push(`${pad}${key}: []`);
        continue;
      }
      const items = value.map((item) => {
        if (item !== null && typeof item === 'object') {
          const body = emitMap(item, indent + 2);
          const first = body.split('\n');
          // `- key: value` on the dash line keeps sequence maps readable and
          // unambiguous.
          return `${pad}- ${first[0].trimStart()}\n${first.slice(1).join('\n')}`;
        }
        return `${pad}- ${scalar(item)}`;
      });
      out.push(`${pad}${key}:\n${items.join('\n')}`);
      continue;
    }
    out.push(`${pad}${key}: ${scalar(value)}`);
  }
  return out.join('\n');
}

/** Render the four documents as one `---`-separated YAML stream. */
function renderCrSet(result, { header = '' } = {}) {
  const chunks = result.documents.map((doc, index) => {
    const label = `# ${doc.kind}: ${doc.metadata.name}`;
    const head = index === 0 && header ? `# ${header}\n` : '';
    return `${head}${label}\n${emitMap(doc)}`;
  });
  return `${chunks.join('\n---\n')}\n`;
}

/**
 * Convenience for the stamping script and tests: the (plugin, cliKey) pairs the
 * catalog can render today.
 */
function renderablePairs(catalog = CATALOG) {
  const pairs = [];
  for (const plugin of catalog.plugins || []) {
    for (const [cliKey, entry] of Object.entries(plugin.harnesses || {})) {
      if (entry.status === 'unsupported') continue;
      pairs.push({ pluginId: plugin.id, cliKey, engine: entry.engine, version: entry.version });
    }
  }
  return pairs;
}

/** The skill-track counterpart of renderablePairs. */
function renderableSkillPairs(catalog = SKILLS) {
  const pairs = [];
  for (const skill of catalog.skills || []) {
    for (const [cliKey, entry] of Object.entries(skill.harnesses || {})) {
      if (entry.status === 'unsupported') continue;
      pairs.push({ skillId: skill.id, cliKey, engine: entry.engine, version: entry.version });
    }
  }
  return pairs;
}

module.exports = {
  API_VERSION,
  MODEL_DEFAULTS,
  DIGEST_PLACEHOLDER,
  OCI_PINNED,
  GIT_COMMIT,
  CODEX_RESERVED_ENV,
  HARNESS_IMAGES,
  buildCrSet,
  buildSkillCrSet,
  renderCrSet,
  crNames,
  providerBlockKey,
  renderablePairs,
  renderableSkillPairs,
  findPlugin,
  systemPrompt,
  skillSystemPrompt,
  emitMap,
};
