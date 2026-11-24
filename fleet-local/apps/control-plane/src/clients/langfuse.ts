import { config } from '../config.ts';
import { fetchJson } from './http.ts';

function auth(): Record<string, string> {
  const pair = Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
  return { Authorization: `Basic ${pair}` };
}

export interface LangfuseTrace {
  id: string;
  sessionId?: string;
  userId?: string;
  name?: string;
  timestamp?: string;
  totalCost?: number;
  latency?: number;
}

// Langfuse is unexposed (ClusterIP); the BFF reads its public API in-cluster and
// the SPA deep-links to the port-forwarded UI.
export const langfuse = {
  traces(params: { sessionId?: string; userId?: string; limit?: number } = {}) {
    const qs = new URLSearchParams({ limit: String(params.limit ?? 50) });
    if (params.sessionId) qs.set('sessionId', params.sessionId);
    if (params.userId) qs.set('userId', params.userId);
    return fetchJson<{ data?: LangfuseTrace[] }>(`${config.langfuseHost}/api/public/traces?${qs}`, {
      headers: auth(),
    });
  },
};