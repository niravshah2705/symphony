'use strict';

/**
 * Pure container-cloning helpers for the per-tenant provisioner.
 *
 * A per-tenant stack is cloned from the live SHARED source service. Historically
 * only `containers[0]` was copied — so an egress-proxy SIDECAR added to the
 * shared planner/coder would NOT propagate to tenant stacks, silently leaving
 * per-tenant agents with no proxy (and, once secrets move to the sidecar, no
 * credentials). These helpers copy EVERY container, overlaying per-tenant plain
 * env on the primary (ingress) container and a small patch on each sidecar,
 * while preserving each container's own image + secret env + resources + mounts.
 *
 * Extracted as pure functions so the multi-container behavior is unit-tested
 * without any GCP client.
 */

/** Split a container's env into value-source (secret) entries and plain {name:value}. */
function splitEnv(containerEnv) {
  const secretEnv = [];
  const plainEnv = {};
  for (const entry of containerEnv || []) {
    if (entry.valueSource) secretEnv.push(entry);
    else plainEnv[entry.name] = entry.value != null ? String(entry.value) : '';
  }
  return { secretEnv, plainEnv };
}

function extractContainers(containers) {
  return (containers || []).map((c) => {
    const { secretEnv, plainEnv } = splitEnv(c.env);
    return {
      image: c.image,
      ports: c.ports,
      secretEnv,
      plainEnv,
      resources: c.resources,
      volumeMounts: c.volumeMounts,
    };
  });
}

/** Extract all containers + template volumes/exec-env from a v2 SERVICE. */
function extractSourceService(svc) {
  return {
    containers: extractContainers(svc.template.containers),
    volumes: svc.template.volumes,
    executionEnvironment: svc.template.executionEnvironment,
  };
}

/** Extract all containers + volumes/exec-env from a v2 JOB (template.template). */
function extractSourceJob(job) {
  const t = job.template.template;
  return {
    containers: extractContainers(t.containers),
    volumes: t.volumes,
    executionEnvironment: t.executionEnvironment,
  };
}

function toEnvList(obj) {
  return Object.entries(obj || {}).map(([name, value]) => ({ name, value: String(value) }));
}

/**
 * Build the per-tenant containers array from the extracted source containers.
 *
 * - Primary (index 0, the ingress container): tenant image + tenant plain env +
 *   its source secret env; ports added when `withPorts`.
 * - Sidecars (index > 0): keep their source image + secret env; overlay the
 *   tenant `sidecarEnv` patch onto their source plain env; never given ports.
 *
 * @param {Array} srcContainers extracted source containers (extractSource*)
 * @param {object} spec { image, port, env, sidecarEnv }
 * @param {object} [opts] { withPorts }
 */
function cloneContainers(srcContainers, spec, { withPorts = false } = {}) {
  return (srcContainers || []).map((c, index) => {
    if (index === 0) {
      const container = {
        image: spec.image || c.image,
        env: [...toEnvList(spec.env), ...(c.secretEnv || [])],
        resources: c.resources,
        volumeMounts: c.volumeMounts,
      };
      if (withPorts) container.ports = [{ containerPort: spec.port || 8080 }];
      return container;
    }
    return {
      image: c.image,
      env: [...toEnvList({ ...c.plainEnv, ...(spec.sidecarEnv || {}) }), ...(c.secretEnv || [])],
      resources: c.resources,
      volumeMounts: c.volumeMounts,
    };
  });
}

module.exports = {
  splitEnv,
  extractContainers,
  extractSourceService,
  extractSourceJob,
  toEnvList,
  cloneContainers,
};
