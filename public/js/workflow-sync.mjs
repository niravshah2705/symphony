/**
 * Server-first persistence for the workflow designer.
 *
 * The canvas used to save only to localStorage, so a graph belonged to one
 * browser. This module owns the trip to `/api/workflows`: it loads the tenant's
 * graphs, carries over a pre-existing localStorage draft exactly once, and
 * pushes edits with the revision the server last gave us.
 *
 * localStorage stays in play as a DRAFT CACHE, not the source of truth: every
 * change is written locally first, so an offline tab or a closed laptop loses
 * nothing, and the next successful flush reconciles against the server copy.
 *
 * Revision conflicts are surfaced rather than resolved. Two tabs (or two
 * people) editing one graph is a decision for a human; silently last-write-wins
 * is how a teammate's lane disappears.
 */

export const WORKFLOW_SYNC_SOURCES = Object.freeze(['server', 'imported', 'seed', 'offline']);

function isOfflineError(error) {
  // A network failure has no HTTP status. Anything with a status reached the
  // gateway, so the session is online and the response is a real answer.
  return !error || typeof error.status !== 'number';
}

function isConflict(error) {
  return Boolean(error && (error.code === 'revision_conflict' || error.status === 409));
}

export function createWorkflowSync({ client, model, storage = null, organizationId = '', canWrite = true }) {
  if (!client || typeof client.getWorkflows !== 'function') {
    throw new TypeError('createWorkflowSync needs a workflows API client');
  }
  if (!model || typeof model.normalizeState !== 'function') {
    throw new TypeError('createWorkflowSync needs the workflow model');
  }

  const revisions = new Map();
  const signatures = new Map();
  const onServer = new Set();
  const removed = new Set();
  let offline = false;
  let seededExamples = false;
  let context = {
    persona: null, grants: null, personas: [], gateTemplate: null,
    canAdminDefaults: false, agents: [], loaded: false,
  };

  /**
   * A draft is only a draft if this browser actually stored one. Rehydrating an
   * absent key yields the built-in examples, and treating those as a draft would
   * import five graphs into a tenant that never had them.
   */
  function readDraft() {
    if (!storage || !organizationId) return null;
    try {
      const key = model.storageKeyForOrganization(organizationId);
      if (!key || storage.getItem(key) == null) return null;
      const result = model.readStateFromStorage(storage, organizationId);
      return result && result.state ? result.state : null;
    } catch (_) {
      return null;
    }
  }

  function writeDraft(state) {
    if (!storage || !organizationId) return { ok: false, error: 'Local storage is unavailable.' };
    try {
      return model.writeStateToStorage(storage, organizationId, state);
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : 'Local storage is unavailable.' };
    }
  }

  /**
   * What this browser still owes the server. Saves are debounced and a push can
   * be interrupted by a reload, a closed lid, or a dropped connection, so the
   * debt is written before the requests and cleared as each one is acknowledged.
   * Without it, the next load would take the server copy and quietly discard the
   * edit — the opposite of the draft-first promise above.
   */
  function debtKey() {
    const key = model.storageKeyForOrganization(organizationId);
    return key ? `${key}.pending` : '';
  }

  function readDebt() {
    const empty = { dirty: [], deleted: [] };
    if (!storage || !debtKey()) return empty;
    try {
      const raw = storage.getItem(debtKey());
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object') return empty;
      const ids = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []);
      return { dirty: ids(parsed.dirty), deleted: ids(parsed.deleted) };
    } catch (_) {
      return empty;
    }
  }

  function writeDebt({ dirty, deleted }) {
    if (!storage || !debtKey()) return;
    try {
      if (dirty.length || deleted.length) storage.setItem(debtKey(), JSON.stringify({ dirty, deleted }));
      else storage.removeItem(debtKey());
    } catch (_) {
      // The draft is the durable copy; losing the marker costs a redundant push.
    }
  }

  function recordRevisions(payload) {
    revisions.clear();
    onServer.clear();
    removed.clear();
    for (const workflow of payload.workflows || []) {
      if (!workflow || !workflow.id) continue;
      onServer.add(workflow.id);
      if (Number.isInteger(workflow.revision)) revisions.set(workflow.id, workflow.revision);
    }
  }

  /**
   * Which graphs the server already holds verbatim. Without it a flush would PUT
   * every graph on every keystroke — and merely switching the active workflow,
   * which changes no graph at all, would write the whole collection. The
   * signature is taken from the canvas state rather than the server payload so
   * both sides of the comparison are normalized the same way.
   */
  function contentSignature(workflow) {
    const { revision, ...rest } = workflow || {};
    return JSON.stringify(rest);
  }

  function recordContent(state) {
    signatures.clear();
    for (const workflow of (state && state.workflows) || []) {
      if (workflow && workflow.id) signatures.set(workflow.id, contentSignature(workflow));
    }
  }

  /** Build canvas state from a server payload, falling back to the local draft. */
  function stateFrom(payload, draft, { schemaVersion = 2 } = {}) {
    const built = model.normalizeState({
      schemaVersion,
      activeWorkflowId: payload.activeWorkflowId
        || (draft && draft.activeWorkflowId)
        || (payload.workflows && payload.workflows[0] && payload.workflows[0].id)
        || '',
      workflows: payload.workflows || [],
      customAgents: (draft && draft.customAgents) || [],
      customContexts: (draft && draft.customContexts) || [],
    });
    return built && built.state ? built.state : built;
  }

  /**
   * Re-apply what this browser still owes the server: graphs it edited or
   * created but never pushed, and deletions the server has not seen. Anything
   * not in the debt keeps the server's copy, so a teammate's newer work wins.
   */
  function mergeDebt(serverState, draft, debt) {
    if (!debt.dirty.length && !debt.deleted.length) return serverState;
    const deleted = new Set(debt.deleted);
    const owed = new Set(debt.dirty);
    const byId = new Map(((draft && draft.workflows) || []).map((graph) => [graph.id, graph]));
    const graphs = (serverState.workflows || [])
      .filter((graph) => !deleted.has(graph.id))
      .map((graph) => (owed.has(graph.id) && byId.has(graph.id) ? byId.get(graph.id) : graph));
    for (const id of owed) {
      if (deleted.has(id) || !byId.has(id)) continue;
      if (!graphs.some((graph) => graph.id === id)) graphs.push(byId.get(id));
    }
    return stateFrom({ workflows: graphs }, draft);
  }

  async function load() {
    const draft = readDraft();
    const debt = readDebt();
    let payload;
    try {
      payload = await client.getWorkflows();
    } catch (error) {
      if (isOfflineError(error)) {
        offline = true;
        if (draft) return { state: draft, source: 'offline', error, context: { ...context } };
        return { state: model.createInitialState(), source: 'offline', error, context: { ...context } };
      }
      // 401/403 is not a persistence problem; the caller's session handling owns it.
      throw error;
    }

    context = {
      persona: payload.persona || null,
      grants: payload.grants || null,
      personas: payload.personas || [],
      gateTemplate: payload.gateTemplate || null,
      canAdminDefaults: Boolean(payload.canAdminDefaults),
      agents: payload.agents || [],
      loaded: true,
    };

    let workflows = Array.isArray(payload.workflows) ? payload.workflows : [];
    let source = 'server';
    const draftGraphs = draft && Array.isArray(draft.workflows) ? draft.workflows : [];

    if (!workflows.length && draftGraphs.length && canWrite) {
      // The server imports into an empty collection inside a transaction, so a
      // second tab racing us gets `skipped` rather than a duplicate graph.
      let imported = null;
      try {
        imported = await client.importWorkflows(draftGraphs);
      } catch (error) {
        if (!isOfflineError(error) && error.status !== 400) throw error;
        imported = null;
      }
      if (imported && Array.isArray(imported.workflows) && imported.workflows.length) {
        workflows = imported.workflows;
        source = 'imported';
      }
    }

    if (!workflows.length) {
      // Nothing on the server and nothing local: the gateway already lazy-seeded
      // platform defaults, so an empty answer means seeding is off. Use the
      // built-in examples rather than showing a blank canvas.
      recordRevisions({ workflows: [] });
      const seeded = model.createInitialState();
      recordContent(seeded);
      seededExamples = true;
      return { state: seeded, source: 'seed', context: { ...context } };
    }

    recordRevisions({ workflows });
    seededExamples = false;
    const serverState = stateFrom({ workflows }, draft);
    recordContent(serverState);
    const state = mergeDebt(serverState, draft, debt);
    offline = false;
    writeDraft(state);
    // An interrupted save resumes here rather than being rolled back by the load
    // that follows it. The push is revision-checked, so a teammate who saved
    // first turns this into a conflict instead of being overwritten.
    if ((debt.dirty.length || debt.deleted.length) && canWrite) {
      return { state, source, sync: await flush(state), context: { ...context } };
    }
    return { state, source, context: { ...context } };
  }

  function revisionOf(id) {
    return revisions.has(id) ? revisions.get(id) : null;
  }

  /**
   * Push the canvas state. Draft-first: the local copy is written before any
   * request, so a failure here never loses work.
   */
  async function flush(state) {
    const draft = writeDraft(state);
    const draftWarning = draft.ok ? null : draft.error;
    if (!canWrite) return { status: 'readonly', draftWarning, context: { ...context } };
    if (offline) return { status: 'offline', draftWarning, context: { ...context } };

    try {
      if (seededExamples) {
        // The canvas is showing built-in examples this tenant does not have.
        // Adopt them with one transactional import rather than creating each
        // graph: if another tab filled the collection first, the server skips.
        const adopted = await client.importWorkflows(state.workflows || []);
        const list = adopted && Array.isArray(adopted.workflows) ? adopted.workflows : [];
        if (!list.length) {
          return { status: 'error', error: new Error('The workflow could not be saved.'), draftWarning, context: { ...context } };
        }
        recordRevisions({ workflows: list });
        recordContent(state);
        seededExamples = false;
        if (adopted.skipped) {
          return { status: 'conflict', serverWorkflows: list, draftWarning, context: { ...context } };
        }
        return { status: 'saved', workflows: list, draftWarning, context: { ...context } };
      }
      // A delete is only sent if the graph is still absent at push time: undoing
      // a deletion, or re-creating the same id, must not delete the new content.
      const present = new Set((state.workflows || []).map((workflow) => workflow.id));
      const outstanding = readDebt();
      const deletions = [...new Set([...removed, ...outstanding.deleted])].filter((id) => !present.has(id));
      const dirty = new Set(outstanding.dirty);
      for (const workflow of state.workflows || []) {
        if (!onServer.has(workflow.id) || signatures.get(workflow.id) !== contentSignature(workflow)) dirty.add(workflow.id);
      }
      // Record the debt before sending anything: a reload mid-push resumes from it.
      writeDebt({ dirty: [...dirty], deleted: deletions });
      for (const id of deletions) {
        await client.deleteWorkflow(id);
        onServer.delete(id);
        revisions.delete(id);
        signatures.delete(id);
        dirty.delete(id);
        writeDebt({ dirty: [...dirty], deleted: deletions.filter((pending) => pending !== id) });
      }
      removed.clear();
      for (const workflow of state.workflows || []) {
        if (!dirty.has(workflow.id)) continue;
        const signature = contentSignature(workflow);
        if (onServer.has(workflow.id)) {
          const saved = await client.putWorkflow(workflow.id, workflow, revisionOf(workflow.id));
          if (saved && Number.isInteger(saved.revision)) revisions.set(workflow.id, saved.revision);
        } else {
          const created = await client.createWorkflow(workflow);
          onServer.add(workflow.id);
          if (created && Number.isInteger(created.revision)) revisions.set(workflow.id, created.revision);
        }
        signatures.set(workflow.id, signature);
        dirty.delete(workflow.id);
        writeDebt({ dirty: [...dirty], deleted: deletions.filter((pending) => pending !== workflow.id) });
      }
      writeDebt({ dirty: [], deleted: [] });
    } catch (error) {
      if (isConflict(error)) {
        const serverCopy = (error.payload && error.payload.workflow) || null;
        return { status: 'conflict', serverWorkflow: serverCopy, draftWarning, context: { ...context } };
      }
      if (isOfflineError(error)) {
        offline = true;
        return { status: 'offline', draftWarning, context: { ...context } };
      }
      return { status: 'error', error, draftWarning, context: { ...context } };
    }

    return { status: 'saved', draftWarning, context: { ...context } };
  }

  function forget(id) {
    if (onServer.has(id)) removed.add(id);
    revisions.delete(id);
    signatures.delete(id);
  }

  return {
    load,
    flush,
    forget,
    isOffline: () => offline,
    setOnline: () => { offline = false; },
    revisionOf,
    context: () => ({ ...context }),
    writeDraft,
    readDraft,
  };
}
