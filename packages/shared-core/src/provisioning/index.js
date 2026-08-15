'use strict';

const { provision, teardown } = require('./provisioner');
const { buildPlan } = require('./plan');
const { names, urls, assertSlug } = require('./naming');
const {
  extractSourceService,
  extractSourceJob,
  mergeServiceScaling,
  cloneContainers,
} = require('./containers');

/**
 * Real @google-cloud adapter for the provisioning executor.
 *
 * Implements the small `clients` interface provisioner.js expects on top of the
 * v2 Cloud Run, Pub/Sub, and Cloud Scheduler SDKs. All SDKs are required LAZILY
 * so importing this module (e.g. for provision/teardown re-exports or tests of
 * the pure core) never needs the GCP libraries installed. Every create/delete is
 * idempotent: ALREADY_EXISTS services/jobs are reconciled in place, while
 * ALREADY_EXISTS auxiliary resources and NOT_FOUND deletes are tolerated, so
 * retried provisions and teardowns converge on the current secure template.
 * After each service reconcile, revisions are bounded to the three newest so
 * tenant stacks follow the same rollback window as shared deployments.
 *
 * "Reuse original builds": createService/createJob copy the image AND the secret
 * env blocks, resource limits, execution environment, scaling, concurrency,
 * and skills volumes from the live SHARED source service/job. Explicit
 * per-service safety overrides (such as the pipeline's max-one ceiling) are
 * applied after the source profile.
 */

const ALREADY_EXISTS = 6; // gRPC ALREADY_EXISTS
const NOT_FOUND = 5; // gRPC NOT_FOUND
const CLOUD_RUN_REVISIONS_TO_KEEP = 3;
const PROVIDER_SECRET_ENV_RE = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?:$|_)/i;

function tolerate(codes, err) {
  if (err && codes.includes(err.code)) return;
  throw err;
}

function iamMember(value) {
  const member = String(value || '').trim();
  if (!member) return '';
  return member.includes(':') ? member : `serviceAccount:${member}`;
}

function assertContainerBoundary(spec, src, kind) {
  const primary = src.containers && src.containers[0];
  const secretEnv = (primary && primary.secretEnv) || [];
  if (spec.requireSecretFreePrimary && secretEnv.length) {
    throw new Error(`${spec.name} source app container contains secret env; ${kind} agents require sidecar-only credentials`);
  }
  if (spec.forbidProviderSecretsOnPrimary) {
    const forbidden = secretEnv.find((entry) => PROVIDER_SECRET_ENV_RE.test(String(entry.name || '')));
    if (forbidden) {
      throw new Error(`${spec.name} source app container contains forbidden provider credential env ${forbidden.name}`);
    }
  }
  if ((spec.requireEgressProxy || spec.requireProxySidecar) && (!src.containers || src.containers.length < 2)) {
    throw new Error(`${spec.name} source ${kind} has no required proxy sidecar`);
  }
}

async function awaitOperation(start) {
  const [operation] = await start;
  await operation.promise();
}

function revisionCreatedAt(revision) {
  const value = revision && revision.createTime;
  if (!value) return Number.NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return parsed;
  }

  if (value.seconds === undefined || value.seconds === null) return Number.NaN;
  const seconds = value.seconds && typeof value.seconds.toNumber === 'function'
    ? value.seconds.toNumber()
    : Number(value.seconds);
  const nanos = value.nanos === undefined || value.nanos === null ? 0 : Number(value.nanos);
  return Number.isFinite(seconds) && Number.isFinite(nanos)
    ? (seconds * 1000) + (nanos / 1e6)
    : Number.NaN;
}

function revisionId(name) {
  return String(name || '').split('/').filter(Boolean).pop() || '';
}

/**
 * Reconcile a Cloud Run resource after create reports ALREADY_EXISTS.
 *
 * Updates require the server-owned fully-qualified name. Carrying the etag
 * forward also makes reconciliation fail on a concurrent modification instead
 * of silently overwriting it with a stale template.
 */
async function updateExistingRunResource({ client, kind, name, desired, updateMask }) {
  const resourceKey = kind === 'service' ? 'service' : 'job';
  const getMethod = kind === 'service' ? 'getService' : 'getJob';
  const updateMethod = kind === 'service' ? 'updateService' : 'updateJob';
  const [existing] = await client[getMethod]({ name });
  if (!existing || !String(existing.name || '').trim()) {
    throw new Error(`Cloud Run ${kind} ${name} has no server identity`);
  }

  const resource = {
    ...desired,
    name: existing.name,
    ...(existing.etag ? { etag: existing.etag } : {}),
  };
  const request = { [resourceKey]: resource };
  if (updateMask) request.updateMask = updateMask;
  await awaitOperation(client[updateMethod](request));
}

let runClients = null;
function getRun() {
  if (!runClients) {
    const { ServicesClient, JobsClient, RevisionsClient } = require('@google-cloud/run').v2;
    runClients = {
      services: new ServicesClient(),
      jobs: new JobsClient(),
      revisions: new RevisionsClient(),
    };
  }
  return runClients;
}
let pubsubClient = null;
function getPubSub() {
  if (!pubsubClient) {
    const { PubSub } = require('@google-cloud/pubsub');
    pubsubClient = new PubSub();
  }
  return pubsubClient;
}
let schedulerClient = null;
function getScheduler() {
  if (!schedulerClient) {
    const { CloudSchedulerClient } = require('@google-cloud/scheduler').v1;
    schedulerClient = new CloudSchedulerClient();
  }
  return schedulerClient;
}

/** Build the executor's `clients` adapter bound to a project/region. */
function createGcpClients({ projectId, region }, dependencies = {}) {
  const parent = `projects/${projectId}/locations/${region}`;
  const services = () => (dependencies.run || getRun()).services;
  const jobs = () => (dependencies.run || getRun()).jobs;
  const revisions = () => (dependencies.run || getRun()).revisions;

  const serviceSrcCache = new Map();
  const jobSrcCache = new Map();
  async function sourceService(name) {
    if (!serviceSrcCache.has(name)) {
      const [svc] = await services().getService({ name: `${parent}/services/${name}` });
      // Capture ALL containers (image + secret env + resources + mounts each) so
      // an egress-proxy sidecar on the shared service propagates to tenant stacks.
      serviceSrcCache.set(name, extractSourceService(svc));
    }
    return serviceSrcCache.get(name);
  }

  async function sourceJob(name) {
    if (!jobSrcCache.has(name)) {
      const [job] = await jobs().getJob({ name: `${parent}/jobs/${name}` });
      // Jobs have a different template nesting than services. Read the shared
      // worker Job so its app + proxy resources are inherited independently.
      jobSrcCache.set(name, extractSourceJob(job));
    }
    return jobSrcCache.get(name);
  }

  async function setInvoker(spec) {
    const members = spec.allowUnauthenticated
      ? ['allUsers']
      : (spec.invokers || []).map((sa) => `serviceAccount:${sa}`);
    if (!members.length) return;
    await services().setIamPolicy({
      resource: `${parent}/services/${spec.name}`,
      policy: { bindings: [{ role: 'roles/run.invoker', members }] },
    });
  }

  async function listServiceRevisions(serviceName) {
    const service = `${parent}/services/${serviceName}`;
    const [items] = await revisions().listRevisions({ parent: service });
    const sortable = [...items].map((revision) => {
      if (!revisionId(revision && revision.name)) {
        throw new Error(`Cloud Run service ${serviceName} returned a revision without a server identity`);
      }
      const createdAt = revisionCreatedAt(revision);
      if (!Number.isFinite(createdAt)) {
        throw new Error(
          `Cloud Run revision ${revision.name} has no valid creation timestamp; refusing unsafe cleanup`,
        );
      }
      return { revision, createdAt };
    });
    sortable.sort((left, right) => right.createdAt - left.createdAt);
    return sortable.map(({ revision }) => revision);
  }

  async function pruneServiceRevisions(serviceName) {
    const servicePath = `${parent}/services/${serviceName}`;
    const [service] = await services().getService({ name: servicePath });
    if (!service || !String(service.name || '').trim()) {
      throw new Error(`Cloud Run service ${serviceName} has no server identity after reconciliation`);
    }

    const current = await listServiceRevisions(serviceName);
    const stale = current.slice(CLOUD_RUN_REVISIONS_TO_KEEP).reverse();
    const protectedRevisionIds = new Set([
      revisionId(service.latestCreatedRevision),
      revisionId(service.latestReadyRevision),
      ...(service.trafficStatuses || [])
        .filter((target) => Number(target.percent || 0) > 0 || String(target.tag || '').trim())
        .map((target) => revisionId(target.revision)),
    ].filter(Boolean));
    const protectedStale = stale.filter((revision) => protectedRevisionIds.has(revisionId(revision.name)));
    if (protectedStale.length) {
      throw new Error(
        `Unable to retain only ${CLOUD_RUN_REVISIONS_TO_KEEP} revisions for Cloud Run service ${serviceName}; `
        + `older revision ${protectedStale[0].name} is latest, receives traffic, or has a traffic tag`,
      );
    }

    for (const revision of stale) {
      if (!String(revision.etag || '').trim()) {
        throw new Error(
          `Cloud Run revision ${revision.name} has no etag; refusing deletion without a concurrency precondition`,
        );
      }
      try {
        await awaitOperation(revisions().deleteRevision({
          name: revision.name,
          etag: revision.etag,
        }));
      } catch (err) {
        const detail = err && err.message ? `: ${err.message}` : '';
        throw new Error(
          `Unable to retain only ${CLOUD_RUN_REVISIONS_TO_KEEP} revisions for Cloud Run service ${serviceName}; `
          + `failed to delete ${revision.name}${detail}`,
          { cause: err },
        );
      }
    }

    const remaining = await listServiceRevisions(serviceName);
    if (remaining.length > CLOUD_RUN_REVISIONS_TO_KEEP) {
      throw new Error(
        `Cloud Run service ${serviceName} still has ${remaining.length} revisions after pruning; `
        + `expected at most ${CLOUD_RUN_REVISIONS_TO_KEEP}`,
      );
    }
  }

  return {
    async getServiceImage(name) {
      return (await sourceService(name)).containers[0].image;
    },
    async getJobImage(name) {
      return (await sourceJob(name)).containers[0].image;
    },
    async createService(spec) {
      const src = spec.sourceName ? await sourceService(spec.sourceName) : { containers: [] };
      assertContainerBoundary(spec, src, 'service');
      const service = {
        ingress: spec.ingress,
        labels: spec.labels,
        template: {
          serviceAccount: spec.serviceAccount,
          // Preserve the source service's parameterized scaling profile while
          // allowing pipeline stages to apply their stricter explicit ceiling.
          scaling: mergeServiceScaling(src.scaling, spec.maxInstanceCount),
          ...(spec.requestTimeoutSeconds != null
            ? { timeout: { seconds: spec.requestTimeoutSeconds } }
            : {}),
          executionEnvironment: src.executionEnvironment,
          maxInstanceRequestConcurrency: src.maxInstanceRequestConcurrency,
          volumes: src.volumes,
          // Clone every source container by default, overlaying per-tenant env
          // on the primary and `sidecarEnv` on sidecars. An explicit
          // primaryContainerOnly spec converges a legacy service to one app.
          containers: cloneContainers(src.containers, spec, { withPorts: true }),
        },
      };
      try {
        await awaitOperation(services().createService({ parent, serviceId: spec.name, service }));
      } catch (err) {
        if (!err || err.code !== ALREADY_EXISTS) throw err;
        await updateExistingRunResource({
          client: services(),
          kind: 'service',
          name: `${parent}/services/${spec.name}`,
          desired: service,
          updateMask: { paths: ['ingress', 'labels', 'template'] },
        });
      }
      await setInvoker(spec);
      await pruneServiceRevisions(spec.name);
    },
    async createJob(spec) {
      const src = spec.sourceName ? await sourceJob(spec.sourceName) : { containers: [] };
      assertContainerBoundary(spec, src, 'job');
      const job = {
        labels: spec.labels,
        template: {
          template: {
            serviceAccount: spec.serviceAccount,
            timeout: { seconds: 86400 },
            maxRetries: 1,
            executionEnvironment: src.executionEnvironment,
            volumes: src.volumes,
            containers: cloneContainers(src.containers, spec, { withPorts: false }),
          },
        },
      };
      try {
        await awaitOperation(jobs().createJob({ parent, jobId: spec.name, job }));
      } catch (err) {
        if (!err || err.code !== ALREADY_EXISTS) throw err;
        await updateExistingRunResource({
          client: jobs(),
          kind: 'job',
          name: `${parent}/jobs/${spec.name}`,
          desired: job,
        });
      }
    },
    async createTopic(topic) {
      const name = typeof topic === 'string' ? topic : topic.name;
      const labels = typeof topic === 'string' ? undefined : topic.labels;
      const handle = getPubSub().topic(name);
      try {
        await getPubSub().createTopic({ name, labels });
      } catch (err) {
        tolerate([ALREADY_EXISTS], err);
      }
      const publishers = typeof topic === 'string' ? [] : (topic.publishers || []);
      if (publishers.length) {
        await handle.iam.setPolicy({
          bindings: [{
            role: 'roles/pubsub.publisher',
            members: publishers.map(iamMember).filter(Boolean),
          }],
        });
      }
    },
    async createPushSubscription(spec) {
      const options = {
        pushConfig: {
          pushEndpoint: spec.pushEndpoint,
          oidcToken: { serviceAccountEmail: spec.oidcServiceAccount, audience: spec.audience },
        },
        ackDeadlineSeconds: spec.ackDeadlineSeconds || 30,
      };
      if (spec.labels) options.labels = spec.labels;
      if (spec.deadLetterTopic) {
        options.deadLetterPolicy = {
          deadLetterTopic: `projects/${projectId}/topics/${spec.deadLetterTopic}`,
          maxDeliveryAttempts: 10,
        };
      }
      try {
        await getPubSub().topic(spec.topic).createSubscription(spec.name, options);
      } catch (err) {
        tolerate([ALREADY_EXISTS], err);
      }
      if (spec.deadLetterSubscriber) {
        await getPubSub().subscription(spec.name).iam.setPolicy({
          bindings: [{
            role: 'roles/pubsub.subscriber',
            members: [iamMember(spec.deadLetterSubscriber)].filter(Boolean),
          }],
        });
      }
    },
    async createSchedulerJob(spec) {
      try {
        await getScheduler().createJob({
          parent,
          job: {
            name: `${parent}/jobs/${spec.name}`,
            schedule: spec.schedule,
            httpTarget: {
              uri: spec.uri,
              httpMethod: 'POST',
              oidcToken: { serviceAccountEmail: spec.oidcServiceAccount, audience: spec.audience },
            },
          },
        });
      } catch (err) {
        tolerate([ALREADY_EXISTS], err);
      }
    },
    async deleteService(name) {
      try {
        const [op] = await services().deleteService({ name: `${parent}/services/${name}` });
        await op.promise();
      } catch (err) {
        tolerate([NOT_FOUND], err);
      }
    },
    async deleteJob(name) {
      try {
        const [op] = await jobs().deleteJob({ name: `${parent}/jobs/${name}` });
        await op.promise();
      } catch (err) {
        tolerate([NOT_FOUND], err);
      }
    },
    async deleteTopic(name) {
      try {
        await getPubSub().topic(name).delete();
      } catch (err) {
        tolerate([NOT_FOUND], err);
      }
    },
    async deleteSubscription(name) {
      try {
        await getPubSub().subscription(name).delete();
      } catch (err) {
        tolerate([NOT_FOUND], err);
      }
    },
    async deleteSchedulerJob(name) {
      try {
        await getScheduler().deleteJob({ name: `${parent}/jobs/${name}` });
      } catch (err) {
        tolerate([NOT_FOUND], err);
      }
    },
  };
}

/** Provision a tenant stack using real GCP clients. */
async function provisionTenant(slug, cfg) {
  assertSlug(slug);
  return provision(slug, cfg, { clients: createGcpClients(cfg) });
}

/** Tear a tenant stack down using real GCP clients. */
async function teardownTenant(slug, cfg) {
  assertSlug(slug);
  return teardown(slug, { clients: createGcpClients(cfg) });
}

module.exports = {
  createGcpClients,
  provisionTenant,
  teardownTenant,
  // Re-exports for the executor/pure core.
  provision,
  teardown,
  buildPlan,
  names,
  urls,
  assertSlug,
};
