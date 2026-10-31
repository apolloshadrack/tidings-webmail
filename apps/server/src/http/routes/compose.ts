import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import MailComposer from 'nodemailer/lib/mail-composer';
import { z } from 'zod';
import { appendMessage, expungeUidIfSafe } from '../../imap/ops.js';
import { syncMailbox } from '../../imap/sync.js';
import { cleanHeaderValue, sanitizeFilename } from '../../lib/mime.js';
import { ComposeSchema, allowedFromAddresses, loginAddress, normalizeAddress } from '../../mail/outbox.js';
import { type App, HttpError, accountFor, checkMutation, requireSession, sendError } from '../context.js';
import { roleFolder } from './mail.js';

const DraftSchema = ComposeSchema.partial().extend({ draftId: z.string().uuid() }).passthrough();

export function composeRoutes(f: FastifyInstance, app: App) {
  const uploadDir = join(app.cfg.dataDir, 'tmp', 'uploads');
  mkdirSync(uploadDir, { recursive: true, mode: 0o700 });

  // ---------- drafts: local-first, synced to IMAP Drafts on demand ----------
  f.get('/api/drafts', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      const rows = app.db.prepare('SELECT id, json, updated_at FROM drafts WHERE user_key = ? ORDER BY updated_at DESC').all(s.userKey) as {
        id: string;
        json: string;
        updated_at: number;
      }[];
      return { drafts: rows.map((r) => ({ id: r.id, updatedAt: r.updated_at, ...JSON.parse(r.json) })) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.put('/api/drafts/:id', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const body = DraftSchema.parse({ ...(req.body as object), draftId: id });
      const json = JSON.stringify(body);
      if (json.length > 12 * 1024 * 1024) throw new HttpError(413, 'Draft too large');
      app.db
        .prepare(
          `INSERT INTO drafts (id, user_key, json, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at WHERE drafts.user_key = excluded.user_key`,
        )
        .run(id, s.userKey, json, Date.now());
      return { ok: true, updatedAt: Date.now() };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.delete('/api/drafts/:id', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const acc = accountFor(app, s, req.ip);
      const uploads = app.db.prepare('SELECT id FROM uploads WHERE user_key = ? AND draft_id = ?').all(s.userKey, id) as { id: string }[];
      await app.outbox.cleanupDraft(acc, id);
      uploads.forEach((u) => app.outbox.removeUpload(s.userKey, u.id));
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Write the draft to the IMAP Drafts folder (replacing the previous copy) so other clients see it. */
  f.post('/api/drafts/:id/sync', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const row = app.db.prepare('SELECT * FROM drafts WHERE id = ? AND user_key = ?').get(id, s.userKey) as
        | { json: string; imap_uid: number | null; imap_uid_validity: string | null }
        | undefined;
      if (!row) throw new HttpError(404, 'Draft not found');
      const d = JSON.parse(row.json) as z.infer<typeof DraftSchema>;
      const acc = accountFor(app, s, req.ip);
      const drafts = roleFolder(app, s.userKey, '\\Drafts');
      if (!drafts) return { ok: false, reason: 'no-drafts-folder' };
      const addrs = (l?: { name: string; address: string }[]) =>
        (l ?? []).flatMap((a) => {
          try {
            return [{ name: cleanHeaderValue(a.name ?? ''), address: normalizeAddress(a.address) }];
          } catch {
            return [];
          }
        });
      const raw = await new MailComposer({
        from: d.from ? { name: '', address: d.from } : loginAddress(app.cfg, s.username),
        to: addrs(d.to),
        cc: addrs(d.cc),
        bcc: addrs(d.bcc),
        subject: cleanHeaderValue(d.subject ?? ''),
        text: d.text ?? '',
        html: d.html,
        headers: { 'X-Tidings-Draft-ID': id },
        attachDataUrls: true,
        disableFileAccess: true,
        disableUrlAccess: true,
      } as never)
        .compile()
        .build();
      const res = await appendMessage(acc, drafts, raw, ['\\Draft', '\\Seen']);
      if (row.imap_uid && row.imap_uid_validity) {
        await expungeUidIfSafe(acc, drafts, row.imap_uid_validity, row.imap_uid).catch(() => undefined);
      }
      app.db
        .prepare('UPDATE drafts SET imap_uid = ?, imap_uid_validity = ?, imap_synced_at = ? WHERE id = ?')
        .run(res && res.uid ? res.uid : null, res && res.uidValidity ? res.uidValidity.toString() : null, Date.now(), id);
      void syncMailbox(acc, app.db, drafts, 2).catch(() => undefined);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---------- uploads (streamed to disk, quota-checked) ----------
  f.post('/api/uploads', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const draftId = z.string().uuid().optional().parse((req.query as { draftId?: string }).draftId);
      const file = await req.file({ limits: { fileSize: app.cfg.maxUploadMb * 1024 * 1024, files: 1 } });
      if (!file) throw new HttpError(400, 'No file');
      const id = randomUUID();
      const path = join(uploadDir, id);
      await pipeline(file.file, createWriteStream(path, { mode: 0o600 }));
      if (file.file.truncated) {
        rmSync(path, { force: true });
        throw new HttpError(413, `Attachments are limited to ${app.cfg.maxUploadMb} MB`);
      }
      const size = statSync(path).size;
      if (draftId) {
        const used = (app.db.prepare('SELECT COALESCE(SUM(size),0) n FROM uploads WHERE user_key = ? AND draft_id = ?').get(s.userKey, draftId) as { n: number }).n;
        if (used + size > app.cfg.maxUploadMb * 1024 * 1024) {
          rmSync(path, { force: true });
          throw new HttpError(413, `Attachments for one message are limited to ${app.cfg.maxUploadMb} MB in total`);
        }
      }
      const filename = sanitizeFilename(file.filename, 'attachment');
      const type = /^[\w.+-]+\/[\w.+-]+$/.test(file.mimetype) ? file.mimetype : 'application/octet-stream';
      app.db
        .prepare('INSERT INTO uploads (id, user_key, draft_id, filename, content_type, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, s.userKey, draftId ?? null, filename, type, size, path, Date.now());
      return { id, filename, size, contentType: type };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.delete('/api/uploads/:id', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      app.outbox.removeUpload(s.userKey, z.string().uuid().parse((req.params as { id: string }).id));
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---------- send + outbox ----------
  f.post('/api/send', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const input = ComposeSchema.parse(req.body);
      const acc = accountFor(app, s, req.ip);
      const r = await app.outbox.queue(acc, s.sid, app.sessions.dataKey(s), s.username, () => app.sessions.password(s), input);
      return r;
    } catch (err) {
      const e = err as Error;
      if (!(err instanceof HttpError) && !(e as { issues?: unknown }).issues && /not allowed|recipient|valid|limit|exceed|Add at least/i.test(e.message)) {
        return reply.code(400).send({ error: e.message, code: 'COMPOSE_INVALID' });
      }
      return sendError(reply, err);
    }
  });

  f.get('/api/outbox', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      return { items: app.outbox.list(s.userKey) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.post('/api/outbox/:id/cancel', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const compose = app.outbox.cancel(s.userKey, (req.params as { id: string }).id);
      if (!compose) throw new HttpError(409, 'Too late — the message has already been sent.', 'ALREADY_SENT');
      accountFor(app, s).emit('event', { type: 'outbox' });
      return { compose };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.post('/api/outbox/:id/send', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const acc = accountFor(app, s, req.ip);
      await app.outbox.sendNow(acc, s.userKey, (req.params as { id: string }).id, s.sid, app.sessions.dataKey(s), s.username, () => app.sessions.password(s));
      return { ok: true };
    } catch (err) {
      const e = err as Error;
      if (/another session|Nothing to send/.test(e.message)) return reply.code(409).send({ error: e.message });
      return sendError(reply, err);
    }
  });

  f.delete('/api/outbox/:id', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      app.outbox.discard(s.userKey, (req.params as { id: string }).id);
      accountFor(app, s).emit('event', { type: 'outbox' });
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---------- contacts & autocomplete (frecency: sent-to ranks above received-from) ----------
  f.get('/api/contacts/suggest', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      const q = z.object({ q: z.string().max(200).default('') }).parse(req.query).q.trim().toLowerCase();
      const like = `%${q}%`;
      const contacts = app.db
        .prepare(
          `SELECT name, email, use_count, last_used, source FROM contacts WHERE user_key = ? AND (lower(email) LIKE ? OR lower(name) LIKE ?)
           ORDER BY (CASE source WHEN 'sent' THEN 3 WHEN 'manual' THEN 2 ELSE 1 END) * (use_count + 1) DESC, last_used DESC LIMIT 8`,
        )
        .all(s.userKey, like, like) as { name: string; email: string }[];
      const seen = new Set(contacts.map((c) => c.email));
      const fromIndex = q.length >= 2
        ? (app.db
            .prepare(
              `SELECT from_name name, from_addr email, COUNT(*) n FROM messages WHERE user_key = ? AND (lower(from_addr) LIKE ? OR lower(from_name) LIKE ?)
               AND list_unsubscribe IS NULL AND from_addr != '' GROUP BY from_addr ORDER BY n DESC LIMIT 8`,
            )
            .all(s.userKey, like, like) as { name: string; email: string }[])
        : [];
      const out = [...contacts, ...fromIndex.filter((c) => !seen.has(c.email))].slice(0, 8).map((c) => ({ name: c.name, address: c.email }));
      return { suggestions: out };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.get('/api/contacts', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      return {
        contacts: app.db
          .prepare(`SELECT id, name, email, notes, source, use_count useCount, last_used lastUsed FROM contacts WHERE user_key = ? ORDER BY lower(COALESCE(NULLIF(name,''), email))`)
          .all(s.userKey),
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.post('/api/contacts', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const b = z.object({ name: z.string().max(200).default(''), email: z.string().max(320), notes: z.string().max(5000).default('') }).parse(req.body);
      const email = normalizeAddress(b.email);
      app.db
        .prepare(
          `INSERT INTO contacts (user_key, name, email, notes, source, created_at) VALUES (?, ?, ?, ?, 'manual', ?)
           ON CONFLICT(user_key, email) DO UPDATE SET name = excluded.name, notes = excluded.notes, source = 'manual'`,
        )
        .run(s.userKey, cleanHeaderValue(b.name), email, b.notes, Date.now());
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.delete('/api/contacts/:id', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      app.db.prepare('DELETE FROM contacts WHERE id = ? AND user_key = ?').run(Number((req.params as { id: string }).id), s.userKey);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Export address book as vCard 4.0 */
  f.get('/api/contacts.vcf', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      const rows = app.db.prepare(`SELECT name, email FROM contacts WHERE user_key = ? AND source != 'received'`).all(s.userKey) as { name: string; email: string }[];
      const esc = (v: string) => v.replace(/[\\,;]/g, '\\$&').replace(/\n/g, '\\n');
      const body = rows.map((r) => `BEGIN:VCARD\r\nVERSION:4.0\r\nFN:${esc(r.name || r.email)}\r\nEMAIL:${esc(r.email)}\r\nEND:VCARD\r\n`).join('');
      reply.header('Content-Type', 'text/vcard; charset=utf-8');
      reply.header('Content-Disposition', 'attachment; filename="contacts.vcf"');
      return reply.send(body);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.post('/api/contacts/import', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const { vcf } = z.object({ vcf: z.string().max(5 * 1024 * 1024) }).parse(req.body);
      let n = 0;
      const ins = app.db.prepare(
        `INSERT INTO contacts (user_key, name, email, source, created_at) VALUES (?, ?, ?, 'manual', ?) ON CONFLICT(user_key, email) DO NOTHING`,
      );
      for (const card of vcf.split(/BEGIN:VCARD/i).slice(1)) {
        const unfolded = card.replace(/\r?\n[ \t]/g, '');
        const fn = /^FN[^:]*:(.*)$/im.exec(unfolded)?.[1]?.trim() ?? '';
        for (const m of unfolded.matchAll(/^EMAIL[^:]*:(.*)$/gim)) {
          try {
            ins.run(s.userKey, cleanHeaderValue(fn.replace(/\\(.)/g, '$1')), normalizeAddress(m[1].trim()), Date.now());
            n++;
          } catch {
            /* skip invalid */
          }
        }
      }
      return { imported: n };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---------- identities ----------
  f.get('/api/identities', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      const rows = app.db
        .prepare('SELECT id, name, email, reply_to replyTo, signature_html signatureHtml, is_default isDefault FROM identities WHERE user_key = ? ORDER BY is_default DESC, id')
        .all(s.userKey) as { email: string }[];
      const allowed = allowedFromAddresses(app.cfg, app.db, s.userKey, s.username);
      const login = loginAddress(app.cfg, s.username);
      // Make sure the login address always exists as an identity.
      if (!rows.some((r) => r.email === login)) rows.unshift({ id: 0, name: '', email: login, replyTo: null, signatureHtml: '', isDefault: rows.length === 0 ? 1 : 0 } as never);
      return { identities: rows, allowed: allowed === 'any' ? null : [...allowed] };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.put('/api/identities', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const list = z
        .array(
          z.object({
            name: z.string().max(200).default(''),
            email: z.string().max(320),
            replyTo: z.string().max(320).nullable().optional(),
            signatureHtml: z.string().max(64 * 1024).default(''),
            isDefault: z.union([z.boolean(), z.number()]).default(false),
          }),
        )
        .max(50)
        .parse(req.body);
      const allowed = allowedFromAddresses(app.cfg, app.db, s.userKey, s.username);
      const ins = app.db.prepare('INSERT INTO identities (user_key, name, email, reply_to, signature_html, is_default) VALUES (?, ?, ?, ?, ?, ?)');
      app.db.transaction(() => {
        app.db.prepare('DELETE FROM identities WHERE user_key = ?').run(s.userKey);
        let defaultSet = false;
        for (const i of list) {
          const email = normalizeAddress(i.email);
          if (allowed !== 'any' && !allowed.has(email)) throw new HttpError(403, `Your administrator does not allow sending as ${email}`);
          const isDefault: boolean = !!i.isDefault && !defaultSet;
          defaultSet ||= isDefault;
          // Signature HTML is sanitized again in the browser before rendering; strip the obviously active parts here too.
          const sig = i.signatureHtml.replace(/<\s*(script|iframe|object|embed|form|style|link|meta|base)[\s\S]*?>[\s\S]*?(<\s*\/\s*\1\s*>)?/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
          ins.run(s.userKey, cleanHeaderValue(i.name), email, i.replyTo ? normalizeAddress(i.replyTo) : null, sig, isDefault ? 1 : 0);
        }
      })();
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---------- snippets (Superhuman-style text templates) ----------
  f.get('/api/snippets', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      return { snippets: app.db.prepare('SELECT id, title, body_html bodyHtml FROM snippets WHERE user_key = ? ORDER BY title').all(s.userKey) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.post('/api/snippets', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const b = z.object({ id: z.number().int().optional(), title: z.string().min(1).max(200), bodyHtml: z.string().max(64 * 1024) }).parse(req.body);
      if (b.id) app.db.prepare('UPDATE snippets SET title = ?, body_html = ? WHERE id = ? AND user_key = ?').run(b.title, b.bodyHtml, b.id, s.userKey);
      else app.db.prepare('INSERT INTO snippets (user_key, title, body_html, created_at) VALUES (?, ?, ?, ?)').run(s.userKey, b.title, b.bodyHtml, Date.now());
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.delete('/api/snippets/:id', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      app.db.prepare('DELETE FROM snippets WHERE id = ? AND user_key = ?').run(Number((req.params as { id: string }).id), s.userKey);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
