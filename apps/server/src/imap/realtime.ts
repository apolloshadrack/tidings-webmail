import type { StatusObject } from 'imapflow';
import type { DB } from '../db/index.js';
import type { Account } from './account.js';
import { moveMessages, setFlags } from './ops.js';
import { syncMailbox, syncMailboxList } from './sync.js';

const POLL_MS = 60_000;

/**
 * Wire an account for live updates:
 *  - IDLE on INBOX (via Account) -> resync INBOX
 *  - while a browser is listening: LIST-STATUS every 60s, resync folders whose counters changed
 *  - snoozed messages whose time has come are moved back and marked unread
 */
export function wireRealtime(acc: Account, db: DB, onAuthFailed: () => void) {
  let last = new Map<string, string>();
  const fingerprint = (s?: StatusObject) => (s ? `${s.messages}|${s.uidNext}|${s.unseen}|${s.highestModseq ?? ''}|${s.uidValidity ?? ''}` : '');

  acc.on('status', (map: Map<string, StatusObject | undefined>) => {
    const changed: string[] = [];
    const next = new Map<string, string>();
    for (const [path, st] of map) {
      const fp = fingerprint(st);
      next.set(path, fp);
      if (last.size && last.get(path) !== fp) changed.push(path);
    }
    last = next;
    for (const path of changed) void syncMailbox(acc, db, path, 4).catch(() => undefined);
    if (changed.length) acc.emit('event', { type: 'mailboxes' });
  });

  acc.on('inbox-changed', () => {
    void syncMailbox(acc, db, 'INBOX', 9).catch(() => undefined);
  });

  acc.on('auth-failed', onAuthFailed);

  const timer = setInterval(() => {
    if (acc.isDead) {
      clearInterval(timer);
      return;
    }
    void wakeSnoozed(acc, db).catch(() => undefined);
    if (acc.listeners_ > 0) {
      void acc.run((c) => syncMailboxList(acc, db, c), 3).catch(() => undefined);
    }
  }, POLL_MS);
  timer.unref();
  void wakeSnoozed(acc, db).catch(() => undefined);
}

export async function wakeSnoozed(acc: Account, db: DB) {
  const due = db.prepare('SELECT message_id, from_mailbox FROM snoozes WHERE user_key = ? AND wake_at <= ?').all(acc.userKey, Date.now()) as {
    message_id: string;
    from_mailbox: string;
  }[];
  if (!due.length) return;
  for (const d of due) {
    const row = db.prepare(`SELECT mailbox, uid, uid_validity FROM messages WHERE user_key = ? AND message_id = ? AND mailbox = 'Snoozed'`).get(acc.userKey, d.message_id) as
      | { mailbox: string; uid: number; uid_validity: string }
      | undefined;
    if (row) {
      const res = await moveMessages(acc, db, { mailbox: row.mailbox, uidValidity: row.uid_validity, uids: [row.uid] }, d.from_mailbox);
      const newUid = res.uidMap[row.uid];
      if (newUid && res.uidValidity) {
        await setFlags(acc, db, { mailbox: d.from_mailbox, uidValidity: res.uidValidity, uids: [newUid] }, [], ['\\Seen']).catch(() => undefined);
      }
    }
    db.prepare('DELETE FROM snoozes WHERE user_key = ? AND message_id = ?').run(acc.userKey, d.message_id);
  }
  acc.emit('event', { type: 'snooze', woke: due.length });
}
