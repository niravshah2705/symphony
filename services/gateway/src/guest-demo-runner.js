'use strict';

/**
 * Guest demo runner — turns a clicked id into the next scripted turn.
 *
 * It is a pure module behind an injected surface (`store`, `catalog`, `crset`,
 * `deployer`, `now`) for two reasons. Nothing here may reach a tenant: no
 * `createProxy`, no orchestrator hop, no kagent client, no billing gate — so the
 * absence of those imports is the isolation proof, and injection keeps the route
 * testable without a cluster, a Firebase project, or a model.
 *
 * The `crset` step renders the genuine four-CR set through the real renderer and
 * returns it as a string artifact. Nothing is applied: a guest has no
 * organization, so the only credential a real run could resolve would be a
 * platform-managed one, and handing anonymous browser traffic a spend path would
 * defeat the EULA and billing gates that exist to prevent exactly that.
 */

class GuestDemoError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const SIMULATED_PREVIEW_HEADER = 'Simulated preview - nothing was applied to a cluster.';

function nowIso(now) {
  return new Date(now()).toISOString();
}

function createGuestDemoRunner({ store, catalog, crset, deployer = null, config, now = () => Date.now() } = {}) {
  if (!store || !catalog || !crset || !config) {
    throw new TypeError('createGuestDemoRunner requires store, catalog, crset and config');
  }
  const { GUEST_DEMO, findGuestCommand, findGuestNode, findGuestAnswer, resolveNext, guestCommandSummaries, RESTART } = catalog;
  const maxMessages = config.maxMessages;
  const sessionTtlMs = config.sessionTtlMs;
  const previewTtlMs = config.previewTtlMs;
  // The catalogue spells the retention window as `{days}` rather than a literal,
  // so the sentence cannot outlive the number it quotes.
  const retentionDays = String(Math.max(1, Math.round(previewTtlMs / 86400000)));
  const withDays = (value) => (typeof value === 'string' ? value.split('{days}').join(retentionDays) : value);

  /** The public starter list: ids the visitor may click, and nothing else. */
  function commands() {
    return {
      schema: GUEST_DEMO.schema,
      version: GUEST_DEMO.version,
      agent: { id: GUEST_DEMO.agent.id, label: GUEST_DEMO.agent.label },
      notice: Object.fromEntries(Object.entries(GUEST_DEMO.notice).map(([key, value]) => [key, withDays(value)])),
      templates: GUEST_DEMO.templates,
      maxMessages,
      sessionTtlMs,
      previewTtlMs,
      commands: guestCommandSummaries(),
    };
  }

  /**
   * A visitor message is the server's own echo of what was clicked, never text
   * from the browser — so the transcript cannot carry a prompt injection someone
   * "typed". The assistant turn is the fixed acknowledgement.
   */
  function clickedMessage(label) {
    return { role: 'user', kind: 'guest-echo', text: label };
  }

  function ackMessage() {
    return { role: 'assistant', kind: 'guest-echo', text: GUEST_DEMO.echo };
  }

  function sessionView(session) {
    if (!session) return null;
    return {
      id: session.id,
      commandId: session.commandId,
      nodeId: session.nodeId,
      flowId: session.flowId,
      template: session.template,
      variant: session.variant || {},
      expiresAt: session.expiresAt,
      previewUrl: session.previewToken ? previewUrlFor(session.previewToken) : null,
      previewExpiresAt: session.previewExpiresAt,
    };
  }

  function previewUrlFor(token) {
    const base = config.previewBaseUrl;
    if (!base || !token) return null;
    return `${String(base).replace(/\/+$/, '')}/${encodeURIComponent(token)}/`;
  }

  /** Load a session and fail the way the route needs it to be reported. */
  function requireSession(sessionId) {
    if (typeof sessionId !== 'string' || !/^gcs_[0-9a-f-]{36}$/.test(sessionId)) {
      throw new GuestDemoError(400, 'guest_session_id_invalid', 'A demo session id is required.');
    }
    const session = store.getGuestSession(sessionId);
    if (!session || store.isGuestSessionExpired(session, now())) {
      // One code for "never existed" and "aged out": distinguishing them would
      // let a caller probe which ids were issued, and the SPA reacts the same way
      // either way — start a fresh session.
      throw new GuestDemoError(410, 'guest_session_expired', 'This demo session is no longer available.');
    }
    return session;
  }

  /**
   * Every starter click opens its own session — a guest may run as many as they
   * like, and closing the tab loses the thread, which is what the footer notice
   * promises. The per-IP limit and the store's caps are what bound that.
   */
  function startSession({ commandId } = {}) {
    const command = findGuestCommand(commandId);
    if (!command) throw new GuestDemoError(400, 'guest_command_unknown', 'That starter option is not available.');

    const session = store.createGuestSession({
      commandId: command.id,
      nodeId: command.entryNode,
      template: command.template || null,
    });
    const appended = store.appendGuestMessages(session.id, [clickedMessage(command.labelFallback), ackMessage()]);
    if (appended.overflow) throw new GuestDemoError(500, 'guest_session_write_failed', 'The demo session could not be recorded.');

    return {
      session: sessionView(appended.session),
      turn: { role: 'assistant', text: GUEST_DEMO.echo, kind: 'guest-echo' },
      next: resolveNext(command.entryNode),
    };
  }

  /** Run the scripted flow: render the CR set, release the preview, return steps. */
  async function runFlow(flowTarget, session) {
    const flow = resolveNext(flowTarget);
    if (flow.kind !== 'flow') throw new GuestDemoError(500, 'guest_flow_unknown', 'That demo run is not available.');

    const rendered = crset.buildSkillCrSet({
      skill: GUEST_DEMO.agent,
      cliKey: GUEST_DEMO.cliKey,
      workerPool: config.workerPool,
      snapshotLocation: config.snapshotLocation,
    });
    const yaml = crset.renderCrSet(rendered, { header: SIMULATED_PREVIEW_HEADER });

    let preview = null;
    let deployNote = null;
    if (deployer && session.template && config.deployerUrl) {
      preview = await deployer.deploy({ template: session.template, variant: session.variant || {} });
      if (preview && preview.token) {
        store.setGuestPreview(session.id, {
          previewToken: preview.token,
          previewExpiresAt: new Date(now() + previewTtlMs).toISOString(),
        });
      }
    } else {
      // No deployer configured (local dev) is not an error: the visitor still
      // sees the plan and the CR set, and the step says the preview was skipped.
      deployNote = 'preview-publishing-disabled';
    }

    const steps = flow.steps.map((source) => {
      const step = { ...source, label: withDays(source.label) };
      if (step.id === 'crset') return { ...step, status: 'done', artifacts: { 'agent-crset.yaml': yaml } };
      if (step.id === 'live-url') {
        return { ...step, status: preview ? 'done' : 'skipped', note: preview ? null : deployNote, url: preview ? previewUrlFor(preview.token) : null };
      }
      return { ...step, status: 'done' };
    });

    // `then` is what moves the session on past the flow, so it has to survive the
    // step rendering — dropping it leaves the visitor stuck on the answered node.
    return {
      flow: { kind: 'flow', id: flow.id, steps, ...(flow.then ? { then: flow.then } : {}) },
      preview: preview ? previewUrlFor(preview.token) : null,
    };
  }

  /**
   * The one mutation a guest can make: "I clicked this answer on this node".
   * `nodeId` must equal where the session actually is, so a caller cannot skip
   * ahead to a node they were never offered or replay an answer. Answering moves
   * the session ON to the next question — which is what makes the next request's
   * `nodeId` check meaningful, and why a re-sent answer lands on 409 instead of
   * running the same step twice.
   */
  async function answer({ sessionId, nodeId, answerId } = {}) {
    const session = requireSession(sessionId);
    if (typeof nodeId !== 'string' || nodeId !== session.nodeId) {
      throw new GuestDemoError(409, 'guest_node_stale', 'This demo step has already moved on.');
    }
    const node = findGuestNode(nodeId);
    const choice = findGuestAnswer(node, answerId);
    if (!choice) throw new GuestDemoError(400, 'guest_answer_unknown', 'That option is not available for this step.');

    const onward = choice.next && choice.next !== RESTART ? resolveNext(choice.next) : null;
    const position = { template: choice.template || session.template, variant: choice.variant || {} };
    if (onward && onward.kind === 'question') position.nodeId = onward.id;

    const updated = store.touchGuestSession(session.id, position);
    const ack = ackMessage();
    const appended = store.appendGuestMessages(session.id, [clickedMessage(choice.labelFallback), ack]);
    // The acknowledgement is returned as `turn` for the same reason the command
    // response carries it: the transcript the browser paints should be the copy
    // the server stored, not text the browser invented from the button label.
    const turn = { role: ack.role, text: ack.text, kind: ack.kind };
    // The store's own slice bound is the storage guard; `maxMessages` is the
    // product limit, and the visitor has to be told about it rather than watch
    // the transcript silently stop growing.
    if (appended.overflow || appended.session.messages.length >= maxMessages) {
      return {
        session: sessionView(appended.session),
        turn,
        next: { kind: 'terminal', id: 'guest_message_cap', label: `This demo session holds ${maxMessages} messages. Sign in to keep going.`, labelKey: 'guestMessageCap', messages: maxMessages, stopped: 'message_cap' },
      };
    }

    // A customisation re-releases the SAME preview URL with the merged variant.
    // It never moves the expiry: clicking more does not buy more retention.
    if (choice.redeploy && deployer && config.deployerUrl && updated.previewToken) {
      await deployer.redeploy({
        token: updated.previewToken,
        template: updated.template,
        variant: updated.variant || {},
      });
    }

    // The restart leaf hands the visitor a new session rather than continuing
    // this one; there is nothing to carry over and no identity to carry it on.
    if (choice.next === RESTART) {
      return { session: sessionView(appended.session), turn, next: { kind: 'restart', id: RESTART } };
    }

    // A documentation answer is the one step that reaches a real read endpoint.
    // The query text is the server's, and the browser makes the call itself.
    if (choice.query) {
      return {
        session: sessionView(appended.session),
        turn,
        next: { kind: 'knowledge-search', id: choice.id, query: choice.query, label: choice.labelFallback, labelKey: choice.labelKey, then: onward },
      };
    }

    if (onward && onward.kind === 'flow') {
      const { flow, preview } = await runFlow(onward.id, appended.session);
      const after = flow.then ? resolveNext(flow.then) : null;
      const settled = store.touchGuestSession(session.id, {
        flowId: flow.id,
        // A flow with no question after it ends the thread. Leaving the previous
        // node id in place would offer the same deploy again on a reload — and a
        // second deploy means a second preview URL for one click.
        ...(after && after.kind === 'question' ? { nodeId: after.id } : { nodeId: null }),
      });
      return { session: sessionView(settled), turn, preview, next: after, flow };
    }

    return {
      session: sessionView(appended.session),
      turn,
      next: onward || { kind: 'terminal', id: 'guest_end', label: 'That is the end of this demo.', labelKey: 'guestDemoEnd' },
    };
  }

  /** Rehydrate a tab's transcript. Expired or unknown reads as empty, not broken. */
  function getSession(sessionId) {
    if (typeof sessionId !== 'string' || !/^gcs_[0-9a-f-]{36}$/.test(sessionId)) return { session: null, messages: [], next: null };
    const session = store.getGuestSession(sessionId);
    if (!session || store.isGuestSessionExpired(session, now())) return { session: null, messages: [], next: null };
    // `next` is the tree position, and a reload without it lands the visitor on a
    // transcript with no buttons: the answered step cannot be re-run (the store
    // has moved on and a stale `nodeId` is a 409), so it has to be re-offered.
    // A session that finished mid-flow resolves to the question after it, or null.
    return {
      session: sessionView(session),
      messages: (session.messages || []).map(({ id, role, text, kind, ts }) => ({ id, role, text, kind, ts })),
      next: resolveNext(session.nodeId),
    };
  }

  return { commands, startSession, answer, getSession, sessionView, previewUrlFor, GuestDemoError };
}

module.exports = { createGuestDemoRunner, GuestDemoError, SIMULATED_PREVIEW_HEADER };
