import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getMessage } from '../../imap/message.js';
import { moveMessages } from '../../imap/ops.js';
import { syncMailboxList } from '../../imap/sync.js';
import { hmac, safeEqual } from '../../lib/crypto.js';
import { EgressError, egressFetch } from '../../lib/egress.js';
import { sniffImage } from '../../lib/mime.js';
import { SCRIPT_NAME, SieveClient, emptyModel, parseModel, renderScript, type TidingsSieve } from '../../mail/sieve.js';
import { type App, HttpError, accountFor, checkMutation, requireSession, sendError } from '../context.js';
import { roleFolder } from './mail.js';

const SieveModelSchema = z.object({
  rules: z
    .array(
      z.object({
        id: z.string().max(64),
        name: z.string().max(200),
        enabled: z.boolean(),
        match: z.enum(['all', 'any']),
        conditions: z
          .array(z.object({ field: z.enum(['from', 'to', 'subject', 'cc', 'list-id']), op: z.enum(['contains', 'is', 'not-contains']), value: z.string().min(1).max(500) }))
          .max(20),
        actions: z.array(z.object({ type: z.enum(['move', 'mark-read', 'star', 'discard', 'forward', 'stop']), value: z.string().max(500).optional() })).max(10),
      }),
    )
    .max(200),
  vacation: z.object({
    enabled: z.boolean(),
    subject: z.string().max(500),
    body: z.string().max(20_000),
    days: z.number().int().min(1).max(30),
    from: z.number().optional(),
    until: z.number().optional(),
    addresses: z.array(z.string().max(320)).max(20),
  }),
});

function proxySig(app: App, userKey: string, url: string) {
  return hmac(app.cfg.secret, 'img-proxy', userKey, url).toString('base64url').slice(0, 32);
}

export function prefsRoutes(f: FastifyInstance, app: App) {
  // ---------- settings (opaque JSON owned by the client, size-capped) ----------
  f.put('/api/settings', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const json = JSON.stringify(z.record(z.string(), z.unknown()).parse(req.body));
      if (json.length > 64 * 1024) throw new HttpError(413, 'Settings too large');
      app.db.prepare('INSERT INTO settings (user_key, json) VALUES (?, ?) ON CONFLICT(user_key) DO UPDATE SET json = excluded.json').run(s.userKey, json);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---------- filters & vacation (ManageSieve) ----------
  const withSieve = async <T>(app_: App, s: ReturnType<typeof requireSession>, fn: (c: SieveClient) => Promise<T>): Promise<T> => {
    if (!app_.cfg.sieve) throw new HttpError(404, 'Filters are not available on this server', 'NO_SIEVE');
    const c = new SieveClient(app_.cfg, s.username, app_.sessions.password(s));
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.logout();
    }
  };

  f.get('/api/sieve', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      if (!app.cfg.sieve) return { available: false };
      return await withSieve(app, s, async (c) => {
        const scripts = await c.listScripts();
        const ours = scripts.find((x) => x.name === SCRIPT_NAME);
        const model = ours ? parseModel(await c.getScript(SCRIPT_NAME)) : null;
        const active = scripts.find((x) => x.active)?.name ?? null;
        return {
          available: true,
          extensions: c.extensions,
          model: model ?? emptyModel(),
          active,
          otherScripts: scripts.filter((x) => x.name !== SCRIPT_NAME).map((x) => x.name),
          managedByUs: active === SCRIPT_NAME,
        };
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.put('/api/sieve', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const body = SieveModelSchema.parse(req.body);
      return await withSieve(app, s, async (c) => {
        const scripts = await c.listScripts();
        const active = scripts.find((x) => x.active)?.name;
        const existing = scripts.find((x) => x.name === SCRIPT_NAME) ? parseModel(await c.getScript(SCRIPT_NAME)) : null;
        // Keep the user's previously active script (e.g. Roundcube's) running via include.
        const includes = new Set(existing?.includes ?? []);
        if (active && active !== SCRIPT_NAME) includes.add(active);
        const model: TidingsSieve = { ...body, includes: [...includes] } as TidingsSieve;
        const script = renderScript(model, c.extensions);
        await c.putScript(SCRIPT_NAME, script);
        await c.setActive(SCRIPT_NAME);
        return { ok: true, keptIncludes: model.includes };
      });
    } catch (err) {
      const e = err as Error;
      if (!(err instanceof HttpError) && /extension|rejected|support/i.test(e.message)) return reply.code(400).send({ error: e.message });
      return sendError(reply, err);
    }
  });

  // ---------- senders: block / trust images ----------
  f.post('/api/senders/trust', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const b = z.object({ email: z.string().max(320), trusted: z.boolean() }).parse(req.body);
      if (b.trusted) app.db.prepare('INSERT OR IGNORE INTO trusted_senders (user_key, sender) VALUES (?, ?)').run(s.userKey, b.email.toLowerCase());
      else app.db.prepare('DELETE FROM trusted_senders WHERE user_key = ? AND sender = ?').run(s.userKey, b.email.toLowerCase());
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Block = move everything from this sender to Spam now, and add a Sieve rule if filters are available. */
  f.post('/api/senders/block', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const { email } = z.object({ email: z.string().max(320) }).parse(req.body);
      const sender = email.toLowerCase();
      app.db.prepare('INSERT OR IGNORE INTO blocked_senders (user_key, sender, created_at) VALUES (?, ?, ?)').run(s.userKey, sender, Date.now());
      const acc = accountFor(app, s, req.ip);
      const junk = roleFolder(app, s.userKey, '\\Junk');
      let moved = 0;
      if (junk) {
        const rows = app.db
          .prepare('SELECT mailbox, uid_validity, uid FROM messages WHERE user_key = ? AND from_addr = ? AND mailbox != ?')
          .all(s.userKey, sender, junk) as { mailbox: string; uid_validity: string; uid: number }[];
        const byBox = new Map<string, { v: string; uids: number[] }>();
        for (const r of rows) {
          const g = byBox.get(r.mailbox) ?? { v: r.uid_validity, uids: [] };
          g.uids.push(r.uid);
          byBox.set(r.mailbox, g);
        }
        for (const [mailbox, g] of byBox) {
          await moveMessages(acc, app.db, { mailbox, uidValidity: g.v, uids: g.uids }, junk);
          moved += g.uids.length;
        }
      }
      let filter = false;
      if (app.cfg.sieve && junk) {
        try {
          await withSieve(app, s, async (c) => {
            const scripts = await c.listScripts();
            const active = scripts.find((x) => x.active)?.name;
            const model = (scripts.find((x) => x.name === SCRIPT_NAME) ? parseModel(await c.getScript(SCRIPT_NAME)) : null) ?? emptyModel();
            if (active && active !== SCRIPT_NAME && !model.includes.includes(active)) model.includes.push(active);
            model.rules.unshift({
              id: `block-${Date.now()}`,
              name: `Block ${sender}`,
              enabled: true,
              match: 'any',
              conditions: [{ field: 'from', op: 'is', value: sender }],
              actions: [{ type: 'move', value: junk }, { type: 'stop' }],
            });
            await c.putScript(SCRIPT_NAME, renderScript(model, c.extensions));
            await c.setActive(SCRIPT_NAME);
          });
          filter = true;
        } catch {
          filter = false;
        }
      }
      return { ok: true, moved, filter };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---------- subscriptions manager (Gmail-style) ----------
  f.get('/api/subscriptions', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      const rows = app.db
        .prepare(
          `SELECT from_addr email, MAX(from_name) name, COUNT(*) total, SUM(seen = 0) unread, MAX(date) lastDate,
                  MAX(list_unsubscribe_post) oneClick
           FROM messages WHERE user_key = ? AND list_unsubscribe IS NOT NULL AND from_addr != ''
           GROUP BY from_addr ORDER BY total DESC LIMIT 500`,
        )
        .all(s.userKey) as { email: string }[];
      const latest = app.db.prepare(
        `SELECT mailbox, uid_validity uidValidity, uid FROM messages WHERE user_key = ? AND from_addr = ? AND list_unsubscribe IS NOT NULL ORDER BY date DESC LIMIT 1`,
      );
      return { senders: rows.map((r) => ({ ...r, latest: latest.get(s.userKey, r.email) })) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * Unsubscribe. RFC 8058 one-click POST only when the message declares it (and, if the admin configured
   * trusted authserv ids, only when DKIM passed). Otherwise hand the client a mailto/URL to act on visibly.
   */
  f.post('/api/unsubscribe', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const b = z.object({ mailbox: z.string().max(1000), uidValidity: z.string().regex(/^\d+$/), uid: z.number().int().positive() }).parse(req.body);
      const acc = accountFor(app, s, req.ip);
      const msg = await getMessage(acc, app.db, b.mailbox, b.uidValidity, b.uid, app.cfg.trustedAuthservIds);
      if (!msg?.listUnsubscribe) throw new HttpError(404, 'This message has no unsubscribe information');
      const links = [...msg.listUnsubscribe.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
      const https = links.find((l) => /^https:\/\//i.test(l));
      const mailto = links.find((l) => /^mailto:/i.test(l));
      const dkimOk = !app.cfg.trustedAuthservIds.length || msg.auth?.dkim === 'pass';
      if (https && msg.listUnsubscribeOneClick && dkimOk) {
        try {
          const r = await egressFetch(https, {
            method: 'POST',
            body: 'List-Unsubscribe=One-Click',
            httpsOnly: true,
            followRedirects: false,
            allowPrivate: app.cfg.egressAllowPrivate,
            maxBytes: 64 * 1024,
          });
          if (r.status >= 200 && r.status < 300) return { method: 'one-click', ok: true };
          return { method: 'one-click', ok: false, status: r.status, url: https };
        } catch (err) {
          return { method: 'one-click', ok: false, error: (err as Error).message, url: https };
        }
      }
      if (mailto) return { method: 'mailto', mailto };
      if (https || links.find((l) => /^http:/i.test(l))) return { method: 'url', url: https ?? links.find((l) => /^http:/i.test(l)) };
      throw new HttpError(404, 'No usable unsubscribe method');
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---------- privacy image proxy ----------
  f.post('/api/proxy/sign', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const { urls } = z.object({ urls: z.array(z.string().max(4096)).max(500) }).parse(req.body);
      const out: Record<string, string> = {};
      for (const u of urls) {
        try {
          const url = new URL(u);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
          out[u] = `${app.cfg.basePath}/api/proxy/img?u=${encodeURIComponent(url.toString())}&s=${proxySig(app, s.userKey, url.toString())}`;
        } catch {
          /* skip */
        }
      }
      return { urls: out };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.get('/api/proxy/img', async (req, reply) => {
    try {
      const s = requireSession(app, req, false);
      const q = z.object({ u: z.string().max(4096), s: z.string().max(64) }).parse(req.query);
      if (!safeEqual(q.s, proxySig(app, s.userKey, q.u))) throw new HttpError(403, 'Bad signature');
      const r = await egressFetch(q.u, { accept: 'image/*', maxBytes: 8 * 1024 * 1024, allowPrivate: app.cfg.egressAllowPrivate, timeoutMs: 8000 });
      const type = sniffImage(r.body);
      if (r.status !== 200 || !type) return reply.code(404).send();
      reply.header('Content-Type', type);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
      reply.header('Cache-Control', 'private, max-age=86400');
      reply.header('Cross-Origin-Resource-Policy', 'same-origin');
      return reply.send(r.body);
    } catch (err) {
      if (err instanceof EgressError) return reply.code(404).send();
      return sendError(reply, err);
    }
  });

  // ---------- snooze ----------
  f.post('/api/snooze', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const b = z
        .object({
          mailbox: z.string().max(1000),
          uidValidity: z.string().regex(/^\d+$/),
          uids: z.array(z.number().int().positive()).min(1).max(500),
          until: z.number().int(),
        })
        .parse(req.body);
      if (b.until < Date.now() + 60_000) throw new HttpError(400, 'Pick a time in the future');
      const acc = accountFor(app, s, req.ip);
      let snoozed = (app.db.prepare(`SELECT path FROM mailboxes WHERE user_key = ? AND name = 'Snoozed' AND parent_path IS NULL`).get(s.userKey) as { path: string } | undefined)?.path;
      if (!snoozed) {
        await acc.run(async (c) => {
          await c.mailboxCreate('Snoozed').catch(() => undefined);
          await c.mailboxSubscribe('Snoozed').catch(() => undefined);
        }, 8);
        await acc.run((c) => syncMailboxList(acc, app.db, c), 8);
        snoozed = 'Snoozed';
      }
      const rows = app.db
        .prepare(`SELECT uid, message_id FROM messages WHERE user_key = ? AND mailbox = ? AND uid IN (${b.uids.map(() => '?').join(',')})`)
        .all(s.userKey, b.mailbox, ...b.uids) as { uid: number; message_id: string | null }[];
      const r = await moveMessages(acc, app.db, { mailbox: b.mailbox, uidValidity: b.uidValidity, uids: b.uids }, snoozed);
      const ins = app.db.prepare(
        `INSERT INTO snoozes (user_key, message_id, from_mailbox, wake_at, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_key, message_id) DO UPDATE SET wake_at = excluded.wake_at, from_mailbox = excluded.from_mailbox`,
      );
      for (const row of rows) if (row.message_id) ins.run(s.userKey, row.message_id, b.mailbox, b.until, Date.now());
      return { ok: true, folder: snoozed, uidMap: r.uidMap };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.get('/api/snoozed', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      return { items: app.db.prepare('SELECT message_id messageId, from_mailbox fromMailbox, wake_at wakeAt FROM snoozes WHERE user_key = ? ORDER BY wake_at').all(s.userKey) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---------- sender profile (Superhuman-style sidebar), all from the index ----------
  f.get('/api/sender', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      const { email } = z.object({ email: z.string().max(320) }).parse(req.query);
      const e = email.toLowerCase();
      const stats = app.db
        .prepare(
          `SELECT COUNT(*) received, MIN(date) firstSeen, MAX(date) lastSeen, SUM(has_attachments) withAttachments, MAX(from_name) name,
                  MAX(list_unsubscribe IS NOT NULL) newsletter
           FROM messages WHERE user_key = ? AND from_addr = ?`,
        )
        .get(s.userKey, e) as Record<string, number | string | null>;
      const sent = app.db.prepare(`SELECT COUNT(*) n FROM messages WHERE user_key = ? AND to_json LIKE ? AND mailbox IN (SELECT path FROM mailboxes WHERE user_key = ? AND special_use = '\\Sent')`).get(s.userKey, `%"${e}"%`, s.userKey) as { n: number };
      const recent = app.db
        .prepare(
          `SELECT thread_id threadId, subject, MAX(date) date, mailbox FROM messages WHERE user_key = ? AND (from_addr = ? OR to_json LIKE ?)
           GROUP BY thread_id ORDER BY date DESC LIMIT 8`,
        )
        .all(s.userKey, e, `%"${e}"%`);
      const contact = app.db.prepare('SELECT name, notes, source FROM contacts WHERE user_key = ? AND email = ?').get(s.userKey, e);
      const blocked = !!app.db.prepare('SELECT 1 FROM blocked_senders WHERE user_key = ? AND sender = ?').get(s.userKey, e);
      const trusted = !!app.db.prepare('SELECT 1 FROM trusted_senders WHERE user_key = ? AND sender = ?').get(s.userKey, e);
      return { email: e, ...stats, sentTo: sent.n, recent, contact: contact ?? null, blocked, imagesTrusted: trusted, domain: e.split('@')[1] ?? '' };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
