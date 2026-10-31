import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import { type Account, type AccountRegistry, AuthFailedError, UidValidityChangedError } from '../imap/account.js';
import { evictUser } from '../imap/message.js';
import type { Outbox } from '../mail/outbox.js';
import { safeEqual } from '../lib/crypto.js';
import type { Session, SessionStore } from '../lib/sessions.js';

export const COOKIE = 'tidings_session';

export interface App {
  cfg: Config;
  db: DB;
  sessions: SessionStore;
  accounts: AccountRegistry;
  outbox: Outbox;
  onAccountCreated: (acc: Account) => void;
}

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export function cookieOptions(cfg: Config, maxAgeSeconds?: number) {
  return {
    httpOnly: true,
    secure: cfg.publicUrl.protocol === 'https:',
    sameSite: 'lax' as const,
    path: cfg.basePath || '/',
    ...(maxAgeSeconds ? { maxAge: maxAgeSeconds } : {}),
  };
}

export function requireSession(app: App, req: FastifyRequest, touch = true): Session {
  const token = req.cookies[COOKIE];
  const s = app.sessions.get(token, touch);
  if (!s) throw new HttpError(401, 'Your session has expired. Please sign in again.', 'SESSION_EXPIRED');
  req.session = s;
  return s;
}

export function accountFor(app: App, s: Session, ip?: string): Account {
  let acc = app.accounts.get(s.userKey);
  if (!acc || acc.isDead) {
    let pw: string;
    try {
      pw = app.sessions.password(s);
    } catch {
      throw new HttpError(401, 'Your session has expired. Please sign in again.', 'SESSION_EXPIRED');
    }
    acc = app.accounts.getOrCreate(s.userKey, s.username, pw, (a) => app.onAccountCreated(a));
  }
  if (ip) acc.originatingIp = ip;
  return acc;
}

/**
 * CSRF + same-origin enforcement for every state-changing request:
 * CSRF header must match the session token, Origin must equal TIDINGS_PUBLIC_URL's origin,
 * and the body must be JSON or multipart (no simple form posts).
 */
export function checkMutation(app: App, req: FastifyRequest, s?: Session) {
  const origin = req.headers.origin;
  if (!origin || origin !== app.cfg.publicUrl.origin) {
    throw new HttpError(403, 'Cross-origin request refused', 'BAD_ORIGIN');
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') throw new HttpError(403, 'Cross-site request refused', 'BAD_ORIGIN');
  const ct = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (req.method !== 'DELETE' && ct && ct !== 'application/json' && ct !== 'multipart/form-data') {
    throw new HttpError(415, 'Unsupported content type');
  }
  if (s) {
    const token = String(req.headers['x-tidings-csrf'] ?? '');
    if (!token || !safeEqual(token, s.csrf)) throw new HttpError(403, 'Invalid CSRF token', 'BAD_CSRF');
  }
}

export function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, code: err.code });
  if (err instanceof UidValidityChangedError) {
    return reply.code(409).send({ error: 'This folder changed on the server. Refreshing…', code: 'UIDVALIDITY_CHANGED', mailbox: err.mailbox });
  }
  if (err instanceof AuthFailedError) {
    return reply.code(401).send({ error: 'The mail server rejected your password. Please sign in again.', code: 'AUTH_FAILED' });
  }
  const e = err as { statusCode?: number; validation?: unknown; message?: string; issues?: unknown };
  if (e.issues) return reply.code(400).send({ error: 'Invalid request', code: 'VALIDATION', issues: e.issues });
  if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
  reply.log.error({ err: e.message }, 'request failed');
  return reply.code(502).send({ error: e.message ?? 'The mail server did not respond as expected', code: 'UPSTREAM' });
}

export function endUserSessions(app: App, userKey: string) {
  app.sessions.destroyAllForUser(userKey);
  evictUser(userKey);
  void app.accounts.remove(userKey);
}
