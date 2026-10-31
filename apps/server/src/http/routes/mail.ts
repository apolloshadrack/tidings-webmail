import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getMessage, getSource, openPart } from '../../imap/message.js';
import { deletePermanently, moveMessages, setFlags } from '../../imap/ops.js';
import { type MailboxRow, syncMailbox, syncMailboxList, uidSet } from '../../imap/sync.js';
import { contentDisposition, sniffImage, sanitizeFilename } from '../../lib/mime.js';
import { type App, HttpError, accountFor, checkMutation, requireSession, sendError } from '../context.js';
import { ftsQuery, parseSearch } from '../search.js';

const TargetSchema = z.object({
  mailbox: z.string().min(1).max(1000),
  uidValidity: z.string().regex(/^\d{1,20}$/),
  uids: z.array(z.number().int().positive()).min(1).max(10_000),
});

const ROLE_ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash'];

interface MsgRow {
  rowid: number;
  mailbox: string;
  uid: number;
  uid_validity: string;
  message_id: string | null;
  thread_id: string;
  subject: string;
  from_name: string;
  from_addr: string;
  to_json: string;
  cc_json: string;
  date: number;
  size: number;
  flags: string;
  seen: number;
  flagged: number;
  answered: number;
  draft: number;
  has_attachments: number;
  snippet: string;
  list_unsubscribe: string | null;
}

export function mailboxRoles(app: App, userKey: string): Map<string, string> {
  const rows = app.db.prepare('SELECT path, special_use FROM mailboxes WHERE user_key = ? AND special_use IS NOT NULL').all(userKey) as {
    path: string;
    special_use: string;
  }[];
  return new Map(rows.map((r) => [r.path, r.special_use]));
}

export function roleFolder(app: App, userKey: string, role: string): string | undefined {
  return (app.db.prepare('SELECT path FROM mailboxes WHERE user_key = ? AND special_use = ?').get(userKey, role) as { path: string } | undefined)?.path;
}

function itemFromRow(r: MsgRow) {
  return {
    mailbox: r.mailbox,
    uid: r.uid,
    uidValidity: r.uid_validity,
    messageId: r.message_id,
    threadId: r.thread_id,
    subject: r.subject,
    from: { name: r.from_name, address: r.from_addr },
    to: JSON.parse(r.to_json) as { name: string; address: string }[],
    cc: JSON.parse(r.cc_json) as { name: string; address: string }[],
    date: r.date,
    size: r.size,
    flags: JSON.parse(r.flags) as string[],
    unread: r.seen === 0,
    flagged: r.flagged === 1,
    answered: r.answered === 1,
    draft: r.draft === 1,
    hasAttachments: r.has_attachments === 1,
    snippet: r.snippet,
    newsletter: !!r.list_unsubscribe,
  };
}

export function mailRoutes(f: FastifyInstance, app: App) {
  // ---------- folders ----------
  f.get('/api/mailboxes', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      const q = req.query as { refresh?: string };
      let rows = app.db.prepare('SELECT * FROM mailboxes WHERE user_key = ?').all(s.userKey) as MailboxRow[];
      if (!rows.length || q.refresh) {
        const acc = accountFor(app, s, req.ip);
        rows = await acc.run((c) => syncMailboxList(acc, app.db, c), 9);
      }
      const quota = null;
      return {
        mailboxes: rows
          .map((r) => ({
            path: r.path,
            name: r.path.toUpperCase() === 'INBOX' ? 'Inbox' : r.name,
            delimiter: r.delimiter,
            parent: r.parent_path,
            role: r.special_use,
            total: r.total,
            unread: r.unseen,
            synced: r.synced_count,
            subscribed: r.subscribed === 1,
            color: r.color,
            uidValidity: r.uid_validity,
          }))
          .sort((a, b) => {
            const ra = a.role ? ROLE_ORDER.indexOf(a.role) : -1;
            const rb = b.role ? ROLE_ORDER.indexOf(b.role) : -1;
            if (ra !== rb) return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
            return a.path.localeCompare(b.path);
          }),
        quota,
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.post('/api/mailboxes/sync', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const { path } = z.object({ path: z.string().min(1).max(1000) }).parse(req.body);
      const acc = accountFor(app, s, req.ip);
      const result = await syncMailbox(acc, app.db, path, 9);
      return result;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.post('/api/mailboxes', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const body = z.object({ name: z.string().min(1).max(200), parent: z.string().max(1000).optional(), role: z.enum(['archive']).optional() }).parse(req.body);
      const acc = accountFor(app, s, req.ip);
      const parentRow = body.parent
        ? (app.db.prepare('SELECT delimiter FROM mailboxes WHERE user_key = ? AND path = ?').get(s.userKey, body.parent) as { delimiter: string } | undefined)
        : undefined;
      const delim = parentRow?.delimiter ?? (app.db.prepare('SELECT delimiter FROM mailboxes WHERE user_key = ? AND delimiter IS NOT NULL LIMIT 1').get(s.userKey) as { delimiter: string } | undefined)?.delimiter ?? '/';
      if (body.name.includes(delim)) throw new HttpError(400, `Folder names cannot contain "${delim}"`);
      const path = body.parent ? [...body.parent.split(delim), body.name] : body.name;
      await acc.run(async (c) => {
        await c.mailboxCreate(path);
        await c.mailboxSubscribe(path).catch(() => undefined);
      }, 8);
      await acc.run((c) => syncMailboxList(acc, app.db, c), 8);
      const full = Array.isArray(path) ? path.join(delim) : path;
      if (body.role === 'archive') app.db.prepare(`UPDATE mailboxes SET special_use = '\\Archive' WHERE user_key = ? AND path = ?`).run(s.userKey, full);
      acc.emit('event', { type: 'mailboxes' });
      return { path: full };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.patch('/api/mailboxes', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const body = z
        .object({ path: z.string().min(1).max(1000), newName: z.string().min(1).max(200).optional(), color: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().optional() })
        .parse(req.body);
      const acc = accountFor(app, s, req.ip);
      if (body.color !== undefined) app.db.prepare('UPDATE mailboxes SET color = ? WHERE user_key = ? AND path = ?').run(body.color, s.userKey, body.path);
      if (body.newName) {
        const row = app.db.prepare('SELECT * FROM mailboxes WHERE user_key = ? AND path = ?').get(s.userKey, body.path) as MailboxRow | undefined;
        if (!row) throw new HttpError(404, 'Folder not found');
        if (row.special_use) throw new HttpError(400, 'System folders cannot be renamed');
        const delim = row.delimiter ?? '/';
        if (body.newName.includes(delim)) throw new HttpError(400, `Folder names cannot contain "${delim}"`);
        const newPath = row.parent_path ? `${row.parent_path}${delim}${body.newName}` : body.newName;
        await acc.run((c) => c.mailboxRename(body.path, newPath), 8);
        app.db.prepare('UPDATE messages SET mailbox = ? WHERE user_key = ? AND mailbox = ?').run(newPath, s.userKey, body.path);
        app.db.prepare('UPDATE mailboxes SET path = ?, name = ? WHERE user_key = ? AND path = ?').run(newPath, body.newName, s.userKey, body.path);
        await acc.run((c) => syncMailboxList(acc, app.db, c), 8);
      }
      acc.emit('event', { type: 'mailboxes' });
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.delete('/api/mailboxes', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const { path } = z.object({ path: z.string().min(1).max(1000) }).parse(req.query);
      const row = app.db.prepare('SELECT special_use, total FROM mailboxes WHERE user_key = ? AND path = ?').get(s.userKey, path) as
        | { special_use: string | null; total: number }
        | undefined;
      if (!row) throw new HttpError(404, 'Folder not found');
      if (row.special_use) throw new HttpError(400, 'System folders cannot be deleted');
      const acc = accountFor(app, s, req.ip);
      await acc.run((c) => c.mailboxDelete(path), 8);
      app.db.prepare('DELETE FROM mailboxes WHERE user_key = ? AND path = ?').run(s.userKey, path);
      app.db.prepare('DELETE FROM messages WHERE user_key = ? AND mailbox = ?').run(s.userKey, path);
      acc.emit('event', { type: 'mailboxes' });
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---------- lists (served from the index) ----------
  f.get('/api/list', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      const q = z
        .object({
          mailbox: z.string().max(1000).optional(),
          q: z.string().max(500).optional(),
          filter: z.string().max(500).optional(),
          threads: z.enum(['0', '1']).default('1'),
          limit: z.coerce.number().int().min(1).max(200).default(60),
          cursor: z.string().max(400).optional(),
        })
        .parse(req.query);
      const roles = mailboxRoles(app, s.userKey);
      if (q.mailbox && !q.cursor) {
        // First open of a folder waits for its first index chunk; afterwards the index answers instantly
        // and stale folders refresh in the background (SSE tells the client when new rows land).
        const row = app.db.prepare('SELECT last_sync FROM mailboxes WHERE user_key = ? AND path = ?').get(s.userKey, q.mailbox) as
          | { last_sync: number | null }
          | undefined;
        if (row) {
          const acc = accountFor(app, s, req.ip);
          if (!row.last_sync) await syncMailbox(acc, app.db, q.mailbox, 9);
          else if (Date.now() - row.last_sync > 60_000) void syncMailbox(acc, app.db, q.mailbox, 6).catch(() => undefined);
        }
      }
      const query = [q.filter, q.q].filter(Boolean).join(' ');
      const parsed = query ? parseSearch(query, roles) : { where: [], params: [], mailbox: undefined, freeText: [], hasFolderScope: false };
      const mailbox = parsed.mailbox ?? q.mailbox;
      const where = ['m.user_key = ?', 'm.deleted = 0', ...parsed.where];
      const params: unknown[] = [s.userKey, ...parsed.params];
      if (mailbox) {
        where.push('m.mailbox = ?');
        params.push(mailbox);
      } else if (!parsed.hasFolderScope) {
        // global search: everything except Trash and Junk
        const excluded = [...roles].filter(([, r]) => r === '\\Trash' || r === '\\Junk').map(([p]) => p);
        if (excluded.length) {
          where.push(`m.mailbox NOT IN (${excluded.map(() => '?').join(',')})`);
          params.push(...excluded);
        }
      }
      const fts = ftsQuery(parsed.freeText);
      if (fts) {
        where.push('m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)');
        params.push(fts);
      }
      const role = mailbox ? roles.get(mailbox) : undefined;
      const threads = !!mailbox && q.threads === '1' && !['\\Drafts', '\\Sent', '\\Trash'].includes(role ?? '') && !q.q;
      let cursorDate = Number.MAX_SAFE_INTEGER;
      let cursorKey = '￿';
      if (q.cursor) {
        const i = q.cursor.indexOf(':');
        cursorDate = Number(q.cursor.slice(0, i));
        cursorKey = q.cursor.slice(i + 1);
      }

      if (!threads) {
        const rows = app.db
          .prepare(
            `SELECT m.rowid, m.* FROM messages m WHERE ${where.join(' AND ')}
             AND (m.date < ? OR (m.date = ? AND (m.mailbox || ':' || printf('%012d', m.uid)) < ?))
             ORDER BY m.date DESC, m.mailbox || ':' || printf('%012d', m.uid) DESC LIMIT ?`,
          )
          .all(...params, cursorDate, cursorDate, cursorKey, q.limit + 1) as MsgRow[];
        const more = rows.length > q.limit;
        const page = rows.slice(0, q.limit);
        const last = page[page.length - 1];
        return {
          items: page.map((r) => {
            const it = itemFromRow(r);
            return { ...it, key: `${r.mailbox}:${r.uid}`, uids: [r.uid], count: 1, unreadCount: it.unread ? 1 : 0, participants: [it.from] };
          }),
          nextCursor: more && last ? `${last.date}:${last.mailbox}:${String(last.uid).padStart(12, '0')}` : null,
          threads: false,
        };
      }

      // Conversation mode: one row per thread (latest message in this folder represents it).
      const groups = app.db
        .prepare(
          `SELECT m.thread_id AS tid, MAX(m.date) AS d, COUNT(*) AS n, SUM(m.seen = 0) AS unread, MAX(m.flagged) AS flagged,
                  MAX(m.has_attachments) AS att, json_group_array(m.uid) AS uids
           FROM messages m WHERE ${where.join(' AND ')}
           GROUP BY m.thread_id
           HAVING (d < ? OR (d = ? AND tid < ?))
           ORDER BY d DESC, tid DESC LIMIT ?`,
        )
        .all(...params, cursorDate, cursorDate, cursorKey, q.limit + 1) as {
        tid: string;
        d: number;
        n: number;
        unread: number;
        flagged: number;
        att: number;
        uids: string;
      }[];
      const more = groups.length > q.limit;
      const page = groups.slice(0, q.limit);
      const latest = app.db.prepare(
        `SELECT m.rowid, m.* FROM messages m WHERE m.user_key = ? AND m.thread_id = ? AND m.mailbox = ? AND m.deleted = 0 ORDER BY m.date DESC LIMIT 1`,
      );
      const participantsQ = app.db.prepare(
        `SELECT from_name, from_addr, MIN(date) first FROM messages WHERE user_key = ? AND thread_id = ? GROUP BY from_addr ORDER BY first LIMIT 4`,
      );
      const totalQ = app.db.prepare(`SELECT COUNT(DISTINCT COALESCE(message_id, mailbox || uid)) n FROM messages WHERE user_key = ? AND thread_id = ? AND deleted = 0`);
      const items = page.map((g) => {
        const r = latest.get(s.userKey, g.tid, mailbox) as MsgRow;
        const it = itemFromRow(r);
        const participants = (participantsQ.all(s.userKey, g.tid) as { from_name: string; from_addr: string }[]).map((p) => ({ name: p.from_name, address: p.from_addr }));
        return {
          ...it,
          key: `t:${g.tid}`,
          uids: JSON.parse(g.uids) as number[],
          count: (totalQ.get(s.userKey, g.tid) as { n: number }).n,
          unreadCount: g.unread,
          unread: g.unread > 0,
          flagged: g.flagged === 1,
          hasAttachments: g.att === 1,
          participants,
        };
      });
      const last = page[page.length - 1];
      return { items, nextCursor: more && last ? `${last.d}:${last.tid}` : null, threads: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** All messages of a conversation, across folders (Trash/Junk only when viewing those). */
  f.get('/api/thread', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      const q = z.object({ threadId: z.string().max(1000), mailbox: z.string().max(1000).optional() }).parse(req.query);
      const roles = mailboxRoles(app, s.userKey);
      const viewingRole = q.mailbox ? roles.get(q.mailbox) : undefined;
      const hidden = [...roles].filter(([p, r]) => (r === '\\Trash' || r === '\\Junk') && p !== q.mailbox && viewingRole !== r).map(([p]) => p);
      const rows = app.db
        .prepare(
          `SELECT m.rowid, m.* FROM messages m WHERE m.user_key = ? AND m.thread_id = ? AND m.deleted = 0
           ${hidden.length ? `AND m.mailbox NOT IN (${hidden.map(() => '?').join(',')})` : ''} ORDER BY m.date ASC`,
        )
        .all(s.userKey, q.threadId, ...hidden) as MsgRow[];
      // De-duplicate copies of the same message in several folders, preferring the viewed folder.
      const byId = new Map<string, MsgRow>();
      for (const r of rows) {
        const k = r.message_id ?? `${r.mailbox}:${r.uid}`;
        const prev = byId.get(k);
        if (!prev || r.mailbox === q.mailbox) byId.set(k, r);
      }
      return { messages: [...byId.values()].sort((a, b) => a.date - b.date).map(itemFromRow) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---------- message bodies ----------
  const MsgQuery = z.object({ mailbox: z.string().max(1000), uidValidity: z.string().regex(/^\d{1,20}$/), uid: z.coerce.number().int().positive() });

  f.get('/api/message', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      const q = MsgQuery.extend({ prefetch: z.string().optional() }).parse(req.query);
      const acc = accountFor(app, s, req.ip);
      const msg = await getMessage(acc, app.db, q.mailbox, q.uidValidity, q.uid, app.cfg.trustedAuthservIds, q.prefetch ? 3 : 9);
      if (!msg) throw new HttpError(404, 'Message not found (it may have been moved or deleted).', 'NOT_FOUND');
      const known = app.db.prepare('SELECT 1 FROM contacts WHERE user_key = ? AND email = ?');
      const trusted = msg.from[0] ? !!app.db.prepare('SELECT 1 FROM trusted_senders WHERE user_key = ? AND sender = ?').get(s.userKey, msg.from[0].address) : false;
      reply.header('Cache-Control', 'private, no-store');
      return {
        ...msg,
        senderKnown: msg.from[0] ? !!known.get(s.userKey, msg.from[0].address) : false,
        imagesTrusted: trusted,
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * Attachments / inline parts. Untrusted bytes are NEVER rendered as active content in our origin:
   * inline only when magic bytes say png/jpeg/gif/webp; everything else is a download as octet-stream.
   */
  f.get('/api/message/part', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      const q = MsgQuery.extend({ part: z.string().regex(/^[0-9]+(\.[0-9]+)*$/), inline: z.string().optional(), name: z.string().max(300).optional() }).parse(req.query);
      const acc = accountFor(app, s, req.ip);
      const p = await openPart(acc, q.mailbox, q.uidValidity, q.uid, q.part);
      if (!p) throw new HttpError(404, 'Attachment not found');
      const filename = sanitizeFilename(p.meta?.filename ?? q.name, `attachment-${q.part}`);
      const sniff = sniffImage(p.buf);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
      reply.header('Cross-Origin-Resource-Policy', 'same-origin');
      reply.header('Cache-Control', 'private, no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      if (q.inline && sniff) {
        reply.header('Content-Type', sniff);
        reply.header('Content-Disposition', contentDisposition('inline', filename));
      } else {
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Content-Disposition', contentDisposition('attachment', filename));
      }
      return reply.send(p.buf);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.get('/api/message/source', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      const q = MsgQuery.extend({ download: z.string().optional() }).parse(req.query);
      const acc = accountFor(app, s, req.ip);
      const buf = await getSource(acc, q.mailbox, q.uidValidity, q.uid);
      if (!buf) throw new HttpError(404, 'Message not found');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'private, no-store');
      if (q.download) {
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Content-Disposition', contentDisposition('attachment', `message-${q.uid}.eml`));
        return reply.send(buf);
      }
      // returned as JSON text so the SPA renders it as a text node, never as markup
      return { source: buf.toString('utf8') };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---------- actions ----------
  f.post('/api/actions/flags', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const body = z
        .object({ targets: z.array(TargetSchema).min(1).max(100), add: z.array(z.string()).max(10).default([]), remove: z.array(z.string()).max(10).default([]) })
        .parse(req.body);
      const acc = accountFor(app, s, req.ip);
      for (const t of body.targets) await setFlags(acc, app.db, t, body.add, body.remove);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.post('/api/actions/move', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const body = z
        .object({
          targets: z.array(TargetSchema).min(1).max(100),
          to: z.string().max(1000).optional(),
          role: z.enum(['archive', 'trash', 'junk', 'inbox', 'notjunk']).optional(),
        })
        .parse(req.body);
      const acc = accountFor(app, s, req.ip);
      let dest = body.to;
      if (body.role) {
        const role = { archive: '\\Archive', trash: '\\Trash', junk: '\\Junk', inbox: '\\Inbox', notjunk: '\\Inbox' }[body.role];
        dest = acc.has('X-GM-EXT-1') && body.role === 'archive' ? roleFolder(app, s.userKey, '\\All') : roleFolder(app, s.userKey, role);
        if (!dest && body.role === 'archive') throw new HttpError(409, 'There is no Archive folder yet.', 'NEEDS_ARCHIVE_FOLDER');
        if (!dest) throw new HttpError(409, `No ${body.role} folder found on the server`, 'NO_FOLDER');
      }
      if (!dest) throw new HttpError(400, 'Missing destination');
      const results = [];
      for (const t of body.targets) {
        if (body.role === 'junk') await setFlags(acc, app.db, t, ['$Junk'], ['$NotJunk']).catch(() => undefined);
        if (body.role === 'notjunk') await setFlags(acc, app.db, t, ['$NotJunk'], ['$Junk']).catch(() => undefined);
        const r = await moveMessages(acc, app.db, t, dest);
        results.push({ from: t.mailbox, uids: t.uids, ...r });
      }
      return { results };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.post('/api/actions/delete', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const body = z.object({ targets: z.array(TargetSchema).min(1).max(100) }).parse(req.body);
      const roles = mailboxRoles(app, s.userKey);
      for (const t of body.targets) {
        const r = roles.get(t.mailbox);
        if (r !== '\\Trash' && r !== '\\Junk' && r !== '\\Drafts') throw new HttpError(400, 'Permanent delete is only allowed in Trash, Spam or Drafts');
      }
      const acc = accountFor(app, s, req.ip);
      for (const t of body.targets) await deletePermanently(acc, app.db, t);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.post('/api/actions/empty', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const { mailbox } = z.object({ mailbox: z.string().max(1000) }).parse(req.body);
      const role = mailboxRoles(app, s.userKey).get(mailbox);
      if (role !== '\\Trash' && role !== '\\Junk') throw new HttpError(400, 'Only Trash and Spam can be emptied');
      const row = app.db.prepare('SELECT uid_validity FROM mailboxes WHERE user_key = ? AND path = ?').get(s.userKey, mailbox) as { uid_validity: string };
      const uids = (app.db.prepare('SELECT uid FROM messages WHERE user_key = ? AND mailbox = ?').all(s.userKey, mailbox) as { uid: number }[]).map((r) => r.uid);
      const acc = accountFor(app, s, req.ip);
      for (let i = 0; i < uids.length; i += 1000) {
        await deletePermanently(acc, app.db, { mailbox, uidValidity: row.uid_validity, uids: uids.slice(i, i + 1000) });
      }
      return { ok: true, deleted: uids.length };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---------- tier-2 body search (server-side IMAP SEARCH, per folder, cancellable by the client) ----------
  f.post('/api/search/body', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const body = z.object({ text: z.string().min(2).max(200), mailbox: z.string().max(1000) }).parse(req.body);
      const acc = accountFor(app, s, req.ip);
      const uids = await acc.run(async (c) => {
        const lock = await c.getMailboxLock(body.mailbox, { readOnly: true });
        try {
          const res = await Promise.race([
            c.search({ body: body.text }, { uid: true }),
            new Promise<never>((_, rej) => setTimeout(() => rej(new HttpError(504, 'Body search took too long in this folder')), 20_000)),
          ]);
          return (res || []) as number[];
        } finally {
          lock.release();
        }
      }, 4);
      const rows = uids.length
        ? (app.db
            .prepare(`SELECT m.rowid, m.* FROM messages m WHERE m.user_key = ? AND m.mailbox = ? AND m.uid IN (${uids.slice(-500).map(() => '?').join(',')}) ORDER BY m.date DESC`)
            .all(s.userKey, body.mailbox, ...uids.slice(-500)) as MsgRow[])
        : [];
      return {
        items: rows.map((r) => {
          const it = itemFromRow(r);
          return { ...it, key: `${r.mailbox}:${r.uid}`, uids: [r.uid], count: 1, unreadCount: it.unread ? 1 : 0, participants: [it.from] };
        }),
        truncated: uids.length > 500,
        set: uids.length ? uidSet(uids.slice(0, 3)) : '',
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.get('/api/quota', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      const acc = accountFor(app, s, req.ip);
      if (!acc.has('QUOTA')) return { quota: null };
      const q = await acc.run((c) => c.getQuota('INBOX'), 2);
      if (!q || !q.storage) return { quota: null };
      return { quota: { used: q.storage.usage ?? 0, limit: q.storage.limit ?? 0 } };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
