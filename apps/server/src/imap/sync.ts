import type { FetchMessageObject, ImapFlow, ListResponse, MessageAddressObject } from 'imapflow';
import type { DB } from '../db/index.js';
import {
  cleanHeaderValue,
  decodeCharset,
  decodeTransfer,
  hasRealAttachments,
  htmlToText,
  makeSnippet,
  normalizeSubject,
  parseMessageIds,
  pickBodyParts,
} from '../lib/mime.js';
import type { Account } from './account.js';

const FIRST_CHUNK = 300;
const CHUNK = 1000;

export interface MailboxRow {
  path: string;
  name: string;
  delimiter: string | null;
  parent_path: string | null;
  special_use: string | null;
  flags: string;
  subscribed: number;
  uid_validity: string | null;
  uid_next: number | null;
  highest_modseq: string | null;
  total: number;
  unseen: number;
  last_sync: number | null;
  synced_count: number;
  color: string | null;
  sort_order: number | null;
}

/** Compress a list of UIDs into an IMAP sequence set: 1:5,7,9:12 */
export function uidSet(uids: number[]): string {
  const s = [...new Set(uids)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const start = s[i];
    while (i + 1 < s.length && s[i + 1] === s[i] + 1) i++;
    out.push(start === s[i] ? `${start}` : `${start}:${s[i]}`);
  }
  return out.join(',');
}

const NAME_FALLBACK: Record<string, string[]> = {
  '\\Sent': ['sent', 'sent items', 'sent messages', 'sent mail', 'gesendete objekte', 'gesendet', 'envoyés', 'elementos enviados', 'enviados', 'posta inviata', 'verzonden'],
  '\\Drafts': ['drafts', 'draft', 'entwürfe', 'brouillons', 'borradores', 'bozze', 'concepten'],
  '\\Trash': ['trash', 'deleted', 'deleted items', 'deleted messages', 'bin', 'papierkorb', 'corbeille', 'papelera', 'cestino', 'prullenbak'],
  '\\Junk': ['junk', 'spam', 'junk e-mail', 'junk email', 'bulk mail', 'spam-verdacht', 'indésirables', 'correo no deseado'],
  '\\Archive': ['archive', 'archives', 'archiv', 'archivo', 'archivio', 'archief'],
};

function detectSpecialUse(m: ListResponse): string | null {
  if (m.path.toUpperCase() === 'INBOX') return '\\Inbox';
  if (m.specialUse) return m.specialUse;
  const name = m.name.toLowerCase();
  for (const [use, names] of Object.entries(NAME_FALLBACK)) if (names.includes(name)) return use;
  return null;
}

/** Refresh the folder list and per-folder counts (LIST + STATUS). */
export async function syncMailboxList(acc: Account, db: DB, client: ImapFlow): Promise<MailboxRow[]> {
  const list = await client.list({
    statusQuery: { messages: true, unseen: true, uidNext: true, uidValidity: true, highestModseq: true },
  });
  const existing = new Map(
    (db.prepare('SELECT path FROM mailboxes WHERE user_key = ?').all(acc.userKey) as { path: string }[]).map((r) => [r.path, true]),
  );
  const upsert = db.prepare(`
    INSERT INTO mailboxes (user_key, path, name, delimiter, parent_path, special_use, flags, subscribed, total, unseen)
    VALUES (@user_key, @path, @name, @delimiter, @parent_path, @special_use, @flags, @subscribed, @total, @unseen)
    ON CONFLICT(user_key, path) DO UPDATE SET
      name = excluded.name, delimiter = excluded.delimiter, parent_path = excluded.parent_path,
      special_use = excluded.special_use, flags = excluded.flags, subscribed = excluded.subscribed,
      total = excluded.total, unseen = excluded.unseen`);
  const seen = new Set<string>();
  db.transaction(() => {
    for (const m of list) {
      if (m.flags.has('\\Noselect') || m.flags.has('\\NonExistent')) continue;
      seen.add(m.path);
      upsert.run({
        user_key: acc.userKey,
        path: m.path,
        name: m.name,
        delimiter: m.delimiter ?? null,
        parent_path: m.parentPath || null,
        special_use: detectSpecialUse(m),
        flags: JSON.stringify([...m.flags]),
        subscribed: m.subscribed === false ? 0 : 1,
        total: m.status?.messages ?? 0,
        unseen: m.status?.unseen ?? 0,
      });
    }
    for (const path of existing.keys()) {
      if (!seen.has(path)) {
        db.prepare('DELETE FROM mailboxes WHERE user_key = ? AND path = ?').run(acc.userKey, path);
        db.prepare('DELETE FROM messages WHERE user_key = ? AND mailbox = ?').run(acc.userKey, path);
      }
    }
  })();
  // remember STATUS values to detect remote changes cheaply
  const statusMap = new Map(list.map((m) => [m.path, m.status]));
  acc.emit('status', statusMap);
  return db.prepare('SELECT * FROM mailboxes WHERE user_key = ? ORDER BY path').all(acc.userKey) as MailboxRow[];
}

function addr(a?: MessageAddressObject[]): { name: string; address: string }[] {
  return (a ?? []).filter((x) => x.address).map((x) => ({ name: cleanHeaderValue(x.name ?? ''), address: (x.address ?? '').toLowerCase() }));
}

function parseHeaderBlock(buf?: Buffer): Map<string, string> {
  const map = new Map<string, string>();
  if (!buf) return map;
  const text = buf.toString('latin1').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) {
      const k = line.slice(0, i).trim().toLowerCase();
      if (!map.has(k)) map.set(k, line.slice(i + 1).trim());
    }
  }
  return map;
}

function threadIdFor(db: DB, userKey: string, msgId: string | null, inReplyTo: string | null, refs: string[], fallback: string): string {
  const byMsgId = db.prepare('SELECT thread_id FROM messages WHERE user_key = ? AND message_id = ? LIMIT 1');
  if (refs.length) {
    const root = byMsgId.get(userKey, refs[0]) as { thread_id: string } | undefined;
    return root?.thread_id ?? refs[0];
  }
  if (inReplyTo) {
    const parent = byMsgId.get(userKey, inReplyTo) as { thread_id: string } | undefined;
    return parent?.thread_id ?? inReplyTo;
  }
  if (msgId) {
    const self = byMsgId.get(userKey, msgId) as { thread_id: string } | undefined;
    return self?.thread_id ?? msgId;
  }
  return fallback;
}

const FLAG_COLS = (flags: Set<string>) => ({
  seen: flags.has('\\Seen') ? 1 : 0,
  flagged: flags.has('\\Flagged') ? 1 : 0,
  answered: flags.has('\\Answered') ? 1 : 0,
  draft: flags.has('\\Draft') ? 1 : 0,
  deleted: flags.has('\\Deleted') ? 1 : 0,
});

/** Fetch metadata + a preview for a set of UIDs and insert them into the index. */
async function indexUids(acc: Account, db: DB, client: ImapFlow, path: string, uidValidity: string, uids: number[]) {
  if (!uids.length) return;
  const msgs: FetchMessageObject[] = [];
  for await (const m of client.fetch(
    uidSet(uids),
    {
      uid: true,
      flags: true,
      envelope: true,
      internalDate: true,
      size: true,
      bodyStructure: true,
      headers: ['references', 'list-unsubscribe', 'list-unsubscribe-post'],
    },
    { uid: true },
  )) {
    msgs.push(m);
  }

  // Previews: group messages by the part that holds their text, fetch the first 2 KB of each.
  const snippets = new Map<number, string>();
  const groups = new Map<string, { uids: number[]; info: Map<number, { charset?: string; encoding?: string; html: boolean }> }>();
  for (const m of msgs) {
    if (!m.bodyStructure) continue;
    const parts = pickBodyParts(m.bodyStructure);
    const p = parts.text ?? parts.html;
    if (!p) continue;
    const g = groups.get(p.part) ?? { uids: [] as number[], info: new Map<number, { charset?: string; encoding?: string; html: boolean }>() };
    g.uids.push(m.uid);
    g.info.set(m.uid, { charset: p.charset, encoding: p.encoding, html: !parts.text });
    groups.set(p.part, g);
  }
  for (const [part, g] of groups) {
    for await (const m of client.fetch(uidSet(g.uids), { uid: true, bodyParts: [{ key: part, start: 0, maxLength: 2048 }] }, { uid: true })) {
      const raw = m.bodyParts ? [...m.bodyParts.values()][0] : undefined;
      const info = g.info.get(m.uid);
      if (!raw || !info) continue;
      const binary = m.binaryParts && m.binaryParts.size > 0;
      let text = decodeCharset(binary ? raw : decodeTransfer(raw, info.encoding), info.charset);
      if (info.html) text = htmlToText(text);
      snippets.set(m.uid, makeSnippet(text));
    }
  }

  const insert = db.prepare(`
    INSERT INTO messages (user_key, mailbox, uid, uid_validity, message_id, thread_id, in_reply_to, refs, subject,
      from_name, from_addr, to_json, cc_json, reply_to_json, date, internal_date, size, flags, seen, flagged, answered, draft, deleted,
      has_attachments, snippet, list_unsubscribe, list_unsubscribe_post, modseq)
    VALUES (@user_key, @mailbox, @uid, @uid_validity, @message_id, @thread_id, @in_reply_to, @refs, @subject,
      @from_name, @from_addr, @to_json, @cc_json, @reply_to_json, @date, @internal_date, @size, @flags, @seen, @flagged, @answered, @draft, @deleted,
      @has_attachments, @snippet, @list_unsubscribe, @list_unsubscribe_post, @modseq)
    ON CONFLICT(user_key, mailbox, uid) DO NOTHING`);

  // Oldest first so parents get their thread id before their replies.
  msgs.sort((a, b) => a.uid - b.uid);
  db.transaction(() => {
    for (const m of msgs) {
      const env = m.envelope ?? {};
      const headers = parseHeaderBlock(m.headers);
      const msgId = parseMessageIds(env.messageId)[0] ?? null;
      const inReplyTo = parseMessageIds(env.inReplyTo)[0] ?? null;
      const refs = parseMessageIds(headers.get('references')).slice(-50);
      const flags = m.flags ?? new Set<string>();
      const from = addr(env.from)[0] ?? { name: '', address: '' };
      const internal = m.internalDate ? new Date(m.internalDate).getTime() : Date.now();
      let date = env.date ? new Date(env.date).getTime() : internal;
      if (!Number.isFinite(date) || date > Date.now() + 86_400_000 * 2) date = internal; // bogus/future Date headers
      const subject = cleanHeaderValue(env.subject ?? '');
      insert.run({
        user_key: acc.userKey,
        mailbox: path,
        uid: m.uid,
        uid_validity: uidValidity,
        message_id: msgId,
        thread_id: threadIdFor(db, acc.userKey, msgId, inReplyTo, refs, `${path}:${uidValidity}:${m.uid}`),
        in_reply_to: inReplyTo,
        refs: JSON.stringify(refs),
        subject,
        from_name: from.name,
        from_addr: from.address,
        to_json: JSON.stringify(addr(env.to)),
        cc_json: JSON.stringify(addr(env.cc)),
        reply_to_json: JSON.stringify(addr(env.replyTo)),
        date,
        internal_date: internal,
        size: m.size ?? 0,
        flags: JSON.stringify([...flags]),
        ...FLAG_COLS(flags),
        has_attachments: hasRealAttachments(m.bodyStructure) ? 1 : 0,
        snippet: snippets.get(m.uid) ?? '',
        list_unsubscribe: headers.get('list-unsubscribe')?.slice(0, 2000) ?? null,
        list_unsubscribe_post: /one-click/i.test(headers.get('list-unsubscribe-post') ?? '') ? 1 : 0,
        modseq: m.modseq !== undefined ? m.modseq.toString() : null,
      });
    }
  })();
}

/**
 * Recompute synced/unseen counts from the index. While a folder is still backfilling, the server's
 * STATUS UNSEEN (written by syncMailboxList) is more accurate than a partial index count, so keep it.
 */
export function refreshCounts(db: DB, userKey: string, path: string) {
  const synced = (db.prepare('SELECT COUNT(*) n FROM messages WHERE user_key = ? AND mailbox = ?').get(userKey, path) as { n: number }).n;
  const row = db.prepare('SELECT total FROM mailboxes WHERE user_key = ? AND path = ?').get(userKey, path) as { total: number } | undefined;
  if (!row) return;
  if (synced >= row.total) {
    const unseen = (db.prepare('SELECT COUNT(*) n FROM messages WHERE user_key = ? AND mailbox = ? AND seen = 0 AND deleted = 0').get(userKey, path) as { n: number }).n;
    db.prepare('UPDATE mailboxes SET synced_count = ?, unseen = ? WHERE user_key = ? AND path = ?').run(synced, unseen, userKey, path);
  } else {
    db.prepare('UPDATE mailboxes SET synced_count = ? WHERE user_key = ? AND path = ?').run(synced, userKey, path);
  }
}

const inflight = new Map<string, Promise<SyncResult>>();

export interface SyncResult {
  added: number;
  removed: number;
  updated: number;
  pending: number;
}

/**
 * Bring the index for one mailbox up to date:
 *  - UIDVALIDITY change -> drop the folder's index and rebuild
 *  - UID SEARCH ALL -> detect expunged + not-yet-indexed messages
 *  - CONDSTORE CHANGEDSINCE (or a full FLAGS rescan) -> flag changes
 *  - newest FIRST_CHUNK missing messages now, the rest in background chunks
 */
const rerun = new Set<string>();

export function syncMailbox(acc: Account, db: DB, path: string, priority = 5): Promise<SyncResult> {
  const key = `${acc.userKey}\0${path}`;
  const running = inflight.get(key);
  if (running) {
    // A sync is already underway but may have started before this change: run once more after it.
    rerun.add(key);
    return running;
  }
  const p = acc
    .run((client) => syncMailboxNow(acc, db, client, path), priority)
    .finally(() => {
      inflight.delete(key);
      if (rerun.delete(key)) void syncMailbox(acc, db, path, priority).catch(() => undefined);
    });
  inflight.set(key, p);
  return p;
}

async function syncMailboxNow(acc: Account, db: DB, client: ImapFlow, path: string): Promise<SyncResult> {
  const lock = await client.getMailboxLock(path, { readOnly: true });
  const result: SyncResult = { added: 0, removed: 0, updated: 0, pending: 0 };
  try {
    // A pooled connection may have had this folder selected for a while without hearing about new
    // mail; NOOP makes the server report EXISTS/EXPUNGE so the view below is current.
    await client.noop();
    const mb = client.mailbox;
    if (!mb) throw new Error('mailbox not selected');
    const uidValidity = mb.uidValidity.toString();
    const row = db.prepare('SELECT * FROM mailboxes WHERE user_key = ? AND path = ?').get(acc.userKey, path) as MailboxRow | undefined;
    if (row?.uid_validity && row.uid_validity !== uidValidity) {
      db.prepare('DELETE FROM messages WHERE user_key = ? AND mailbox = ?').run(acc.userKey, path);
    }

    const serverUids = mb.exists > 0 ? ((await client.search({ all: true }, { uid: true })) || []) : [];
    const known = new Set(
      (db.prepare('SELECT uid FROM messages WHERE user_key = ? AND mailbox = ?').all(acc.userKey, path) as { uid: number }[]).map((r) => r.uid),
    );
    const serverSet = new Set(serverUids);
    const removed = [...known].filter((u) => !serverSet.has(u));
    if (removed.length) {
      const del = db.prepare('DELETE FROM messages WHERE user_key = ? AND mailbox = ? AND uid = ?');
      db.transaction(() => removed.forEach((u) => del.run(acc.userKey, path, u)))();
      result.removed = removed.length;
    }

    // Flag changes on already-indexed messages
    const canModseq = acc.enabled.has('CONDSTORE') && !mb.noModseq && mb.highestModseq !== undefined;
    const knownStill = [...known].filter((u) => serverSet.has(u));
    if (knownStill.length) {
      const changedSince = canModseq && row?.highest_modseq && row.uid_validity === uidValidity ? BigInt(row.highest_modseq) : undefined;
      if (changedSince === undefined || mb.highestModseq! > changedSince) {
        const upd = db.prepare(
          'UPDATE messages SET flags = @flags, seen = @seen, flagged = @flagged, answered = @answered, draft = @draft, deleted = @deleted, modseq = @modseq WHERE user_key = @user_key AND mailbox = @mailbox AND uid = @uid AND flags != @flags',
        );
        const updates: FetchMessageObject[] = [];
        for await (const m of client.fetch(uidSet(knownStill), { uid: true, flags: true }, { uid: true, changedSince })) updates.push(m);
        db.transaction(() => {
          for (const m of updates) {
            const flags = m.flags ?? new Set<string>();
            const r = upd.run({
              user_key: acc.userKey,
              mailbox: path,
              uid: m.uid,
              flags: JSON.stringify([...flags]),
              ...FLAG_COLS(flags),
              modseq: m.modseq?.toString() ?? null,
            });
            result.updated += r.changes;
          }
        })();
      }
    }

    // New / not yet indexed messages, newest first
    const missing = serverUids.filter((u) => !known.has(u)).sort((a, b) => b - a);
    const now = missing.slice(0, FIRST_CHUNK);
    await indexUids(acc, db, client, path, uidValidity, now);
    result.added = now.length;
    result.pending = missing.length - now.length;

    db.prepare(
      'UPDATE mailboxes SET uid_validity = ?, uid_next = ?, highest_modseq = ?, total = ?, last_sync = ? WHERE user_key = ? AND path = ?',
    ).run(uidValidity, mb.uidNext, mb.highestModseq?.toString() ?? null, mb.exists, Date.now(), acc.userKey, path);
    refreshCounts(db, acc.userKey, path);

    if (result.pending > 0) {
      const rest = missing.slice(FIRST_CHUNK);
      setImmediate(() => void backfill(acc, db, path, uidValidity, rest));
    }
  } finally {
    lock.release();
  }
  if (result.added || result.removed || result.updated) {
    acc.emit('event', { type: 'mailbox', path, ...result });
  }
  return result;
}

async function backfill(acc: Account, db: DB, path: string, uidValidity: string, uids: number[]) {
  for (let i = 0; i < uids.length; i += CHUNK) {
    const chunk = uids.slice(i, i + CHUNK);
    try {
      await acc.run(async (client) => {
        const lock = await client.getMailboxLock(path, { readOnly: true });
        try {
          if (client.mailbox && client.mailbox.uidValidity.toString() !== uidValidity) throw new Error('uidvalidity changed');
          await indexUids(acc, db, client, path, uidValidity, chunk);
        } finally {
          lock.release();
        }
      }, 1);
    } catch {
      return; // next sync will pick up whatever is still missing
    }
    refreshCounts(db, acc.userKey, path);
    acc.emit('event', { type: 'mailbox', path, added: chunk.length, removed: 0, updated: 0, pending: Math.max(0, uids.length - i - CHUNK) });
  }
}
