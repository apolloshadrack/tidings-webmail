import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { AccountRegistry } from './imap/account.js';
import { wireRealtime } from './imap/realtime.js';
import { Outbox } from './mail/outbox.js';
import { SessionStore } from './lib/sessions.js';
import { type App, endUserSessions } from './http/context.js';
import { authRoutes } from './http/routes/auth.js';
import { mailRoutes } from './http/routes/mail.js';
import { composeRoutes } from './http/routes/compose.js';
import { prefsRoutes } from './http/routes/prefs.js';
import { eventRoutes } from './http/routes/events.js';
import { extraRoutes } from './http/routes/extras.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  const cfg = loadConfig();
  const db = openDatabase(cfg.dataDir);

  const f = Fastify({
    logger: {
      level: cfg.logLevel,
      redact: {
        paths: ['req.headers.cookie', 'req.headers["x-tidings-csrf"]', 'req.body.password', '*.password', '*.pass'],
        censor: '[redacted]',
      },
      serializers: {
        // Never log query strings (they can contain proxied URLs or folder names).
        req: (r: { method: string; url: string; ip: string }) => ({ method: r.method, path: r.url.split('?')[0], ip: r.ip }),
      },
    },
    trustProxy: cfg.trustedProxies.length ? cfg.trustedProxies : false,
    bodyLimit: 12 * 1024 * 1024,
    disableRequestLogging: cfg.logLevel !== 'debug',
  });

  const sessions = new SessionStore(db, cfg);
  const accounts = new AccountRegistry(cfg, f.log);
  const outbox = new Outbox(db, cfg, f.log);
  const app: App = {
    cfg,
    db,
    sessions,
    accounts,
    outbox,
    onAccountCreated: (acc) => wireRealtime(acc, db, () => endUserSessions(app, acc.userKey)),
  };

  await f.register(cookie);
  await f.register(multipart);
  await f.register(rateLimit, { global: false });

  // Security headers on every response.
  const appCsp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  f.addHook('onSend', async (req, reply, payload) => {
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', appCsp);
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    if (cfg.publicUrl.protocol === 'https:') reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    if (req.url.startsWith(`${cfg.basePath}/api/`) && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'private, no-store');
    return payload;
  });

  f.get(`${cfg.basePath}/healthz`, async () => ({ ok: true }));
  f.get(`${cfg.basePath}/readyz`, async (_req, reply) => {
    try {
      db.prepare('SELECT 1').get();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  await f.register(
    async (scope) => {
      authRoutes(scope, app);
      mailRoutes(scope, app);
      composeRoutes(scope, app);
      prefsRoutes(scope, app);
      eventRoutes(scope, app);
      extraRoutes(scope, app);
    },
    { prefix: cfg.basePath },
  );

  // Static SPA. The base path and brand are injected at runtime so one build works at / and /webmail.
  const webDist = process.env.TIDINGS_WEB_DIST ?? join(here, '../../web/dist');
  if (existsSync(join(webDist, 'index.html'))) {
    const template = readFileSync(join(webDist, 'index.html'), 'utf8');
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const html = template
      .replace('<head>', `<head><base href="${esc(cfg.basePath)}/">`)
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(cfg.branding.name)}</title>`)
      .replace('data-base-path=""', `data-base-path="${esc(cfg.basePath)}"`);
    await f.register(fastifyStatic, {
      root: webDist,
      prefix: `${cfg.basePath}/`,
      index: false,
      wildcard: false,
      setHeaders: (res, path) => {
        if (path.includes('/assets/')) res.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
    const serveIndex = async (_req: unknown, reply: import('fastify').FastifyReply) =>
      reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(html);
    f.get(`${cfg.basePath}/`, serveIndex);
    if (cfg.branding.customCss) {
      f.get(`${cfg.basePath}/custom.css`, async (_req, reply) => reply.type('text/css').send(cfg.branding.customCss));
    }
    f.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith(`${cfg.basePath}/api/`) && req.url.startsWith(`${cfg.basePath}/`) && !/\.[a-z0-9]{2,5}$/i.test(req.url.split('?')[0])) {
        return serveIndex(req, reply);
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  // Housekeeping: expire sessions, sweep stale uploads.
  const tmp = join(cfg.dataDir, 'tmp', 'uploads');
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const sweep = () => {
    sessions.sweep();
    const cutoff = Date.now() - 2 * 86_400_000;
    db.prepare(`DELETE FROM uploads WHERE created_at < ? AND id NOT IN (SELECT value FROM outbox, json_each(json_extract(outbox.meta, '$.uploads')) WHERE outbox.state IN ('queued','stalled','failed'))`).run(cutoff);
    const live = new Set((db.prepare('SELECT id FROM uploads').all() as { id: string }[]).map((r) => r.id));
    for (const name of readdirSync(tmp)) {
      if (!live.has(name) && statSync(join(tmp, name)).mtimeMs < Date.now() - 3600_000) rmSync(join(tmp, name), { force: true });
    }
    db.prepare(`DELETE FROM outbox WHERE state = 'sent' AND created_at < ?`).run(Date.now() - 7 * 86_400_000);
  };
  sweep();
  setInterval(sweep, 15 * 60_000).unref();

  return { f, cfg, app };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain || process.env.TIDINGS_START === '1') {
  buildServer()
    .then(async ({ f, cfg }) => {
      await f.listen({ port: cfg.port, host: cfg.bind });
      f.log.info(`Tidings listening on ${cfg.bind}:${cfg.port} (public URL ${cfg.publicUrl.toString()})`);
      const shutdown = async () => {
        await f.close();
        process.exit(0);
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    })
    .catch((err) => {
      console.error(`[tidings] failed to start: ${(err as Error).message}`);
      process.exit(1);
    });
}
