const MAX_INPUT = 8_000;

const ROUTE_DEFINITIONS = Object.freeze({
  salutation: {
    label: 'Greeting',
    title: 'Good to see you.',
    answer: 'Hello! I’m ready. Ask a question or tell me what you want to move forward.',
  },
  knowledge: {
    label: 'Knowledge search',
    title: 'Searching workspace knowledge',
    answer: 'I checked connected business memory, projects, and recent workspace activity for relevant details.',
  },
  unsafe: {
    label: 'Protected route',
    title: 'I can’t help with that request.',
    answer: 'I can’t help create sexual exploitation, scams, fraud, or deceptive content. This workspace is for lawful work that grows durable businesses and improves people’s lives. I can help reshape the request into a safe, legitimate goal.',
  },
  business: {
    label: 'Business workflow',
    title: 'Business workflow prepared',
    answer: 'I ran the request through the fraud gate, mapped the revenue signals, prepared business memory and architecture, and broke the work into scheduler-ready segments.',
  },
  build: {
    label: 'Build request',
    title: 'Let’s build that.',
    answer: 'I’ll help set up the project and hand it to the planner. Confirm each step below.',
  },
  troubleshooting: {
    label: 'Troubleshooting',
    title: 'Checking diagnostics and logs',
    answer: 'I checked live readiness signals and recent run logs, then pulled the most useful next action into the side panel.',
  },
  implementation: {
    label: 'Project task',
    title: 'Implementation task drafted',
    answer: 'I turned the requested implementation change into a project-task draft. Review the project and task details in the side panel before creating it.',
  },
  general: {
    label: 'Thinker route',
    title: 'I’ve organized the request.',
    answer: 'I clarified the outcome and prepared a practical next move with the configured thinking model.',
  },
});

const STOP_WORDS = new Set([
  'about', 'after', 'also', 'and', 'are', 'can', 'check', 'find', 'for', 'from', 'have',
  'into', 'look', 'our', 'please', 'search', 'show', 'that', 'the', 'their', 'this', 'what',
  'when', 'where', 'which', 'with', 'workspace', 'would', 'your',
]);

function cleanInput(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_INPUT);
}

function route(intent, input, confidence) {
  const definition = ROUTE_DEFINITIONS[intent];
  return { intent, input, confidence, ...definition };
}

export function classifyOmniboxIntent(value) {
  const input = cleanInput(value);
  const lower = input.toLowerCase();
  if (!input) return route('general', input, 0);

  const scamAction = /\b(?:help|how|write|create|make|run|launch|send|build|teach|show)\b.{0,70}\b(?:scam|phish(?:ing)?|fake invoice|ponzi|carding|identity theft|money laundering|steal|defraud|impersonat(?:e|ion))\b/i;
  const scamIntent = /\b(?:i want to|let'?s|can i|give me a way to)\b.{0,50}\b(?:scam|phish|defraud|steal|launder|impersonate)\b/i;
  const directFraud = /\b(?:steal (?:money|cards?|credentials)|launder money|bypass fraud checks?|clone credit cards?)\b/i;
  const explicitSexual = /\b(?:create|generate|write|show|send|sell|promote|give me|i want|find me|where can i)\b.{0,60}\b(?:porn(?:ographic)?|explicit sexual|sexual exploitation|nudes?|escort scam)\b/i;
  const defensiveFraud = /\b(?:prevent|detect|recognize|report|avoid|protect|anti-fraud|fraud prevention|is this|check whether|could this be)\b/i;
  if (((scamAction.test(input) || scamIntent.test(input)) && !defensiveFraud.test(input)) || directFraud.test(input) || explicitSexual.test(input)) {
    return route('unsafe', input, 0.99);
  }

  if (input.length <= 80 && /^(?:hi|hello|hey|good (?:morning|afternoon|evening)|namaste|howdy|greetings)[!.?\s]*$/i.test(input)) {
    return route('salutation', input, 0.99);
  }

  const changeVerb = /\b(?:modify|change|update|fix|refactor|implement|remove|replace|rename|add|redesign|adjust)\b/i;
  const implementationNoun = /\b(?:implementation|code|component|screen|page|api|endpoint|function|module|database|schema|button|form|layout|workflow|feature|file|repository|repo|ui)\b/i;
  if (changeVerb.test(input) && implementationNoun.test(input)) {
    return route('implementation', input, 0.92);
  }

  if (/\b(?:troubleshoot|debug|diagnos(?:e|is|tic)|logs?|stack trace|exception|error|failed|failure|not working|service down|timeout|latency|crash(?:ed|ing)?)\b/i.test(input)) {
    return route('troubleshooting', input, 0.94);
  }

  if (/\b(?:rag|document(?:s|ation)?|docs|knowledge base|memory|remember|workspace history|search (?:for|my|our|the)|look up|find (?:in|my|our))\b/i.test(input)) {
    return route('knowledge', input, 0.9);
  }

  if (/\b(?:create|build|make|develop|design|prototype|scaffold|architect|spin up|stand up|kick off|start building)\b/i.test(input)
    && /\b(?:software|apps?|application|web ?app|website|platform|tool|system|service|product|saas|mvp|prototype|bot|assistant|dashboard|marketplace|portal|extension|plugin)\b/i.test(input)) {
    return route('build', input, 0.9);
  }

  if (/\b(?:business|startup|revenue|moneti[sz]e|pricing|sales|customer|market|go-to-market|growth|profit|margin|subscription|business model|launch|founder|venture|product idea)\b/i.test(input)) {
    return route('business', input, 0.9);
  }

  return route('general', input, 0.58);
}

function firstText(values, fallback = '') {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return cleanInput(value[0]);
    if (typeof value === 'string' && value.trim()) return cleanInput(value);
  }
  return fallback;
}

function textList(value) {
  if (!Array.isArray(value)) return value ? [cleanInput(value)] : [];
  return value.map((item) => cleanInput(typeof item === 'string' ? item : item && (item.text || item.label || item.question))).filter(Boolean);
}

function revenueModel(input) {
  if (/\b(?:subscription|saas|monthly|annual|membership)\b/i.test(input)) return 'Recurring subscription · track MRR and churn';
  if (/\b(?:marketplace|commission|transaction|booking)\b/i.test(input)) return 'Transaction fee · track GMV and take rate';
  if (/\b(?:service|consulting|agency)\b/i.test(input)) return 'Service revenue · track utilization and gross margin';
  if (/\b(?:shop|store|e-?commerce|retail|product sales?)\b/i.test(input)) return 'Product margin · track AOV and repeat purchase';
  return 'Pricing model is an open decision';
}

function fraudAssessment(input) {
  const high = /\b(?:guaranteed returns?|risk[- ]free profit|pyramid|ponzi|fake reviews?|fake invoice|impersonat(?:e|ion)|stolen|phish|launder|bypass verification)\b/i.test(input);
  const medium = /\b(?:crypto|investment|lending|cash advance|affiliate|reseller|dropship|lead generation|commission-only|prepay|upfront fee)\b/i.test(input);
  if (high) return { level: 'high', score: 82, tone: 'red', label: 'High-risk signals', summary: 'Potential deception or unrealistic claims need resolution before any planning continues.' };
  if (medium) return { level: 'review', score: 46, tone: 'amber', label: 'Manual review', summary: 'The model can be legitimate, but claims, consent, payments, and counterparties need verification.' };
  return { level: 'low', score: 18, tone: 'green', label: 'No obvious fraud pattern', summary: 'No common fraud pattern is visible in the request. Validate identity, claims, consent, and payment flows during discovery.' };
}

export function buildBusinessWorkspace(value, enrichment = {}) {
  const input = cleanInput(value);
  const source = enrichment && (enrichment.enrichment || enrichment.analysis || enrichment.result || enrichment);
  const goal = firstText([source.goal, source.outcome, source.goals, source.summary], input);
  const audience = firstText([source.audience, source.customer, source.targetUsers], 'Primary customer is still an open decision');
  const constraints = textList(source.constraints);
  const assumptions = textList(source.assumptions);
  const nextSteps = textList(source.nextSteps || source.suggestedNextSteps || source.recommendations);
  const fraud = fraudAssessment(input);
  const segments = [
    ...nextSteps,
    'Define the smallest measurable customer outcome',
    'Instrument revenue and retention signals',
    'Design the first decision-ready workflow',
    'Schedule buildable implementation tasks',
  ].filter((step, index, list) => step && list.indexOf(step) === index).slice(0, 5);

  return {
    goal,
    fraud,
    metrics: [
      { tone: 'green', label: 'Revenue path', value: revenueModel(input), meta: 'MRR = customers × average revenue' },
      { tone: 'amber', label: 'Unit economics', value: 'Needs CAC + margin inputs', meta: 'Payback = CAC ÷ monthly gross profit' },
      { tone: 'red', label: 'Fraud exposure', value: `${fraud.score} / 100 · ${fraud.label}`, meta: 'Identity · claims · consent · payments' },
      { tone: 'blue', label: 'Growth signal', value: 'Activation → retained use', meta: 'Track conversion by customer cohort' },
    ],
    memory: [
      ['Outcome', goal],
      ['Customer', audience],
      ['Revenue', revenueModel(input)],
      ['Constraints', constraints.join(' · ') || 'No explicit constraints captured'],
      ['Assumptions', assumptions.join(' · ') || 'Validate demand, willingness to pay, and delivery cost'],
    ],
    architecture: [
      { id: 'request', label: 'Omnibox', meta: 'Intent + context' },
      { id: 'gate', label: 'Fraud gate', meta: 'Risk before work' },
      { id: 'memory', label: 'Business memory', meta: 'Durable decisions' },
      { id: 'thinker', label: 'Thinker + spec', meta: 'Small segments' },
      { id: 'design', label: 'UI design', meta: 'Side-panel brief' },
      { id: 'scheduler', label: 'Task scheduler', meta: 'Ready to queue' },
    ],
    segments,
    design: {
      name: 'Outcome cockpit',
      summary: 'A focused decision surface that keeps the customer outcome primary and moves evidence, actions, and risk into supporting layers.',
      primary: 'Validate the customer outcome',
      secondary: 'Review evidence and assumptions',
    },
    stages: [
      { label: 'Fraud check', status: fraud.level === 'high' ? 'blocked' : 'done' },
      { label: 'Revenue metrics', status: 'done' },
      { label: 'Business memory', status: 'done' },
      { label: 'Thinker + specs', status: 'done' },
      { label: 'UI design', status: 'done' },
      { label: 'Task scheduler', status: fraud.level === 'high' ? 'blocked' : 'ready' },
    ],
  };
}

function taskTitle(input) {
  const stripped = input
    .replace(/^(?:please\s+|can you\s+|could you\s+|i want (?:you )?to\s+)/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const title = (stripped || 'Review requested implementation change').slice(0, 110).replace(/[.!?]+$/, '');
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export function buildImplementationTask(value) {
  const input = cleanInput(value);
  return {
    title: taskTitle(input),
    description: [
      'Requested from the Agent workspace omnibox.',
      '',
      `**Request**\n${input}`,
      '',
      '**Acceptance criteria**',
      '- The requested behavior is implemented in the scoped component or module',
      '- Existing behavior outside the requested scope remains unchanged',
      '- Relevant automated tests cover the changed behavior',
      '- The implementation passes the project validation commands',
    ].join('\n'),
    priority: 2,
  };
}

function searchTerms(query) {
  return [...new Set(cleanInput(query).toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) || [])]
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term))
    .slice(0, 16);
}

function matchScore(text, terms) {
  const haystack = cleanInput(text).toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

export function searchWorkspaceMemory(query, sources = {}) {
  const terms = searchTerms(query);
  const records = [];
  for (const document of sources.documents || []) {
    records.push({
      type: 'Workspace document',
      title: document.title || document.path || 'Untitled document',
      summary: document.snippet || 'Matched workspace documentation',
      status: document.path || 'Connected document',
      href: '#/agent',
    });
  }
  for (const business of sources.businesses || []) {
    records.push({
      type: 'Business memory',
      title: business.name || 'Untitled business',
      summary: business.description || 'Linked business record',
      status: business.project ? business.project.name : business.status || 'Saved',
      href: '#/business',
    });
  }
  for (const project of sources.projects || []) {
    records.push({
      type: 'Project document',
      title: project.name || 'Untitled project',
      summary: project.description || project.content || 'Workspace project',
      status: project.state || `${Math.round(Number(project.progress || 0) * 100)}% complete`,
      href: project.id ? `#/projects/${project.id}` : '#/projects',
    });
  }
  for (const job of sources.jobs || []) {
    const steps = (job.steps || []).map((step) => step.message).filter(Boolean).join(' · ');
    records.push({
      type: 'Workspace history',
      title: job.projectName || job.taskTitle || job.taskIdentifier || 'Agent run',
      summary: firstText([job.error, typeof job.summary === 'string' ? job.summary : '', steps], 'Recorded agent activity'),
      status: job.status || 'Recorded',
      href: '#/agent-jobs',
    });
  }
  return records
    .map((record, index) => ({ ...record, score: matchScore(`${record.title} ${record.summary} ${record.status}`, terms), index }))
    .filter((record) => !terms.length || record.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 8)
    .map(({ index, ...record }) => record);
}

export function summarizeTroubleshooting(diagnostics = {}, jobs = []) {
  const checks = Array.isArray(diagnostics.checks) ? diagnostics.checks : [];
  const statusOf = (value) => {
    const status = String(value || '').toLowerCase();
    if (['error', 'failed', 'unavailable'].includes(status)) return 'error';
    if (['warn', 'warning', 'attention', 'not-configured'].includes(status)) return 'warning';
    return 'ok';
  };
  const counts = checks.reduce((total, check) => {
    total[statusOf(check.status)] += 1;
    return total;
  }, { ok: 0, warning: 0, error: 0 });
  const signals = [];
  for (const job of jobs || []) {
    if (job.error) signals.push({ level: 'error', source: job.projectName || job.taskIdentifier || 'Agent run', message: job.error, ts: job.finishedAt || job.updatedAt });
    for (const step of job.steps || []) {
      if (['warn', 'warning', 'error'].includes(String(step.level || '').toLowerCase())) {
        signals.push({ level: String(step.level).toLowerCase(), source: job.projectName || job.taskIdentifier || 'Agent run', message: step.message, ts: step.ts });
      }
    }
  }
  signals.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return {
    checks,
    counts,
    signals: signals.slice(0, 6),
    headline: counts.error
      ? `${counts.error} readiness check${counts.error === 1 ? '' : 's'} blocked`
      : counts.warning
        ? `${counts.warning} item${counts.warning === 1 ? '' : 's'} need attention`
        : 'Essential services look ready',
  };
}

export { ROUTE_DEFINITIONS };
