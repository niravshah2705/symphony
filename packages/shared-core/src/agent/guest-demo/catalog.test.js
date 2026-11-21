'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GUEST_DEMO,
  RESTART,
  ID_SHAPE,
  isGuestId,
  findGuestCommand,
  findGuestNode,
  findGuestAnswer,
  findGuestFlow,
  resolveNext,
  guestCommandSummaries,
  assertCatalogIntegrity,
} = require('./catalog.js');

test('the shipped catalogue passes its own integrity check', () => {
  assert.equal(assertCatalogIntegrity(), true);
});

test('every command resolves to a real entry node, and the four starters are the promised ones', () => {
  assert.deepEqual(
    GUEST_DEMO.commands.map((command) => command.id),
    ['gcmd.helloworld', 'gcmd.tictactoe', 'gcmd.reverse-engineer', 'gcmd.docs-search'],
  );
  for (const command of GUEST_DEMO.commands) {
    const node = findGuestNode(command.entryNode);
    assert.ok(node, `${command.id} entryNode does not resolve`);
    assert.ok(node.answers.length, `${command.id} starts on a node with no clickable answers`);
    if (command.template) assert.ok(GUEST_DEMO.templates.includes(command.template));
  }
});

test('the flow reaches a deploy step that says "Deploy as a webapp"', () => {
  const flow = findGuestFlow('deploy.webapp');
  assert.ok(flow);
  const deploy = flow.steps.find((step) => step.id === 'deploy');
  assert.match(deploy.labelFallback, /^Deploy as a webapp$/);
  assert.equal(flow.steps.filter((step) => step.artifacts).length, 1);
  assert.equal(flow.steps.at(-1).id, 'live-url');
  assert.ok(findGuestNode(flow.then));
});

test('every answer target resolves, and the tree terminates', () => {
  for (const node of Object.values(GUEST_DEMO.nodes)) {
    for (const answer of node.answers) {
      if (!answer.next || answer.next === RESTART) continue;
      assert.ok(findGuestNode(answer.next) || findGuestFlow(answer.next), `${answer.id} -> ${answer.next}`);
    }
  }
  // Two answers with no `next` end a session; if they ever grow one, the loop
  // below catches the accidental cycle instead of a browser hanging on it.
  const terminal = Object.values(GUEST_DEMO.nodes).flatMap((n) => n.answers).filter((a) => !a.next);
  assert.ok(terminal.length >= 2, 'no answer can end the conversation');
});

test('answer ids are unique across the whole tree', () => {
  const ids = Object.values(GUEST_DEMO.nodes).flatMap((node) => node.answers.map((answer) => answer.id));
  assert.equal(new Set(ids).size, ids.length);
});

test('templates named by commands and answers all exist', () => {
  const answerIds = Object.values(GUEST_DEMO.nodes).flatMap((node) => node.answers.map((answer) => answer.id));
  for (const command of GUEST_DEMO.commands) {
    if (command.template) assert.ok(GUEST_DEMO.templates.includes(command.template));
  }
  for (const node of Object.values(GUEST_DEMO.nodes)) {
    for (const answer of node.answers) {
      if (answer.template) assert.ok(GUEST_DEMO.templates.includes(answer.template), `${answer.id} names an unknown bundle`);
    }
  }
  // A target the tree cannot offer would be a list item that resolves to nothing.
  for (const target of GUEST_DEMO.targets) assert.ok(answerIds.includes(target));
});

test('ids are the strict guest shape, and anything else is refused before lookup', () => {
  for (const bad of ['../etc/passwd', 'GCMD.HELLOWORLD', 'gcmd helloworld', '', 'x'.repeat(80), null, undefined, 7, { id: 'gcmd.helloworld' }]) {
    assert.equal(isGuestId(bad), false, `${String(bad)} should not be a guest id`);
    assert.equal(findGuestCommand(bad), null);
    assert.equal(findGuestNode(bad), null);
    assert.equal(findGuestFlow(bad), null);
  }
  assert.equal(ID_SHAPE.test(findGuestCommand('gcmd.helloworld').entryNode), true);
  assert.equal(findGuestAnswer(findGuestNode('docs.topic'), 'gans.helloworld.stack.node'), null);
});

test('resolveNext returns the DTO the SPA renders, not the raw catalogue row', () => {
  const question = resolveNext('helloworld.stack');
  assert.equal(question.kind, 'question');
  assert.deepEqual(Object.keys(question.answers[0]).sort(), ['id', 'label', 'labelKey', 'query', 'redeploy']);
  assert.equal(question.answers[0].label, 'Node.js');
  assert.equal(question.answers[0].variant, undefined, 'a variant must not leak to the client');

  const flow = resolveNext('deploy.webapp');
  assert.equal(flow.kind, 'flow');
  assert.deepEqual(flow.steps[0], { id: 'plan', label: 'Plan the build', labelKey: 'guestDemoStepPlan', artifacts: false });
  assert.equal(flow.then, 'customise.accent');

  assert.equal(resolveNext('gans.docs.topic.adlc'), null);
  assert.equal(resolveNext(RESTART), null);
});

test('a documentation answer carries the server-supplied query', () => {
  const node = findGuestNode('docs.topic');
  const answer = findGuestAnswer(node, 'gans.docs.topic.adlc');
  assert.equal(answer.query, 'Agentic Development Life Cycle overview');
  assert.equal(resolveNext('docs.topic').answers[0].query, answer.query);
  assert.equal(findGuestAnswer(node, 'gans.helloworld.stack.node'), null);
});

test('nothing in the catalogue carries a URL, a model, a worker pool or an org', () => {
  const text = JSON.stringify(GUEST_DEMO);
  for (const forbidden of ['workerPool', 'atespace', 'org_id', 'orgId', 'model', 'apiKey', 'http://']) {
    assert.ok(!text.includes(forbidden), `catalogue mentions "${forbidden}"`);
  }
  // The reverse-engineer command has no target field at all: the only sites it
  // can take apart are the enumerated first-party templates.
  const reverse = findGuestCommand('gcmd.reverse-engineer');
  assert.equal(reverse.url, undefined);
  assert.equal(reverse.target, undefined);
});

test('command summaries are id + copy only, for the public commands endpoint', () => {
  const summaries = guestCommandSummaries();
  assert.equal(summaries.length, GUEST_DEMO.commands.length);
  for (const summary of summaries) {
    assert.deepEqual(Object.keys(summary).sort(), ['id', 'label', 'labelKey']);
  }
});

test('a broken tree fails loudly instead of silently offering a dead button', () => {
  const broken = structuredClone(GUEST_DEMO);
  broken.nodes['helloworld.stack'].answers[0].next = 'helloworld.nowhere';
  broken.commands[0].entryNode = 'nope.node';
  broken.flows['deploy.webapp'].steps[3].labelFallback = 'Ship it';
  broken.nodes['tictactoe.theme'].answers[1].id = broken.nodes['tictactoe.theme'].answers[0].id;
  assert.throws(() => assertCatalogIntegrity(broken), (error) => {
    assert.match(error.message, /helloworld\.nowhere" does not resolve/);
    assert.match(error.message, /nope\.node" does not resolve/);
    assert.match(error.message, /Deploy as a webapp/);
    assert.match(error.message, /gans\.tictactoe\.theme\.classic" is not unique/);
    return true;
  });
});

test('the agent record is shaped for buildSkillCrSet', () => {
  const agent = GUEST_DEMO.agent;
  assert.equal(agent.id, 'guest-webapp-demo');
  assert.match(agent.id, /^[a-z]([-a-z0-9]*[a-z0-9])?$/);
  assert.ok(agent.id.length <= 63);
  assert.equal(agent.harnesses[GUEST_DEMO.cliKey].engine, 'kagent');
  assert.equal(agent.harnesses.kagent.status, 'supported');
  assert.equal(agent.harnesses.kagent.mcp, false, 'a standalone skill must not declare an mcp.json');
  assert.equal(agent.upstream.commit.length, 40);
  assert.equal(agent.artifact.skillPath, 'skills/guest-webapp-demo');
});
