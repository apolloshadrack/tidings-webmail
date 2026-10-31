import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { syncMailbox, syncMailboxList } from '../../imap/sync.js';
import { userKeyFor } from '../../lib/crypto.js';
import { loginAddress } from '../../mail/outbox.js';
import { type App, COOKIE, HttpError, accountFor, checkMutation, cookieOptions, requireSession, sendError } from '../context.js';
import { evictUser } from '../../imap/message.js';

const LoginSchema = z.object({
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  publicComputer: z.boolean().default(false),
});

// Progressive delay per username, plus a per (username, ip) budget. No hard lockout (that would
// let an attacker lock anyone out), but brute force becomes impractically slow.
const failures = new Map<string, { n: number; first: number }>();
const pairBudget = new Map<string, { n: number; first: number }>();
setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const m of [failures, pairBudget]) for (const [k, v] of m) if (v.first < cutoff) m.delete(k);
}, 600_000).unref();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function authRoutes(f: FastifyInstance, app: App) {
  f.get('/api/config', async () => ({
    brand: app.cfg.branding,
    basePath: app.cfg.basePath,
    sourceUrl: app.cfg.sourceUrl,
    version: process.env.TIDINGS_VERSION ?? '0.1.0',
    features: { sieve: !!app.cfg.sieve },
    demo: app.cfg.demo,
    defaultDomain: app.cfg.defaultDomain ?? null,
  }));

  f.post(
    '/api/session',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      try {
        checkMutation(app, req);
        const body = LoginSchema.parse(req.body);
        let username = body.username.trim();
        if (/[\u0000-\u001F\u007F"]/.test(username) || /[\u0000-\u001F\u007F]/.test(body.password)) {
          throw new HttpError(400, 'Username or password contains invalid characters');
        }
        if (!username.includes('@') && app.cfg.defaultDomain) username = `${username}@${app.cfg.defaultDomain}`;
        const canon = username.toLowerCase();
        const pairKey = `${canon}|${req.ip}`;
        const pair = pairBudget.get(pairKey) ?? { n: 0, first: Date.now() };
        if (pair.n >= 20) throw new HttpError(429, 'Too many attempts. Try again later.', 'RATE_LIMITED');
        const fail = failures.get(canon);
        if (fail?.n) await sleep(Math.min(5000, 250 * 2 ** Math.min(fail.n, 5)));

        const userKey = userKeyFor(app.cfg.imap.host, app.cfg.imap.port, username);
        // Verify the credentials with a throwaway connection.
        const { Account } = await import('../../imap/account.js');
        const probe = new Account(userKey, username, body.password, app.cfg, req.log);
        probe.originatingIp = req.ip;
        const client = probe.createClient('verify');
        try {
          await client.connect();
          await client.logout();
        } catch (err) {
          const e = err as { authenticationFailed?: boolean; code?: string; message: string };
          if (e.authenticationFailed) {
            failures.set(canon, { n: (fail?.n ?? 0) + 1, first: fail?.first ?? Date.now() });
            pair.n++;
            pairBudget.set(pairKey, pair);
            // Stable line for fail2ban: see contrib/fail2ban/tidings.conf
            req.log.warn({ event: 'login_failed', ip: req.ip, user: canon }, 'tidings login failed');
            throw new HttpError(401, 'Wrong email or password.', 'AUTH_FAILED');
          }
          req.log.error({ err: e.message }, 'imap unreachable during login');
          throw new HttpError(503, 'Cannot reach the mail server right now. Please try again shortly.', 'UPSTREAM');
        }
        failures.delete(canon);

        const session = app.sessions.create({
          userKey,
          username,
          password: body.password,
          publicComputer: body.publicComputer,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
        reply.setCookie(
          COOKIE,
          session.token,
          cookieOptions(app.cfg, body.publicComputer ? undefined : app.cfg.sessionMaxDays * 86_400),
        );
        const acc = accountFor(app, session, req.ip);
        acc.updatePassword(body.password);
        // Warm up: folder list then INBOX, in the background.
        void acc
          .run((c) => syncMailboxList(acc, app.db, c), 9)
          .then(async (boxes) => {
            await syncMailbox(acc, app.db, 'INBOX', 9);
            // Then everything else at low priority: Sent first (conversations need your replies), then the rest.
            const order = ['\\Sent', '\\Archive', '\\Drafts', '\\Junk', '\\Trash'];
            const rest = boxes
              .filter((b) => b.path !== 'INBOX' && b.subscribed)
              .sort((a, b) => {
                const ra = order.indexOf(a.special_use ?? '');
                const rb = order.indexOf(b.special_use ?? '');
                return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
              });
            for (const b of rest) await syncMailbox(acc, app.db, b.path, 1).catch(() => undefined);
          })
          .catch((e) => req.log.warn({ err: (e as Error).message }, 'initial sync failed'));
        req.log.info({ event: 'login', ip: req.ip, user: canon }, 'tidings login');
        return { ok: true, csrf: session.csrf };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  f.get('/api/session', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      const settings = app.db.prepare('SELECT json FROM settings WHERE user_key = ?').get(s.userKey) as { json: string } | undefined;
      return {
        username: s.username,
        email: loginAddress(app.cfg, s.username),
        csrf: s.csrf,
        publicComputer: s.publicComputer,
        settings: settings ? JSON.parse(settings.json) : null,
        identityPolicy: app.cfg.identityPolicy,
        allowedFrom: app.cfg.identityPolicy === 'free' ? null : [loginAddress(app.cfg, s.username), ...(app.cfg.aliases[loginAddress(app.cfg, s.username)] ?? [])],
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.post('/api/session/logout', async (req, reply) => {
    try {
      const s = requireSession(app, req, false);
      checkMutation(app, req, s);
      const acc = app.accounts.get(s.userKey);
      if (acc) {
        // Never silently drop a message the user is waiting to send.
        await app.outbox
          .flushSession(acc, s.sid, app.sessions.dataKey(s), s.username, () => app.sessions.password(s))
          .catch(() => undefined);
      }
      app.sessions.destroy(s.sid);
      if (app.sessions.countForUser(s.userKey) === 0) {
        evictUser(s.userKey);
        await app.accounts.remove(s.userKey);
      }
      reply.clearCookie(COOKIE, cookieOptions(app.cfg));
      reply.header('Clear-Site-Data', '"cache", "storage"');
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
