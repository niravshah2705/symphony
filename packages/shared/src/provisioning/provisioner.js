'use strict';

const { buildPlan } = require('./plan');
const { names } = require('./naming');

/**
 * Runtime per-tenant provisioner (executor).
 *
 * Given a validated deployment slug + config + an injected `clients` adapter
 * (see index.js for the real @google-cloud adapter), it provisions a tenant's
 * gateway + planner + coder-control services, a coder-worker Job, per-tenant
 * Pub/Sub topics + push subscriptions, and Cloud Scheduler ticks — REUSING the
 * live SHARED services' images (no rebuild). All operations are idempotent
 * (create-if-absent), so a retried provision does not duplicate resources.
 *
 * The `clients` adapter is a small interface (not the raw GCP SDK) so this
 * orchestration is unit-testable with fakes:
 *   getServiceImage(name)/getJobImage(name) -> string
 *   createService({name,image,ingress,allowUnauthenticated,port,serviceAccount,env,invokers})
 *   createJob({name,image,serviceAccount,env})
 *   createTopic(name) / createPushSubscription(spec) / createSchedulerJob(spec)
 *   delete{Service,Job,Topic,Subscription,SchedulerJob}(name)
 * Each create resolves whether the resource was created or already existed.
 */

function nowIso() {
  // Normal runtime code (not a workflow script) — Date is available here.
  return new Date().toISOString();
}

/**
 * Provision a tenant stack. Returns the Organization.deployments map to persist.
 * @param {string} slug
 * @param {object} cfg  see plan.buildPlan cfg + { sourceServiceNames: {gateway,planner,coder,worker} }
 * @param {object} deps { clients }
 */
async function provision(slug, cfg, { clients }) {
  const plan = buildPlan(slug, cfg);
  const src = cfg.sourceServiceNames || {};

  // 1. Reuse the ORIGINAL images from the live SHARED services (no rebuild).
  const [gatewayImage, plannerImage, coderImage, workerImage] = await Promise.all([
    clients.getServiceImage(src.gateway),
    clients.getServiceImage(src.planner),
    clients.getServiceImage(src.coder),
    clients.getJobImage(src.worker),
  ]);

  // 2. Per-tenant topics (before subscriptions).
  for (const topic of plan.topics) await clients.createTopic(topic);

  // 3. Internal agent services first (their URLs back the subs/scheduler/gateway).
  await clients.createService({ ...plan.services.planner, image: plannerImage });
  await clients.createService({ ...plan.services.coder, image: coderImage });
  // 4. Worker Job (coder-control launches it by name).
  await clients.createJob({ ...plan.worker, image: workerImage });
  // 5. Public gateway (front-facing origin).
  await clients.createService({ ...plan.services.gateway, image: gatewayImage });

  // 6. Push subscriptions + scheduler ticks (endpoints now exist).
  for (const sub of plan.subscriptions) await clients.createPushSubscription(sub);
  for (const job of plan.schedulers) await clients.createSchedulerJob(job);

  return {
    status: 'provisioned',
    slug,
    gateway: { name: plan.services.gateway.name, url: plan.deploymentUrls.gateway, status: 'provisioned' },
    planner: { name: plan.services.planner.name, url: plan.deploymentUrls.planner, status: 'provisioned' },
    coder: { name: plan.services.coder.name, url: plan.deploymentUrls.coder, status: 'provisioned' },
    worker: { name: plan.worker.name, status: 'provisioned' },
    error: null,
    updated_at: nowIso(),
  };
}

/**
 * Tear a tenant stack down (on org delete). Idempotent: each delete ignores
 * NOT_FOUND. Deletes in reverse dependency order so nothing dangles.
 */
async function teardown(slug, { clients }) {
  const n = names(slug);
  // Scheduler + subs first (they reference service URLs), then services/job,
  // then topics. IAM bindings vanish with their resource.
  for (const job of [n.plannerTick, n.coderTick]) await clients.deleteSchedulerJob(job);
  for (const sub of [n.plannerPushSub, n.coderPushSub]) await clients.deleteSubscription(sub);
  for (const svc of [n.gateway, n.planner, n.coder]) await clients.deleteService(svc);
  await clients.deleteJob(n.worker);
  for (const topic of [n.plannerTopic, n.coderTopic]) await clients.deleteTopic(topic);
  return { status: 'torn_down', slug, updated_at: nowIso() };
}

module.exports = { provision, teardown };
