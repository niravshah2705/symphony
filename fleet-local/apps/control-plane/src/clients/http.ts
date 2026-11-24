export class HttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, url: string) {
    super(`${url} -> ${status}: ${body.slice(0, 400)}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export interface JsonOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export async function fetchJson<T = unknown>(url: string, opts: JsonOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text, url);
    return (text ? JSON.parse(text) : {}) as T;
  } finally {
    clearTimeout(timer);
  }
}