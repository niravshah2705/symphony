'use strict';

/**
 * Durable approval gates for the requirement-evaluation step.
 *
 * When `evaluateRequirement` returns amber/red, the caller creates a gate that
 * HOLDS the business pipeline until a human refines/approves the requirement.
 * If no human responds within the configured wait window, the planner's
 * scheduler tick auto-approves and proceeds — documenting the decision.
 *
 * Durability comes from an ABSOLUTE persisted `deadline` (ISO), never an
 * in-memory timer: it survives a browser tab closing (state is server-side) and
 * a server restart (the next tick recomputes from the stored deadline). The
 * gate is a DETERMINISTIC, server-enforced guardrail — it does not rely on LLM
 * judgement to decide whether work may proceed.
 *
 * The store, model steps, and clock are injected via `deps` so the lifecycle is
 * unit-testable without the JSON store or a live model.
 */

const DEFAULT_WAIT_MINUTES = 120;
const DECIDED_STATUSES = Object.freeze(['approved', 'auto-approved']);

class GateError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'GateError';
    this.status = status;
  }
}

function resolveDeps(deps = {}) {
  const storeImpl = deps.store || require('../store');
  const bp = () => require('./business-pipeline');
  return {
    store: storeImpl,
    prepareBusiness: deps.prepareBusiness || ((args) => bp().prepareBusiness(args)),
    evaluateRequirement: deps.evaluateRequirement || ((args) => bp().evaluateRequirement(args)),
    saveMemory: deps.saveMemory || ((record) => storeImpl.addMemory(require('./memory').normalizeMemory(record))),
    getSettings: deps.getSettings || (() => storeImpl.getSettings()),
    getAssumedRole: deps.getAssumedRole || (() => storeImpl.getAssumedRole()),
    resolveBusiness: deps.resolveBusiness || ((businessId, context) => defaultResolveBusiness(storeImpl, businessId, context)),
    // Emit a gate transition to the global workspace channel so the SPA can drive
    // the terminal advance from SSE instead of polling the gate. Best-effort.
    publishGate: deps.publishGate || ((gateId, status) => require('./workspace-events').publishGate(gateId, status)),
    now: deps.now || (() => Date.now()),
  };
}

function defaultResolveBusiness(storeImpl, businessId, context = {}) {
  if (!businessId || typeof storeImpl.readStore !== 'function') return null;
  try {
    const organizationId = String(context.organizationId || context.orgId || '').trim();
    const projectId = String(context.projectId || context.nativeProjectId || '').trim();
    return (storeImpl.readStore().businesses || []).find((business) => {
      if (!business || business.id !== businessId) return false;
      if (!organizationId) return true;
      return String(business.orgId || business.organizationId || '') === organizationId
        && String(business.nativeProjectId || business.projectId || '') === projectId;
    }) || null;
  } catch (_) {
    return null;
  }
}

/** Absolute deadline = createdAt + waitMinutes. */
function computeDeadline(createdAtISO, waitMinutes) {
  const base = Date.parse(createdAtISO);
  const minutes = Number.isFinite(Number(waitMinutes)) ? Number(waitMinutes) : DEFAULT_WAIT_MINUTES;
  return new Date(base + minutes * 60_000).toISOString();
}

/**
 * Persist a new gate (amber/red only). The deadline is derived from the record's
 * own createdAt so it is exactly `waitMinutes` after creation.
 */
function createGate(fields, deps = {}) {
  const d = resolveDeps(deps);
  const waitMinutes = Number.isFinite(Number(fields.waitMinutes)) ? Number(fields.waitMinutes) : DEFAULT_WAIT_MINUTES;
  const record = d.store.addApprovalGate({
    requirement: String(fields.requirement || ''),
    businessId: fields.businessId || null,
    conversationId: fields.conversationId || null,
    evaluation: fields.evaluation || null,
    signal: fields.signal,
    waitMinutes,
    status: 'awaiting-approval',
    deadline: null,
    decidedAt: null,
    decision: null,
    proceededAt: null,
    jobId: null,
    attempts: Number.isFinite(Number(fields.attempts)) ? Number(fields.attempts) : 0,
    ...(fields.orgId ? { orgId: String(fields.orgId) } : {}),
    ...(fields.nativeProjectId ? { nativeProjectId: String(fields.nativeProjectId) } : {}),
  });
  return d.store.updateApprovalGate(record.id, { deadline: computeDeadline(record.createdAt, waitMinutes) });
}

/**
 * Run the gated pipeline for a decided gate. Idempotent: a gate already
 * `proceeded` short-circuits, and the status is latched to a decided value
 * BEFORE running so a concurrent/retry caller cannot double-run. If
 * `prepareBusiness` throws, the gate is left decided-but-not-proceeded and the
 * sweep retries it later (scheduler.enqueue dedupes, so no double-queue).
 */
async function proceedGate(inputGate, decision = {}, deps = {}) {
  const d = resolveDeps(deps);
  const store = d.store;
  const gate = store.getApprovalGate(inputGate && inputGate.id) || inputGate;
  if (!gate) throw new GateError('Approval gate not found.', 404);
  if (gate.status === 'proceeded') return { gate, business: null, alreadyProceeded: true };

  const by = decision.by === 'timeout' ? 'timeout' : 'human';
  const note = String(decision.note || (by === 'timeout' ? 'Auto-approved after timeout.' : 'Approved by operator.'));

  // Latch to a decided status only from `awaiting-approval` (retry path keeps its
  // existing decided status/decision).
  if (gate.status === 'awaiting-approval') {
    store.updateApprovalGate(gate.id, {
      status: by === 'timeout' ? 'auto-approved' : 'approved',
      decidedAt: new Date(d.now()).toISOString(),
      decision: { by, note },
    });
  }
  const decided = store.getApprovalGate(gate.id) || gate;
  const effective = decided.decision || { by, note };
  const gateContext = {
    organizationId: gate.orgId,
    projectId: gate.nativeProjectId,
  };

  const business = await d.prepareBusiness({
    input: gate.requirement,
    business: d.resolveBusiness(gate.businessId, gateContext),
    settings: d.getSettings(),
    assumedRole: d.getAssumedRole(),
    ...(gate.orgId ? { orgId: gate.orgId } : {}),
    ...(gate.nativeProjectId ? { nativeProjectId: gate.nativeProjectId } : {}),
  });

  // Document the decision durably — outlives the gate record.
  try {
    d.saveMemory({
      scope: 'business',
      refId: gate.businessId || null,
      title: effective.by === 'timeout' ? 'Requirement gate auto-approved (timeout)' : 'Requirement gate approved',
      text: `${effective.note} Requirement: ${String(gate.requirement || '').slice(0, 300)}`,
      source: 'approval-gate',
      ...(gate.orgId ? { orgId: gate.orgId } : {}),
      ...(gate.nativeProjectId ? { nativeProjectId: gate.nativeProjectId } : {}),
    });
  } catch (_) {
    // Best-effort documentation; never block proceeding on a memory-write failure.
  }

  const jobId = (business && business.scheduler && business.scheduler.jobId) || null;
  const finalized = store.updateApprovalGate(gate.id, { status: 'proceeded', proceededAt: new Date(d.now()).toISOString(), jobId });
  // The gate advanced (human approve OR timeout auto-approve both land here) —
  // tell watching browsers so they run the pipeline without polling the gate.
  d.publishGate(gate.id, 'proceeded', {
    organizationId: gate.orgId,
    projectId: gate.nativeProjectId,
  });
  return { gate: finalized || { ...decided, status: 'proceeded' }, business };
}

/** Human "approve & proceed now". Only valid from an awaiting gate. */
async function approveGate(id, deps = {}) {
  const d = resolveDeps(deps);
  const gate = d.store.getApprovalGate(id);
  if (!gate) throw new GateError('Approval gate not found.', 404);
  if (gate.status !== 'awaiting-approval') throw new GateError(`Gate is already ${gate.status}.`, 409);
  return proceedGate(gate, { by: 'human', note: 'Approved by operator.' }, deps);
}

/**
 * Refine + re-score. Supersedes the current gate, re-evaluates the new input,
 * and returns {evaluation, signal, gate}. Green → no gate (caller proceeds);
 * amber/red → a fresh gate (deadline clock restarts on human engagement).
 */
async function reevaluateGate(id, input, deps = {}) {
  const d = resolveDeps(deps);
  const gate = d.store.getApprovalGate(id);
  if (!gate) throw new GateError('Approval gate not found.', 404);
  if (gate.status !== 'awaiting-approval') throw new GateError(`Gate is already ${gate.status}.`, 409);

  const gateContext = {
    organizationId: gate.orgId,
    projectId: gate.nativeProjectId,
  };
  const out = await d.evaluateRequirement({
    input,
    settings: d.getSettings(),
    business: d.resolveBusiness(gate.businessId, gateContext),
    ...(gate.orgId ? { orgId: gate.orgId } : {}),
    ...(gate.nativeProjectId ? { nativeProjectId: gate.nativeProjectId } : {}),
  });
  d.store.updateApprovalGate(gate.id, { status: 'superseded' });
  // The gate a browser is watching is now terminal — tell it to stop the poll.
  d.publishGate(gate.id, 'superseded', {
    organizationId: gate.orgId,
    projectId: gate.nativeProjectId,
  });

  if (out.blocked) return { evaluation: null, signal: out.signal, gate: null, blocked: true, answer: out.answer };
  if (out.signal === 'green') return { evaluation: out.evaluation, signal: 'green', gate: null };

  const next = createGate({
    requirement: out.goal,
    businessId: gate.businessId,
    conversationId: gate.conversationId,
    evaluation: out.evaluation,
    signal: out.signal,
    waitMinutes: gate.waitMinutes,
    attempts: (Number(gate.attempts) || 0) + 1,
    orgId: gate.orgId,
    nativeProjectId: gate.nativeProjectId,
  }, deps);
  return { evaluation: out.evaluation, signal: out.signal, gate: next };
}

/**
 * Scheduler tick worker. (1) Auto-approve awaiting gates past their deadline.
 * (2) Restart recovery: re-drive gates decided but not yet proceeded (a crash
 * between the two writes). Each gate is isolated so one failure cannot stall the
 * sweep. Returns per-gate results for logging.
 */
async function sweepExpiredGates(now = Date.now(), deps = {}) {
  const d = resolveDeps(deps);
  const store = d.store;
  const results = [];

  for (const gate of store.listApprovalGates({ status: 'awaiting-approval' })) {
    if (Date.parse(gate.deadline) <= now) {
      try {
        results.push(await proceedGate(gate, { by: 'timeout', note: `No human response within ${gate.waitMinutes} minutes; auto-approved per policy.` }, deps));
      } catch (err) {
        results.push({ gate: gate.id, error: err && err.message });
      }
    }
  }

  for (const gate of store.listApprovalGates()) {
    if (DECIDED_STATUSES.includes(gate.status) && !gate.proceededAt) {
      try {
        results.push(await proceedGate(gate, gate.decision || { by: 'timeout', note: 'Resumed after restart.' }, deps));
      } catch (err) {
        results.push({ gate: gate.id, error: err && err.message });
      }
    }
  }
  return results;
}

module.exports = {
  GateError,
  DEFAULT_WAIT_MINUTES,
  computeDeadline,
  createGate,
  proceedGate,
  approveGate,
  reevaluateGate,
  sweepExpiredGates,
};
