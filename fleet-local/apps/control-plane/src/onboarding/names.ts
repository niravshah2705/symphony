// One place for every derived name, so the onboarding steps, the chat proxy and
// the attach step all agree. UUIDs are canonical; slugs only shape k8s names.

export const orgNamespace = (orgSlug: string) => `org-${orgSlug}`;
export const workerPoolName = (orgSlug: string) => `org-${orgSlug}`;
export const tenantId = (orgSlug: string) => orgSlug;
export const helmRelease = (orgSlug: string) => `${orgSlug}-kagent-tenant`;
export const litellmSecretName = (orgSlug: string, projectSlug: string) => `litellm-${orgSlug}-${projectSlug}`;
export const litellmSecretKey = 'key';
// The same virtual key, under the env name the qoder BYOK provider declares.
// A Secret written before Qoder existed is healed by the key step (names only
// live here; the value never leaves the Secret).
export const qoderSecretKey = 'QODER_API_KEY';
export const keyAlias = (orgId: string, projectId: string) => `fleet:${orgId}:${projectId}`;

// The chart renders <tenant.id>-agent-<name>; P6 renders one agent per catalog
// model, named "<modelId>-worker" (the legacy single agent was just "worker").
// A bundle harness is appended to the tenant's harness list, never replaces one:
// the existing app|claude|codex|custom-claude|qoder objects keep their names, so
// turning a bundle on or off cannot disturb an agent that is already serving.
export const bundleHarnessName = (runtime: string) => `bundle-${runtime}`;
export const bundleAgentName = (orgSlug: string, runtime: string) => agentName(orgSlug, `${bundleHarnessName(runtime)}-worker`);
// One pod per (org, target); the key suffix keeps two builds of the same runtime
// from colliding on a name, and the whole thing stays inside the 63-char limit.
export const bundlePullProbe = (orgSlug: string, key: string) => `bundle-pull-${orgSlug}-${key.slice(0, 12)}`.slice(0, 63);

export const agentName = (orgSlug: string, agent = 'worker') => `${orgSlug}-agent-${agent}`;
export const modelAgentName = (orgSlug: string, modelId: string) => agentName(orgSlug, `${modelId}-worker`);

// LiteLLM model list for teams/keys: the catalog verbatim plus the OpenRouter
// passthrough wildcard, so new openrouter/<author>/<model> ids need no re-mint.
export function litellmModelList(catalog: readonly { model: string }[]): string[] {
  return [...new Set([...catalog.map((m) => m.model), 'openrouter/*'])];
}

export function assertRfc1123Slug(slug: string): void {
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(slug) || slug === 'atespaces') {
    const err = new Error(`invalid slug "${slug}": lowercase alphanumerics and '-', no leading/trailing '-'`) as Error & {
      statusCode?: number;
    };
    err.statusCode = 400;
    throw err;
  }
}