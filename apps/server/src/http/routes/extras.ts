import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { getMessage } from '../../imap/message.js';
import { setFlags } from '../../imap/ops.js';
import { uidSet } from '../../imap/sync.js';
import { cleanHeaderValue, contentDisposition, sanitizeFilename } from '../../lib/mime.js';
import { loginAddress, normalizeAddress } from '../../mail/outbox.js';
import { type App, HttpError, accountFor, checkMutation, requireSession, sendError } from '../context.js';

/**
 * Roundcube-parity extras:
 *  - read receipts (RFC 8098 MDN), only ever sent when the user explicitly clicks "Send receipt"
 *  - folder export as mbox (mboxrd quoting)
 */
export function extraRoutes(f: FastifyInstance, app: App) {
  f.post('/api/mdn', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const b = z.object({ mailbox: z.string().max(1000), uidValidity: z.string().regex(/^\d+$/), uid: z.number().int().positive() }).parse(req.body);
      const acc = accountFor(app, s, req.ip);
      const msg = await getMessage(acc, app.db, b.mailbox, b.uidValidity, b.uid, app.cfg.trustedAuthservIds);
      if (!msg?.dispositionNotificationTo) throw new HttpError(400, 'This message did not ask for a read receipt');
      if (msg.flags.includes('$MDNSent')) return { ok: true, already: true };
      const to = normalizeAddress(/<([^>]+)>/.exec(msg.dispositionNotificationTo)?.[1] ?? msg.dispositionNotificationTo);
      const from = loginAddress(app.cfg, s.username);
      const domain = from.split('@')[1] ?? 'localhost';
      const boundary = `mdn-${randomUUID()}`;
      const subject = cleanHeaderValue(`Read: ${msg.subject}`).slice(0, 200);
      const human = `Your message to ${from} was displayed on ${new Date().toUTCString()}.\r\n\r\nThis is no guarantee that the message has been read or understood.\r\n`;
      const machine = [
        `Reporting-UA: ${domain}; Tidings`,
        `Final-Recipient: rfc822;${from}`,
        msg.messageId ? `Original-Message-ID: ${msg.messageId}` : '',
        'Disposition: manual-action/MDN-sent-manually; displayed',
      ]
        .filter(Boolean)
        .join('\r\n');
      const headers = [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${randomUUID()}@${domain}>`,
        ...(msg.messageId ? [`References: ${msg.messageId}`] : []),
        'MIME-Version: 1.0',
        `Content-Type: multipart/report; report-type=disposition-notification; boundary="${boundary}"`,
      ];
      const body = [
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        human,
        `--${boundary}`,
        'Content-Type: message/disposition-notification',
        '',
        machine,
        '',
        `--${boundary}--`,
        '',
      ];
      const raw = `${headers.join('\r\n')}\r\n\r\n${body.join('\r\n')}`;
      const ep = app.cfg.smtp;
      const t = nodemailer.createTransport({
        host: ep.host,
        port: ep.port,
        secure: ep.tls === 'tls',
        requireTLS: ep.tls === 'starttls',
        ignoreTLS: ep.tls === 'none',
        auth: { user: s.username, pass: app.sessions.password(s) },
        tls: { rejectUnauthorized: !app.cfg.tlsInsecure, servername: ep.servername ?? ep.host, ca: app.cfg.caFile ? readFileSync(app.cfg.caFile) : undefined },
        disableFileAccess: true,
        disableUrlAccess: true,
      } as Parameters<typeof nodemailer.createTransport>[0]);
      // MDNs use a null return path (RFC 8098 §2.1) so they can never bounce in a loop.
      await t.sendMail({ envelope: { from: '', to: [to] }, raw });
      t.close();
      await setFlags(acc, app.db, { mailbox: b.mailbox, uidValidity: b.uidValidity, uids: [b.uid] }, ['$MDNSent'], []);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  f.post('/api/mdn/ignore', async (req, reply) => {
    try {
      const s = requireSession(app, req);
      checkMutation(app, req, s);
      const b = z.object({ mailbox: z.string().max(1000), uidValidity: z.string().regex(/^\d+$/), uid: z.number().int().positive() }).parse(req.body);
      const acc = accountFor(app, s, req.ip);
      // $MDNSent also records "the user decided", so the question is not asked again (RFC 3503).
      await setFlags(acc, app.db, { mailbox: b.mailbox, uidValidity: b.uidValidity, uids: [b.uid] }, ['$MDNSent'], []);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Export a folder as mboxrd, streamed message by message. */
  f.get('/api/mailboxes/export', async (req, reply) => {
    let s;
    try {
      s = requireSession(app, req);
    } catch (err) {
      return sendError(reply, err);
    }
    const { path } = z.object({ path: z.string().min(1).max(1000) }).parse(req.query);
    const row = app.db.prepare('SELECT name FROM mailboxes WHERE user_key = ? AND path = ?').get(s.userKey, path) as { name: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'Folder not found' });
    const acc = accountFor(app, s, req.ip);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'application/mbox',
      'Content-Disposition': contentDisposition('attachment', `${sanitizeFilename(row.name, 'folder')}.mbox`),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    try {
      await acc.run(async (client) => {
        const lock = await client.getMailboxLock(path, { readOnly: true });
        try {
          const uids = ((await client.search({ all: true }, { uid: true })) || []) as number[];
          for (let i = 0; i < uids.length; i += 200) {
            for await (const m of client.fetch(uidSet(uids.slice(i, i + 200)), { uid: true, source: true, internalDate: true, envelope: true }, { uid: true })) {
              if (!m.source) continue;
              const from = m.envelope?.from?.[0]?.address?.replace(/\s/g, '') || 'MAILER-DAEMON';
              const date = new Date(m.internalDate ?? Date.now()).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1 $3 $2 $5 $4');
              const body = m.source.toString('latin1').replace(/\r\n/g, '\n').replace(/^(>*From )/gm, '>$1');
              res.write(Buffer.from(`From ${from} ${date}\n${body}${body.endsWith('\n') ? '' : '\n'}\n`, 'latin1'));
            }
          }
        } finally {
          lock.release();
        }
      }, 2);
    } catch {
      /* the client sees a truncated download; nothing else we can do mid-stream */
    }
    res.end();
  });
}
