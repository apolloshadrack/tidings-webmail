import { type RefObject, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Archive, ChevronDown, ChevronRight, Clock, FileText, Folder, FolderPlus, Inbox, LogOut, Mailbox as MailboxIcon, PanelLeftClose,
  PanelLeftOpen, Send, Settings as SettingsIcon, ShieldAlert, Star, Trash2, Users, Newspaper, PenLine,
} from 'lucide-react';
import { api } from '../api/client';
import type { Mailbox, ServerConfig, SessionInfo } from '../api/types';
import { moveTo, emptyFolder } from '../lib/actions';
import { composeNew } from '../lib/composeActions';
import { bytes } from '../lib/format';
import { describeKey } from '../lib/keys';
import { queryClient, useMailboxes } from '../state/queries';
import { useSettings } from '../state/settings';
import { useUi } from '../state/ui';
import { BrandMark } from './Brand';
import { Menu, type MenuItem } from './Menu';

const ROLE_ICON: Record<string, typeof Inbox> = {
  '\\Inbox': Inbox, '\\Drafts': FileText, '\\Sent': Send, '\\Archive': Archive, '\\Junk': ShieldAlert, '\\Trash': Trash2,
};
const ROLE_LABEL: Record<string, string> = { '\\Inbox': 'Inbox', '\\Drafts': 'Drafts', '\\Sent': 'Sent', '\\Archive': 'Archive', '\\Junk': 'Spam', '\\Trash': 'Trash' };
const FOLDER_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b'];

export function Sidebar({ session, config }: { session: SessionInfo; config?: ServerConfig; navRef: RefObject<HTMLDivElement | null> }) {
  const { data: boxes = [] } = useMailboxes();
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const mobileNav = useUi((s) => s.mobileNav);
  const setMobileNav = useUi((s) => s.setMobileNav);
  const collapsed = useSettings((s) => s.s.sidebarCollapsed);
  const setS = useSettings((s) => s.set);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const quota = useQuery({ queryKey: ['quota'], queryFn: () => api<{ quota: { used: number; limit: number } | null }>('/api/quota').then((r) => r.quota), staleTime: 600_000 });

  const system = boxes.filter((b) => b.role && ROLE_ICON[b.role]);
  const snoozed = boxes.find((b) => b.path === 'Snoozed' && !b.role);
  const custom = boxes.filter((b) => !b.role && b !== snoozed);

  // Build a tree of custom folders by delimiter.
  const tree = useMemo(() => {
    const children = new Map<string | null, Mailbox[]>();
    const paths = new Set(custom.map((b) => b.path));
    for (const b of custom) {
      const parent = b.parent && paths.has(b.parent) ? b.parent : null;
      children.set(parent, [...(children.get(parent) ?? []), b]);
    }
    return children;
  }, [custom]);

  const isActive = (path: string) => view.kind === 'mailbox' && view.path === path;

  function folderMenu(b: Mailbox, x: number, y: number) {
    const items: MenuItem[] = [
      { label: 'Open', run: () => setView({ kind: 'mailbox', path: b.path }) },
      { label: 'Search in this folder', run: () => setView({ kind: 'search', q: `in:"${b.path}" ` }) },
    ];
    if (b.role === '\\Trash' || b.role === '\\Junk') items.push({ label: `Empty ${ROLE_LABEL[b.role]}`, danger: true, run: () => void emptyFolder(b.path, ROLE_LABEL[b.role!]) });
    if (!b.role) {
      items.push({ divider: true });
      items.push({ label: 'New subfolder', run: () => createFolder(b.path) });
      items.push({ label: 'Rename', run: () => renameFolder(b) });
      items.push({ label: 'Colour', submenu: [{ label: 'None', run: () => void colorFolder(b, null) }, ...FOLDER_COLORS.map((c) => ({ label: c, swatch: c, run: () => void colorFolder(b, c) }))] });
      items.push({ divider: true });
      items.push({ label: 'Delete folder', danger: true, run: () => deleteFolder(b) });
    }
    setMenu({ x, y, items });
  }

  const dropProps = (path: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!useUi.getState().dragItems) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).classList.add('drop-target');
    },
    onDragLeave: (e: React.DragEvent) => (e.currentTarget as HTMLElement).classList.remove('drop-target'),
    onDrop: (e: React.DragEvent) => {
      (e.currentTarget as HTMLElement).classList.remove('drop-target');
      const keys = useUi.getState().dragItems;
      useUi.getState().setDragItems(null);
      if (!keys) return;
      e.preventDefault();
      const items = useUi.getState().visibleItems.filter((i) => keys.includes(i.key));
      if (items.length && items[0].mailbox !== path) void moveTo(path, items);
    },
  });

  function renderFolder(b: Mailbox, depth: number): React.ReactNode {
    const kids = tree.get(b.path) ?? [];
    const open = !closed.has(b.path);
    return (
      <li key={b.path}>
        <button
          className={`nav-item${isActive(b.path) ? ' active' : ''}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          aria-current={isActive(b.path) ? 'page' : undefined}
          onClick={() => setView({ kind: 'mailbox', path: b.path })}
          onContextMenu={(e) => {
            e.preventDefault();
            folderMenu(b, e.clientX, e.clientY);
          }}
          title={b.path}
          {...dropProps(b.path)}
        >
          {kids.length ? (
            <span
              className="chev"
              role="button"
              aria-label={open ? 'Collapse' : 'Expand'}
              onClick={(e) => {
                e.stopPropagation();
                const n = new Set(closed);
                if (open) n.add(b.path);
                else n.delete(b.path);
                setClosed(n);
              }}
            >
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          ) : null}
          {b.color ? <span className="dot" style={{ background: b.color }} /> : <Folder size={17} />}
          <span className="label">{b.name}</span>
          {b.unread > 0 && <span className="count">{b.unread > 9999 ? '9999+' : b.unread}</span>}
        </button>
        {kids.length > 0 && open && <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{kids.map((k) => renderFolder(k, depth + 1))}</ul>}
      </li>
    );
  }

  const q = quota.data;
  const pct = q && q.limit ? Math.min(100, (q.used / q.limit) * 100) : 0;

  return (
    <>
      {mobileNav && <div className="scrim mobile-only" style={{ zIndex: 84 }} onClick={() => setMobileNav(false)} />}
      <nav className={`sidebar${mobileNav ? ' mobile-open' : ''}`} aria-label="Folders">
        <div className="brand">
          {config?.brand.logoUrl ? <img src={config.brand.logoUrl} alt="" height={26} /> : <BrandMark />}
          <span className="brand-name">{config?.brand.name ?? 'Tidings'}</span>
        </div>
        <button className="compose-btn" onClick={() => void composeNew()} title="Compose (c)">
          <PenLine size={17} />
          <span>Compose</span>
          <kbd>C</kbd>
        </button>
        <div className="nav">
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 1 }}>
            {system.filter((b) => b.role === '\\Inbox').map((b) => (
              <SystemItem key={b.path} b={b} active={isActive(b.path)} onClick={() => setView({ kind: 'mailbox', path: b.path })} onMenu={folderMenu} drop={dropProps(b.path)} />
            ))}
            <li>
              <button className={`nav-item${view.kind === 'search' && view.q.startsWith('is:starred') ? ' active' : ''}`} onClick={() => setView({ kind: 'search', q: 'is:starred in:anywhere' })}>
                <Star size={17} /> <span className="label">Starred</span>
              </button>
            </li>
            {snoozed && (
              <li>
                <button className={`nav-item${isActive(snoozed.path) ? ' active' : ''}`} onClick={() => setView({ kind: 'mailbox', path: snoozed.path })}>
                  <Clock size={17} /> <span className="label">Snoozed</span>
                  {snoozed.total > 0 && <span className="count">{snoozed.total}</span>}
                </button>
              </li>
            )}
            {system.filter((b) => b.role !== '\\Inbox').map((b) => (
              <SystemItem key={b.path} b={b} active={isActive(b.path)} onClick={() => setView({ kind: 'mailbox', path: b.path })} onMenu={folderMenu} drop={dropProps(b.path)} />
            ))}
          </ul>
          <div className="nav-section">
            <span>Folders</span>
            <button className="icon-btn sm" aria-label="New folder" title="New folder" onClick={() => createFolder()}>
              <FolderPlus size={15} />
            </button>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 1 }}>
            {(tree.get(null) ?? []).map((b) => renderFolder(b, 0))}
            {!custom.length && <li className="hint" style={{ padding: '2px 10px' }}>No folders yet</li>}
          </ul>
          <div className="nav-section"><span>More</span></div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 1 }}>
            <li>
              <button className={`nav-item${view.kind === 'subscriptions' ? ' active' : ''}`} onClick={() => setView({ kind: 'subscriptions' })}>
                <Newspaper size={17} /> <span className="label">Subscriptions</span>
              </button>
            </li>
            <li>
              <button className={`nav-item${view.kind === 'contacts' ? ' active' : ''}`} onClick={() => setView({ kind: 'contacts' })}>
                <Users size={17} /> <span className="label">Contacts</span>
              </button>
            </li>
            <li>
              <button className={`nav-item${view.kind === 'outbox' ? ' active' : ''}`} onClick={() => setView({ kind: 'outbox' })}>
                <MailboxIcon size={17} /> <span className="label">Outbox</span>
              </button>
            </li>
          </ul>
        </div>
        {q && q.limit > 0 && (
          <div className="quota" title={`${bytes(q.used)} of ${bytes(q.limit)} used`}>
            {bytes(q.used)} of {bytes(q.limit)} used
            <div className={`quota-bar${pct >= 95 ? ' full' : pct >= 80 ? ' warn' : ''}`}>
              <i style={{ width: `${Math.max(2, pct)}%` }} />
            </div>
          </div>
        )}
        <div className="sidebar-foot">
          <button className="icon-btn" aria-label="Settings" title={`Settings (${describeKey('g')} ${describeKey(',')})`} onClick={() => useUi.getState().setDialog({ kind: 'settings' })}>
            <SettingsIcon size={18} />
          </button>
          <button
            className="icon-btn"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title="Toggle sidebar ([)"
            onClick={() => setS({ sidebarCollapsed: !collapsed })}
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
          <span style={{ flex: 1 }} />
          <button
            className="icon-btn"
            aria-label={`Sign out ${session.email}`}
            title={`Sign out (${session.email})`}
            onClick={() => void signOut()}
          >
            <LogOut size={18} />
          </button>
        </div>
      </nav>
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}

function SystemItem({ b, active, onClick, onMenu, drop }: { b: Mailbox; active: boolean; onClick: () => void; onMenu: (b: Mailbox, x: number, y: number) => void; drop: object }) {
  const Icon = ROLE_ICON[b.role!] ?? Folder;
  const showCount = b.role === '\\Inbox' || b.role === '\\Junk' || b.role === '\\Drafts';
  const n = b.role === '\\Drafts' ? b.total : b.unread;
  return (
    <li>
      <button
        className={`nav-item${active ? ' active' : ''}`}
        aria-current={active ? 'page' : undefined}
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(b, e.clientX, e.clientY);
        }}
        {...drop}
      >
        <Icon size={17} />
        <span className="label">{ROLE_LABEL[b.role!] ?? b.name}</span>
        {showCount && n > 0 && <span className={`count${b.role === '\\Inbox' ? ' hot' : ''}`}>{n > 9999 ? '9999+' : n}</span>}
      </button>
    </li>
  );
}

function createFolder(parent?: string) {
  useUi.getState().setDialog({
    kind: 'prompt',
    title: parent ? 'New subfolder' : 'New folder',
    label: parent ? `Name (inside “${parent}”)` : 'Name',
    confirm: 'Create folder',
    run: async (name) => {
      try {
        await api('/api/mailboxes', { body: { name, parent } });
        await queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
        useUi.getState().pushToast({ message: `Folder “${name}” created` });
      } catch (err) {
        useUi.getState().pushToast({ message: (err as Error).message, tone: 'error' });
      }
    },
  });
}

function renameFolder(b: Mailbox) {
  useUi.getState().setDialog({
    kind: 'prompt',
    title: 'Rename folder',
    label: 'Name',
    initial: b.name,
    confirm: 'Rename',
    run: async (name) => {
      if (name === b.name) return;
      try {
        await api('/api/mailboxes', { method: 'PATCH', body: { path: b.path, newName: name } });
        await queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
      } catch (err) {
        useUi.getState().pushToast({ message: (err as Error).message, tone: 'error' });
      }
    },
  });
}

async function colorFolder(b: Mailbox, color: string | null) {
  await api('/api/mailboxes', { method: 'PATCH', body: { path: b.path, color } }).catch(() => undefined);
  await queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
}

function deleteFolder(b: Mailbox) {
  useUi.getState().setDialog({
    kind: 'confirm',
    title: `Delete “${b.name}”?`,
    body: b.total ? `The folder and its ${b.total} messages will be deleted from the server. This cannot be undone.` : 'The folder will be deleted from the server.',
    confirm: 'Delete folder',
    danger: true,
    run: async () => {
      try {
        await api(`/api/mailboxes?path=${encodeURIComponent(b.path)}`, { method: 'DELETE' });
        await queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
        const v = useUi.getState().view;
        if (v.kind === 'mailbox' && v.path === b.path) useUi.getState().setView({ kind: 'mailbox', path: 'INBOX' });
      } catch (err) {
        useUi.getState().pushToast({ message: (err as Error).message, tone: 'error' });
      }
    },
  });
}

async function signOut() {
  try {
    await api('/api/session/logout', { body: {} });
  } finally {
    queryClient.clear();
    try {
      localStorage.removeItem('tidings.recentSearches');
    } catch {
      /* ignore */
    }
    location.reload();
  }
}
