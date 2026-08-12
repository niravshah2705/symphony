import { clear, el, toast } from '../dom.js';
import { icon } from '../icons.js';
import {
  activeWorkspaceOrganization,
  getWorkspaceContext,
} from '../workspace-context.js';
import {
  addEdge,
  addNode,
  cloneWorkflow,
  createCustomAgent,
  createCustomContext,
  createWorkflow,
  deleteCustomAgent,
  deleteCustomContext,
  deleteEdge,
  deleteNode,
  deleteWorkflow,
  findAgentProfile,
  findContextProfile,
  getAgentCatalog,
  getContextCatalog,
  graphSummary,
  moveNode,
  readStateFromStorage,
  resetSeededWorkflows,
  updateCustomAgent,
  updateCustomContext,
  updateEdge,
  updateNode,
  upsertWorkflow,
  writeStateToStorage,
} from '../workflow-designer-model.mjs';

const CANVAS_WIDTH = 2500;
const CANVAS_HEIGHT = 1040;
const NODE_WIDTH = 202;
const NODE_ANCHOR_Y = 58;
const GRID_SIZE = 20;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 1.4;
const ZOOM_STEP = 0.1;
const SAVE_DELAY_MS = 280;
const SVG_NS = 'http://www.w3.org/2000/svg';

const APPROVER_ROLES = Object.freeze([
  ['ORG_ADMIN', 'Organization Admin'],
  ['PROJECT_ADMIN', 'Project Admin'],
  ['RELEASE_MANAGER', 'Release Manager'],
  ['COMMERCIAL_LEAD', 'Commercial Lead'],
  ['RESEARCH_LEAD', 'Research Lead'],
  ['INCIDENT_COMMANDER', 'Incident Commander'],
  ['ON_CALL_LEAD', 'On-call Lead'],
  ['HUMAN_REVIEWER', 'Human Reviewer'],
]);

const AGENT_CATEGORIES = Object.freeze([
  'Planning', 'Engineering', 'Quality', 'Operations', 'Research', 'Commercial', 'Customer', 'Data', 'Governance',
]);

let fieldSequence = 0;
let flushPendingDesignerSave = null;
let persistenceEventsBound = false;

function bindPersistenceEvents() {
  if (persistenceEventsBound) return;
  persistenceEventsBound = true;
  const flush = () => flushPendingDesignerSave?.();
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

function browserStorage() {
  try {
    return window.localStorage;
  } catch (_) {
    return null;
  }
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || minimum));
}

function snap(value) {
  return Math.round((Number(value) || 0) / GRID_SIZE) * GRID_SIZE;
}

function commaList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean).slice(0, 20);
}

function lines(value) {
  if (Array.isArray(value)) return value.join('\n');
  return String(value || '');
}

function lineList(value) {
  return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 20);
}

function deepClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function svgElement(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function field(label, control, help = '') {
  const controlId = control.getAttribute('id') || `workflow-field-${++fieldSequence}`;
  control.setAttribute('id', controlId);
  return el('div', { class: 'workflow-field' }, [
    el('label', { for: controlId }, label),
    control,
    help ? el('small', { class: 'workflow-field-help' }, help) : null,
  ]);
}

function textInput(value, attrs = {}) {
  return el('input', { type: 'text', value: value || '', ...attrs });
}

function textArea(value, attrs = {}) {
  return el('textarea', { rows: '3', ...attrs }, value || '');
}

function option(value, label, selected = false) {
  return el('option', { value, selected }, label);
}

function safeId(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100);
}

function nodeLabel(node, state) {
  if (node.name) return node.name;
  if (node.kind === 'agent') return findAgentProfile(node.refId, state)?.name || 'Agent';
  if (node.kind === 'environment') return findContextProfile(node.refId, state)?.name || 'Context';
  return 'Human approval';
}

function nodeDescription(node, state) {
  if (node.description) return node.description;
  if (node.kind === 'agent') {
    const profile = findAgentProfile(node.refId, state);
    return profile?.description || profile?.purpose || 'Organization agent';
  }
  if (node.kind === 'environment') return findContextProfile(node.refId, state)?.description || 'Execution context';
  return Array.isArray(node.reviewCriteria) && node.reviewCriteria.length
    ? node.reviewCriteria.join(' · ')
    : 'Review evidence before downstream work continues.';
}

function nodeKindLabel(node, state) {
  if (node.kind === 'approval') return 'Human gate';
  if (node.kind === 'environment') return 'Environment';
  return findAgentProfile(node.refId, state)?.category || 'Agent';
}

function nodeIconName(node) {
  if (node.kind === 'approval') return 'check';
  if (node.kind === 'environment') return 'sliders';
  return 'spark';
}

function workflowById(state, id) {
  return state.workflows.find((workflow) => workflow.id === id) || state.workflows[0] || null;
}

/**
 * Frontend-only organization workflow designer. It deliberately performs no API
 * calls: drafts live under an organization-keyed localStorage record and the UI
 * calls out that graphs are non-executable prototypes.
 */
export async function renderWorkflows(view) {
  flushPendingDesignerSave?.();
  flushPendingDesignerSave = null;
  const workspace = getWorkspaceContext();
  const organization = activeWorkspaceOrganization(workspace);
  if (!organization) {
    clear(view).append(el('section', { class: 'workflow-page workflow-empty-state' }, [
      el('div', { class: 'workflow-empty' }, [
        icon('graph', { size: 28 }),
        el('h1', {}, 'Select an organization to design workflows'),
        el('p', { class: 'muted' }, 'Workflow drafts are isolated by organization. Select or create one before opening the designer.'),
        el('a', { class: 'btn primary', href: '#/organization' }, 'Open Organization'),
      ]),
    ]));
    return;
  }

  const canEdit = String(organization.role || '').toUpperCase() === 'ORG_ADMIN';
  const storage = browserStorage();
  const loaded = readStateFromStorage(storage, organization.id);
  let state = loaded.state;
  let selected = { kind: 'workflow', id: state.activeWorkflowId };
  let connectSource = '';
  let paletteQuery = '';
  let persistTimer = null;
  let scrollTimer = null;
  let pendingViewportSave = null;
  let designer = null;
  let paletteHost = null;
  let canvasHost = null;
  let inspectorHost = null;
  let workflowSelect = null;
  let statusHost = null;
  let summaryHost = null;

  function currentWorkflow() {
    return workflowById(state, state.activeWorkflowId);
  }

  function setSaveStatus(message, tone = '') {
    if (!statusHost) return;
    statusHost.textContent = message;
    statusHost.dataset.state = tone === 'ok' ? 'saved' : tone === 'error' ? 'error' : 'dirty';
  }

  function persistNow({ silent = false } = {}) {
    if (persistTimer) window.clearTimeout(persistTimer);
    persistTimer = null;
    const result = writeStateToStorage(storage, organization.id, state);
    if (result.ok) setSaveStatus('Saved locally · not shared', 'ok');
    else {
      setSaveStatus('Could not save · session copy retained', 'error');
      if (!silent) toast(result.error || 'Browser storage is unavailable. Your current session is still usable.', 'err');
    }
    return result;
  }

  function schedulePersist() {
    setSaveStatus('Saving locally…');
    if (persistTimer) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => persistNow(), SAVE_DELAY_MS);
  }

  function persistPendingViewport() {
    if (scrollTimer) window.clearTimeout(scrollTimer);
    scrollTimer = null;
    const pending = pendingViewportSave;
    pendingViewportSave = null;
    if (!pending || currentWorkflow()?.id !== pending.workflowId) return;
    updateViewport({ x: pending.x, y: pending.y }, { rerender: false });
  }

  flushPendingDesignerSave = () => {
    persistPendingViewport();
    if (persistTimer) persistNow({ silent: true });
  };
  bindPersistenceEvents();

  function renderWorkflowOptions() {
    if (!workflowSelect) return;
    workflowSelect.replaceChildren(...state.workflows.map((workflow) => option(
      workflow.id,
      workflow.exampleId ? `${workflow.name} · example` : workflow.name,
      workflow.id === state.activeWorkflowId,
    )));
  }

  function updateSummary() {
    if (!summaryHost) return;
    const workflow = currentWorkflow();
    const summary = graphSummary(workflow);
    const agents = workflow.nodes.filter((node) => node.kind === 'agent').length;
    const gates = workflow.nodes.filter((node) => node.kind === 'approval').length;
    summaryHost.textContent = `${agents} agents · ${gates} approvals · ${summary.componentCount} ${summary.componentCount === 1 ? 'lane' : 'independent lanes'}`;
  }

  function acceptState(nextState, {
    palette = false,
    canvas = true,
    inspector = true,
    controls = true,
    persist = true,
  } = {}) {
    state = nextState;
    if (persist) schedulePersist();
    if (controls) renderWorkflowOptions();
    if (palette) renderPalette();
    if (canvas) renderCanvas();
    if (inspector) renderInspector();
    updateSummary();
  }

  function acceptWorkflow(workflow, opts = {}) {
    const result = upsertWorkflow(state, workflow);
    if (!result.ok) {
      toast(result.error || 'The workflow could not be updated.', 'err');
      return false;
    }
    result.state.activeWorkflowId = result.workflow.id;
    acceptState(result.state, opts);
    return true;
  }

  function activateWorkflow(id) {
    const workflow = workflowById(state, id);
    if (!workflow) return;
    state = { ...state, activeWorkflowId: workflow.id };
    selected = { kind: 'workflow', id: workflow.id };
    connectSource = '';
    if (canEdit) schedulePersist();
    renderWorkflowOptions();
    renderCanvas();
    renderInspector();
    updateSummary();
  }

  function selectItem(kind, id) {
    selected = { kind, id };
    renderCanvas();
    renderInspector();
    if (window.matchMedia('(max-width: 1080px)').matches && designer) {
      designer.classList.remove('is-palette-open');
      designer.classList.add('is-inspector-open');
    }
  }

  function restoreCanvasFocus(kind, id) {
    window.requestAnimationFrame(() => {
      const selector = kind === 'edge' ? '[data-edge-id]' : '[data-node-id]';
      const container = Array.from(canvasHost?.querySelectorAll(selector) || [])
        .find((candidate) => candidate.dataset[kind === 'edge' ? 'edgeId' : 'nodeId'] === id);
      const target = kind === 'edge' ? container?.querySelector('.workflow-edge-hit') : container;
      target?.focus({ preventScroll: true });
    });
  }

  function addNodeFromPalette(kind, refId, position = null) {
    if (!canEdit) return;
    const viewport = canvasHost?.querySelector('.workflow-canvas-viewport');
    const workflow = currentWorkflow();
    const zoom = workflow.viewport?.zoom || 1;
    const suggested = position || {
      x: snap(((viewport?.scrollLeft || 0) + (viewport?.clientWidth || 760) / 2) / zoom - NODE_WIDTH / 2),
      y: snap(((viewport?.scrollTop || 0) + (viewport?.clientHeight || 560) / 2) / zoom - NODE_ANCHOR_Y),
    };
    let input;
    if (kind === 'agent') {
      const profile = findAgentProfile(refId, state);
      input = { kind, refId, x: suggested.x, y: suggested.y, name: profile?.name, description: profile?.description || profile?.purpose };
    } else if (kind === 'environment') {
      const context = findContextProfile(refId, state);
      input = { kind, refId, x: suggested.x, y: suggested.y, name: context?.name, description: context?.description };
    } else {
      input = {
        kind: 'approval', x: suggested.x, y: suggested.y, name: 'Human approval',
        description: 'Review evidence before downstream work continues.', requiredRole: 'Organization Admin',
        reviewCriteria: ['Evidence and risk are ready for a human decision.'], rejectionHandling: 'Stop this lane and return the work for revision.',
      };
    }
    const result = addNode(workflow, input);
    if (!result.ok) return toast(result.error || 'The node could not be added.', 'err');
    selected = { kind: 'node', id: result.node.id };
    acceptWorkflow(result.workflow);
  }

  function beginConnection(nodeId) {
    if (!canEdit) return;
    connectSource = connectSource === nodeId ? '' : nodeId;
    renderCanvas();
    renderInspector();
    if (connectSource) toast(`Choose an input port for ${nodeLabel(currentWorkflow().nodes.find((node) => node.id === nodeId), state)}.`);
  }

  function finishConnection(targetId) {
    if (!canEdit || !connectSource) return;
    const result = addEdge(currentWorkflow(), { source: connectSource, target: targetId });
    if (!result.ok) {
      toast(result.error || 'Those nodes cannot be connected.', 'err');
      return;
    }
    connectSource = '';
    selected = { kind: 'edge', id: result.edge.id };
    acceptWorkflow(result.workflow);
  }

  function moveSelectedNode(nodeId, dx, dy) {
    if (!canEdit) return;
    const workflow = currentWorkflow();
    const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const result = moveNode(workflow, nodeId, { x: snap(node.x + dx), y: snap(node.y + dy) });
    if (!result.ok) return toast(result.error || 'The node could not be moved.', 'err');
    if (acceptWorkflow(result.workflow, { inspector: false, controls: false })) restoreCanvasFocus('node', nodeId);
  }

  function updateSelectedNode(patch, { redrawInspector = false } = {}) {
    if (!canEdit || selected.kind !== 'node') return;
    const result = updateNode(currentWorkflow(), selected.id, patch);
    if (!result.ok) return toast(result.error || 'The node could not be updated.', 'err');
    acceptWorkflow(result.workflow, { inspector: redrawInspector, controls: false });
  }

  function paletteItem({ kind, id, name, description, category, custom = false }) {
    const add = el('button', {
      type: 'button', class: 'workflow-palette-add', disabled: !canEdit,
      'aria-label': `Add ${name} to workflow`, title: `Add ${name}`,
    }, icon('right', { size: 15 }));
    add.addEventListener('click', () => addNodeFromPalette(kind, id));
    const row = el('article', {
      class: 'workflow-palette-item', draggable: canEdit ? 'true' : 'false',
      dataset: { paletteKind: kind, paletteId: id },
    }, [
      el('span', { class: `workflow-palette-icon workflow-palette-icon--${kind}` }, icon(kind === 'environment' ? 'sliders' : 'spark', { size: 16 })),
      el('div', { class: 'workflow-palette-copy' }, [
        el('strong', {}, name),
        el('small', {}, description || 'Available organization resource'),
        el('span', { class: 'workflow-palette-meta' }, [category || (kind === 'environment' ? 'Context' : 'Agent'), custom ? ' · Custom' : '']),
      ]),
      el('div', { class: 'workflow-palette-actions' }, [
        custom ? (() => {
          const edit = el('button', { type: 'button', class: 'workflow-icon-button', disabled: !canEdit, 'aria-label': `Edit ${name}`, title: 'Edit profile' }, icon('sliders', { size: 14 }));
          edit.addEventListener('click', () => selectItem(kind === 'agent' ? 'agent-profile' : 'context-profile', id));
          return edit;
        })() : null,
        add,
      ]),
    ]);
    row.addEventListener('dragstart', (event) => {
      if (!canEdit || !event.dataTransfer) return;
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('application/x-ai-fleet-workflow-node', JSON.stringify({ kind, refId: id }));
      event.dataTransfer.setData('text/plain', `${kind}:${id}`);
    });
    return row;
  }

  function paletteSection(title, items) {
    return el('section', { class: 'workflow-palette-section' }, [
      el('h3', {}, title),
      el('div', { class: 'workflow-palette-list' }, items.length ? items : [el('p', { class: 'muted workflow-palette-none' }, 'No matching items.')]),
    ]);
  }

  function renderPalette() {
    if (!paletteHost) return;
    const query = paletteQuery.trim().toLowerCase();
    const matches = (item) => !query || [item.name, item.description, item.purpose, item.category]
      .filter(Boolean).join(' ').toLowerCase().includes(query);
    const agents = getAgentCatalog(state).filter(matches);
    const contexts = getContextCatalog(state).filter(matches);
    const search = el('input', {
      type: 'search', value: paletteQuery, placeholder: 'Search agents and contexts',
      'aria-label': 'Search agents and contexts',
    });
    search.addEventListener('input', () => {
      paletteQuery = search.value;
      renderPalette();
      window.requestAnimationFrame(() => {
        const next = paletteHost.querySelector('input[type="search"]');
        next?.focus();
        next?.setSelectionRange(paletteQuery.length, paletteQuery.length);
      });
    });
    const newAgent = el('button', { type: 'button', disabled: !canEdit }, 'New custom agent');
    newAgent.addEventListener('click', () => selectItem('new-agent', ''));
    const newContext = el('button', { type: 'button', disabled: !canEdit }, 'New context');
    newContext.addEventListener('click', () => selectItem('new-context', ''));
    const close = el('button', { type: 'button', class: 'workflow-icon-button workflow-panel-close', 'aria-label': 'Close agent palette' }, icon('close', { size: 15 }));
    close.addEventListener('click', () => designer?.classList.remove('is-palette-open'));

    clear(paletteHost).append(
      el('div', { class: 'workflow-panel-header' }, [
        el('div', {}, [el('strong', {}, 'Agent palette'), el('small', {}, 'Drag or add to the canvas')]),
        close,
      ]),
      el('div', { class: 'workflow-palette-tools' }, [search, el('div', { class: 'workflow-palette-create' }, [newAgent, newContext])]),
      el('div', { class: 'workflow-panel-body' }, [
        paletteSection('Agents', agents.map((profile) => paletteItem({ kind: 'agent', ...profile, custom: profile.source === 'custom' || state.customAgents.some((item) => item.id === profile.id) }))),
        paletteSection('Execution contexts', contexts.map((context) => paletteItem({ kind: 'environment', ...context, category: 'Context', custom: context.source === 'custom' || state.customContexts.some((item) => item.id === context.id) }))),
        paletteSection('Control', query && !'human approval role gate review'.includes(query) ? [] : [paletteItem({
          kind: 'approval', id: '', name: 'Human approval', category: 'Control',
          description: 'Pause a designed lane for a role-based approve or reject decision.',
        })]),
      ]),
    );
  }

  function drawEdges(svg, workflow) {
    svg.replaceChildren();
    const defs = svgElement('defs');
    for (const [id, selectedMarker] of [['workflow-arrow', false], ['workflow-arrow-selected', true]]) {
      const marker = svgElement('marker', {
        id, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse',
      });
      marker.append(svgElement('path', {
        d: 'M 0 0 L 10 5 L 0 10 z',
        class: `workflow-edge-arrow${selectedMarker ? ' is-selected' : ''}`,
      }));
      defs.append(marker);
    }
    svg.append(defs);
    const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
    for (const edge of workflow.edges) {
      const source = nodes.get(edge.source);
      const target = nodes.get(edge.target);
      if (!source || !target) continue;
      const x1 = source.x + NODE_WIDTH;
      const y1 = source.y + NODE_ANCHOR_Y;
      const x2 = target.x;
      const y2 = target.y + NODE_ANCHOR_Y;
      const bend = Math.max(70, Math.abs(x2 - x1) * 0.42);
      const direction = x2 >= x1 ? 1 : -1;
      const d = `M ${x1} ${y1} C ${x1 + bend * direction} ${y1}, ${x2 - bend * direction} ${y2}, ${x2} ${y2}`;
      const isSelected = selected.kind === 'edge' && selected.id === edge.id;
      const group = svgElement('g', {
        class: `workflow-edge-group${isSelected ? ' is-selected' : ''}`,
        'data-edge-id': edge.id,
      });
      const visible = svgElement('path', {
        d,
        class: 'workflow-edge',
        'marker-end': `url(#workflow-arrow${isSelected ? '-selected' : ''})`,
      });
      const hit = svgElement('path', {
        d, class: 'workflow-edge-hit', tabindex: '0', role: 'button',
        'aria-label': `Connection from ${nodeLabel(source, state)} to ${nodeLabel(target, state)}`,
      });
      const choose = (restoreFocus = false) => {
        selectItem('edge', edge.id);
        if (restoreFocus) restoreCanvasFocus('edge', edge.id);
      };
      hit.addEventListener('click', () => choose());
      hit.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(true); }
      });
      group.append(visible, hit);
      if (edge.outcome) {
        const text = svgElement('text', {
          x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) - 8, class: 'workflow-edge-label', 'text-anchor': 'middle',
        });
        text.textContent = edge.outcome;
        group.append(text);
      }
      svg.append(group);
    }
  }

  function attachNodeDrag(nodeElement, node, workflow, svg) {
    const handle = nodeElement.querySelector('.workflow-node-header');
    if (!handle || !canEdit) return;
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      event.preventDefault();
      selected = { kind: 'node', id: node.id };
      const working = deepClone(workflow);
      const moving = working.nodes.find((candidate) => candidate.id === node.id);
      const zoom = workflow.viewport?.zoom || 1;
      const start = { x: event.clientX, y: event.clientY, nodeX: moving.x, nodeY: moving.y };
      nodeElement.classList.add('is-dragging');
      document.body.classList.add('workflow-dragging');
      const onMove = (moveEvent) => {
        moving.x = clamp(snap(start.nodeX + (moveEvent.clientX - start.x) / zoom), 0, CANVAS_WIDTH - NODE_WIDTH);
        moving.y = clamp(snap(start.nodeY + (moveEvent.clientY - start.y) / zoom), 0, CANVAS_HEIGHT - 150);
        nodeElement.style.left = `${moving.x}px`;
        nodeElement.style.top = `${moving.y}px`;
        drawEdges(svg, working);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.classList.remove('workflow-dragging');
        const result = moveNode(workflow, node.id, { x: moving.x, y: moving.y });
        if (result.ok) acceptWorkflow(result.workflow, { inspector: true, controls: false });
        else renderCanvas();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
    });
  }

  function renderNode(node, workflow, summary, svg) {
    const standalone = summary.standaloneNodeIds.includes(node.id);
    const active = selected.kind === 'node' && selected.id === node.id;
    const inputPort = el('button', {
      type: 'button', class: 'workflow-port workflow-port--input',
      disabled: !canEdit || !connectSource || connectSource === node.id,
      'aria-label': connectSource ? `Connect selected node to ${nodeLabel(node, state)}` : `Input port for ${nodeLabel(node, state)}`,
      title: connectSource ? 'Complete connection' : 'Select another node output first',
    });
    inputPort.addEventListener('click', (event) => { event.stopPropagation(); finishConnection(node.id); });
    const outputPort = el('button', {
      type: 'button', class: 'workflow-port workflow-port--output', disabled: !canEdit,
      'aria-label': `Start connection from ${nodeLabel(node, state)}`,
      'aria-pressed': connectSource === node.id ? 'true' : 'false', title: 'Start connection',
    });
    outputPort.addEventListener('click', (event) => { event.stopPropagation(); beginConnection(node.id); });
    const article = el('article', {
      class: `workflow-node workflow-node--${node.kind}${active ? ' is-selected' : ''}${standalone ? ' is-standalone' : ''}${canEdit ? '' : ' is-readonly'}`,
      style: `left:${node.x}px;top:${node.y}px`, tabindex: '0', role: 'group',
      'aria-label': `${nodeLabel(node, state)}, ${nodeKindLabel(node, state)}${standalone ? ', standalone' : ''}`,
      dataset: {
        nodeId: node.id,
        nodeKind: node.kind,
        selected: String(active),
        standalone: String(standalone),
        readonly: String(!canEdit),
      },
    }, [
      inputPort,
      el('div', { class: 'workflow-node-header' }, [
        el('span', { class: 'workflow-node-icon' }, icon(nodeIconName(node), { size: 16 })),
        el('div', { class: 'workflow-node-copy' }, [
          el('span', { class: 'workflow-node-kind' }, nodeKindLabel(node, state)),
          el('strong', { class: 'workflow-node-title' }, nodeLabel(node, state)),
        ]),
        standalone ? el('span', { class: 'workflow-node-status' }, 'Standalone') : null,
      ]),
      el('p', { class: 'workflow-node-body' }, nodeDescription(node, state)),
      el('footer', { class: 'workflow-node-footer' }, [
        node.kind === 'approval' ? el('span', {}, node.requiredRole || 'Human reviewer') : null,
        node.kind === 'environment' ? el('span', {}, 'Execution context') : null,
        node.kind === 'agent' ? el('span', {}, 'Agent profile') : null,
      ]),
      outputPort,
    ]);
    article.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      selectItem('node', node.id);
    });
    article.addEventListener('keydown', (event) => {
      if (event.target !== article) return;
      const directions = { ArrowLeft: [-GRID_SIZE, 0], ArrowRight: [GRID_SIZE, 0], ArrowUp: [0, -GRID_SIZE], ArrowDown: [0, GRID_SIZE] };
      if (directions[event.key] && canEdit) {
        event.preventDefault();
        moveSelectedNode(node.id, ...directions[event.key]);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectItem('node', node.id);
        restoreCanvasFocus('node', node.id);
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && canEdit) {
        event.preventDefault();
        selected = { kind: 'confirm-node-delete', id: node.id };
        renderInspector();
      }
    });
    attachNodeDrag(article, node, workflow, svg);
    return article;
  }

  function updateViewport(patch, { rerender = true } = {}) {
    const workflow = deepClone(currentWorkflow());
    workflow.viewport = { ...workflow.viewport, ...patch };
    acceptWorkflow(workflow, {
      canvas: rerender,
      inspector: false,
      controls: false,
      persist: canEdit,
    });
  }

  function renderCanvas() {
    if (!canvasHost) return;
    const workflow = currentWorkflow();
    if (!workflow) return;
    const summary = graphSummary(workflow);
    const zoom = clamp(workflow.viewport?.zoom || 1, MIN_ZOOM, MAX_ZOOM);
    const paletteToggle = el('button', { type: 'button', class: 'workflow-panel-toggle', 'aria-label': 'Open agent palette' }, [icon('menu', { size: 15 }), ' Agents']);
    paletteToggle.addEventListener('click', () => {
      if (!designer) return;
      designer.classList.remove('is-inspector-open');
      designer.classList.toggle('is-palette-open');
    });
    const inspectorToggle = el('button', { type: 'button', class: 'workflow-panel-toggle', 'aria-label': 'Open inspector' }, [icon('panel', { size: 15 }), ' Inspector']);
    inspectorToggle.addEventListener('click', () => {
      if (!designer) return;
      designer.classList.remove('is-palette-open');
      designer.classList.toggle('is-inspector-open');
    });
    const zoomOut = el('button', { type: 'button', class: 'workflow-icon-button', 'aria-label': 'Zoom out', disabled: zoom <= MIN_ZOOM }, el('span', { 'aria-hidden': 'true' }, '−'));
    zoomOut.addEventListener('click', () => updateViewport({ zoom: clamp(zoom - ZOOM_STEP, MIN_ZOOM, MAX_ZOOM) }));
    const zoomIn = el('button', { type: 'button', class: 'workflow-icon-button', 'aria-label': 'Zoom in', disabled: zoom >= MAX_ZOOM }, el('span', { 'aria-hidden': 'true' }, '+'));
    zoomIn.addEventListener('click', () => updateViewport({ zoom: clamp(zoom + ZOOM_STEP, MIN_ZOOM, MAX_ZOOM) }));
    const fit = el('button', { type: 'button' }, 'Fit');
    const viewport = el('div', {
      class: 'workflow-canvas-viewport', tabindex: '0',
      'aria-label': `${workflow.name} workflow canvas. Use arrow keys on a focused node to move it.`,
    });
    fit.addEventListener('click', () => {
      const nextZoom = clamp(Math.min((viewport.clientWidth - 36) / CANVAS_WIDTH, (viewport.clientHeight - 36) / CANVAS_HEIGHT), MIN_ZOOM, 1);
      updateViewport({ zoom: nextZoom, x: 0, y: 0 });
    });
    const cancelConnection = el('button', { type: 'button', hidden: !connectSource }, 'Cancel connection');
    cancelConnection.addEventListener('click', () => { connectSource = ''; renderCanvas(); renderInspector(); });
    const toolbar = el('div', { class: 'workflow-canvas-toolbar' }, [
      el('div', { class: 'workflow-canvas-tools-start' }, [paletteToggle, el('span', { class: 'workflow-canvas-summary' }, `${summary.componentCount} ${summary.componentCount === 1 ? 'lane' : 'lanes'} · ${summary.standaloneNodeIds.length} standalone`), cancelConnection]),
      el('div', { class: 'workflow-zoom' }, [zoomOut, el('output', { class: 'workflow-zoom-output', 'aria-label': 'Canvas zoom' }, `${Math.round(zoom * 100)}%`), zoomIn, fit, inspectorToggle]),
    ]);
    const stage = el('div', { class: 'workflow-canvas-stage', style: `width:${CANVAS_WIDTH * zoom}px;height:${CANVAS_HEIGHT * zoom}px` });
    const canvas = el('div', {
      class: 'workflow-canvas', style: `width:${CANVAS_WIDTH}px;height:${CANVAS_HEIGHT}px;transform:scale(${zoom})`,
      dataset: { workflowCanvas: 'true' },
    });
    const svg = svgElement('svg', {
      class: 'workflow-edge-layer', width: CANVAS_WIDTH, height: CANVAS_HEIGHT, viewBox: `0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`,
      'aria-label': 'Workflow connections', role: 'group',
    });
    drawEdges(svg, workflow);
    canvas.append(svg, ...workflow.nodes.map((node) => renderNode(node, workflow, summary, svg)));
    stage.append(canvas);
    viewport.append(stage);
    viewport.addEventListener('dragover', (event) => {
      if (!canEdit) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    viewport.addEventListener('drop', (event) => {
      if (!canEdit || !event.dataTransfer) return;
      event.preventDefault();
      try {
        const payload = JSON.parse(event.dataTransfer.getData('application/x-ai-fleet-workflow-node'));
        const rect = canvas.getBoundingClientRect();
        addNodeFromPalette(payload.kind, payload.refId, {
          x: clamp(snap((event.clientX - rect.left) / zoom - NODE_WIDTH / 2), 0, CANVAS_WIDTH - NODE_WIDTH),
          y: clamp(snap((event.clientY - rect.top) / zoom - NODE_ANCHOR_Y), 0, CANVAS_HEIGHT - 150),
        });
      } catch (_) {
        toast('That palette item could not be added.', 'err');
      }
    });
    let pan = null;
    viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('.workflow-node, .workflow-edge-hit, button')) return;
      pan = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      viewport.classList.add('is-panning');
      const onMove = (moveEvent) => {
        viewport.scrollLeft = pan.left - (moveEvent.clientX - pan.x);
        viewport.scrollTop = pan.top - (moveEvent.clientY - pan.y);
      };
      const onUp = () => {
        viewport.classList.remove('is-panning');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
    });
    const renderedWorkflowId = workflow.id;
    viewport.addEventListener('scroll', () => {
      if (scrollTimer) window.clearTimeout(scrollTimer);
      pendingViewportSave = {
        workflowId: renderedWorkflowId,
        x: viewport.scrollLeft,
        y: viewport.scrollTop,
      };
      scrollTimer = window.setTimeout(() => persistPendingViewport(), 180);
    }, { passive: true });
    clear(canvasHost).append(toolbar, viewport);
    window.requestAnimationFrame(() => {
      viewport.scrollLeft = Number(workflow.viewport?.x) || 0;
      viewport.scrollTop = Number(workflow.viewport?.y) || 0;
    });
  }

  function inspectorHeader(title, subtitle = '') {
    const close = el('button', { type: 'button', class: 'workflow-icon-button workflow-panel-close', 'aria-label': 'Close inspector' }, icon('close', { size: 15 }));
    close.addEventListener('click', () => designer?.classList.remove('is-inspector-open'));
    return el('div', { class: 'workflow-panel-header' }, [
      el('div', {}, [el('strong', {}, title), subtitle ? el('small', {}, subtitle) : null]),
      close,
    ]);
  }

  function inlineConfirm({ title, body, confirmLabel, danger = true, onConfirm, onCancel }) {
    const confirm = el('button', { type: 'button', class: danger ? 'danger' : 'primary' }, confirmLabel);
    confirm.addEventListener('click', onConfirm);
    const cancel = el('button', { type: 'button' }, 'Cancel');
    cancel.addEventListener('click', onCancel);
    return el('section', { class: `workflow-inline-confirm${danger ? ' workflow-inline-confirm--danger' : ''}`, role: 'alert' }, [
      el('strong', {}, title), el('p', {}, body), el('div', { class: 'workflow-inline-confirm-actions' }, [cancel, confirm]),
    ]);
  }

  function workflowInspector(workflow) {
    const name = textInput(workflow.name, { maxlength: '100', disabled: !canEdit });
    const description = textArea(workflow.description, { maxlength: '600', rows: '4', disabled: !canEdit });
    name.addEventListener('input', () => {
      const next = { ...deepClone(currentWorkflow()), name: name.value };
      acceptWorkflow(next, { canvas: false, inspector: false });
      renderWorkflowOptions();
    });
    description.addEventListener('input', () => acceptWorkflow(
      { ...deepClone(currentWorkflow()), description: description.value },
      { canvas: false, inspector: false, controls: false },
    ));
    const deleteButton = el('button', { type: 'button', class: 'danger', disabled: !canEdit || state.workflows.length < 2 }, 'Delete workflow');
    deleteButton.addEventListener('click', () => { selected = { kind: 'confirm-workflow-delete', id: workflow.id }; renderInspector(); });
    return [
      inspectorHeader('Workflow', workflow.exampleId ? 'Seeded ADLC example' : 'Browser-local draft'),
      el('div', { class: 'workflow-panel-body' }, [
        field('Name', name),
        field('Description', description),
        el('section', { class: 'workflow-inspector-section' }, [
          el('h3', {}, 'Graph rules'),
          el('p', { class: 'muted' }, 'Multiple roots and disconnected lanes are valid. Connections must remain acyclic.'),
        ]),
        deleteButton,
      ]),
    ];
  }

  function nodeInspector(node) {
    const workflow = currentWorkflow();
    const name = textInput(node.name || nodeLabel(node, state), { maxlength: '100', disabled: !canEdit });
    const description = textArea(node.description || nodeDescription(node, state), { maxlength: '600', rows: '4', disabled: !canEdit });
    name.addEventListener('input', () => updateSelectedNode({ name: name.value }));
    description.addEventListener('input', () => updateSelectedNode({ description: description.value }));
    const body = [field('Card name', name), field('Description', description)];

    if (node.kind === 'approval') {
      const role = el('select', { disabled: !canEdit }, APPROVER_ROLES.map(([, label]) => option(label, label, label === node.requiredRole)));
      role.addEventListener('change', () => updateSelectedNode({ requiredRole: role.value }));
      const criteria = textArea(lines(node.reviewCriteria), { maxlength: '1000', rows: '4', disabled: !canEdit });
      criteria.addEventListener('input', () => updateSelectedNode({ reviewCriteria: lineList(criteria.value) }));
      const instructions = textArea(node.instructions, { maxlength: '1000', rows: '3', disabled: !canEdit });
      instructions.addEventListener('input', () => updateSelectedNode({ instructions: instructions.value }));
      const rejection = textArea(node.rejectionHandling, { maxlength: '1000', rows: '3', disabled: !canEdit });
      rejection.addEventListener('input', () => updateSelectedNode({ rejectionHandling: rejection.value }));
      body.push(field('Approver role', role), field('Review criteria', criteria), field('Approval instructions', instructions), field('On rejection', rejection));
    } else {
      const profile = node.kind === 'agent' ? findAgentProfile(node.refId, state) : findContextProfile(node.refId, state);
      body.push(el('section', { class: 'workflow-inspector-section' }, [
        el('h3', {}, node.kind === 'agent' ? 'Agent profile' : 'Execution context'),
        el('p', {}, profile?.purpose || profile?.description || 'Profile details unavailable.'),
        el('small', { class: 'muted' }, profile?.custom ? 'Custom organization profile' : 'Curated platform profile'),
      ]));
      if (canEdit && profile?.custom) {
        const edit = el('button', { type: 'button' }, `Edit ${node.kind === 'agent' ? 'profile' : 'context'}`);
        edit.addEventListener('click', () => {
          selected = { kind: node.kind === 'agent' ? 'agent-profile' : 'context-profile', id: profile.id };
          renderInspector();
        });
        body.push(edit);
      }
    }

    const dependency = el('select', { disabled: !canEdit }, [
      option('', 'Choose an upstream node'),
      ...workflow.nodes.filter((candidate) => candidate.id !== node.id).map((candidate) => option(candidate.id, nodeLabel(candidate, state))),
    ]);
    const addDependency = el('button', { type: 'button', disabled: !canEdit }, 'Add dependency');
    addDependency.addEventListener('click', () => {
      if (!dependency.value) return;
      const result = addEdge(currentWorkflow(), { source: dependency.value, target: node.id });
      if (!result.ok) return toast(result.error || 'That dependency is not valid.', 'err');
      selected = { kind: 'edge', id: result.edge.id };
      acceptWorkflow(result.workflow);
    });
    body.push(el('section', { class: 'workflow-inspector-section' }, [
      el('h3', {}, 'Dependencies'),
      el('p', { class: 'muted' }, 'Keyboard alternative to drawing a connection.'),
      dependency,
      addDependency,
    ]));
    const remove = el('button', { type: 'button', class: 'danger', disabled: !canEdit }, 'Delete node');
    remove.addEventListener('click', () => { selected = { kind: 'confirm-node-delete', id: node.id }; renderInspector(); });
    body.push(remove);
    return [inspectorHeader(nodeLabel(node, state), nodeKindLabel(node, state)), el('div', { class: 'workflow-panel-body' }, body)];
  }

  function edgeInspector(edge) {
    const workflow = currentWorkflow();
    const source = workflow.nodes.find((node) => node.id === edge.source);
    const target = workflow.nodes.find((node) => node.id === edge.target);
    const supportsOutcome = source?.kind === 'approval';
    const outcome = el('select', { disabled: !canEdit || !supportsOutcome }, [
      option('', 'Default continuation', !edge.outcome),
      option('approved', 'Approved', edge.outcome === 'approved'),
      option('rejected', 'Rejected', edge.outcome === 'rejected'),
    ]);
    outcome.addEventListener('change', () => {
      const result = updateEdge(currentWorkflow(), edge.id, { outcome: outcome.value || undefined });
      if (!result.ok) return toast(result.error || 'The connection could not be updated.', 'err');
      acceptWorkflow(result.workflow, { inspector: false, controls: false });
    });
    const remove = el('button', { type: 'button', class: 'danger', disabled: !canEdit }, 'Delete connection');
    remove.addEventListener('click', () => { selected = { kind: 'confirm-edge-delete', id: edge.id }; renderInspector(); });
    return [
      inspectorHeader('Connection', `${nodeLabel(source, state)} → ${nodeLabel(target, state)}`),
      el('div', { class: 'workflow-panel-body' }, [
        el('section', { class: 'workflow-inspector-section workflow-connection-summary' }, [
          el('strong', {}, nodeLabel(source, state)), icon('right', { size: 15 }), el('strong', {}, nodeLabel(target, state)),
        ]),
        field(
          'Outcome label',
          outcome,
          supportsOutcome
            ? 'Use approval/rejection labels for explicit decision branches.'
            : 'Outcome labels are available only on connections leaving an approval node.',
        ),
        remove,
      ]),
    ];
  }

  function agentProfileForm(existing = null) {
    const name = textInput(existing?.name, { required: true, maxlength: '80', placeholder: 'e.g. Accessibility reviewer' });
    const category = el('select', {}, AGENT_CATEGORIES.map((value) => option(value, value, value === existing?.category)));
    const description = textArea(existing?.description, { maxlength: '300', rows: '3', placeholder: 'Short palette description' });
    const purpose = textArea(existing?.purpose, { maxlength: '800', rows: '4', placeholder: 'What decision or outcome does this agent own?' });
    const inputs = textArea(lines(existing?.inputs), { maxlength: '1200', rows: '3', placeholder: 'One expected input per line' });
    const outputs = textArea(lines(existing?.outputs), { maxlength: '1200', rows: '3', placeholder: 'One expected output per line' });
    const guardrails = textArea(lines(existing?.guardrails), { maxlength: '1600', rows: '4', placeholder: 'One non-negotiable guardrail per line' });
    const runtime = el('select', {}, [
      option('organization-default', 'Organization default', !existing?.runtime || existing?.runtime === 'organization-default'),
      option('deep-agent', 'DeepAgent', existing?.runtime === 'deep-agent'),
      option('codex-sdk', 'Codex SDK', existing?.runtime === 'codex-sdk'),
      option('claude-agent-sdk', 'Claude Agent SDK', existing?.runtime === 'claude-agent-sdk'),
      option('manual', 'Manual handoff', existing?.runtime === 'manual'),
    ]);
    const model = el('select', {}, [
      option('organization-default', 'Organization default', !existing?.modelPreference || existing?.modelPreference === 'organization-default'),
      option('quality', 'Quality', existing?.modelPreference === 'quality'),
      option('balanced', 'Balanced', existing?.modelPreference === 'balanced'),
      option('fast', 'Fast', existing?.modelPreference === 'fast'),
      option('economy', 'Economy', existing?.modelPreference === 'economy'),
    ]);
    const tools = textInput((existing?.tools || []).join(', '), { maxlength: '500', placeholder: 'e.g. web_search, test_run' });
    const skills = textInput((existing?.skills || []).join(', '), { maxlength: '500', placeholder: 'e.g. web-research, software-planning' });
    const form = el('form', { class: 'workflow-profile-form' }, [
      field('Name', name), field('Category', category), field('Description', description),
      field('Purpose', purpose), field('Inputs', inputs), field('Outputs', outputs), field('Guardrails', guardrails),
      el('details', { class: 'workflow-advanced' }, [
        el('summary', {}, 'Advanced profile'),
        el('div', { class: 'workflow-advanced-body' }, [
          field('Runtime', runtime), field('Model preference', model), field('Tools', tools, 'Names only; no arguments.'), field('Skills', skills),
          el('p', { class: 'workflow-secret-warning' }, 'Do not enter credentials, executable code, HTML, or tool arguments. This prototype does not execute profiles.'),
        ]),
      ]),
      el('div', { class: 'workflow-form-actions' }, [
        el('button', { type: 'button', dataset: { cancel: 'true' } }, 'Cancel'),
        el('button', { type: 'submit', class: 'primary' }, existing ? 'Save agent' : 'Create agent'),
      ]),
    ]);
    form.querySelector('[data-cancel]').addEventListener('click', () => { selected = { kind: 'workflow', id: state.activeWorkflowId }; renderInspector(); });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const payload = {
        name: name.value, category: category.value, description: description.value, purpose: purpose.value,
        inputs: lineList(inputs.value), outputs: lineList(outputs.value), guardrails: lineList(guardrails.value),
        runtime: runtime.value, modelPreference: model.value, tools: commaList(tools.value), skills: commaList(skills.value),
      };
      const result = existing ? updateCustomAgent(state, existing.id, payload) : createCustomAgent(state, payload);
      if (!result.ok) return toast(result.error || 'The custom agent could not be saved.', 'err');
      selected = { kind: 'agent-profile', id: result.agent.id };
      acceptState(result.state, { palette: true, canvas: true, inspector: true });
      toast(existing ? 'Custom agent updated.' : 'Custom agent created.');
    });
    return form;
  }

  function contextProfileForm(existing = null) {
    const name = textInput(existing?.name, { required: true, maxlength: '80', placeholder: 'e.g. Staging sandbox' });
    const description = textArea(existing?.description, { maxlength: '500', rows: '4', placeholder: 'Describe this non-secret execution context.' });
    const form = el('form', { class: 'workflow-profile-form' }, [
      field('Context name', name), field('Description', description),
      el('p', { class: 'workflow-secret-warning' }, 'Context profiles are descriptive only. Never store credentials or environment-variable values here.'),
      el('div', { class: 'workflow-form-actions' }, [
        el('button', { type: 'button', dataset: { cancel: 'true' } }, 'Cancel'),
        el('button', { type: 'submit', class: 'primary' }, existing ? 'Save context' : 'Create context'),
      ]),
    ]);
    form.querySelector('[data-cancel]').addEventListener('click', () => { selected = { kind: 'workflow', id: state.activeWorkflowId }; renderInspector(); });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const payload = { name: name.value, description: description.value };
      const result = existing ? updateCustomContext(state, existing.id, payload) : createCustomContext(state, payload);
      if (!result.ok) return toast(result.error || 'The context could not be saved.', 'err');
      selected = { kind: 'context-profile', id: result.context.id };
      acceptState(result.state, { palette: true, canvas: true, inspector: true });
      toast(existing ? 'Context updated.' : 'Context created.');
    });
    return form;
  }

  function profileInspector(kind, id) {
    const isAgent = kind === 'agent-profile';
    const existing = isAgent ? state.customAgents.find((item) => item.id === id) : state.customContexts.find((item) => item.id === id);
    if (!existing) return [inspectorHeader('Profile unavailable'), el('div', { class: 'workflow-panel-body' }, 'This custom profile no longer exists.')];
    const remove = el('button', { type: 'button', class: 'danger', disabled: !canEdit }, `Delete ${isAgent ? 'agent' : 'context'}`);
    remove.addEventListener('click', () => { selected = { kind: isAgent ? 'confirm-agent-delete' : 'confirm-context-delete', id }; renderInspector(); });
    return [
      inspectorHeader(existing.name, isAgent ? 'Custom agent profile' : 'Custom execution context'),
      el('div', { class: 'workflow-panel-body' }, [isAgent ? agentProfileForm(existing) : contextProfileForm(existing), remove]),
    ];
  }

  function confirmationInspector() {
    const workflow = currentWorkflow();
    if (selected.kind === 'confirm-node-delete') {
      const node = workflow.nodes.find((item) => item.id === selected.id);
      const references = workflow.edges.filter((edge) => edge.source === selected.id || edge.target === selected.id).length;
      return [inspectorHeader('Delete node', nodeLabel(node, state)), el('div', { class: 'workflow-panel-body' }, [inlineConfirm({
        title: `Delete ${nodeLabel(node, state)}?`,
        body: references ? `This also removes ${references} connected ${references === 1 ? 'edge' : 'edges'}.` : 'This standalone node will be removed from the canvas.',
        confirmLabel: 'Delete node',
        onCancel: () => { selected = { kind: 'node', id: node.id }; renderInspector(); },
        onConfirm: () => {
          const result = deleteNode(workflow, node.id);
          if (!result.ok) return toast(result.error || 'The node could not be deleted.', 'err');
          selected = { kind: 'workflow', id: workflow.id };
          acceptWorkflow(result.workflow);
        },
      })])];
    }
    if (selected.kind === 'confirm-edge-delete') {
      return [inspectorHeader('Delete connection'), el('div', { class: 'workflow-panel-body' }, [inlineConfirm({
        title: 'Delete this connection?', body: 'The two nodes remain on the canvas.', confirmLabel: 'Delete connection',
        onCancel: () => { selected = { kind: 'edge', id: selected.id }; renderInspector(); },
        onConfirm: () => {
          const result = deleteEdge(workflow, selected.id);
          if (!result.ok) return toast(result.error || 'The connection could not be deleted.', 'err');
          selected = { kind: 'workflow', id: workflow.id };
          acceptWorkflow(result.workflow);
        },
      })])];
    }
    if (selected.kind === 'confirm-workflow-delete') {
      return [inspectorHeader('Delete workflow'), el('div', { class: 'workflow-panel-body' }, [inlineConfirm({
        title: `Delete ${workflow.name}?`, body: 'This browser-local draft and all of its nodes will be removed.', confirmLabel: 'Delete workflow',
        onCancel: () => { selected = { kind: 'workflow', id: workflow.id }; renderInspector(); },
        onConfirm: () => {
          const result = deleteWorkflow(state, workflow.id);
          if (!result.ok) return toast(result.error || 'The workflow could not be deleted.', 'err');
          selected = { kind: 'workflow', id: result.state.activeWorkflowId };
          acceptState(result.state, { palette: false, canvas: true, inspector: true });
        },
      })])];
    }
    const isAgent = selected.kind === 'confirm-agent-delete';
    if (isAgent || selected.kind === 'confirm-context-delete') {
      const profile = isAgent ? state.customAgents.find((item) => item.id === selected.id) : state.customContexts.find((item) => item.id === selected.id);
      return [inspectorHeader(`Delete ${isAgent ? 'agent' : 'context'}`), el('div', { class: 'workflow-panel-body' }, [inlineConfirm({
        title: `Delete ${profile?.name || 'this profile'}?`, body: 'Deletion is blocked while any workflow node references this profile.', confirmLabel: 'Delete profile',
        onCancel: () => { selected = { kind: isAgent ? 'agent-profile' : 'context-profile', id: selected.id }; renderInspector(); },
        onConfirm: () => {
          const result = isAgent ? deleteCustomAgent(state, selected.id) : deleteCustomContext(state, selected.id);
          if (!result.ok) return toast(result.error || 'Remove referencing nodes before deleting this profile.', 'err');
          selected = { kind: 'workflow', id: state.activeWorkflowId };
          acceptState(result.state, { palette: true, canvas: true, inspector: true });
        },
      })])];
    }
    return [];
  }

  function renderInspector() {
    if (!inspectorHost) return;
    const workflow = currentWorkflow();
    let content;
    if (selected.kind.startsWith('confirm-')) content = confirmationInspector();
    else if (selected.kind === 'node') {
      const node = workflow.nodes.find((item) => item.id === selected.id);
      content = node ? nodeInspector(node) : workflowInspector(workflow);
    } else if (selected.kind === 'edge') {
      const edge = workflow.edges.find((item) => item.id === selected.id);
      content = edge ? edgeInspector(edge) : workflowInspector(workflow);
    } else if (selected.kind === 'new-agent') content = [inspectorHeader('New custom agent', 'Organization-local prototype profile'), el('div', { class: 'workflow-panel-body' }, agentProfileForm())];
    else if (selected.kind === 'new-context') content = [inspectorHeader('New context', 'Non-secret execution context'), el('div', { class: 'workflow-panel-body' }, contextProfileForm())];
    else if (selected.kind === 'agent-profile' || selected.kind === 'context-profile') content = profileInspector(selected.kind, selected.id);
    else if (selected.kind === 'confirm-reset') content = [inspectorHeader('Reset examples'), el('div', { class: 'workflow-panel-body' }, [inlineConfirm({
      title: 'Reset all seeded examples?', body: 'Example graphs return to their original layout. Custom workflows and profiles remain.', confirmLabel: 'Reset examples',
      onCancel: () => { selected = { kind: 'workflow', id: workflow.id }; renderInspector(); },
      onConfirm: () => {
        const result = resetSeededWorkflows(state);
        if (!result.ok) return toast(result.error || 'Examples could not be reset.', 'err');
        selected = { kind: 'workflow', id: result.state.activeWorkflowId };
        acceptState(result.state, { palette: true, canvas: true, inspector: true });
        toast('Seeded examples reset.');
      },
    })])];
    else content = workflowInspector(workflow);
    clear(inspectorHost).append(...content);
  }

  function mount() {
    workflowSelect = el('select', { 'aria-label': 'Active workflow' });
    workflowSelect.addEventListener('change', () => activateWorkflow(workflowSelect.value));
    const newWorkflowButton = el('button', { type: 'button', disabled: !canEdit }, 'New blank');
    newWorkflowButton.addEventListener('click', () => {
      const workflow = createWorkflow({ name: 'Untitled workflow', description: 'A new organization ADLC workflow.' });
      const result = upsertWorkflow(state, workflow);
      if (!result.ok) return toast(result.error || 'A workflow could not be created.', 'err');
      result.state.activeWorkflowId = workflow.id;
      selected = { kind: 'workflow', id: workflow.id };
      acceptState(result.state, { palette: false, canvas: true, inspector: true });
    });
    const duplicateButton = el('button', { type: 'button', disabled: !canEdit }, 'Duplicate');
    duplicateButton.addEventListener('click', () => {
      const source = currentWorkflow();
      const copy = cloneWorkflow(source, { name: `${source.name} copy`, exampleId: null });
      const result = upsertWorkflow(state, copy);
      if (!result.ok) return toast(result.error || 'The workflow could not be duplicated.', 'err');
      result.state.activeWorkflowId = copy.id;
      selected = { kind: 'workflow', id: copy.id };
      acceptState(result.state, { palette: false, canvas: true, inspector: true });
    });
    const resetButton = el('button', { type: 'button', disabled: !canEdit }, 'Reset examples');
    resetButton.addEventListener('click', () => {
      selected = { kind: 'confirm-reset', id: '' };
      renderInspector();
      designer?.classList.remove('is-palette-open');
      designer?.classList.add('is-inspector-open');
    });
    statusHost = el('span', { class: 'workflow-toolbar-status', role: 'status', 'aria-live': 'polite' }, 'Saved locally · not shared');
    summaryHost = el('span', { class: 'workflow-summary' });
    paletteHost = el('aside', { class: 'workflow-panel workflow-palette', 'aria-label': 'Agent palette' });
    canvasHost = el('section', { class: 'workflow-canvas-shell', 'aria-label': 'Workflow canvas' });
    inspectorHost = el('aside', { class: 'workflow-panel workflow-inspector', 'aria-label': 'Workflow inspector' });
    designer = el('div', { class: 'workflow-designer' }, [paletteHost, canvasHost, inspectorHost]);
    const header = el('header', { class: 'workflow-header' }, [
      el('div', { class: 'workflow-header-copy' }, [
        el('span', { class: 'workflow-eyebrow' }, 'Local ADLC prototype'),
        el('div', { class: 'workflow-title-row' }, [el('h1', { class: 'workflow-title' }, `${organization.name} workflows`), el('span', { class: 'workflow-prototype-badge' }, 'Does not execute')]),
        el('p', {}, 'Compose curated and custom agents, execution contexts, and human decisions. Disconnected lanes are valid independent workflows.'),
        summaryHost,
      ]),
      el('div', { class: 'workflow-toolbar' }, [
        el('div', { class: 'workflow-toolbar-group' }, [workflowSelect, newWorkflowButton, duplicateButton, resetButton]),
        statusHost,
      ]),
    ]);
    clear(view).append(el('section', {
      class: `workflow-page${canEdit ? '' : ' is-readonly'}`,
      'aria-readonly': String(!canEdit),
      dataset: { organizationId: organization.id, editable: String(canEdit) },
    }, [
      header,
      !canEdit ? el('div', { class: 'workflow-readonly-banner', role: 'note' }, [
        icon('info', { size: 16 }), el('span', {}, 'Read-only organization view. An organization admin can edit this browser-local copy.'),
      ]) : null,
      loaded.error ? el('div', { class: 'workflow-recovery-banner', role: 'status' },
        /storage/i.test(loaded.error)
          ? `${loaded.error} Changes will last only for this session.`
          : 'A damaged or outdated local draft was replaced with safe examples.') : null,
      designer,
    ]));
    renderWorkflowOptions();
    renderPalette();
    renderCanvas();
    renderInspector();
    updateSummary();
    if (loaded.error && /storage/i.test(loaded.error)) setSaveStatus('Session only · storage unavailable', 'error');
  }

  mount();
}
