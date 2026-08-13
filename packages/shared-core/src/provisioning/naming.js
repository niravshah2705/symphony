'use strict';

/**
 * Deterministic, Cloud-Run-safe names + URLs for a tenant's per-org stack.
 *
 * Everything derives from the org's opaque `deployment_slug` (`t`+12 hex of the
 * org id — see services/org Organization.deployment_slug), which is validated
 * here as defense-in-depth before it is ever interpolated into a Cloud Run /
 * Pub/Sub / Scheduler resource name (injection-attacks checklist: no
 * client-controlled value reaches an API arg unsanitized — the slug is derived
 * from a UUID, never from user input, but we still assert its shape).
 *
 * URLs use Cloud Run's deterministic per-project scheme
 *   https://<service>-<project_number>.<region>.run.app
 * (identical to deploy/gcp/terraform/locals.tf) so a service can be given its
 * OWN url as PUBSUB_PUSH_AUDIENCE at create time, and so the push-subscription /
 * scheduler OIDC audiences match what each service expects — no create→update
 * round-trip and no self-reference cycle.
 */

const SLUG_RE = /^t[a-z0-9]{1,48}$/;

function assertSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new Error(`invalid deployment slug: ${JSON.stringify(slug)}`);
  }
  return slug;
}

/** Cloud Run resource names for a tenant. */
function names(slug) {
  assertSlug(slug);
  return {
    gateway: `gw-${slug}`,
    planner: `pl-${slug}`,
    coder: `cc-${slug}`, // coder-control service
    orchestrator: `po-${slug}`,
    tester: `pt-${slug}`,
    deployer: `pd-${slug}`,
    worker: `cw-${slug}`, // coder-worker Cloud Run Job
    plannerTopic: `planner-${slug}`,
    coderTopic: `coder-${slug}`,
    plannerPushSub: `planner-${slug}-push`,
    coderPushSub: `coder-${slug}-push`,
    pipelinePlanTopic: `pipeline-plan-${slug}`,
    pipelineCodeTopic: `pipeline-code-${slug}`,
    pipelineTestTopic: `pipeline-test-${slug}`,
    pipelineDeployTopic: `pipeline-deploy-${slug}`,
    pipelinePlanResultsTopic: `pipeline-plan-results-${slug}`,
    pipelineCodeResultsTopic: `pipeline-code-results-${slug}`,
    pipelineTestResultsTopic: `pipeline-test-results-${slug}`,
    pipelineDeployResultsTopic: `pipeline-deploy-results-${slug}`,
    pipelinePlanPushSub: `pipeline-plan-${slug}-push`,
    pipelineCodePushSub: `pipeline-code-${slug}-push`,
    pipelineTestPushSub: `pipeline-test-${slug}-push`,
    pipelineDeployPushSub: `pipeline-deploy-${slug}-push`,
    pipelinePlanResultsPushSub: `pipeline-plan-results-${slug}-push`,
    pipelineCodeResultsPushSub: `pipeline-code-results-${slug}-push`,
    pipelineTestResultsPushSub: `pipeline-test-results-${slug}-push`,
    pipelineDeployResultsPushSub: `pipeline-deploy-results-${slug}-push`,
    plannerTick: `planner-tick-${slug}`,
    coderTick: `coder-tick-${slug}`,
  };
}

/** Deterministic https URLs for the three per-tenant services. */
function urls(slug, { projectNumber, region }) {
  assertSlug(slug);
  if (!projectNumber || !region) {
    throw new Error('urls() requires { projectNumber, region }');
  }
  const suffix = `${projectNumber}.${region}.run.app`;
  const n = names(slug);
  return {
    gateway: `https://${n.gateway}-${suffix}`,
    planner: `https://${n.planner}-${suffix}`,
    coder: `https://${n.coder}-${suffix}`,
    orchestrator: `https://${n.orchestrator}-${suffix}`,
    tester: `https://${n.tester}-${suffix}`,
    deployer: `https://${n.deployer}-${suffix}`,
  };
}

module.exports = { assertSlug, names, urls, SLUG_RE };
