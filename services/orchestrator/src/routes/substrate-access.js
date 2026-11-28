'use strict';

/**
 * Shared substrate control-plane access helpers.
 *
 * Extracted from routes/agent.js so that both the substrate routes and the
 * fleet read surface resolve a tenant's atespace and per-request credential
 * through exactly one code path. Credential/atespace resolution must never be
 * duplicated (a second owner of the substrate bearer is a second rotation path
 * and an audit gap); this module is that single owner.
 */

const { getSettings } = require('@software-factory/shared/store');
const { CONFIG } = require('@software-factory/shared/config');
const { normalizeEventContext } = require('@software-factory/shared/messaging/events');
const substrate = require('@software-factory/shared/agent/substrate');

/**
 * The gateway-forwarded organization/project selection, normalized. Reads the
 * two x-ai-fleet-* headers the gateway injected; there is no client-trusted
 * source of tenant scope below the gateway boundary.
 */
function requestWorkspaceContext(req) {
  const getHeader = (name) => {
    if (req && typeof req.get === 'function') return req.get(name);
    return req && req.headers ? req.headers[name] : undefined;
  };
  return normalizeEventContext({
    organizationId: getHeader('x-ai-fleet-organization-id') || '',
    projectId: getHeader('x-ai-fleet-project-id') || '',
  });
}

/**
 * The tenant a substrate call operates on.
 *
 * The gateway-validated workspace context is the only authoritative source. Query
 * and body used to WIN over it, so any caller with a valid session could point the
 * control plane — atespace resolution, actor creation, credential sync — at another
 * organization's namespace simply by naming it. A caller that names a tenant the
 * gateway did not admit is refused as though it did not exist: 404, not 403, so the
 * endpoint cannot be used to enumerate which orgs a deployment serves
 * (services/org/CLAUDE.md invariant 1).
 */
function substrateContext(req) {
  const context = requestWorkspaceContext(req);
  const settings = getSettings();
  const claimed = (name) => (
    (typeof req.query?.[name] === 'string' && req.query[name].trim())
    || (typeof req.body?.[name] === 'string' && req.body[name].trim())
    || ''
  );
  const claimedOrganizationId = claimed('organizationId');
  const claimedProjectId = claimed('projectId');
  for (const [validated, requested] of [
    [context.organizationId, claimedOrganizationId],
    [context.projectId, claimedProjectId],
  ]) {
    if (validated && requested && requested !== validated) {
      const err = new Error('context_not_found');
      err.status = 404;
      throw err;
    }
  }
  const organizationId = context.organizationId || claimedOrganizationId || 'default';
  const projectId = context.projectId || claimedProjectId || 'default';
  return { settings, organizationId, projectId, context };
}

/**
 * Resolve everything a substrate control-plane call needs, in one place: the
 * tenant, the atespace that tenant owns, the URL and the per-request credential.
 *
 * `?atespace=` used to be handed to the resolver unconditionally on the status
 * route. On a shared stack the operator allowlist names every tenant space — that
 * is what makes one process serve many orgs — so a caller who was already admitted
 * to one organization could point a read, or any verb built on this function, at
 * another organization's namespace by naming it, while its own tenant sat in the
 * same headers. A named atespace is therefore only honored when nothing is pinned:
 * the local / auth-disabled profile, where one process serves one workspace and the
 * query string is the only signal there is.
 */
async function substrateAccess(req) {
  const { settings, organizationId, projectId, context } = substrateContext(req);
  const resolve = (atespace) => substrate.resolveSubstrateAtespace({
    atespace, organizationId, projectId,
  });
  const home = resolve(settings.substrateAtespace);
  const claimed = typeof req.query?.atespace === 'string' ? req.query.atespace.trim() : '';
  const pinned = Boolean(context.organizationId);
  if (claimed && pinned && claimed !== home) {
    const err = new Error('context_not_found');
    err.status = 404;
    throw err;
  }
  const atespace = claimed && !pinned ? resolve(claimed) : home;
  const url = settings.substrateUrl || CONFIG.SUBSTRATE?.url || '';
  // Resolved per request: the ateapi bearer is a projected service-account token
  // that rotates hourly, so a stale one must not outlive this call.
  const token = await substrate.resolveSubstrateApiToken({
    token: settings.substrateApiToken,
    organizationId,
    projectId,
  });
  return { settings, organizationId, projectId, atespace, url, token };
}

/**
 * Control-plane health + the live actor list for the request's tenant, shaped for
 * the browser. `?projectId=` narrows the list to one project's actors. It is a
 * *display* filter, not a scope: the atespace already fixed the tenant, and an
 * Actor carries no project field (metadata is atespace/name/uid/version), so the
 * only project signal is the token `plan-<project>-<run>` that
 * createEphemeralActor embeds in the name — computed here by the same expression
 * that writes it. Two projects sharing the first 12 sanitized characters therefore
 * share a prefix, which is why the response echoes the prefix it matched on
 * instead of implying an exact filter.
 */
async function listRunningActors(req) {
  const { settings, atespace, url, token, projectId } = await substrateAccess(req);
  // Sequential: the actor list is only fetched once the control plane answers,
  // so it cannot share a Promise.all with the status call it depends on.
  const status = await substrate.getControlPlaneStatus({ url, atespace, token });
  const listed = url && token && status && status.connected
    ? await substrate.listActors({ url, atespace, token }).catch(() => [])
    : [];
  const wantProject = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
  const namePrefix = wantProject ? `plan-${substrate.actorProjectToken(wantProject)}-` : '';
  return {
    agentPattern: settings.agentPattern || 'substrate',
    atespace,
    workerPool: substrate.resolveSubstrateWorkerPool(settings.substrateWorkerPool),
    ingressUrl: substrate.resolveSubstrateIngressUrl(settings.substrateIngressUrl),
    // `configured` now means "reachable AND authenticatable": a control plane
    // that answers 16 UNAUTHENTICATED is not usable, so the credential is part
    // of what configured asserts. `credentialConfigured` names which half is
    // missing (the managed secret substrateApiToken) so the UI can say so.
    configured: Boolean(url) && Boolean(token),
    credentialConfigured: Boolean(token),
    status,
    actors: listed
      .filter((a) => !namePrefix || String(a.metadata?.name || '').startsWith(namePrefix))
      .map((a) => ({
        name: a.metadata?.name,
        state: a.status?.state,
        workerPod: a.status?.workerPod,
        nodeName: a.status?.nodeName,
      })),
    projectFilter: wantProject ? { projectId: wantProject, namePrefix } : null,
    contextProjectId: projectId || '',
  };
}

module.exports = {
  requestWorkspaceContext,
  substrateContext,
  substrateAccess,
  listRunningActors,
};
