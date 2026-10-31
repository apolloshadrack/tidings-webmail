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
let stopped = false;

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

function openStream() {
  source = new EventSource(`${BASE}/api/events`, { withCredentials: true });
  source.onmessage = (m) => {
    try {
      const ev = JSON.parse(m.data) as ServerEvent;
      handle(ev);
      channel?.postMessage(ev);
    } catch {
      /* ignore malformed */
    }
  };
  source.onopen = () => ui().setOnline(true);
  source.onerror = () => {
    ui().setOnline(navigator.onLine);
  };
}

export function startRealtime() {
  stopped = false;
  channel && (channel.onmessage = (m) => handle(m.data as ServerEvent));
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks) {
    void locks.request('tidings-sse-leader', () => {
      if (stopped) return Promise.resolve();
      openStream();
      // Hold the lock until this tab goes away (or we stop).
      return new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (stopped) {
            clearInterval(check);
            resolve();
          }
        }, 1000);
      });
    });
  } else {
    openStream();
  }
  const on = () => ui().setOnline(true);
  const off = () => ui().setOnline(false);
  window.addEventListener('online', on);
  window.addEventListener('offline', off);
  return () => {
    stopped = true;
    source?.close();
    source = null;
    window.removeEventListener('online', on);
    window.removeEventListener('offline', off);
  };
}
