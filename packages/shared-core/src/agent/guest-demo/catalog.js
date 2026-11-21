'use strict';

/**
 * Guest demo catalogue — the one description of what an unauthenticated visitor
 * is allowed to ask for, read by BOTH the gateway endpoint that serves the
 * starter list and the runner that answers it. Nothing here is duplicated in the
 * SPA: the browser renders ids it was given and sends ids back, which is the
 * whole reason a guest cannot type.
 *
 * Ids are opaque, server-issued, and the only guest input. Every lookup runs the
 * strict `ID_SHAPE` test first, so an id fabricated in the DOM — a path, a
 * template string, a longer payload — is rejected before it reaches the tree and
 * buys the caller a 400 rather than a code path.
 *
 * Two kinds of node move the visitor through the tree:
 *   question — a prompt plus a fixed set of clickable answers;
 *   flow     — the scripted demo run, ending in the deploy step and a preview URL.
 * An answer may set the session's `template` (which bundle gets deployed) and/or
 * merge `variant` keys (accent colour, extra feature). That is how one flow
 * produces five different sites without any of them being authored at runtime.
 *
 * Labels are `labelFallback`: the English string the server ships so the endpoint
 * is self-describing, paired with a `labelKey` the SPA resolves through its own
 * dictionary. One source for ids, localizable strings in the SPA.
 */

const ID_SHAPE = /^[a-z][a-z0-9._-]{0,63}$/;
const LABEL_MAX = 80;
const QUESTION_MAX = 200;
// Kubernetes names, not guest ids: this is the shape `assertName` in
// ../registry/agent-crset.js enforces on the four CRs the demo renders.
const K8S_NAME_SHAPE = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const K8S_NAME_MAX = 63;

const RESTART = '__restart__';

/**
 * The synthetic skill record handed to `buildSkillCrSet`
 * (`../registry/agent-crset.js`). It is first-party and deliberately NOT in
 * `registry/skill-catalog.json`: that catalog publishes third-party OCI artifacts
 * and its validator demands an upstream GitHub pin, a ghcr image, a Dockerfile, an
 * icon and a CI-stamped digest. This record only ever reaches the CR renderer, so
 * it carries the fields the renderer reads and nothing else. `promptAppend` length
 * is enforced by `buildSkillCrSet` itself — no second limit here.
 */
const AGENT = Object.freeze({
  id: 'guest-webapp-demo',
  label: 'Guest Webapp Demo',
  upstream: Object.freeze({
    repository: 'local/guest-webapp-demo',
    url: 'https://github.com/local/guest-webapp-demo.git',
    // Not a real pin: the artifact is first-party and never published. The
    // renderer slices 12 chars off it for the AgentTemplate description.
    commit: '0'.repeat(40),
  }),
  artifact: Object.freeze({
    version: '1',
    image: 'ghcr.io/local/guest-webapp-demo-skill',
    skillPath: 'skills/guest-webapp-demo',
    entryFile: 'SKILL.md',
  }),
  promptAppend: 'Scaffold the chosen template, plan the build, then deploy it as a static webapp and report the preview URL. Never ask the visitor for free text; offer only the options you were given.',
  harnesses: Object.freeze({
    kagent: Object.freeze({ status: 'supported', engine: 'kagent', version: '1', mcp: false }),
  }),
});

const CLI_KEY = 'kagent';

/**
 * The commands a guest may click. `entryNode` is where the tree starts. Note what
 * is absent: no URL, no model, no prompt field. A free-text target would turn the
 * gateway into a fetch-anything proxy and put an SSRF surface behind an
 * unauthenticated route.
 */
const COMMANDS = Object.freeze([
  Object.freeze({
    id: 'gcmd.helloworld',
    labelKey: 'guestCmdHelloWorld',
    labelFallback: 'Create my hello-world application',
    template: 'helloworld',
    entryNode: 'helloworld.stack',
  }),
  Object.freeze({
    id: 'gcmd.tictactoe',
    labelKey: 'guestCmdTicTacToe',
    labelFallback: 'Create my tic-tac-toe application',
    template: 'tic-tac-toe',
    entryNode: 'tictactoe.theme',
  }),
  Object.freeze({
    id: 'gcmd.reverse-engineer',
    labelKey: 'guestCmdReverseEngineer',
    labelFallback: 'Reverse engineer a website',
    entryNode: 'reverse.target',
  }),
  Object.freeze({
    id: 'gcmd.docs-search',
    labelKey: 'guestCmdDocsSearch',
    labelFallback: 'Search the reviewed documentation',
    entryNode: 'docs.topic',
  }),
]);

/**
 * Fixed-answer questions. `next` names another node or a flow; a terminal answer
 * omits it. `redeploy` re-releases the same preview URL with the merged variant —
 * it does not move the expiry.
 */
const NODES = Object.freeze({
  'helloworld.stack': Object.freeze({
    id: 'helloworld.stack',
    questionKey: 'guestQHelloWorldStack',
    questionFallback: 'Which stack should the hello-world app use?',
    answers: Object.freeze([
      Object.freeze({ id: 'gans.helloworld.stack.node', labelKey: 'guestAHelloWorldNode', labelFallback: 'Node.js', variant: Object.freeze({ stack: 'node' }), next: 'helloworld.theme' }),
      Object.freeze({ id: 'gans.helloworld.stack.static', labelKey: 'guestAHelloWorldStatic', labelFallback: 'Static HTML', variant: Object.freeze({ stack: 'static' }), next: 'helloworld.theme' }),
    ]),
  }),
  'helloworld.theme': Object.freeze({
    id: 'helloworld.theme',
    questionKey: 'guestQHelloWorldTheme',
    questionFallback: 'Pick a starting look.',
    answers: Object.freeze([
      Object.freeze({ id: 'gans.helloworld.theme.indigo', labelKey: 'guestAThemeIndigo', labelFallback: 'Indigo', variant: Object.freeze({ accent: 'indigo' }), next: 'deploy.webapp' }),
      Object.freeze({ id: 'gans.helloworld.theme.emerald', labelKey: 'guestAThemeEmerald', labelFallback: 'Emerald', variant: Object.freeze({ accent: 'emerald' }), next: 'deploy.webapp' }),
    ]),
  }),

  'tictactoe.theme': Object.freeze({
    id: 'tictactoe.theme',
    questionKey: 'guestQTicTacToeTheme',
    questionFallback: 'Which board theme?',
    answers: Object.freeze([
      Object.freeze({ id: 'gans.tictactoe.theme.classic', labelKey: 'guestAThemeClassic', labelFallback: 'Classic light', variant: Object.freeze({ accent: 'slate' }), next: 'tictactoe.mode' }),
      Object.freeze({ id: 'gans.tictactoe.theme.dark', labelKey: 'guestAThemeDark', labelFallback: 'Dark', variant: Object.freeze({ accent: 'indigo' }), next: 'tictactoe.mode' }),
    ]),
  }),
  'tictactoe.mode': Object.freeze({
    id: 'tictactoe.mode',
    questionKey: 'guestQTicTacToeMode',
    questionFallback: 'Who plays against whom?',
    answers: Object.freeze([
      Object.freeze({ id: 'gans.tictactoe.mode.local', labelKey: 'guestATicTacToeLocal', labelFallback: 'Two players on one device', variant: Object.freeze({ opponent: 'local' }), next: 'deploy.webapp' }),
      Object.freeze({ id: 'gans.tictactoe.mode.ai', labelKey: 'guestATicTacToeAi', labelFallback: 'Play against the computer', variant: Object.freeze({ opponent: 'ai' }), next: 'deploy.webapp' }),
    ]),
  }),

  // The "reverse engineer a website" list. These are the only sites the demo can
  // take apart: first-party templates, not arbitrary URLs fetched on demand.
  'reverse.target': Object.freeze({
    id: 'reverse.target',
    questionKey: 'guestQReverseTarget',
    questionFallback: 'Which example site should we take apart?',
    answers: Object.freeze([
      Object.freeze({ id: 'gtarget.storefront', labelKey: 'guestAReverseStorefront', labelFallback: 'Sample storefront', template: 'clone-storefront', next: 'reverse.depth' }),
      Object.freeze({ id: 'gtarget.saas-landing', labelKey: 'guestAReverseSaas', labelFallback: 'Sample SaaS landing page', template: 'clone-saas-landing', next: 'reverse.depth' }),
      Object.freeze({ id: 'gtarget.docs-site', labelKey: 'guestAReverseDocs', labelFallback: 'Sample documentation site', template: 'clone-docs-site', next: 'reverse.depth' }),
    ]),
  }),
  'reverse.depth': Object.freeze({
    id: 'reverse.depth',
    questionKey: 'guestQReverseDepth',
    questionFallback: 'How far should the rebuild go?',
    answers: Object.freeze([
      Object.freeze({ id: 'gans.reverse.depth.map', labelKey: 'guestAReverseMap', labelFallback: 'Component map and clone plan only', variant: Object.freeze({ depth: 'map' }), next: 'deploy.webapp' }),
      Object.freeze({ id: 'gans.reverse.depth.full', labelKey: 'guestAReverseFull', labelFallback: 'Rebuild the page as a webapp', variant: Object.freeze({ depth: 'full' }), next: 'deploy.webapp' }),
    ]),
  }),

  'docs.topic': Object.freeze({
    id: 'docs.topic',
    questionKey: 'guestQDocsTopic',
    questionFallback: 'What should I look up in the reviewed documentation?',
    // `query` is the server's own text for the one public read endpoint; the
    // visitor picks an id, never types a search.
    answers: Object.freeze([
      Object.freeze({ id: 'gans.docs.topic.adlc', labelKey: 'guestADocsAdlc', labelFallback: 'What is the Agentic Development Life Cycle?', query: 'Agentic Development Life Cycle overview', next: 'docs.result' }),
      Object.freeze({ id: 'gans.docs.topic.planner', labelKey: 'guestADocsPlanner', labelFallback: 'How does the planner break work down?', query: 'planner milestones tasks', next: 'docs.result' }),
      Object.freeze({ id: 'gans.docs.topic.egress', labelKey: 'guestADocsEgress', labelFallback: 'How are credentials kept out of agents?', query: 'egress proxy credential isolation', next: 'docs.result' }),
    ]),
  }),
  'docs.result': Object.freeze({
    id: 'docs.result',
    questionKey: 'guestQDocsResult',
    questionFallback: 'Want to see what else a demo session can do?',
    answers: Object.freeze([
      Object.freeze({ id: 'gans.docs.result.build', labelKey: 'guestADocsBuildNext', labelFallback: 'Yes — build me an application', next: 'helloworld.stack' }),
      Object.freeze({ id: 'gans.docs.result.stop', labelKey: 'guestADocsStop', labelFallback: 'No, that was enough' }),
    ]),
  }),

  // Customisation runs after the first deploy, so "the agent allows & prompts for
  // customisation" is a scripted branch rather than a free-text invitation.
  'customise.accent': Object.freeze({
    id: 'customise.accent',
    questionKey: 'guestQCustomiseAccent',
    questionFallback: 'Your site is live. Change the accent colour?',
    answers: Object.freeze([
      Object.freeze({ id: 'gans.customise.accent.emerald', labelKey: 'guestAAccentEmerald', labelFallback: 'Emerald', variant: Object.freeze({ accent: 'emerald' }), next: 'customise.feature', redeploy: true }),
      Object.freeze({ id: 'gans.customise.accent.amber', labelKey: 'guestAAccentAmber', labelFallback: 'Amber', variant: Object.freeze({ accent: 'amber' }), next: 'customise.feature', redeploy: true }),
      Object.freeze({ id: 'gans.customise.accent.keep', labelKey: 'guestAAccentKeep', labelFallback: 'Keep it as it is', next: 'customise.feature' }),
    ]),
  }),
  'customise.feature': Object.freeze({
    id: 'customise.feature',
    questionKey: 'guestQCustomiseFeature',
    questionFallback: 'Add one more thing before you go?',
    answers: Object.freeze([
      Object.freeze({ id: 'gans.customise.feature.page', labelKey: 'guestAFeaturePage', labelFallback: 'A second page', variant: Object.freeze({ extra: 'page' }), next: 'customise.done', redeploy: true }),
      Object.freeze({ id: 'gans.customise.feature.footer', labelKey: 'guestAFeatureFooter', labelFallback: 'A footer with contact details', variant: Object.freeze({ extra: 'footer' }), next: 'customise.done', redeploy: true }),
      Object.freeze({ id: 'gans.customise.feature.none', labelKey: 'guestAFeatureNone', labelFallback: 'Nothing else' }),
    ]),
  }),
  'customise.done': Object.freeze({
    id: 'customise.done',
    questionKey: 'guestQCustomiseDone',
    questionFallback: 'Anything else?',
    answers: Object.freeze([
      Object.freeze({ id: 'gans.customise.done.restart', labelKey: 'guestADoneRestart', labelFallback: 'Start another demo session', next: RESTART }),
      Object.freeze({ id: 'gans.customise.done.stop', labelKey: 'guestADoneStop', labelFallback: 'No, I am done' }),
    ]),
  }),
});

/**
 * The scripted demo run. `crset` is the only step that produces an artifact, and
 * the runner renders it with the real kagent renderer — nothing is applied to a
 * cluster, which is why the SPA labels the block "simulated preview".
 */
const FLOWS = Object.freeze({
  'deploy.webapp': Object.freeze({
    id: 'deploy.webapp',
    steps: Object.freeze([
      Object.freeze({ id: 'plan', labelKey: 'guestDemoStepPlan', labelFallback: 'Plan the build' }),
      Object.freeze({ id: 'skill', labelKey: 'guestDemoStepSkill', labelFallback: 'Mount the demo skill' }),
      Object.freeze({ id: 'crset', labelKey: 'guestDemoStepCrset', labelFallback: 'Render the kagent agent', artifacts: true }),
      Object.freeze({ id: 'deploy', labelKey: 'guestDemoStepDeploy', labelFallback: 'Deploy as a webapp' }),
      Object.freeze({ id: 'live-url', labelKey: 'guestDemoStepLiveUrl', labelFallback: 'Preview URL is live for {days} day' }),
    ]),
    then: 'customise.accent',
  }),
});

const TEMPLATES = Object.freeze(['helloworld', 'tic-tac-toe', 'clone-storefront', 'clone-saas-landing', 'clone-docs-site']);

/** The reverse-engineer targets, addressable without walking the question tree. */
const TARGETS = Object.freeze(['gtarget.storefront', 'gtarget.saas-landing', 'gtarget.docs-site']);

/**
 * Copy the server owns, so the endpoint and the page can never disagree about
 * what a guest is being told. Rendered in the hero, the composer and the footer.
 */
const NOTICE = Object.freeze({
  restrictedKey: 'guestRestrictedNotice',
  restricted: 'Restricted access: you are browsing as a guest. Pick from the options below — free text, tenant data and agent runs need an account.',
  retrievabilityKey: 'guestDataNotRetrievable',
  retrievability: 'Guest conversations are not tied to an account and cannot be retrieved later. Sign in to keep your history.',
  retentionKey: 'guestPreviewExpiryNotice',
  // `{days}` is filled by the caller from the configured retention, because a
  // sentence that hard-codes "1 day" starts lying the moment an operator moves
  // GUEST_DEMO_PREVIEW_TTL_MS.
  retention: 'Each demo session and the site it generates stay available for {days} day, then are deleted.',
  signInKey: 'guestSignInCta',
  signIn: 'Sign in for the full experience',
});

const GUEST_DEMO = Object.freeze({
  schema: 'guest-demo/v1',
  version: '1',
  agent: AGENT,
  cliKey: CLI_KEY,
  commands: COMMANDS,
  nodes: NODES,
  flows: FLOWS,
  templates: TEMPLATES,
  targets: TARGETS,
  notice: NOTICE,
  // The turn the visitor sees when a command is accepted — the server's own echo,
  // so the transcript never shows text the visitor did not click.
  echoKey: 'guestCommandEcho',
  echo: 'Got it — here is what I can set up.',
});

function isGuestId(value) {
  return typeof value === 'string' && ID_SHAPE.test(value);
}

function findGuestCommand(commandId) {
  if (!isGuestId(commandId)) return null;
  return COMMANDS.find((command) => command.id === commandId) || null;
}

function findGuestNode(nodeId) {
  if (!isGuestId(nodeId)) return null;
  return NODES[nodeId] || null;
}

function findGuestAnswer(node, answerId) {
  if (!node || !isGuestId(answerId)) return null;
  return node.answers.find((answer) => answer.id === answerId) || null;
}

function findGuestFlow(flowId) {
  if (!isGuestId(flowId)) return null;
  return FLOWS[flowId] || null;
}

/**
 * Resolve whatever an answer points at — a follow-up question, a scripted flow, or
 * nothing (terminal). The returned DTO is what the SPA renders; `redeploy` and
 * `query` travel with it so the client never has to infer a behaviour.
 */
function resolveNext(target) {
  const flow = findGuestFlow(target);
  if (flow) {
    return Object.freeze({
      kind: 'flow',
      id: flow.id,
      steps: Object.freeze(flow.steps.map((step) => Object.freeze({ id: step.id, label: step.labelFallback, labelKey: step.labelKey, artifacts: Boolean(step.artifacts) }))),
      then: flow.then || null,
    });
  }
  const node = findGuestNode(target);
  if (node) {
    return Object.freeze({
      kind: 'question',
      id: node.id,
      question: node.questionFallback,
      questionKey: node.questionKey,
      answers: Object.freeze(node.answers.map((answer) => Object.freeze({ id: answer.id, label: answer.labelFallback, labelKey: answer.labelKey, redeploy: Boolean(answer.redeploy), query: answer.query || null }))),
    });
  }
  return null;
}

/** Locale-independent summaries for `GET /api/guest/demo/commands`. */
function guestCommandSummaries() {
  return COMMANDS.map(({ id, labelFallback, labelKey }) => Object.freeze({ id, label: labelFallback, labelKey }));
}

/**
 * The tree is data, and data rots quietly: a `next` that names nothing leaves a
 * visitor stuck behind a button that does nothing, and a duplicate id makes
 * `findGuestAnswer` return the wrong branch. Checked here rather than discovered
 * in a browser.
 *
 * Resolution goes through the passed `catalog`, never the module constants, so a
 * caller can validate a modified copy — which is what a test of a broken tree
 * needs, and what a stale index would otherwise hide.
 */
function assertCatalogIntegrity(catalog = GUEST_DEMO) {
  const problems = [];
  const seenAnswers = new Set();
  const nodeIn = (id) => (isGuestId(id) && catalog.nodes[id]) || null;
  const flowIn = (id) => (isGuestId(id) && catalog.flows[id]) || null;

  for (const command of catalog.commands) {
    if (!isGuestId(command.id)) problems.push(`command id "${command.id}" is not a valid guest id`);
    if (command.labelFallback.length > LABEL_MAX) problems.push(`command ${command.id} label exceeds ${LABEL_MAX} chars`);
    if (command.entryNode && !nodeIn(command.entryNode)) problems.push(`command ${command.id} entryNode "${command.entryNode}" does not resolve`);
    if (command.template && !catalog.templates.includes(command.template)) problems.push(`command ${command.id} template "${command.template}" is not a known bundle`);
  }

  for (const node of Object.values(catalog.nodes)) {
    if (!node.answers.length) problems.push(`node ${node.id} offers no answers`);
    if (node.questionFallback.length > QUESTION_MAX) problems.push(`node ${node.id} question exceeds ${QUESTION_MAX} chars`);
    for (const answer of node.answers) {
      if (!isGuestId(answer.id)) problems.push(`answer id "${answer.id}" is not a valid guest id`);
      if (seenAnswers.has(answer.id)) problems.push(`answer id "${answer.id}" is not unique`);
      seenAnswers.add(answer.id);
      if (answer.labelFallback.length > LABEL_MAX) problems.push(`answer ${answer.id} label exceeds ${LABEL_MAX} chars`);
      if (answer.template && !catalog.templates.includes(answer.template)) problems.push(`answer ${answer.id} template "${answer.template}" is not a known bundle`);
      if (answer.next && answer.next !== RESTART && !nodeIn(answer.next) && !flowIn(answer.next)) {
        problems.push(`answer ${answer.id} next "${answer.next}" does not resolve`);
      }
    }
  }

  for (const flow of Object.values(catalog.flows)) {
    if (!flow.steps.length) problems.push(`flow ${flow.id} has no steps`);
    if (flow.then && !nodeIn(flow.then)) problems.push(`flow ${flow.id} then "${flow.then}" does not resolve`);
    if (!flow.steps.some((step) => step.id === 'deploy')) problems.push(`flow ${flow.id} never reaches the deploy step`);
  }

  for (const target of catalog.targets) {
    if (!seenAnswers.has(target)) problems.push(`target "${target}" is not an answer any node offers`);
  }

  // The deploy step is the promise the whole demo makes; if its label ever loses
  // the words, the flow no longer demonstrates what it claims to.
  const deployStep = (catalog.flows['deploy.webapp'] || { steps: [] }).steps.find((step) => step.id === 'deploy');
  if (!deployStep || !/deploy as a webapp/i.test(deployStep.labelFallback)) {
    problems.push('the deploy step no longer says "Deploy as a webapp"');
  }

  // buildSkillCrSet asserts its own names, but failing at request time for a
  // mistake made in this file is a worse diagnosis than failing here.
  if (!K8S_NAME_SHAPE.test(catalog.agent.id) || catalog.agent.id.length > K8S_NAME_MAX) {
    problems.push(`agent id "${catalog.agent.id}" is not a valid Kubernetes name`);
  }

  if (problems.length) throw new Error(`guest demo catalogue is broken:\n  ${problems.join('\n  ')}`);
  return true;
}

assertCatalogIntegrity();

module.exports = {
  GUEST_DEMO,
  RESTART,
  TEMPLATES,
  ID_SHAPE,
  LABEL_MAX,
  QUESTION_MAX,
  isGuestId,
  findGuestCommand,
  findGuestNode,
  findGuestAnswer,
  findGuestFlow,
  resolveNext,
  guestCommandSummaries,
  assertCatalogIntegrity,
};
