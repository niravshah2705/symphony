import { api } from '../api.js';
import { el, clear, loading, toast } from '../dom.js';

const FALLBACK_PATTERNS = [
  { id: 'sequential', label: 'Sequential guidance', description: 'Guide one runtime session through each stage in order.', steps: ['Understand', 'Act', 'Verify'] },
  { id: 'parallel', label: 'Fan-out guidance', description: 'Ask capable runtimes to split independent investigation while keeping workspace writes serialized.', steps: ['Split', 'Investigate', 'Synthesize'] },
  { id: 'evaluator', label: 'Evaluator guidance', description: 'Ask one runtime session to evaluate its candidate and repair concrete gaps.', steps: ['Generate', 'Evaluate', 'Repair'] },
  { id: 'supervisor', label: 'Supervisor guidance', description: 'Ask capable runtimes to delegate bounded specialist work and review the result.', steps: ['Route', 'Review', 'Integrate'] },
];

const RUNTIMES = [
  { id: 'deepagent', label: 'DeepAgent SDK', description: 'Current LangGraph-based skills, tools, and repository workflow.' },
  { id: 'codex-sdk', label: 'Codex SDK', description: 'Official server-side Codex planning sessions with scoped web research.' },
  { id: 'claude-agent-sdk', label: 'Claude Agent SDK', description: 'Official Claude planning loop with streamed usage and reported cost.' },
  { id: 'antigravity-sdk', label: 'Antigravity SDK', description: 'Google Antigravity planning via the Gemini @google/genai interactions API (preview).' },
];

export async function renderWorkflows(view) {
  clear(view).append(loading('Loading workflow patterns…'));
  const [settings, response] = await Promise.all([
    api.getSettings(),
    api.getWorkflowPatterns().catch(() => ({ patterns: FALLBACK_PATTERNS })),
  ]);
  const patterns = Array.isArray(response.patterns) && response.patterns.length ? response.patterns : FALLBACK_PATTERNS;
  let selectedRuntime = settings.agentRuntime || 'deepagent';
  let selectedPattern = settings.workflowPattern || 'sequential';

  const runtimeSelect = el('select', { 'aria-label': 'Agent SDK runtime' }, RUNTIMES.map((runtime) =>
    el('option', { value: runtime.id, ...(runtime.id === selectedRuntime ? { selected: 'selected' } : {}) }, runtime.label)
  ));
  const save = el('button', { class: 'primary', type: 'button' }, 'Save workflow setup');
  const runtimeNote = el('span', { class: 'muted' }, 'Every runtime is wrapped in a LangSmith trace when tracing is configured.');
  const saveStatus = el('span', { class: 'muted', role: 'status' }, 'New runs use the saved runtime and pattern.');

  const cards = el('div', { class: 'pattern-grid' });
  const renderCards = () => {
    cards.replaceChildren(...patterns.map((pattern) => {
      const active = pattern.id === selectedPattern;
      const defaultSteps = {
        sequential: ['Step 1', 'Step 2', 'Finish'],
        parallel: ['Fan out', 'Join', 'Finish'],
        evaluator: ['Generate', 'Evaluate', 'Retry'],
        supervisor: ['Route', 'Handoff', 'Finish'],
      }[pattern.id] || [];
      const steps = pattern.steps || defaultSteps;
      const button = el('button', {
        class: `pattern-card${active ? ' active' : ''}`,
        type: 'button',
        'aria-pressed': String(active),
      }, [
        el('span', { class: 'pattern-card-top' }, [
          el('strong', {}, pattern.label || pattern.name || pattern.id),
          active ? el('span', { class: 'status-pill ok' }, 'Selected') : null,
        ]),
        el('span', { class: 'muted' }, pattern.description || pattern.summary || pattern.bestFor || ''),
        el('span', { class: 'pattern-flow', 'aria-label': 'Workflow stages' }, steps.map((step, index) => [
          el('span', { class: 'pattern-step' }, typeof step === 'string' ? step : step.label || step.id),
          index < steps.length - 1 ? el('span', { class: 'pattern-arrow', 'aria-hidden': 'true' }, '→') : null,
        ]).flat()),
      ]);
      button.addEventListener('click', () => {
        selectedPattern = pattern.id;
        renderCards();
      });
      return button;
    }));
  };
  renderCards();

  const updateRuntimeNote = () => {
    selectedRuntime = runtimeSelect.value;
    const runtime = RUNTIMES.find((item) => item.id === selectedRuntime);
    const expectedProvider = selectedRuntime === 'codex-sdk'
      ? 'codex'
      : selectedRuntime === 'claude-agent-sdk'
        ? 'claude'
        : null;
    const compatibility = expectedProvider && settings.llmProvider !== expectedProvider
      ? ` The hosted slot is ${settings.llmProvider || 'not configured'}, so the effective runtime remains DeepAgent until it matches.`
      : '';
    runtimeNote.textContent = `${runtime?.description || ''}${compatibility} Every effective execution is traced when LangSmith is configured.`;
  };
  runtimeSelect.addEventListener('change', updateRuntimeNote);
  updateRuntimeNote();
  save.addEventListener('click', async () => {
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      await api.saveAgentRuntime({ agentRuntime: selectedRuntime, workflowPattern: selectedPattern });
      toast('Workflow setup saved.');
      saveStatus.textContent = 'Saved. New agent runs will use this SDK and pattern.';
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      save.disabled = false;
      save.textContent = 'Save workflow setup';
    }
  });

  clear(view).append(
    el('div', { class: 'page-head operational-head' }, [
      el('div', {}, [el('h1', {}, 'Workflows'), el('p', { class: 'muted' }, 'Choose the agent SDK and the orchestration pattern used for new work.')]),
      el('a', { class: 'btn', href: '#/analytics' }, 'View trace cost'),
    ]),
    el('section', { class: 'operational-panel runtime-panel' }, [
      el('div', { class: 'panel-heading' }, [
        el('div', {}, [el('h2', {}, 'Agent runtime'), el('p', { class: 'muted' }, 'The selected SDK runs compatible planning work. Brokered tracker and PR work always stays on DeepAgent so credentials remain private.')]),
      ]),
      el('div', { class: 'runtime-picker' }, [runtimeSelect, runtimeNote]),
      el('div', { class: 'runtime-cards' }, RUNTIMES.map((runtime) => el('article', { class: 'runtime-card' }, [
        el('strong', {}, runtime.label),
        el('p', { class: 'muted' }, runtime.description),
      ]))),
    ]),
    el('section', { class: 'operational-panel' }, [
      el('div', { class: 'panel-heading' }, [
        el('div', {}, [el('h2', {}, 'Workflow guidance'), el('p', { class: 'muted' }, 'These patterns guide one runtime session. Capable SDKs may delegate investigation, but the application does not promise concurrent workers or automatic retries.')]),
      ]),
      cards,
      el('div', { class: 'workflow-save-row' }, [saveStatus, save]),
    ])
  );
}
