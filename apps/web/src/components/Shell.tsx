import { Suspense, lazy, useEffect, useRef } from 'react';
import { PenLine } from 'lucide-react';
import type { ComposeState, ServerConfig, SessionInfo } from '../api/types';
import { installCommands } from '../lib/commands';
import { composeFromMailto, composeNew, openComposeState } from '../lib/composeActions';
import { handleKeydown, setShortcutsEnabled } from '../lib/keys';
import { startRealtime } from '../lib/realtime';
import { startRouter } from '../lib/router';
import { useMailboxes } from '../state/queries';
import { useSettings } from '../state/settings';
import { useUi } from '../state/ui';
import { DialogHost } from './Dialogs';
import { MessageList } from './MessageList';
import { Reader } from './Reader';
import { Sidebar } from './Sidebar';
import { Toasts } from './Toasts';
import { Topbar } from './Topbar';
import { ContactsView } from './views/ContactsView';
import { OutboxView } from './views/OutboxView';
import { SubscriptionsView } from './views/SubscriptionsView';

const ComposerDock = lazy(() => import('./Composer').then((m) => ({ default: m.ComposerDock })));

export function Shell({ session, config }: { session: SessionInfo; config?: ServerConfig }) {
  const view = useUi((s) => s.view);
  const open = useUi((s) => s.open);
  const hasComposers = useUi((s) => s.composers.length > 0);
  const collapsed = useSettings((s) => s.s.sidebarCollapsed);
  const shortcuts = useSettings((s) => s.s.shortcuts);
  const listWidth = useSettings((s) => s.s.listWidth);
  const mailboxes = useMailboxes();
  const mobileNav = useRef<HTMLDivElement>(null);

  useEffect(() => {
    installCommands();
    const stopRouter = startRouter();
    const stopRealtime = startRealtime();
    const onKey = (e: KeyboardEvent) => handleKeydown(e);
    window.addEventListener('keydown', onKey);
    const onCompose = (e: Event) => {
      const d = (e as CustomEvent).detail as { mailto?: string; to?: { name: string; address: string }[]; state?: ComposeState };
      if (d.mailto) void composeFromMailto(d.mailto);
      else if (d.state) openComposeState(d.state);
      else void composeNew(d.to ?? []);
    };
    window.addEventListener('tidings:compose', onCompose);
    return () => {
      stopRouter();
      stopRealtime();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('tidings:compose', onCompose);
    };
  }, []);

  useEffect(() => setShortcutsEnabled(shortcuts), [shortcuts]);
  useEffect(() => installCommands(), [mailboxes.data]);

  useEffect(() => {
    document.documentElement.style.setProperty('--list-w', `${listWidth}px`);
  }, [listWidth]);

  useEffect(() => {
    const unread = mailboxes.data?.find((m) => m.path === 'INBOX')?.unread ?? 0;
    const name = config?.brand.name ?? 'Tidings';
    document.title = unread ? `(${unread}) ${name}` : name;
  }, [mailboxes.data, config?.brand.name]);

  const isList = view.kind === 'mailbox' || view.kind === 'search';

  return (
    <div className={`shell${collapsed ? ' collapsed' : ''}`}>
      <Sidebar session={session} config={config} navRef={mobileNav} />
      <main className="main" aria-label="Mail">
        <Topbar session={session} />
        {isList ? (
          <div className={`panes${open ? ' reading' : ''}`}>
            <section className="list-pane" aria-label="Conversations">
              <MessageList />
              <ResizeHandle />
            </section>
            <section className="reader-pane" aria-label="Reading pane">
              <Reader session={session} />
            </section>
          </div>
        ) : view.kind === 'subscriptions' ? (
          <SubscriptionsView />
        ) : view.kind === 'contacts' ? (
          <ContactsView />
        ) : (
          <OutboxView />
        )}
      </main>
      <button className="fab" aria-label="Compose" onClick={() => void composeNew()}>
        <PenLine size={22} />
      </button>
      {hasComposers && (
        <Suspense fallback={null}>
          <ComposerDock />
        </Suspense>
      )}
      <DialogHost />
      <Toasts />
    </div>
  );
}

function ResizeHandle() {
  const set = useSettings((s) => s.set);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize message list"
      tabIndex={-1}
      onPointerDown={(e) => {
        const start = e.clientX;
        const w = useSettings.getState().s.listWidth;
        ref.current?.classList.add('dragging');
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => {
          const next = Math.max(300, Math.min(760, w + ev.clientX - start));
          document.documentElement.style.setProperty('--list-w', `${next}px`);
        };
        const up = (ev: PointerEvent) => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          ref.current?.classList.remove('dragging');
          set({ listWidth: Math.max(300, Math.min(760, w + ev.clientX - start)) });
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
      onDoubleClick={() => set({ listWidth: 420 })}
    />
  );
}
