import type { FastifyInstance } from 'fastify';
import type { Account, ServerEvent } from '../../imap/account.js';
import { type App, accountFor, requireSession, sendError } from '../context.js';
import { syncMailbox } from '../../imap/sync.js';

/**
 * Server-Sent Events: one stream per browser (the client elects a leader tab), fan-out per user.
 * A heartbeat every 20s re-validates the session and keeps proxies from timing the stream out.
 */
export function eventRoutes(f: FastifyInstance, app: App) {
  const perSession = new Map<string, number>();
  const open = new Set<import('node:http').ServerResponse>();
  // On shutdown, end every stream so browsers reconnect promptly to the next process.
  f.addHook('preClose', async () => {
    for (const r of open) r.end();
    open.clear();
  });

  f.get('/api/events', async (req, reply) => {
    let acc: Account;
    let session;
    try {
      session = requireSession(app, req, false);
      if (req.headers.origin && req.headers.origin !== app.cfg.publicUrl.origin) return reply.code(403).send();
      if ((perSession.get(session.sid) ?? 0) >= 4) return reply.code(429).send({ error: 'Too many open streams' });
      acc = accountFor(app, session, req.ip);
    } catch (err) {
      return sendError(reply, err);
    }
    const sid = session.sid;
    perSession.set(sid, (perSession.get(sid) ?? 0) + 1);

    reply.hijack();
    const res = reply.raw;
    open.add(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    let n = Number(req.headers['last-event-id'] ?? 0) || 0;
    const send = (ev: ServerEvent) => {
      n++;
      res.write(`id: ${n}\ndata: ${JSON.stringify(ev)}\n\n`);
    };
    // A reconnect may have missed events: tell the client to refetch what it shows.
    send({ type: n > 1 ? 'resync' : 'mailboxes' });
    acc.on('event', send);
    acc.addListener_();
    // Catch up on anything that arrived while this browser was disconnected.
    void syncMailbox(acc, app.db, 'INBOX', 5).catch(() => undefined);

    const beat = setInterval(() => {
      if (!app.sessions.get(session.token, false)) {
        send({ type: 'auth', reason: 'expired' });
        res.end();
        return;
      }
      // A real event (not a comment) so clients can detect a silently dead connection.
      res.write(`event: ping\ndata: ${Date.now()}\n\n`);
    }, 20_000);

    const cleanup = () => {
      open.delete(res);
      clearInterval(beat);
      acc.off('event', send);
      acc.removeListener_();
      perSession.set(sid, Math.max(0, (perSession.get(sid) ?? 1) - 1));
    };
    req.raw.on('close', cleanup);
  });
}
