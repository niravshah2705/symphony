// One place for every derived name, so the onboarding steps, the chat proxy and
// the attach step all agree. UUIDs are canonical; slugs only shape k8s names.

export const orgNamespace = (orgSlug: string) => `org-${orgSlug}`;
export const workerPoolName = (orgSlug: string) => `org-${orgSlug}`;
export const tenantId = (orgSlug: string) => orgSlug;
export const helmRelease = (orgSlug: string) => `${orgSlug}-kagent-tenant`;
export const litellmSecretName = (orgSlug: string, projectSlug: string) => `litellm-${orgSlug}-${projectSlug}`;
export const litellmSecretKey = 'key';
export const keyAlias = (orgId: string, projectId: string) => `fleet:${orgId}:${projectId}`;

// The chart renders <tenant.id>-agent-<name>; P6 renders one agent per catalog
// model, named "<modelId>-worker" (the legacy single agent was just "worker").
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