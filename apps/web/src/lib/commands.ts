import type { Mailbox } from '../api/types';
import { queryClient } from '../state/queries';
import { settings, useSettings } from '../state/settings';
import { ui } from '../state/ui';
import { archive, actionItems, deleteForever, emptyFolder, junk, runUndo, setRead, toggleStar, trash } from './actions';
import { composeNew, forward, reply } from './composeActions';
import { type Command, registerCommands } from './keys';
import { THEMES } from '../styles/themes';

const boxes = () => queryClient.getQueryData<Mailbox[]>(['mailboxes']) ?? [];
const byRole = (role: string) => boxes().find((b) => b.role === role)?.path;
const noDialog = () => !ui().dialog;
const hasTarget = () => noDialog() && actionItems().length > 0;
const inReader = () => noDialog() && !!ui().open;
const inList = () => noDialog() && (ui().view.kind === 'mailbox' || ui().view.kind === 'search');

function extendSelection(delta: number) {
  const st = ui();
  const items = st.visibleItems;
  const idx = items.findIndex((i) => i.key === st.cursor);
  if (idx < 0) return;
  if (!st.selection.has(items[idx].key)) st.toggleSelect(items[idx].key);
  const next = items[idx + delta];
  if (!next) return;
  if (!st.selection.has(next.key)) st.toggleSelect(next.key);
  st.setCursor(next.key);
}

function archiveAndGo(dir: 'next' | 'previous') {
  const prev = settings().afterAction;
  useSettings.setState((st) => ({ s: { ...st.s, afterAction: dir } }));
  // advanceAfterRemoval reads afterAction synchronously, so we can restore it right away.
  void archive();
  useSettings.setState((st) => ({ s: { ...st.s, afterAction: prev } }));
}

function goRole(role: string, fallback?: string) {
  const path = byRole(role) ?? fallback;
  if (path) ui().setView({ kind: 'mailbox', path });
}

function moveCursor(delta: number) {
  const st = ui();
  const items = st.visibleItems;
  if (!items.length) return;
  const idx = items.findIndex((i) => i.key === (st.focusZone === 'reader' && st.open ? st.open : st.cursor));
  const next = items[Math.max(0, Math.min(items.length - 1, idx < 0 ? 0 : idx + delta))];
  if (!next) return;
  if (st.open && st.focusZone === 'reader') st.setOpen(next.key);
  else st.setCursor(next.key);
  focusList();
}

/** Keep focus on the listbox so assistive tech follows aria-activedescendant. */
function focusList() {
  const a = document.activeElement as HTMLElement | null;
  if (a && (a.tagName === 'IFRAME' || a.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(a.tagName))) return;
  document.querySelector<HTMLElement>('.list-scroll')?.focus({ preventScroll: true });
}

export function buildCommands(): Command[] {
  const list: Command[] = [
    // Navigate
    { id: 'down', title: 'Next conversation', group: 'Navigate', keys: ['j'], alt: [['ArrowDown']], when: inList, run: () => moveCursor(1) },
    { id: 'up', title: 'Previous conversation', group: 'Navigate', keys: ['k'], alt: [['ArrowUp']], when: inList, run: () => moveCursor(-1) },
    { id: 'extend-down', title: 'Extend selection down', group: 'Navigate', keys: ['J'], when: inList, run: () => extendSelection(1) },
    { id: 'extend-up', title: 'Extend selection up', group: 'Navigate', keys: ['K'], when: inList, run: () => extendSelection(-1) },
    {
      id: 'open', title: 'Open conversation', group: 'Navigate', keys: ['Enter'], alt: [['o']],
      when: () => noDialog() && !!ui().cursor && ui().focusZone === 'list',
      run: () => ui().setOpen(ui().cursor),
    },
    {
      id: 'back', title: 'Back to list', group: 'Navigate', keys: ['u'], alt: [['Escape']],
      when: () => noDialog() && (!!ui().open || ui().selection.size > 0),
      run: () => {
        if (ui().selection.size && !ui().open) ui().clearSelection();
        else ui().setOpen(null);
      },
    },
    { id: 'select', title: 'Select conversation', group: 'Navigate', keys: ['x'], when: () => inList() && !!ui().cursor, run: () => ui().toggleSelect(ui().cursor!) },
    { id: 'select-all', title: 'Select all', group: 'Navigate', keys: ['*', 'a'], when: inList, run: () => ui().selectAll() },
    { id: 'search', title: 'Search mail', group: 'Navigate', keys: ['/'], when: noDialog, run: () => ui().focusSearch() },
    { id: 'expand', title: 'Expand all messages', group: 'View', keys: [';'], when: inReader, run: () => window.dispatchEvent(new CustomEvent('tidings:expand-all')) },
    { id: 'sender', title: 'Show sender details', group: 'View', keys: ['i'], when: inReader, run: () => window.dispatchEvent(new CustomEvent('tidings:sender-panel')) },

    // Triage
    { id: 'archive', title: 'Archive', group: 'Triage', keys: ['e'], alt: [['y']], when: hasTarget, run: () => void archive() },
    { id: 'archive-next', title: 'Archive and open older', group: 'Triage', keys: [']'], when: hasTarget, run: () => archiveAndGo('next') },
    { id: 'archive-prev', title: 'Archive and open newer', group: 'Triage', keys: ['['], when: hasTarget, run: () => archiveAndGo('previous') },
    { id: 'trash', title: 'Delete', group: 'Triage', keys: ['#'], alt: [['Delete'], ['Backspace']], when: hasTarget, run: () => void trash() },
    { id: 'junk', title: 'Mark as spam / not spam', group: 'Triage', keys: ['!'], when: hasTarget, run: () => void junk() },
    { id: 'move', title: 'Move to folder…', group: 'Triage', keys: ['v'], when: hasTarget, run: () => ui().setDialog({ kind: 'move', mode: 'move' }) },
    { id: 'snooze', title: 'Snooze…', group: 'Triage', keys: ['h'], alt: [['b']], when: hasTarget, run: () => ui().setDialog({ kind: 'snooze' }) },
    { id: 'star', title: 'Star / unstar', group: 'Triage', keys: ['s'], when: hasTarget, run: () => void toggleStar() },
    { id: 'read', title: 'Mark as read', group: 'Triage', keys: ['I'], when: hasTarget, run: () => void setRead(actionItems(), true) },
    { id: 'unread', title: 'Mark as unread', group: 'Triage', keys: ['U'], when: hasTarget, run: () => void setRead(actionItems(), false) },
    { id: 'undo', title: 'Undo last action', group: 'Triage', keys: ['z'], when: noDialog, run: () => void runUndo() },
    { id: 'delete-forever', title: 'Delete forever', group: 'Triage', paletteOnly: true, when: hasTarget, run: () => deleteForever() },

    // Compose
    { id: 'compose', title: 'Compose', group: 'Compose', keys: ['c'], when: noDialog, run: () => void composeNew() },
    { id: 'reply', title: 'Reply', group: 'Compose', keys: ['r'], when: inReader, run: () => void reply(settings().defaultReply === 'replyAll') },
    { id: 'reply-all', title: 'Reply all', group: 'Compose', keys: ['a'], when: inReader, run: () => void reply(settings().defaultReply !== 'replyAll') },
    { id: 'forward', title: 'Forward', group: 'Compose', keys: ['f'], when: inReader, run: () => void forward() },

    // Go to
    { id: 'go-inbox', title: 'Go to Inbox', group: 'Go to', keys: ['g', 'i'], run: () => ui().setView({ kind: 'mailbox', path: 'INBOX' }) },
    { id: 'go-starred', title: 'Go to Starred', group: 'Go to', keys: ['g', 's'], run: () => ui().setView({ kind: 'search', q: 'is:starred in:anywhere' }) },
    { id: 'go-sent', title: 'Go to Sent', group: 'Go to', keys: ['g', 't'], run: () => goRole('\\Sent') },
    { id: 'go-drafts', title: 'Go to Drafts', group: 'Go to', keys: ['g', 'd'], run: () => goRole('\\Drafts') },
    { id: 'go-archive', title: 'Go to Archive', group: 'Go to', keys: ['g', 'e'], run: () => goRole('\\Archive') },
    { id: 'go-spam', title: 'Go to Spam', group: 'Go to', keys: ['g', '!'], run: () => goRole('\\Junk') },
    { id: 'go-trash', title: 'Go to Trash', group: 'Go to', keys: ['g', '#'], run: () => goRole('\\Trash') },
    { id: 'go-folder', title: 'Go to folder…', group: 'Go to', keys: ['g', 'l'], run: () => ui().setDialog({ kind: 'palette' }), keywords: 'label jump' },
    { id: 'go-subs', title: 'Manage subscriptions', group: 'Go to', paletteOnly: true, run: () => ui().setView({ kind: 'subscriptions' }), keywords: 'unsubscribe newsletters' },
    { id: 'go-contacts', title: 'Contacts', group: 'Go to', keys: ['g', 'c'], run: () => ui().setView({ kind: 'contacts' }), keywords: 'address book people' },
    { id: 'go-outbox', title: 'Outbox', group: 'Go to', keys: ['g', 'o'], run: () => ui().setView({ kind: 'outbox' }), keywords: 'sending queued' },

    // App
    { id: 'palette', title: 'Command palette', group: 'App', keys: ['mod+k'], run: () => ui().setDialog(ui().dialog?.kind === 'palette' ? null : { kind: 'palette' }) },
    { id: 'help', title: 'Keyboard shortcuts', group: 'App', keys: ['?'], when: noDialog, run: () => ui().setDialog({ kind: 'help' }) },
    { id: 'settings', title: 'Settings', group: 'App', keys: ['g', ','], alt: [['mod+,']], run: () => ui().setDialog({ kind: 'settings' }), keywords: 'preferences options' },
    {
      id: 'toggle-dark', title: 'Toggle light / dark', group: 'App', keys: ['mod+shift+l'], keywords: 'theme appearance',
      run: () => {
        const s = settings();
        const dark = document.documentElement.dataset.dark === 'true';
        useSettings.getState().set({ themeMode: 'single', theme: dark ? s.lightTheme : s.darkTheme });
      },
    },
    { id: 'toggle-conv', title: 'Toggle conversation view', group: 'View', paletteOnly: true, run: () => useSettings.getState().set({ conversations: !settings().conversations }) },
    { id: 'toggle-sidebar', title: 'Toggle sidebar', group: 'View', keys: ['mod+\\'], when: noDialog, run: () => useSettings.getState().set({ sidebarCollapsed: !settings().sidebarCollapsed }) },
    {
      id: 'layout', title: 'Cycle reading pane layout', group: 'View', paletteOnly: true, keywords: 'split rows columns',
      run: () => {
        const order = ['columns', 'rows', 'list'] as const;
        useSettings.getState().set({ layout: order[(order.indexOf(settings().layout) + 1) % order.length] });
      },
    },
    {
      id: 'density', title: 'Cycle list density', group: 'View', paletteOnly: true, keywords: 'compact cozy comfortable',
      run: () => {
        const order = ['comfortable', 'cozy', 'compact'] as const;
        useSettings.getState().set({ density: order[(order.indexOf(settings().density) + 1) % order.length] });
      },
    },
    {
      id: 'empty-trash', title: 'Empty Trash', group: 'Triage', paletteOnly: true,
      run: () => {
        const p = byRole('\\Trash');
        if (p) void emptyFolder(p, 'Trash');
      },
    },
    {
      id: 'empty-spam', title: 'Empty Spam', group: 'Triage', paletteOnly: true,
      run: () => {
        const p = byRole('\\Junk');
        if (p) void emptyFolder(p, 'Spam');
      },
    },
  ];
  for (const t of THEMES) {
    list.push({
      id: `theme-${t.id}`, title: `Theme: ${t.name}`, group: 'App', paletteOnly: true, keywords: `appearance ${t.dark ? 'dark' : 'light'}`,
      run: () => useSettings.getState().set({ themeMode: 'single', theme: t.id }),
    });
  }
  return list;
}

export function installCommands() {
  registerCommands(buildCommands());
}
