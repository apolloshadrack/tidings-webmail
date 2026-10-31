import type { ImapFlow, MessageAddressObject } from 'imapflow';
import type { Readable } from 'node:stream';
import type { DB } from '../db/index.js';
import { type AttachmentInfo, cleanHeaderValue, listAttachments, parseMessageIds, pickBodyParts } from '../lib/mime.js';
import { type Account, UidValidityChangedError } from './account.js';

const MAX_BODY = 5 * 1024 * 1024;

export interface Address {
  name: string;
  address: string;
}

export interface FullMessage {
  mailbox: string;
  uid: number;
  uidValidity: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  from: Address[];
  sender: Address[];
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  date: number;
  flags: string[];
  html: string | null;
  text: string | null;
  truncated: boolean;
  attachments: AttachmentInfo[];
  listUnsubscribe: string | null;
  listUnsubscribeOneClick: boolean;
  listPost: string | null;
  deliveredTo: string[];
  dispositionNotificationTo: string | null;
  auth: { dkim?: string; spf?: string; dmarc?: string; trusted: boolean } | null;
  size: number;
}

const addr = (a?: MessageAddressObject[]): Address[] =>
  (a ?? []).filter((x) => x.address).map((x) => ({ name: cleanHeaderValue(x.name ?? ''), address: (x.address ?? '').toLowerCase() }));

function headerMap(buf?: Buffer): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!buf) return map;
  const text = buf.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const arr = map.get(k) ?? [];
    arr.push(line.slice(i + 1).trim());
    map.set(k, arr);
  }
  return map;
}

/** Authentication-Results only counts when added by a server the admin trusts (RFC 8601 §5). */
function parseAuthResults(values: string[] | undefined, trusted: string[]): FullMessage['auth'] {
  if (!values?.length || !trusted.length) return null;
  for (const v of values) {
    const authserv = v.split(';')[0]?.trim().split(/\s+/)[0]?.toLowerCase();
    if (!authserv || !trusted.includes(authserv)) continue;
    const get = (method: string) => new RegExp(`\\b${method}=(\\w+)`, 'i').exec(v)?.[1]?.toLowerCase();
    return { dkim: get('dkim'), spf: get('spf'), dmarc: get('dmarc'), trusted: true };
  }
  return null;
}

async function readStream(stream: Readable, max: number): Promise<{ buf: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (size > max) {
      chunks.push(b.subarray(0, b.length - (size - max)));
      stream.destroy();
      return { buf: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(b);
  }
  return { buf: Buffer.concat(chunks), truncated: false };
}

// Small global LRU for parsed bodies (keyed by user + mailbox + uidvalidity + uid).
const CACHE_LIMIT = 64 * 1024 * 1024;
const cache = new Map<string, { msg: FullMessage; size: number }>();
let cacheSize = 0;
function cacheGet(k: string) {
  const v = cache.get(k);
  if (v) {
    cache.delete(k);
    cache.set(k, v);
  }
  return v?.msg;
}
function cachePut(k: string, msg: FullMessage) {
  const size = (msg.html?.length ?? 0) + (msg.text?.length ?? 0) + 2048;
  cache.set(k, { msg, size });
  cacheSize += size;
  for (const [key, v] of cache) {
    if (cacheSize <= CACHE_LIMIT) break;
    cache.delete(key);
    cacheSize -= v.size;
  }
}
export function evictUser(userKey: string) {
  for (const [k, v] of cache) if (k.startsWith(userKey)) {
    cache.delete(k);
    cacheSize -= v.size;
  }
}

async function selectChecked(client: ImapFlow, mailbox: string, uidValidity: string) {
  const lock = await client.getMailboxLock(mailbox, { readOnly: true });
  if (!client.mailbox || client.mailbox.uidValidity.toString() !== uidValidity) {
    lock.release();
    throw new UidValidityChangedError(mailbox);
  }
  return lock;
}

export async function getMessage(
  acc: Account,
  db: DB,
  mailbox: string,
  uidValidity: string,
  uid: number,
  trustedAuthserv: string[],
  priority = 9,
): Promise<FullMessage | null> {
  const key = `${acc.userKey}\0${mailbox}\0${uidValidity}\0${uid}`;
  const cached = cacheGet(key);
  if (cached) {
    // flags may have changed since caching; take them from the index
    const row = db.prepare('SELECT flags FROM messages WHERE user_key = ? AND mailbox = ? AND uid = ?').get(acc.userKey, mailbox, uid) as
      | { flags: string }
      | undefined;
    return row ? { ...cached, flags: JSON.parse(row.flags) } : cached;
  }
  const msg = await acc.run(async (client) => {
    const lock = await selectChecked(client, mailbox, uidValidity);
    try {
      const m = await client.fetchOne(
        String(uid),
        { uid: true, flags: true, envelope: true, bodyStructure: true, headers: true, size: true, internalDate: true },
        { uid: true },
      );
      if (!m || !m.bodyStructure) return null;
      const h = headerMap(m.headers);
      const parts = pickBodyParts(m.bodyStructure);
      let truncated = false;
      const readPart = async (part?: string) => {
        if (!part) return null;
        const dl = await client.download(String(uid), part, { uid: true, maxBytes: MAX_BODY + 1 });
        if (!dl.content) return null;
        const r = await readStream(dl.content, MAX_BODY);
        truncated ||= r.truncated;
        return r.buf.toString('utf8');
      };
      const html = await readPart(parts.html?.part);
      const text = await readPart(parts.text?.part);
      const bodySet = new Set([parts.html?.part, parts.text?.part].filter(Boolean) as string[]);
      const env = m.envelope ?? {};
      const full: FullMessage = {
        mailbox,
        uid,
        uidValidity,
        messageId: parseMessageIds(env.messageId)[0] ?? null,
        inReplyTo: parseMessageIds(env.inReplyTo)[0] ?? null,
        references: parseMessageIds(h.get('references')?.join(' ')),
        subject: cleanHeaderValue(env.subject ?? ''),
        from: addr(env.from),
        sender: addr(env.sender),
        to: addr(env.to),
        cc: addr(env.cc),
        bcc: addr(env.bcc),
        replyTo: addr(env.replyTo),
        date: env.date ? new Date(env.date).getTime() : new Date(m.internalDate ?? Date.now()).getTime(),
        flags: [...(m.flags ?? [])],
        html,
        text,
        truncated,
        attachments: listAttachments(m.bodyStructure, bodySet),
        listUnsubscribe: h.get('list-unsubscribe')?.[0] ?? null,
        listUnsubscribeOneClick: /List-Unsubscribe=One-Click/i.test(h.get('list-unsubscribe-post')?.[0] ?? ''),
        listPost: h.get('list-post')?.[0] ?? null,
        deliveredTo: [...(h.get('delivered-to') ?? []), ...(h.get('x-original-to') ?? [])].map((s) => s.replace(/[<>]/g, '').trim().toLowerCase()),
        dispositionNotificationTo: h.get('disposition-notification-to')?.[0] ?? null,
        auth: parseAuthResults(h.get('authentication-results'), trustedAuthserv),
        size: m.size ?? 0,
      };
      return full;
    } finally {
      lock.release();
    }
  }, priority);
  if (msg) cachePut(key, msg);
  return msg;
}

/** Stream a single MIME part (attachment / inline image). decodeText=false keeps bytes exactly. */
export async function openPart(acc: Account, mailbox: string, uidValidity: string, uid: number, part: string) {
  if (!/^[0-9]+(\.[0-9]+)*$/.test(part)) throw new Error('bad part');
  // The worker is held until the stream has been consumed, so take it explicitly.
  return acc.run(async (client) => {
    const lock = await selectChecked(client, mailbox, uidValidity);
    try {
      const dl = await client.download(String(uid), part, { uid: true, decodeText: false });
      if (!dl.content) return null;
      const r = await readStream(dl.content, 50 * 1024 * 1024);
      return { meta: dl.meta, buf: r.buf, truncated: r.truncated };
    } finally {
      lock.release();
    }
  }, 7);
}

export async function getSource(acc: Account, mailbox: string, uidValidity: string, uid: number) {
  return acc.run(async (client) => {
    const lock = await selectChecked(client, mailbox, uidValidity);
    try {
      const dl = await client.download(String(uid), undefined, { uid: true, decodeText: false });
      if (!dl.content) return null;
      return (await readStream(dl.content, 50 * 1024 * 1024)).buf;
    } finally {
      lock.release();
    }
  }, 6);
}
