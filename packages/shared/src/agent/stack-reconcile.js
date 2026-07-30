'use strict';

const store = require('../store');
const log = require('../logger');
const { repoParts } = require('./workspace');
const {
  forgeApiRequest,
  findReviewByBranch,
  repoApiPath,
  validateRepository,
} = require('./repository-broker');

/**
 * Lifecycle for stacked dependent PRs.
 *
 * When a dependent task's blocker PR was still open, the broker stacked the
 * dependent onto the blocker branch (fork + PR base). Both the blocker and the
 * dependent leave the active task queue the moment their PRs open, so this pass
 * — driven by the persisted `stackLinks` — is what eventually re-points a still
 * open stacked PR back to the default base once its blocker merges.
 *
 * Each link is handled independently and best-effort: a provider hiccup logs a
 * warning and leaves the link for the next tick; it never throws to the caller.
 */

/** Retarget an open review's base branch to the default base. */
async function retargetReview({ provider, repository, token, review, base, forgeRequest = forgeApiRequest }) {
  const api = repoApiPath(repository);
  if (provider === 'github') {
    await forgeRequest({
      provider, repository, token,
      method: 'PATCH', endpoint: `${api}/pulls/${review.id}`, body: { base }, redactSecrets: [token],
    });
    return;
  }
  await forgeRequest({
    provider, repository, token,
    method: 'PUT', endpoint: `${api}/merge_requests/${review.id}`, body: { target_branch: base }, redactSecrets: [token],
  });
}

/**
 * Reconcile every open stack link. `resolveSelection(projectId)` yields the
 * current `{ provider, repoRef, token }` for the link's project (the orchestrator
 * supplies the Linear/business-aware resolver). Returns a small summary for logs
 * and tests.
 */
// A stacked PR whose dependent review never appears (e.g. a run marked complete
// without opening a PR) would otherwise be re-checked forever. Drop such links
// once they age past this bound so the collection cannot grow without limit.
const STALE_LINK_MS = 14 * 24 * 60 * 60 * 1000;

async function reconcileStacks({
  resolveSelection,
  links = store.listStackLinks(),
  findReview = findReviewByBranch,
  retarget = retargetReview,
  removeLink = store.removeStackLink,
  updateLink = store.updateStackLink,
  repoPartsImpl = repoParts,
  validateRepositoryImpl = validateRepository,
  now = Date.now,
  staleLinkMs = STALE_LINK_MS,
  logger = log,
} = {}) {
  if (typeof resolveSelection !== 'function') {
    throw new Error('reconcileStacks requires a resolveSelection(projectId) function.');
  }
  const summary = { checked: 0, retargeted: 0, cleared: 0, skipped: 0 };
  for (const link of links) {
    summary.checked += 1;
    try {
      const selection = resolveSelection(link.projectId);
      // Pin the repo to the link's own recorded identity so a reconfigured or
      // deleted business (which resolves to the GLOBAL repo fallback) can never
      // make us act on a different, same-named branch. The token still comes
      // fresh from the selection since secrets are never persisted on the link.
      const provider = link.provider || (selection && selection.provider);
      const repoRef = link.repoFullName || (selection && selection.repoRef);
      const parts = provider && repoRef ? repoPartsImpl(repoRef, provider) : null;
      if (!parts) {
        summary.skipped += 1;
        continue;
      }
      const repository = validateRepositoryImpl(parts, provider);
      const token = selection && selection.token;
      const query = { provider, repository, token };

      const dependent = await findReview({ ...query, branch: link.dependentBranch });
      if (!dependent) {
        // PR not opened yet (or since removed). Retire the link once it is stale
        // so a never-opened dependent cannot pin it in the store forever.
        const age = link.createdAt ? now() - Date.parse(link.createdAt) : 0;
        if (Number.isFinite(age) && age > staleLinkMs) {
          removeLink(link.id);
          summary.cleared += 1;
        } else {
          summary.skipped += 1;
        }
        continue;
      }
      if (dependent.state === 'merged' || dependent.state === 'closed') {
        removeLink(link.id); // the dependent resolved on its own
        summary.cleared += 1;
        continue;
      }
      if (dependent.targetBranch === link.defaultBase) {
        removeLink(link.id); // already on the default base (e.g. forge auto-retarget)
        summary.cleared += 1;
        continue;
      }

      // Dependent PR still targets the blocker branch. Retarget once the blocker merges.
      const blocker = await findReview({ ...query, branch: link.blockerBranch });
      if (!blocker || blocker.state !== 'merged') {
        if (!link.dependentReviewId && dependent.id) {
          updateLink(link.id, { dependentReviewId: dependent.id, dependentReviewUrl: dependent.url || null });
        }
        summary.skipped += 1;
        continue;
      }

      await retarget({ ...query, review: dependent, base: link.defaultBase });
      removeLink(link.id);
      summary.retargeted += 1;
      (logger.info || (() => {}))(
        `Retargeted stacked PR ${dependent.url || dependent.id} from ${link.blockerBranch} to ${link.defaultBase} (blocker merged).`
      );
    } catch (error) {
      summary.skipped += 1;
      (logger.warn || (() => {}))(
        `Stack reconcile for ${link.dependentBranch}: ${error && error.message ? error.message : error}`
      );
    }
  }
  return summary;
}

module.exports = { reconcileStacks, retargetReview };
