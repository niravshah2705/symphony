'use strict';

const { provision, teardown } = require('./provisioner');
const { buildPlan } = require('./plan');
const { names, urls, assertSlug } = require('./naming');
const { extractSourceService, extractSourceJob, cloneContainers } = require('./containers');

/**
 * Real @google-cloud adapter for the provisioning executor.
 *
 * Implements the small `clients` interface provisioner.js expects on top of the
 * v2 Cloud Run, Pub/Sub, and Cloud Scheduler SDKs. All SDKs are required LAZILY
 * so importing this module (e.g. for provision/teardown re-exports or tests of
 * the pure core) never needs the GCP libraries installed. Every create/delete is
 * idempotent (ALREADY_EXISTS / NOT_FOUND tolerated) so retried provisions and
 * teardowns converge.
 *
 * "Reuse original builds": createService/createJob copy the image AND the secret
 * env blocks, resource limits, execution environment, concurrency, and skills
 * volumes from the live SHARED source service/job, so a tenant runtime is the
 * same build with the same secrets — only its per-tenant plain env differs.
 */

const ALREADY_EXISTS = 6; // gRPC ALREADY_EXISTS
const NOT_FOUND = 5; // gRPC NOT_FOUND

function tolerate(codes, err) {
  if (err && codes.includes(err.code)) return;
  throw err;
}

function iamMember(value) {
  const member = String(value || '').trim();
  if (!member) return '';
  return member.includes(':') ? member : `serviceAccount:${member}`;
}

let runClients = null;
function getRun() {
  if (!runClients) {
    const { ServicesClient, JobsClient } = require('@google-cloud/run').v2;
    runClients = { services: new ServicesClient(), jobs: new JobsClient() };
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
function createGcpClients({ projectId, region }) {
  const parent = `projects/${projectId}/locations/${region}`;
  const services = () => getRun().services;
  const jobs = () => getRun().jobs;

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

  return {
    async getServiceImage(name) {
      return (await sourceService(name)).containers[0].image;
    },
    async getJobImage(name) {
      return (await sourceJob(name)).containers[0].image;
    },
    async createService(spec) {
      const src = spec.sourceName ? await sourceService(spec.sourceName) : { containers: [] };
      if (spec.requireSecretFreePrimary && src.containers[0] && src.containers[0].secretEnv.length) {
        throw new Error(`${spec.name} source app container contains secret env; pipeline agents require sidecar-only credentials`);
      }
      if (spec.requireEgressProxy && src.containers.length < 2) {
        throw new Error(`${spec.name} source service has no egress-proxy sidecar`);
      }
      const service = {
        ingress: spec.ingress,
        labels: spec.labels,
        template: {
          serviceAccount: spec.serviceAccount,
          scaling: {
            minInstanceCount: 0,
            ...(spec.maxInstanceCount ? { maxInstanceCount: spec.maxInstanceCount } : {}),
          },
          ...(spec.requestTimeoutSeconds
            ? { timeout: { seconds: spec.requestTimeoutSeconds } }
            : {}),
          executionEnvironment: src.executionEnvironment,
          maxInstanceRequestConcurrency: src.maxInstanceRequestConcurrency,
          volumes: src.volumes,
          // Clone EVERY source container (primary + any sidecar), overlaying the
          // per-tenant env on the primary and `sidecarEnv` on the sidecars.
          containers: cloneContainers(src.containers, spec, { withPorts: true }),
        },
      };
      try {
        const [op] = await services().createService({ parent, serviceId: spec.name, service });
        await op.promise();
      } catch (err) {
        tolerate([ALREADY_EXISTS], err);
      }
      await setInvoker(spec);
    },
    async createJob(spec) {
      const src = spec.sourceName ? await sourceJob(spec.sourceName) : { containers: [] };
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
        const [op] = await jobs().createJob({ parent, jobId: spec.name, job });
        await op.promise();
      } catch (err) {
        tolerate([ALREADY_EXISTS], err);
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
