import { config } from '../config.ts';
import { fetchJson, HttpError } from './http.ts';

// Qoder's job-token endpoints. A long-lived personal access token (`pt-...`) is
// exchanged for a 24h job token (`jt-...`), which is what Qoder accepts as
// `Authorization: Bearer ...`. The PAT itself travels in the exchange *body*, so
// this module is the only place it is ever read, and it runs outside the Actor.
//
// Error hygiene is load-bearing here rather than cosmetic: `HttpError` carries the
// response body, and on these two calls both the request body and the response body
// are credentials. Every failure is therefore re-thrown as a status-only error.

export interface QoderTokenSet {
  token: string;
  expiresAt: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
}

export type QoderAuthOperation = 'exchange' | 'refresh';

export class QoderAuthError extends Error {
  status: number;
  operation: QoderAuthOperation;
  constructor(operation: QoderAuthOperation, status: number) {
    super(`qoder ${operation} failed: HTTP ${status}`);
    this.name = 'QoderAuthError';
    this.status = status;
    this.operation = operation;
  }
}

interface RawTokenResponse {
  token?: string;
  expires_in?: number;
  expires_at?: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  refresh_token_expires_at?: string;
}

const url = (path: string) => `${config.qoderAuthBaseUrl}${path}`;

// The API sends both a relative `expires_in` (milliseconds) and an absolute
// `expires_at` (ISO); the relative form is what the CLI trusts, so it wins here and
// epoch seconds are what every caller stores.
function expiryMs(expiresIn: number | undefined, expiresAt: string | undefined, now: number): number | undefined {
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) return expiresIn;
  if (expiresAt) {
    const parsed = Date.parse(expiresAt);
    if (!Number.isNaN(parsed)) return parsed - now;
  }
  return undefined;
}

function tokenSet(nowMs: number, raw: RawTokenResponse): QoderTokenSet {
  const token = raw.token ?? '';
  if (!token.startsWith('jt-')) throw new Error('qoder exchange returned no job token');
  const now = Math.floor(nowMs / 1000);
  const life = expiryMs(raw.expires_in, raw.expires_at, nowMs);
  const refreshLife = expiryMs(raw.refresh_token_expires_in, raw.refresh_token_expires_at, nowMs);
  return {
    token,
    expiresAt: now + Math.floor((life ?? 86400000) / 1000),
    ...(raw.refresh_token ? { refreshToken: raw.refresh_token, refreshExpiresAt: now + Math.floor((refreshLife ?? 172800000) / 1000) } : {}),
  };
}

async function call(
  operation: QoderAuthOperation,
  path: string,
  body: Record<string, string>,
): Promise<QoderTokenSet> {
  let raw: RawTokenResponse;
  try {
    raw = await fetchJson<RawTokenResponse>(url(path), { body, timeoutMs: 15000 });
  } catch (err) {
    if (err instanceof HttpError) throw new QoderAuthError(operation, err.status);
    throw err;
  }
  return tokenSet(Date.now(), raw);
}

export const qoder = {
  exchange(personalToken: string) {
    return call('exchange', '/api/v1/jobToken/exchange', { personal_token: personalToken });
  },
  refresh(refreshToken: string) {
    return call('refresh', '/api/v1/jobToken/refresh', { refresh_token: refreshToken });
  },
};
