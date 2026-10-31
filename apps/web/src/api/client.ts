/** Thin fetch wrapper: base path, CSRF header, JSON, typed errors. */

export const BASE = document.documentElement.dataset.basePath ?? '';

let csrf = '';
export function setCsrf(token: string) {
  csrf = token;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type Listener = (err: ApiError) => void;
const authListeners = new Set<Listener>();
export function onAuthLost(fn: Listener) {
  authListeners.add(fn);
  return () => {
    authListeners.delete(fn);
  };
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal; raw?: BodyInit } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined || opts.raw ? 'POST' : 'GET');
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['X-Tidings-CSRF'] = csrf;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'You appear to be offline.', 'OFFLINE');
  }
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const d = (typeof data === 'object' ? data : {}) as { error?: string; code?: string };
    const err = new ApiError(res.status, d.error ?? `Request failed (${res.status})`, d.code, d as Record<string, unknown>);
    if (res.status === 401 && path !== '/api/session') authListeners.forEach((l) => l(err));
    throw err;
  }
  return data as T;
}

export const qs = (o: Record<string, string | number | boolean | undefined | null>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

export function partUrl(m: { mailbox: string; uidValidity: string; uid: number }, part: string, inline = false, name?: string) {
  return `${BASE}/api/message/part?${qs({ mailbox: m.mailbox, uidValidity: m.uidValidity, uid: m.uid, part, inline: inline ? 1 : undefined, name })}`;
}
