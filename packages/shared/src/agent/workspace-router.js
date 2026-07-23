'use strict';

const MAX_INPUT_CHARS = 8_000;

const ROUTES = Object.freeze({
  salutation: Object.freeze({
    label: 'Greeting',
    title: 'Good to see you.',
    answer: 'Hello! I’m ready. Ask a question or tell me what you want to move forward.',
  }),
  knowledge: Object.freeze({
    label: 'Knowledge search',
    title: 'Searching workspace knowledge',
    answer: 'I checked connected business memory, projects, and recent workspace activity for relevant details.',
  }),
  unsafe: Object.freeze({
    label: 'Protected route',
    title: 'I can’t help with that request.',
    answer: 'I can’t help create sexual exploitation, scams, fraud, or deceptive content. This workspace is for lawful work that grows durable businesses and improves people’s lives. I can help reshape the request into a safe, legitimate goal.',
  }),
  business: Object.freeze({
    label: 'Business workflow',
    title: 'Business workflow prepared',
    answer: 'I ran the request through the fraud gate, mapped the revenue signals, prepared business memory and architecture, and broke the work into scheduler-ready segments.',
  }),
  build: Object.freeze({
    label: 'Build request',
    title: 'Let’s build that.',
    answer: 'I’ll help set up the project and hand it to the planner. Confirm each step below.',
  }),
  troubleshooting: Object.freeze({
    label: 'Troubleshooting',
    title: 'Checking diagnostics and logs',
    answer: 'I checked live readiness signals and recent run logs, then pulled the most useful next action into the side panel.',
  }),
  implementation: Object.freeze({
    label: 'Project task',
    title: 'Implementation task drafted',
    answer: 'I turned the requested implementation change into a project-task draft. Review the project and task details in the side panel before creating it.',
  }),
  general: Object.freeze({
    label: 'Thinker route',
    title: 'I’ve organized the request.',
    answer: 'I clarified the outcome and prepared a practical next move with the configured thinking model.',
  }),
});

class WorkspaceRouterError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'WorkspaceRouterError';
    this.status = status;
  }
}

function normalizeMessage(value) {
  if (typeof value !== 'string') throw new WorkspaceRouterError('input must be a string.');
  const input = value.replace(/\s+/g, ' ').trim();
  if (!input) throw new WorkspaceRouterError('Describe what you want to ask or do.');
  if (input.length > MAX_INPUT_CHARS) throw new WorkspaceRouterError(`input must be ${MAX_INPUT_CHARS.toLocaleString()} characters or fewer.`);
  return input;
}

function result(intent, input, confidence) {
  return { intent, input, confidence, ...ROUTES[intent] };
}

/**
 * Deterministic policy-and-intent gate. It deliberately runs before retrieval,
 * models, tools, diagnostics, or mutations. Defensive fraud questions remain
 * allowed; only requests that ask the agent to facilitate abuse are rejected.
 */
function classifyIntent(value) {
  const input = normalizeMessage(value);
  const scamAction = /\b(?:help|how|write|create|make|run|launch|send|build|teach|show)\b.{0,70}\b(?:scam|phish(?:ing)?|fake invoice|ponzi|carding|identity theft|money laundering|steal|defraud|impersonat(?:e|ion))\b/i;
  const scamIntent = /\b(?:i want to|let'?s|can i|give me a way to)\b.{0,50}\b(?:scam|phish|defraud|steal|launder|impersonate)\b/i;
  const directFraud = /\b(?:steal (?:money|cards?|credentials)|launder money|bypass fraud checks?|clone credit cards?)\b/i;
  const explicitSexual = /\b(?:create|generate|write|show|send|sell|promote|give me|i want|find me|where can i)\b.{0,60}\b(?:porn(?:ographic)?|explicit sexual|sexual exploitation|nudes?|escort scam)\b/i;
  const defensiveFraud = /\b(?:prevent|detect|recognize|report|avoid|protect|anti-fraud|fraud prevention|is this|check whether|could this be)\b/i;
  if (((scamAction.test(input) || scamIntent.test(input)) && !defensiveFraud.test(input)) || directFraud.test(input) || explicitSexual.test(input)) {
    return result('unsafe', input, 0.99);
  }

  if (input.length <= 80 && /^(?:hi|hello|hey|good (?:morning|afternoon|evening)|namaste|howdy|greetings)[!.?\s]*$/i.test(input)) {
    return result('salutation', input, 0.99);
  }

  const changeVerb = /\b(?:modify|change|update|fix|refactor|implement|remove|replace|rename|add|redesign|adjust)\b/i;
  const implementationNoun = /\b(?:implementation|code|component|screen|page|api|endpoint|function|module|database|schema|button|form|layout|workflow|feature|file|repository|repo|ui)\b/i;
  if (changeVerb.test(input) && implementationNoun.test(input)) {
    return result('implementation', input, 0.92);
  }

  if (/\b(?:troubleshoot|debug|diagnos(?:e|is|tic)|logs?|stack trace|exception|error|failed|failure|not working|service down|timeout|latency|crash(?:ed|ing)?)\b/i.test(input)) {
    return result('troubleshooting', input, 0.94);
  }

  if (/\b(?:rag|document(?:s|ation)?|docs|knowledge base|memory|remember|workspace history|search (?:for|my|our|the)|look up|find (?:in|my|our))\b/i.test(input)) {
    return result('knowledge', input, 0.9);
  }

  // A "build" request (create/build a product) precedes the business branch so
  // "Create X software" drives the guided project → planner flow rather than the
  // business-analysis flow. Both a build verb and a product noun are required.
  if (/\b(?:create|build|make|develop|design|prototype|scaffold|architect|spin up|stand up|kick off|start building)\b/i.test(input)
    && /\b(?:software|apps?|application|web ?app|website|platform|tool|system|service|product|saas|mvp|prototype|bot|assistant|dashboard|marketplace|portal|extension|plugin)\b/i.test(input)) {
    return result('build', input, 0.9);
  }

  if (/\b(?:business|startup|revenue|moneti[sz]e|pricing|sales|customer|market|go-to-market|growth|profit|margin|subscription|business model|launch|founder|venture|product idea)\b/i.test(input)) {
    return result('business', input, 0.9);
  }

  return result('general', input, 0.58);
}

module.exports = {
  MAX_INPUT_CHARS,
  ROUTES,
  WorkspaceRouterError,
  normalizeMessage,
  classifyIntent,
};
