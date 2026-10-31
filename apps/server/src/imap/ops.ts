import type { ImapFlow } from 'imapflow';
import type { DB } from '../db/index.js';
import { type Account, UidValidityChangedError } from './account.js';
import { refreshCounts, uidSet } from './sync.js';

export interface Target {
  mailbox: string;
  uidValidity: string;
  uids: number[];
}

async function withMailbox<T>(client: ImapFlow, t: Target, fn: () => Promise<T>): Promise<T> {
  const lock = await client.getMailboxLock(t.mailbox);
  try {
    const mb = client.mailbox;
    if (!mb || mb.uidValidity.toString() !== t.uidValidity) throw new UidValidityChangedError(t.mailbox);
    return await fn();
  } finally {
    lock.release();
  }
}

const FLAG_COLUMN: Record<string, string> = {
  '\\Seen': 'seen',
  '\\Flagged': 'flagged',
  '\\Answered': 'answered',
  '\\Draft': 'draft',
  '\\Deleted': 'deleted',
};

/** Mirror a flag change into the index immediately so every tab sees it without waiting for a resync. */
function applyFlagsLocally(db: DB, userKey: string, t: Target, add: string[], remove: string[]) {
  const sel = db.prepare('SELECT flags FROM messages WHERE user_key = ? AND mailbox = ? AND uid = ?');
  db.transaction(() => {
    for (const uid of t.uids) {
      const row = sel.get(userKey, t.mailbox, uid) as { flags: string } | undefined;
      if (!row) continue;
      const set = new Set<string>(JSON.parse(row.flags));
      add.forEach((f) => set.add(f));
      remove.forEach((f) => set.delete(f));
      const cols: Record<string, number> = {};
      for (const [flag, col] of Object.entries(FLAG_COLUMN)) cols[col] = set.has(flag) ? 1 : 0;
      db.prepare(
        `UPDATE messages SET flags = ?, seen = ?, flagged = ?, answered = ?, draft = ?, deleted = ? WHERE user_key = ? AND mailbox = ? AND uid = ?`,
      ).run(JSON.stringify([...set]), cols.seen, cols.flagged, cols.answered, cols.draft, cols.deleted, userKey, t.mailbox, uid);
    }
  })();
  refreshCounts(db, userKey, t.mailbox);
}

const SAFE_FLAG = /^(\\(Seen|Flagged|Answered|Draft|Deleted)|\$?[A-Za-z0-9_.-]{1,64})$/;

export async function setFlags(acc: Account, db: DB, t: Target, add: string[], remove: string[]) {
  for (const f of [...add, ...remove]) if (!SAFE_FLAG.test(f)) throw Object.assign(new Error(`Invalid flag ${f}`), { statusCode: 400 });
  if (add.includes('\\Deleted') || remove.includes('\\Deleted')) {
    // \Deleted only via the guarded delete paths; a stray flag lets any other client destroy mail.
    const role = (db.prepare('SELECT special_use FROM mailboxes WHERE user_key = ? AND path = ?').get(acc.userKey, t.mailbox) as { special_use: string | null } | undefined)?.special_use;
    if (!['\\Trash', '\\Junk', '\\Drafts'].includes(role ?? '')) throw Object.assign(new Error('The deleted flag can only be changed in Trash, Spam or Drafts'), { statusCode: 400 });
  }
  if (!t.uids.length) return;
  await acc.run(
    (client) =>
      withMailbox(client, t, async () => {
        const range = uidSet(t.uids);
        if (add.length) await client.messageFlagsAdd(range, add, { uid: true });
        if (remove.length) await client.messageFlagsRemove(range, remove, { uid: true });
      }),
    8,
  );
  applyFlagsLocally(db, acc.userKey, t, add, remove);
  acc.emit('event', { type: 'mailbox', path: t.mailbox, updated: t.uids.length, added: 0, removed: 0, pending: 0 });
}

export interface MoveResult {
  destination: string;
  uidValidity?: string;
  uidMap: Record<number, number>;
}

/**
 * Move messages. Uses MOVE when available. Without MOVE, falls back to COPY + \Deleted and only
 * expunges with UID EXPUNGE (UIDPLUS); without UIDPLUS it never expunges, so other clients'
 * \Deleted messages are never destroyed.
 */
export async function moveMessages(acc: Account, db: DB, t: Target, destination: string): Promise<MoveResult> {
  if (!t.uids.length) return { destination, uidMap: {} };
  if (destination === t.mailbox) return { destination, uidMap: {} };
  const res = await acc.run(
    (client) =>
      withMailbox(client, t, async () => {
        const range = uidSet(t.uids);
        if (acc.has('MOVE') || acc.has('UIDPLUS')) {
          const r = await client.messageMove(range, destination, { uid: true });
          if (!r) throw new Error('MOVE failed');
          return r;
        }
        const r = await client.messageCopy(range, destination, { uid: true });
        if (!r) throw new Error('COPY failed');
        await client.messageFlagsAdd(range, ['\\Deleted'], { uid: true });
        return r;
      }),
    8,
  );
  const uidMap: Record<number, number> = {};
  res.uidMap?.forEach((v, k) => (uidMap[k] = v));
  // Re-key moved rows in the index so the destination folder is correct instantly.
  const destRow = db.prepare('SELECT uid_validity FROM mailboxes WHERE user_key = ? AND path = ?').get(acc.userKey, destination) as
    | { uid_validity: string | null }
    | undefined;
  const destValidity = res.uidValidity?.toString() ?? destRow?.uid_validity ?? null;
  db.transaction(() => {
    for (const uid of t.uids) {
      const newUid = uidMap[uid];
      if (newUid && destValidity) {
        db.prepare('DELETE FROM messages WHERE user_key = ? AND mailbox = ? AND uid = ?').run(acc.userKey, destination, newUid);
        db.prepare('UPDATE messages SET mailbox = ?, uid = ?, uid_validity = ? WHERE user_key = ? AND mailbox = ? AND uid = ?').run(
          destination,
          newUid,
          destValidity,
          acc.userKey,
          t.mailbox,
          uid,
        );
      } else {
        db.prepare('DELETE FROM messages WHERE user_key = ? AND mailbox = ? AND uid = ?').run(acc.userKey, t.mailbox, uid);
      }
    }
  })();
  refreshCounts(db, acc.userKey, t.mailbox);
  refreshCounts(db, acc.userKey, destination);
  acc.emit('event', { type: 'mailbox', path: t.mailbox, removed: t.uids.length, added: 0, updated: 0, pending: 0 });
  acc.emit('event', { type: 'mailbox', path: destination, added: t.uids.length, removed: 0, updated: 0, pending: 0 });
  return { destination, uidValidity: destValidity ?? undefined, uidMap };
}

/** Permanently delete (only used inside Trash/Junk, after a confirmation in the UI). */
export async function deletePermanently(acc: Account, db: DB, t: Target) {
  if (!t.uids.length) return;
  await acc.run(
    (client) =>
      withMailbox(client, t, async () => {
        const range = uidSet(t.uids);
        if (acc.has('UIDPLUS')) {
          await client.messageDelete(range, { uid: true });
        } else {
          await client.messageFlagsAdd(range, ['\\Deleted'], { uid: true });
        }
      }),
    8,
  );
  const del = db.prepare('DELETE FROM messages WHERE user_key = ? AND mailbox = ? AND uid = ?');
  db.transaction(() => t.uids.forEach((u) => del.run(acc.userKey, t.mailbox, u)))();
  refreshCounts(db, acc.userKey, t.mailbox);
  acc.emit('event', { type: 'mailbox', path: t.mailbox, removed: t.uids.length, added: 0, updated: 0, pending: 0 });
}

export async function appendMessage(acc: Account, mailbox: string, raw: Buffer, flags: string[]) {
  return acc.run((client) => client.append(mailbox, raw, flags), 6);
}

/** Delete one message by UID only when UIDPLUS allows a targeted expunge (draft replacement). */
export async function expungeUidIfSafe(acc: Account, mailbox: string, uidValidity: string, uid: number) {
  await acc.run((client) =>
    withMailbox(client, { mailbox, uidValidity, uids: [uid] }, async () => {
      if (acc.has('UIDPLUS')) await client.messageDelete(String(uid), { uid: true });
      else await client.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true });
    }),
  );
}
