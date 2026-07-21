import { api } from '../api.js';
import { el, clear, toast } from '../dom.js';

// Leave headroom for normalized timestamps/levels under the server's 50k trace budget.
const MAX_TRACE_CHARS = 45_000;
const EXAMPLE_TRACE = `2026-07-16T09:42:10.117Z request started route=/checkout
2026-07-16T09:42:10.144Z tool inventory.lookup started
2026-07-16T09:42:13.982Z tool inventory.lookup timeout after=3800ms attempt=1
2026-07-16T09:42:14.006Z tool inventory.lookup started attempt=2
2026-07-16T09:42:17.811Z tool inventory.lookup timeout after=3800ms attempt=2
2026-07-16T09:42:17.819Z fallback cache.lookup hit age=47m
2026-07-16T09:42:17.840Z request completed status=200 duration=7723ms`;

let lastAnalysis = null;

export async function renderTraces(view) {
  const stream = el('div', { class: 'conversation-stream', 'aria-live': 'polite' });
  const railBody = el('div', { id: 'trace-details-panel', class: 'rail-content', role: 'tabpanel', 'aria-labelledby': 'trace-details-tab' });
  const traceInput = el('textarea', {
    class: 'trace-input',
    rows: '12',
    maxlength: String(MAX_TRACE_CHARS),
    placeholder: 'Paste a trace, log excerpt, or JSON span export here…',
    'aria-label': 'Trace or log data',
  });
  const contextInput = el('input', {
    placeholder: 'Optional: what felt wrong? e.g. checkout was slow',
    maxlength: '500',
    'aria-label': 'What should the analysis focus on?',
  });
  const count = el('span', { class: 'composer-count' }, `0 / ${MAX_TRACE_CHARS.toLocaleString()}`);
  const analyze = el('button', { class: 'primary scenario-submit', type: 'button' }, 'Analyze with local model');
  const fileInput = el('input', {
    type: 'file',
    accept: '.json,.jsonl,.log,.txt,application/json,text/plain',
    hidden: 'hidden',
  });

  const setRail = (analysis = null) => {
    clear(railBody).append(
      el('div', { class: 'rail-intro' }, [
        el('span', { class: 'rail-intro-icon' }, '↗'),
        el('div', {}, [
          el('strong', {}, analysis ? 'Analysis details' : 'Private local analysis'),
          el('p', {}, analysis
            ? 'The technical evidence behind the plain-language answer.'
            : 'Trace text is sent only to the local model host configured in Settings.'),
        ]),
      ]),
      analysis ? detailRail(analysis) : emptyRail()
    );
  };

  const addWelcome = () => {
    stream.append(
      assistantMessage(
        'Let’s make sense of a difficult trace.',
        'Paste the part that looks suspicious. I’ll explain what likely happened in plain language and keep raw spans and model details tucked away.',
        [{ label: 'How this works', action: () => setRail(null) }]
      )
    );
    if (lastAnalysis) renderAnalysis(stream, lastAnalysis, setRail);
  };

  traceInput.addEventListener('input', () => {
    count.textContent = `${traceInput.value.length.toLocaleString()} / ${MAX_TRACE_CHARS.toLocaleString()}`;
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (file.size > 2_000_000) {
      toast('Choose a trace file smaller than 2 MB.', 'err');
      fileInput.value = '';
      return;
    }
    const text = await file.text();
    traceInput.value = text.slice(0, MAX_TRACE_CHARS);
    traceInput.dispatchEvent(new Event('input'));
    if (text.length > MAX_TRACE_CHARS) toast(`Loaded the first ${MAX_TRACE_CHARS.toLocaleString()} characters.`, 'ok');
  });

  analyze.addEventListener('click', async () => {
    const trace = traceInput.value.trim();
    if (!trace) return toast('Paste a trace or load an example first.', 'err');
    if (trace.length > MAX_TRACE_CHARS) return toast(`Trim the trace to ${MAX_TRACE_CHARS.toLocaleString()} characters.`, 'err');

    stream.append(userMessage(contextInput.value.trim() || 'Please explain what went wrong in this trace.'));
    const pending = assistantMessage('I’m following the trail…', 'Looking for the first meaningful failure and what it affected.');
    pending.classList.add('is-pending');
    stream.append(pending);
    pending.scrollIntoView({ behavior: 'smooth', block: 'end' });
    analyze.disabled = true;
    analyze.textContent = 'Analyzing…';
    try {
      // Let the server's bounded normalizer preserve compact JSON/OTLP exports
      // instead of silently dropping content after 100 client-side lines.
      const response = await api.analyzeTrace({
        trace,
        question: contextInput.value.trim(),
      });
      const analysis = normalizeAnalysis(response);
      lastAnalysis = analysis;
      pending.remove();
      renderAnalysis(stream, analysis, setRail);
      setRail(analysis);
    } catch (err) {
      pending.remove();
      stream.append(assistantMessage(
        'I couldn’t reach the local analyst.',
        err.message || 'Check the local model and try again.',
        [{ label: 'Open model settings', href: '#/settings' }],
        'error'
      ));
    } finally {
      analyze.disabled = false;
      analyze.textContent = 'Analyze with local model';
    }
  });

  const composer = el('div', { class: 'trace-composer' }, [
    el('div', { class: 'composer-kicker' }, [
      el('span', {}, 'Trace input'),
      el('span', { class: 'privacy-chip' }, 'Local-model route'),
    ]),
    contextInput,
    traceInput,
    el('div', { class: 'composer-actions' }, [
      el('button', { type: 'button', onclick: () => fileInput.click() }, 'Choose file'),
      el('button', {
        type: 'button',
        onclick: () => {
          traceInput.value = EXAMPLE_TRACE;
          contextInput.value = 'Why did this request take almost eight seconds?';
          traceInput.dispatchEvent(new Event('input'));
        },
      }, 'Use example'),
      count,
      el('span', { class: 'spacer' }),
      analyze,
      fileInput,
    ]),
  ]);

  clear(view).append(
    el('section', { class: 'scenario-workspace trace-workspace' }, [
      el('main', { class: 'scenario-reader' }, [
        el('div', { class: 'reader-toolbar' }, [
          el('div', { class: 'breadcrumbs' }, [el('span', {}, 'Observe'), el('span', {}, '›'), el('strong', {}, 'Trace analysis')]),
          el('span', { class: 'local-model-state' }, 'Runs on your local model'),
        ]),
        el('div', { class: 'conversation-wrap' }, [stream, composer]),
      ]),
      el('aside', { class: 'evidence-rail scenario-rail', 'aria-label': 'Analysis details' }, [
        el('div', { class: 'rail-tabs', role: 'tablist' }, [
          el('button', { id: 'trace-details-tab', class: 'active', type: 'button', role: 'tab', 'aria-selected': 'true', 'aria-controls': 'trace-details-panel' }, 'Details'),
          el('span', { class: 'rail-model-chip' }, 'Local AI'),
        ]),
        railBody,
      ]),
    ])
  );
  addWelcome();
  setRail(lastAnalysis);
}

function normalizeAnalysis(response) {
  const source = response && (response.analysis || response.result || response.enriched || response);
  if (typeof source === 'string') {
    return { summary: source, likelyCause: '', impact: '', nextSteps: [], evidence: [], provider: response.provider, model: response.model };
  }
  const firstFinding = Array.isArray(source.findings) ? source.findings[0] : null;
  const firstBottleneck = Array.isArray(source.bottlenecks) ? source.bottlenecks[0] : null;
  return {
    summary: source.summary || source.overview || source.explanation || source.message || 'The local model returned an analysis.',
    likelyCause: source.likelyCause || source.likely_cause || source.rootCause || firstFinding && (firstFinding.detail || firstFinding.title) || '',
    impact: source.impact || firstBottleneck && firstBottleneck.observation || '',
    health: source.health || source.confidence || '',
    nextSteps: arrayOfText(source.nextSteps || source.next_steps || source.nextActions || source.recommendations),
    evidence: arrayOfText(source.evidence || source.signals || (source.findings || []).map((item) => item && (item.evidence || item.detail || item.title))),
    timeline: Array.isArray(source.timeline) ? source.timeline : [],
    provider: response.provider || source.provider || source.provenance && source.provenance.provider || 'local',
    model: response.model || source.model || source.provenance && source.provenance.model || 'configured model',
    raw: source.raw || response.raw || null,
  };
}

function arrayOfText(value) {
  if (!Array.isArray(value)) return value ? [String(value)] : [];
  return value.map((item) => typeof item === 'string' ? item : item && (item.text || item.message || item.label) || JSON.stringify(item)).filter(Boolean);
}

function renderAnalysis(stream, analysis, setRail) {
  const details = [];
  if (analysis.likelyCause) details.push(el('p', {}, [el('strong', {}, 'Most likely: '), analysis.likelyCause]));
  if (analysis.impact) details.push(el('p', {}, [el('strong', {}, 'What it affected: '), analysis.impact]));
  if (analysis.nextSteps.length) {
    details.push(el('div', { class: 'friendly-next-steps' }, [
      el('strong', {}, 'What I’d do next'),
      el('ol', {}, analysis.nextSteps.map((step) => el('li', {}, step))),
    ]));
  }
  const message = assistantMessage(
    'Here’s the short version.',
    analysis.summary,
    [{ label: 'View technical details', action: () => setRail(analysis) }]
  );
  const body = message.querySelector('.message-copy');
  body.append(...details);
  stream.append(message);
  message.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function assistantMessage(title, copy, links = [], kind = '') {
  return el('article', { class: `conversation-message assistant ${kind}`.trim() }, [
    el('div', { class: 'message-avatar' }, 'S'),
    el('div', { class: 'message-copy' }, [
      el('strong', { class: 'message-title' }, title),
      el('p', {}, copy),
      links.length ? el('div', { class: 'message-links' }, links.map((link) => {
        if (link.href) return el('a', { href: link.href }, link.label);
        return el('button', { type: 'button', onclick: link.action }, link.label);
      })) : null,
    ]),
  ]);
}

function userMessage(copy) {
  return el('article', { class: 'conversation-message user' }, [
    el('div', { class: 'message-avatar' }, 'You'),
    el('div', { class: 'message-copy' }, [el('p', { dataset: { userContent: 'true' } }, copy)]),
  ]);
}

function detailRail(analysis) {
  return el('div', {}, [
    el('div', { class: 'rail-summary' }, [
      el('div', {}, [el('strong', {}, String(analysis.evidence.length)), el('span', {}, 'signals')]),
      el('div', {}, [el('strong', {}, String(analysis.nextSteps.length)), el('span', {}, 'actions')]),
      el('div', {}, [el('strong', {}, analysis.health || '—'), el('span', {}, 'health')]),
    ]),
    el('div', { class: 'rail-section-label' }, 'Model provenance'),
    el('div', { class: 'detail-card' }, [
      el('span', {}, 'Provider'), el('strong', {}, analysis.provider),
      el('span', {}, 'Model'), el('strong', {}, analysis.model),
      el('span', {}, 'Data route'), el('strong', {}, 'Configured local-model host'),
    ]),
    analysis.evidence.length ? el('div', {}, [
      el('div', { class: 'rail-section-label' }, 'Evidence used'),
      el('div', { class: 'reference-list' }, analysis.evidence.map((signal, index) =>
        el('div', { class: 'reference-card selected' }, [
          el('div', { class: 'reference-main' }, [
            el('span', { class: 'ref-number' }, String(index + 1)),
            el('div', { class: 'ref-body' }, [el('strong', {}, signal)]),
          ]),
        ])
      )),
    ]) : null,
  ]);
}

function emptyRail() {
  return el('div', { class: 'empty-rail' }, [
    el('strong', {}, 'Details stay out of the way'),
    el('p', {}, 'After an analysis, this panel shows the model used, supporting signals, and exact technical evidence.'),
    el('a', { href: '#/settings' }, 'Configure local model'),
  ]);
}
