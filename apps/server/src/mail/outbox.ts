import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import type { Account } from '../imap/account.js';
import { openPart } from '../imap/message.js';
import { appendMessage, expungeUidIfSafe, setFlags } from '../imap/ops.js';
import { syncMailbox } from '../imap/sync.js';
import { open, seal } from '../lib/crypto.js';
import { cleanHeaderValue, sanitizeFilename } from '../lib/mime.js';

export const AddressSchema = z.object({
  name: z.string().max(200).default(''),
  address: z.string().max(320),
});

const RefSchema = z.object({ mailbox: z.string().max(1000), uidValidity: z.string().max(30), uid: z.number().int().positive() });

export const ComposeSchema = z.object({
  draftId: z.string().uuid(),
  from: z.string().max(320),
  to: z.array(AddressSchema).max(500).default([]),
  cc: z.array(AddressSchema).max(500).default([]),
  bcc: z.array(AddressSchema).max(500).default([]),
  subject: z.string().max(998).default(''),
  html: z.string().max(10 * 1024 * 1024).optional(),
  text: z.string().max(10 * 1024 * 1024).default(''),
  attachments: z.array(z.string().uuid()).max(100).default([]),
  kind: z.enum(['new', 'reply', 'replyAll', 'forward']).default('new'),
  inReplyTo: RefSchema.optional(),
  forwardAttachments: RefSchema.extend({ parts: z.array(z.string().regex(/^[0-9.]+$/)).max(100) }).optional(),
  requestReceipt: z.boolean().default(false),
  delaySeconds: z.number().int().min(0).max(30).default(10),
});
export type ComposeInput = z.infer<typeof ComposeSchema>;

// RFC 5321-ish address check: no groups/comments/route-addrs, sane lengths, IDN to ASCII.
const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
export function normalizeAddress(raw: string): string {
  const a = cleanHeaderValue(raw).replace(/^<|>$/g, '');
  const at = a.lastIndexOf('@');
  if (at <= 0 || at === a.length - 1) throw new Error(`"${raw}" is not a valid email address`);
  const local = a.slice(0, at);
  const domain = new URL(`http://${a.slice(at + 1)}`).hostname; // IDNA -> ASCII
  if (local.length > 64 || domain.length > 253 || !LOCAL_RE.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    throw new Error(`"${raw}" is not a valid email address`);
  }
  if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/i.test(domain)) throw new Error(`"${raw}" has an invalid domain`);
  return `${local}@${domain.toLowerCase()}`;
}

export function loginAddress(cfg: Config, username: string): string {
  if (username.includes('@')) return username.toLowerCase();
  return cfg.defaultDomain ? `${username}@${cfg.defaultDomain}`.toLowerCase() : username.toLowerCase();
}

/** Addresses this user may send as, according to the admin's identity policy. */
export function allowedFromAddresses(cfg: Config, db: DB, userKey: string, username: string): Set<string> | 'any' {
  if (cfg.identityPolicy === 'free') return 'any';
  const login = loginAddress(cfg, username);
  const set = new Set([login]);
  if (cfg.identityPolicy === 'aliases') for (const a of cfg.aliases[login] ?? []) set.add(a);
  return set;
}

interface OutboxRow {
  id: string;
  user_key: string;
  session_sid: string | null;
  message_id: string;
  state: string;
  send_at: number;
  created_at: number;
  nonce: Buffer;
  ct: Buffer;
  tag: Buffer;
  meta: string;
  error: string | null;
}

interface Meta {
  subject: string;
  to: string[];
  envelopeFrom: string;
  recipients: string[];
  draftId: string;
  compose: ComposeInput;
  inReplyTo?: ComposeInput['inReplyTo'];
  kind: ComposeInput['kind'];
  uploads: string[];
}

export class Outbox {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private db: DB,
    private cfg: Config,
    private log: { warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void },
  ) {
    // Anything that was mid-flight when the process died is unknown; never auto-send it late.
    db.prepare(`UPDATE outbox SET state = 'unknown' WHERE state = 'sending'`).run();
    db.prepare(`UPDATE outbox SET state = 'stalled' WHERE state = 'queued'`).run();
  }

  private smtpTransport(username: string, password: string) {
    const ep = this.cfg.smtp;
    return nodemailer.createTransport({
      host: ep.host,
      port: ep.port,
      secure: ep.tls === 'tls',
      requireTLS: ep.tls === 'starttls',
      ignoreTLS: ep.tls === 'none',
      auth: { user: username, pass: password },
      tls: {
        rejectUnauthorized: !this.cfg.tlsInsecure,
        minVersion: 'TLSv1.2',
        servername: ep.servername ?? ep.host,
        ca: this.cfg.caFile ? readFileSync(this.cfg.caFile) : undefined,
      },
      disableFileAccess: true,
      disableUrlAccess: true,
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    } as Parameters<typeof nodemailer.createTransport>[0]);
  }

  /** Build the MIME message from an allow-list of fields. Returns the SMTP copy and the Sent copy. */
  async build(acc: Account, input: ComposeInput, username: string) {
    const allowed = allowedFromAddresses(this.cfg, this.db, acc.userKey, username);
    const from = normalizeAddress(input.from);
    if (allowed !== 'any' && !allowed.has(from)) throw new Error(`You are not allowed to send as ${from}`);
    const identity = this.db.prepare('SELECT name, reply_to FROM identities WHERE user_key = ? AND email = ?').get(acc.userKey, from) as
      | { name: string; reply_to: string | null }
      | undefined;

    const clean = (list: { name: string; address: string }[]) =>
      list.map((a) => ({ name: cleanHeaderValue(a.name).slice(0, 200), address: normalizeAddress(a.address) }));
    const to = clean(input.to);
    const cc = clean(input.cc);
    const bcc = clean(input.bcc);
    const recipients = [...new Set([...to, ...cc, ...bcc].map((a) => a.address))];
    if (!recipients.length) throw new Error('Add at least one recipient');
    if (recipients.length > this.cfg.maxRecipientsPerMessage) {
      throw new Error(`Too many recipients (max ${this.cfg.maxRecipientsPerMessage} per message)`);
    }

    // Threading headers are derived server-side from the original, never taken from the client.
    let inReplyTo: string | undefined;
    let references: string[] | undefined;
    if (input.inReplyTo) {
      const orig = this.db
        .prepare('SELECT message_id, refs FROM messages WHERE user_key = ? AND mailbox = ? AND uid = ? AND uid_validity = ?')
        .get(acc.userKey, input.inReplyTo.mailbox, input.inReplyTo.uid, input.inReplyTo.uidValidity) as
        | { message_id: string | null; refs: string }
        | undefined;
      if (orig?.message_id) {
        inReplyTo = orig.message_id;
        const refs: string[] = [...JSON.parse(orig.refs), orig.message_id];
        references = refs.length > 11 ? [refs[0], ...refs.slice(-10)] : refs;
      }
    }

    const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
    let total = 0;
    const uploads = input.attachments.length
      ? (this.db
          .prepare(`SELECT * FROM uploads WHERE user_key = ? AND id IN (${input.attachments.map(() => '?').join(',')})`)
          .all(acc.userKey, ...input.attachments) as { id: string; filename: string; content_type: string; path: string; size: number }[])
      : [];
    for (const u of uploads) {
      const content = readFileSync(u.path);
      total += content.length;
      attachments.push({ filename: u.filename, content, contentType: u.content_type });
    }
    if (input.forwardAttachments) {
      const f = input.forwardAttachments;
      for (const part of f.parts) {
        const p = await openPart(acc, f.mailbox, f.uidValidity, f.uid, part);
        if (!p) continue;
        total += p.buf.length;
        const ct = (p.meta?.contentType ?? '').toLowerCase();
        attachments.push({
          filename: sanitizeFilename(p.meta?.filename, `attachment-${part}`),
          content: p.buf, // download() already removed the transfer encoding
          contentType: /^[\w.+-]+\/[\w.+-]+$/.test(ct) ? ct : 'application/octet-stream',
        });
      }
    }
    const sizeLimit = this.cfg.maxUploadMb * 1024 * 1024;
    if (total > sizeLimit) throw new Error(`Attachments exceed ${this.cfg.maxUploadMb} MB`);

    const domain = from.split('@')[1] ?? 'localhost';
    const messageId = `<${randomUUID()}@${domain}>`;
    const date = new Date();
    const mail = {
      from: { name: cleanHeaderValue(identity?.name ?? ''), address: from },
      sender: from !== loginAddress(this.cfg, username) && loginAddress(this.cfg, username).includes('@') ? loginAddress(this.cfg, username) : undefined,
      replyTo: identity?.reply_to ? normalizeAddress(identity.reply_to) : undefined,
      to,
      cc,
      bcc,
      subject: cleanHeaderValue(input.subject),
      text: input.text,
      html: input.html,
      attachments,
      attachDataUrls: true,
      messageId,
      date,
      inReplyTo,
      references,
      headers: input.requestReceipt ? { 'Disposition-Notification-To': from } : undefined,
      disableFileAccess: true,
      disableUrlAccess: true,
    };
    const smtpRaw = await new MailComposer(mail as never).compile().build();
    const node = new MailComposer(mail as never).compile();
    (node as unknown as { keepBcc: boolean }).keepBcc = true;
    const sentRaw = await node.build();
    return { smtpRaw, sentRaw, messageId, envelopeFrom: loginAddress(this.cfg, username), recipients, to, subject: mail.subject, uploads: uploads.map((u) => u.id) };
  }

  private dailyCount(userKey: string): number {
    const day = new Date().toISOString().slice(0, 10);
    return (this.db.prepare('SELECT count FROM send_counter WHERE user_key = ? AND day = ?').get(userKey, day) as { count: number } | undefined)?.count ?? 0;
  }

  async queue(acc: Account, sessionSid: string, dataKey: Buffer, username: string, password: () => string, input: ComposeInput) {
    if (this.dailyCount(acc.userKey) >= this.cfg.maxMessagesPerDay) {
      throw new Error(`Daily sending limit reached (${this.cfg.maxMessagesPerDay} messages)`);
    }
    // Idempotency: a retried request for the same draft returns the existing queue entry.
    const existing = this.db
      .prepare(`SELECT id, send_at, state FROM outbox WHERE user_key = ? AND json_extract(meta, '$.draftId') = ? AND state IN ('queued','sending','sent')`)
      .get(acc.userKey, input.draftId) as { id: string; send_at: number; state: string } | undefined;
    if (existing) return { id: existing.id, sendAt: existing.send_at, state: existing.state };

    const built = await this.build(acc, input, username);
    const id = randomUUID();
    const payload = Buffer.from(JSON.stringify({ smtp: built.smtpRaw.toString('base64'), sent: built.sentRaw.toString('base64') }));
    const sealed = seal(dataKey, payload, `outbox|${id}|${acc.userKey}`);
    const sendAt = Date.now() + input.delaySeconds * 1000;
    const meta: Meta = {
      subject: built.subject,
      to: built.to.map((a) => a.address),
      envelopeFrom: built.envelopeFrom,
      recipients: built.recipients,
      draftId: input.draftId,
      compose: input,
      inReplyTo: input.inReplyTo,
      kind: input.kind,
      uploads: built.uploads,
    };
    this.db
      .prepare(
        `INSERT INTO outbox (id, user_key, session_sid, message_id, state, send_at, created_at, nonce, ct, tag, meta) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, acc.userKey, sessionSid, built.messageId, sendAt, Date.now(), sealed.nonce, sealed.ct, sealed.tag, JSON.stringify(meta));
    this.schedule(acc, id, dataKey, username, password, input.delaySeconds * 1000);
    acc.emit('event', { type: 'outbox' });
    return { id, sendAt, state: 'queued' };
  }

  private schedule(acc: Account, id: string, dataKey: Buffer, username: string, password: () => string, delay: number) {
    const t = setTimeout(() => {
      this.timers.delete(id);
      void this.deliver(acc, id, dataKey, username, password);
    }, delay);
    this.timers.set(id, t);
  }

  cancel(userKey: string, id: string): ComposeInput | null {
    const row = this.db.prepare(`SELECT * FROM outbox WHERE id = ? AND user_key = ?`).get(id, userKey) as OutboxRow | undefined;
    if (!row || !['queued', 'stalled', 'failed', 'unknown'].includes(row.state)) return null;
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.db.prepare(`DELETE FROM outbox WHERE id = ?`).run(id);
    return (JSON.parse(row.meta) as Meta).compose;
  }

  async sendNow(acc: Account, userKey: string, id: string, sessionSid: string, dataKey: Buffer, username: string, password: () => string) {
    const row = this.db.prepare(`SELECT * FROM outbox WHERE id = ? AND user_key = ?`).get(id, userKey) as OutboxRow | undefined;
    if (!row || !['queued', 'stalled', 'failed'].includes(row.state)) throw new Error('Nothing to send');
    if (row.session_sid !== sessionSid) throw new Error('This message was queued from another session. Open it from Drafts to send it again.');
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    await this.deliver(acc, id, dataKey, username, password);
  }

  private async deliver(acc: Account, id: string, dataKey: Buffer, username: string, password: () => string) {
    const claim = this.db.prepare(`UPDATE outbox SET state = 'sending' WHERE id = ? AND state IN ('queued','stalled','failed')`).run(id);
    if (!claim.changes) return;
    const row = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as OutboxRow;
    const meta = JSON.parse(row.meta) as Meta;
    let raws: { smtp: Buffer; sent: Buffer };
    try {
      const plain = open(dataKey, { nonce: row.nonce, ct: row.ct, tag: row.tag }, `outbox|${id}|${row.user_key}`);
      const j = JSON.parse(plain.toString('utf8')) as { smtp: string; sent: string };
      raws = { smtp: Buffer.from(j.smtp, 'base64'), sent: Buffer.from(j.sent, 'base64') };
    } catch {
      this.fail(acc, id, 'Could not decrypt the queued message (session changed).');
      return;
    }
    try {
      const transport = this.smtpTransport(username, password());
      await transport.sendMail({ envelope: { from: meta.envelopeFrom, to: meta.recipients }, raw: raws.smtp });
      transport.close();
    } catch (err) {
      this.fail(acc, id, smtpErrorText(err));
      return;
    }
    // SMTP accepted it: from here on, failures are "sent, but ..." — never "not sent".
    this.db.prepare(`UPDATE outbox SET state = 'sent', error = NULL, ct = X'', nonce = X'', tag = X'' WHERE id = ?`).run(id);
    const day = new Date().toISOString().slice(0, 10);
    this.db
      .prepare(`INSERT INTO send_counter (user_key, day, count) VALUES (?, ?, 1) ON CONFLICT(user_key, day) DO UPDATE SET count = count + 1`)
      .run(row.user_key, day);
    const warnings: string[] = [];
    try {
      await this.saveSentCopy(acc, raws.sent);
    } catch (err) {
      warnings.push(`Sent, but saving a copy to Sent failed: ${(err as Error).message}`);
    }
    try {
      if (meta.inReplyTo) {
        const flag = meta.kind === 'forward' ? '$Forwarded' : '\\Answered';
        await setFlags(acc, this.db, { mailbox: meta.inReplyTo.mailbox, uidValidity: meta.inReplyTo.uidValidity, uids: [meta.inReplyTo.uid] }, [flag], []);
      }
    } catch {
      /* the original may have been moved; harmless */
    }
    await this.cleanupDraft(acc, meta.draftId).catch(() => undefined);
    this.rememberRecipients(row.user_key, meta.compose);
    for (const up of meta.uploads) this.removeUpload(row.user_key, up);
    if (warnings.length) this.db.prepare('UPDATE outbox SET error = ? WHERE id = ?').run(warnings.join(' '), id);
    acc.emit('event', { type: 'outbox', sent: id, warnings });
  }

  private fail(acc: Account, id: string, message: string) {
    this.db.prepare(`UPDATE outbox SET state = 'failed', error = ? WHERE id = ?`).run(message, id);
    acc.emit('event', { type: 'outbox', failed: id, error: message });
  }

  private async saveSentCopy(acc: Account, raw: Buffer) {
    if (this.cfg.saveSent === 'never') return;
    if (this.cfg.saveSent === 'auto' && acc.has('X-GM-EXT-1')) return; // Gmail stores Sent itself
    const sent = this.db.prepare(`SELECT path FROM mailboxes WHERE user_key = ? AND special_use = '\\Sent'`).get(acc.userKey) as
      | { path: string }
      | undefined;
    if (!sent) throw new Error('no Sent folder found');
    await appendMessage(acc, sent.path, raw, ['\\Seen']);
    void syncMailbox(acc, this.db, sent.path, 2).catch(() => undefined);
  }

  async cleanupDraft(acc: Account, draftId: string) {
    const d = this.db.prepare('SELECT * FROM drafts WHERE id = ? AND user_key = ?').get(draftId, acc.userKey) as
      | { imap_uid: number | null; imap_uid_validity: string | null }
      | undefined;
    this.db.prepare('DELETE FROM drafts WHERE id = ? AND user_key = ?').run(draftId, acc.userKey);
    if (d?.imap_uid && d.imap_uid_validity) {
      const drafts = this.db.prepare(`SELECT path FROM mailboxes WHERE user_key = ? AND special_use = '\\Drafts'`).get(acc.userKey) as
        | { path: string }
        | undefined;
      if (drafts) {
        await expungeUidIfSafe(acc, drafts.path, d.imap_uid_validity, d.imap_uid);
        void syncMailbox(acc, this.db, drafts.path, 2).catch(() => undefined);
      }
    }
  }

  private rememberRecipients(userKey: string, c: ComposeInput) {
    const up = this.db.prepare(`
      INSERT INTO contacts (user_key, name, email, source, use_count, last_used, created_at) VALUES (?, ?, ?, 'sent', 1, ?, ?)
      ON CONFLICT(user_key, email) DO UPDATE SET use_count = use_count + 1, last_used = excluded.last_used,
        name = CASE WHEN contacts.name = '' THEN excluded.name ELSE contacts.name END`);
    const now = Date.now();
    this.db.transaction(() => {
      for (const a of [...c.to, ...c.cc, ...c.bcc]) {
        try {
          up.run(userKey, cleanHeaderValue(a.name), normalizeAddress(a.address), now, now);
        } catch {
          /* skip invalid */
        }
      }
    })();
  }

  removeUpload(userKey: string, id: string) {
    const u = this.db.prepare('SELECT path FROM uploads WHERE id = ? AND user_key = ?').get(id, userKey) as { path: string } | undefined;
    if (u) rmSync(u.path, { force: true });
    this.db.prepare('DELETE FROM uploads WHERE id = ? AND user_key = ?').run(id, userKey);
  }

  list(userKey: string) {
    return (
      this.db
        .prepare(`SELECT id, message_id, state, send_at, created_at, meta, error FROM outbox WHERE user_key = ? AND (state != 'sent' OR created_at > ?) ORDER BY created_at DESC`)
        .all(userKey, Date.now() - 86_400_000) as OutboxRow[]
    ).map((r) => {
      const meta = JSON.parse(r.meta) as Meta;
      return { id: r.id, state: r.state, sendAt: r.send_at, createdAt: r.created_at, subject: meta.subject, to: meta.to, error: r.error, draftId: meta.draftId };
    });
  }

  discard(userKey: string, id: string) {
    this.db.prepare(`DELETE FROM outbox WHERE id = ? AND user_key = ? AND state != 'sending'`).run(id, userKey);
  }

  /** Flush (send immediately) everything this session queued; used on logout so nothing is silently dropped. */
  async flushSession(acc: Account, sid: string, dataKey: Buffer, username: string, password: () => string) {
    const rows = this.db.prepare(`SELECT id FROM outbox WHERE session_sid = ? AND state = 'queued'`).all(sid) as { id: string }[];
    for (const r of rows) {
      const t = this.timers.get(r.id);
      if (t) clearTimeout(t);
      this.timers.delete(r.id);
      await this.deliver(acc, r.id, dataKey, username, password);
    }
  }
}

function smtpErrorText(err: unknown): string {
  const e = err as { responseCode?: number; response?: string; code?: string; message?: string };
  if (e.responseCode === 552 || /size/i.test(e.response ?? '')) return 'The mail server rejected the message because it is too large.';
  if (e.code === 'EAUTH') return 'The mail server rejected your credentials when sending.';
  if (e.responseCode && e.response) return `The mail server refused the message: ${e.response}`;
  return `Sending failed: ${e.message ?? 'unknown error'}`;
}
