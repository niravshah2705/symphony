import type {
  LangfuseTrace,
  Org,
  Project,
  ReconciledCosts,
  Session,
  States,
  User,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, text || res.statusText);
  }
  return (await res.json()) as T;
}

// POST endpoints that stream SSE (onboarding, chat). EventSource is GET-only, so
// we read the fetch body and split event/data blocks ourselves.
export async function postSSE(
  url: string,
  body: unknown,
  onEvent: (event: string, data: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, text || res.statusText);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      const payload = data.join('\n');
      if (payload) onEvent(event, payload);
    }
  }
}

export const api = {
  me: () => json<{ user: User; orgs: Org[] }>('/api/me'),
  logout: () => json<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  listOrgs: () => json<{ orgs: Org[] }>('/api/orgs'),
  createOrg: (slug: string, name: string) =>
    json<{ org: Org }>('/api/orgs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, name }),
    }),
  getOnboard: (orgId: string) => json<{ states: States }>(`/api/orgs/${orgId}/onboard`),
  runOnboard: (orgId: string, onEvent: (e: string, d: string) => void, signal?: AbortSignal) =>
    postSSE(`/api/orgs/${orgId}/onboard`, {}, onEvent, signal),
  listProjects: (orgId: string) => json<{ projects: Project[] }>(`/api/orgs/${orgId}/projects`),
  listSessions: (orgId: string, projectId?: string) =>
    json<{ sessions: Session[] }>(
      `/api/orgs/${orgId}/sessions${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  getCosts: (orgId: string, days = 30) =>
    json<ReconciledCosts>(`/api/orgs/${orgId}/costs?days=${days}`),
  getTraces: (orgId: string, sessionId?: string) =>
    json<{ traces: LangfuseTrace[] }>(
      `/api/orgs/${orgId}/traces${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`,
    ),
  chat: (
    orgId: string,
    projectId: string,
    text: string,
    sessionId: string | undefined,
    onEvent: (e: string, d: string) => void,
    signal?: AbortSignal,
  ) => postSSE(`/api/orgs/${orgId}/projects/${projectId}/chat`, { text, sessionId }, onEvent, signal),
  closeSession: (orgId: string, sessionId: string) =>
    json<{ session: Session }>(`/api/orgs/${orgId}/sessions/${sessionId}/close`, { method: 'POST' }),
  agentCard: (orgId: string, projectId: string) =>
    json<Record<string, unknown>>(`/api/orgs/${orgId}/projects/${projectId}/agent-card`),
};