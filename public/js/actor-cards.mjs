// The actor-card rule, in one place.
//
// `GET /api/agent/substrate/status` returns raw substrate state (an atespace, a
// control-plane health object, and actors whose `state` is one of the eight
// ACTOR_STATE values in packages/shared-core/src/agent/substrate.js). "Needs
// attention" is not a substrate concept — there is no server field for it — so it
// is derived here rather than in a view, and every screen that shows actors reads
// the same three buckets from the same function. A second copy in a view is how one
// screen starts calling a CRASHED actor "paused".

const RUNNING = ['RUNNING', 'RESUMING'];
const PAUSED = ['SUSPENDED', 'SUSPENDING'];

// UNSPECIFIED is in here on purpose: it is what decodeActor answers for a state the
// control plane reported but this client cannot name (a newer substrate version, a
// missing field), and an actor nobody can describe is exactly what a human is for.
const ATTENTION = ['CRASHED', 'REVERTING', 'DELETING', 'UNSPECIFIED'];

export const ACTOR_BUCKETS = Object.freeze({
  running: Object.freeze([...RUNNING]),
  paused: Object.freeze([...PAUSED]),
  attention: Object.freeze([...ATTENTION]),
});

function stateOf(actor) {
  const state = String((actor && actor.state) || '').trim().toUpperCase();
  return state || 'UNSPECIFIED';
}

/** One of 'running' | 'paused' | 'attention' for a single actor. */
export function bucketFor(actor) {
  const state = stateOf(actor);
  if (RUNNING.includes(state)) return 'running';
  if (PAUSED.includes(state)) return 'paused';
  if (ATTENTION.includes(state)) return 'attention';
  return 'attention';
}

/**
 * Why the plane is not answering, in the order an operator can act on: no address
 * configured, no credential, control plane unreachable, or the plane is fine and the
 * actor itself is the problem. A run card that says only "needs attention" for all
 * four sends the user to the wrong screen.
 */
function attentionReason(payload, actor) {
  if (!payload || payload.configured === false) {
    return payload && payload.credentialConfigured === false
      ? 'The substrate is configured, but its control-plane credential is missing.'
      : 'Substrate is not configured for this organization.';
  }
  if (!payload.status || payload.status.connected === false) {
    return 'The substrate control plane is not answering.';
  }
  if (!actor) return 'No actors are running in this workspace right now.';
  const state = stateOf(actor);
  if (state === 'CRASHED') return 'The run stopped unexpectedly.';
  if (state === 'REVERTING') return 'The actor is rolling back to its last snapshot.';
  if (state === 'DELETING') return 'The actor is being torn down.';
  return `The control plane reported state ${state.toLowerCase()}, which this build does not recognize.`;
}

function card(actor, reason, canAct = true) {
  const name = String((actor && actor.name) || '');
  return {
    name,
    state: stateOf(actor),
    bucket: bucketFor(actor),
    workerPod: (actor && actor.workerPod) || '',
    nodeName: (actor && actor.nodeName) || '',
    reason,
    // Paused runs can be resumed; live ones can be suspended; both can be deleted.
    // The verbs are workspace:write on the gateway, so a read-only member gets the
    // board without buttons that would answer 403.
    actions: actor && canAct
      ? (bucketFor(actor) === 'paused' ? ['resume', 'delete'] : ['suspend', 'resume', 'delete'])
      : [],
  };
}

/**
 * The card view model for one organization's atespace.
 *
 * `payload` is the status response verbatim. The project filter is applied
 * server-side (an Actor carries no project field, so only the server can map a
 * project to the `plan-<project>-` prefix in its actor names) and echoed back as
 * `projectFilter`, which is why the filtered-by case is reported rather than implied.
 */
export function buildActorCards(payload = {}, { canAct = true } = {}) {
  const actors = Array.isArray(payload.actors) ? payload.actors : [];
  const planeDown = !payload || payload.configured === false
    || !payload.status || payload.status.connected === false;

  const buckets = { running: [], paused: [], attention: [] };
  for (const actor of actors) buckets[bucketFor(actor)].push(card(actor, attentionReason(payload, actor), canAct));

  // A plane that is not answering has no trustworthy actor list, and an empty grid
  // next to a spinner that is really an outage reads as "idle". So the outage is one
  // attention card with its reason, ahead of whatever else is on show.
  if (planeDown) buckets.attention.unshift(card(null, attentionReason(payload, null)));

  const empty = !buckets.running.length && !buckets.paused.length && !buckets.attention.length;

  return {
    buckets,
    counts: {
      running: buckets.running.length,
      paused: buckets.paused.length,
      attention: buckets.attention.length,
      total: actors.length,
    },
    atespace: payload.atespace || '',
    projectFilter: payload.projectFilter || null,
    // Honest about the one thing a name-prefix filter cannot promise.
    projectFilterNote: payload.projectFilter
      ? `Actors are matched by the name prefix "${payload.projectFilter.namePrefix}"; two projects whose ids agree in their first 12 characters share one prefix.`
      : '',
    emptyReason: empty
      ? (payload.projectFilter
        ? 'No runs for this project in this workspace.'
        : 'No actors are running in this workspace right now.')
      : '',
    planeDown,
  };
}
