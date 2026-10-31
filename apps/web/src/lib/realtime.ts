import { BASE, api, qs } from '../api/client';
import type { ListPage, ServerEvent } from '../api/types';
import { queryClient } from '../state/queries';
import { settings } from '../state/settings';
import { ui } from '../state/ui';
import { displayName } from './format';

/**
 * One EventSource per browser: tabs elect a leader with the Web Locks API; the leader holds the
 * stream and rebroadcasts events to the other tabs over a BroadcastChannel. This keeps us far
 * below the HTTP/1.1 six-connections-per-host limit and the IMAP connection budget.
 */
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('tidings-events') : null;
let source: EventSource | null = null;

function handle(ev: ServerEvent) {
  switch (ev.type) {
    case 'mailbox': {
      void queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
      void queryClient.invalidateQueries({ queryKey: ['list'], predicate: (q) => q.queryKey[1] === ev.path || q.queryKey[1] === '*' });
      if (ev.path) void queryClient.invalidateQueries({ queryKey: ['thread'] });
      if (ev.path === 'INBOX' && ev.added && ev.added > 0 && ev.added < 50) void notifyNew(ev.added);
      break;
    }
    case 'mailboxes':
      void queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
      break;
    case 'outbox':
      void queryClient.invalidateQueries({ queryKey: ['outbox'] });
      if (ev.failed) {
        ui().pushToast({ message: ev.error ?? 'A message could not be sent', tone: 'error', sticky: true, action: { label: 'Open outbox', run: () => ui().setView({ kind: 'outbox' }) } });
      } else if (ev.sent && ev.warnings?.length) {
        ui().pushToast({ message: ev.warnings.join(' '), tone: 'info', ttl: 8000 });
      } else if (ev.sent) {
        ui().pushToast({ message: 'Message sent', tone: 'success' });
      }
      break;
    case 'snooze':
      void queryClient.invalidateQueries({ queryKey: ['list'] });
      void queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
      ui().pushToast({ message: 'Snoozed mail is back in your inbox' });
      break;
    case 'resync':
      void queryClient.invalidateQueries();
      break;
    case 'auth':
      void queryClient.invalidateQueries({ queryKey: ['session'] });
      break;
  }
}

async function notifyNew(added: number) {
  const st = ui();
  if (st.view.kind === 'mailbox' && st.view.path === 'INBOX') st.newCount = 0;
  const s = settings();
  if (!s.desktopNotifications || typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
  try {
    const page = await api<ListPage>(`/api/list?${qs({ mailbox: 'INBOX', threads: 0, limit: Math.min(added, 3) })}`);
    for (const it of page.items.filter((i) => i.unread)) {
      const n = new Notification(s.notificationPreview ? displayName(it.from) : 'New mail', {
        body: s.notificationPreview ? it.subject : `${added} new message${added === 1 ? '' : 's'}`,
        tag: it.key,
        silent: false,
      });
      n.onclick = () => {
        window.focus();
        ui().setView({ kind: 'mailbox', path: 'INBOX' });
        ui().setOpen(it.key);
      };
    }
  } catch {
    /* ignore */
  }
}

let instance = 0;

function openStream(myInstance: number, onDead: () => void) {
  let backoff = 1000;
  let failures = 0;
  let lastSeen = Date.now();
  // Proxies can keep a dead stream "open"; the server pings every 20s, so silence means reconnect.
  const watchdog = setInterval(() => {
    if (myInstance !== instance) {
      clearInterval(watchdog);
      return;
    }
    if (Date.now() - lastSeen > 50_000) {
      lastSeen = Date.now();
      source?.close();
      source = null;
      void queryClient.invalidateQueries();
      connect();
    }
  }, 10_000);
  const connect = () => {
    if (myInstance !== instance) return;
    lastSeen = Date.now();
    source = new EventSource(`${BASE}/api/events`, { withCredentials: true });
    source.addEventListener('ping', () => {
      lastSeen = Date.now();
    });
    source.onmessage = (m) => {
      lastSeen = Date.now();
      try {
        const ev = JSON.parse(m.data) as ServerEvent;
        handle(ev);
        channel?.postMessage(ev);
      } catch {
        /* ignore malformed */
      }
    };
    source.onopen = () => {
      backoff = 1000;
      failures = 0;
      ui().setOnline(true);
    };
    source.onerror = () => {
      ui().setOnline(navigator.onLine);
      // A non-200 response (e.g. a server restart) closes an EventSource for good: reconnect ourselves.
      if (source?.readyState === EventSource.CLOSED) {
        source = null;
        if (myInstance !== instance) return;
        setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: ['session'] });
          connect();
        }, backoff);
        backoff = Math.min(Math.round(backoff * 1.6), 10_000);
        if (++failures >= 12) onDead(); // ~2 minutes of failures: let another tab try
      }
    };
  };
  connect();
}

export function startRealtime() {
  const me = ++instance; // a second start (StrictMode, hot reload) supersedes the first
  if (channel) channel.onmessage = (m) => handle(m.data as ServerEvent);
  let release: (() => void) | null = null;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks) {
    void locks.request('tidings-sse-leader', () => {
      if (me !== instance) return Promise.resolve();
      return new Promise<void>((resolve) => {
        release = resolve;
        openStream(me, () => {
          // Give leadership to another tab if we keep failing.
          source?.close();
          source = null;
          resolve();
        });
      });
    });
  } else {
    openStream(me, () => undefined);
  }
  // Fallback: refresh the outbox when queued sends should have gone out, even if an event was missed.
  const outboxPoll = setInterval(() => {
    const items = queryClient.getQueryData<{ state: string; sendAt: number }[]>(['outbox']) ?? [];
    if (items.some((o) => (o.state === 'queued' || o.state === 'sending') && o.sendAt < Date.now() - 2000)) {
      void queryClient.invalidateQueries({ queryKey: ['outbox'] });
    }
  }, 4000);
  const on = () => ui().setOnline(true);
  const off = () => ui().setOnline(false);
  window.addEventListener('online', on);
  window.addEventListener('offline', off);
  return () => {
    if (me === instance) instance++;
    source?.close();
    source = null;
    (release as (() => void) | null)?.();
    clearInterval(outboxPoll);
    window.removeEventListener('online', on);
    window.removeEventListener('offline', off);
  };
}
