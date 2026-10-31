import { ApiError, api } from '../api/client';
import type { ListItem, ListPage, Mailbox, Target } from '../api/types';
import { allCachedLists, queryClient } from '../state/queries';
import { settings } from '../state/settings';
import { ui } from '../state/ui';

/** Group list items into per-mailbox IMAP targets. */
export function targetsFor(items: ListItem[]): Target[] {
  const by = new Map<string, Target>();
  for (const it of items) {
    const k = `${it.mailbox}\0${it.uidValidity}`;
    const t = by.get(k) ?? { mailbox: it.mailbox, uidValidity: it.uidValidity, uids: [] };
    t.uids.push(...it.uids);
    by.set(k, t);
  }
  return [...by.values()];
}

/** What the next action applies to: the selection if any, else the open conversation, else the cursor row. */
export function actionItems(): ListItem[] {
  const st = ui();
  const items = st.visibleItems;
  if (st.selection.size) return items.filter((i) => st.selection.has(i.key));
  const key = st.focusZone === 'reader' && st.open ? st.open : st.cursor;
  const it = items.find((i) => i.key === key);
  return it ? [it] : [];
}

type Snapshot = ReturnType<typeof allCachedLists>;

function removeRows(keys: Set<string>): Snapshot {
  const snap = allCachedLists();
  for (const [qk, data] of snap) {
    if (!data) continue;
    queryClient.setQueryData(qk, {
      ...data,
      pages: data.pages.map((p: ListPage) => ({ ...p, items: p.items.filter((i) => !keys.has(i.key)) })),
    });
  }
  return snap;
}

function patchRows(keys: Set<string>, patch: (i: ListItem) => ListItem): Snapshot {
  const snap = allCachedLists();
  for (const [qk, data] of snap) {
    if (!data) continue;
    queryClient.setQueryData(qk, {
      ...data,
      pages: data.pages.map((p: ListPage) => ({ ...p, items: p.items.map((i) => (keys.has(i.key) ? patch(i) : i)) })),
    });
  }
  return snap;
}

function restore(snap: Snapshot) {
  for (const [qk, data] of snap) queryClient.setQueryData(qk, data);
}

/** Move the cursor into the slot of removed rows (next = older by default), never to the top. */
function advanceAfterRemoval(removed: Set<string>) {
  const st = ui();
  const items = st.visibleItems;
  const anchor = st.open && removed.has(st.open) ? st.open : st.cursor;
  const idx = items.findIndex((i) => i.key === anchor);
  const remaining = items.filter((i) => !removed.has(i.key));
  let next: ListItem | undefined;
  if (idx >= 0) {
    const pref = settings().afterAction;
    const after = items.slice(idx + 1).find((i) => !removed.has(i.key));
    const before = items.slice(0, idx).reverse().find((i) => !removed.has(i.key));
    next = pref === 'previous' ? before ?? after : after ?? before;
  }
  st.clearSelection();
  st.setVisible(remaining);
  if (!next) {
    st.setCursor(null);
    st.setOpen(null);
    return;
  }
  st.setCursor(next.key);
  if (st.open && removed.has(st.open)) {
    if (settings().afterAction === 'list') st.setOpen(null);
    else st.setOpen(next.key);
  }
}

function invalidateSoon() {
  setTimeout(() => {
    void queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
  }, 300);
}

function errorToast(err: unknown, retry?: () => void) {
  const e = err as ApiError;
  if (e.code === 'UIDVALIDITY_CHANGED') {
    void queryClient.invalidateQueries({ queryKey: ['list'] });
    ui().pushToast({ message: 'This folder changed on the server. Refreshed.', tone: 'info' });
    return;
  }
  ui().pushToast({ message: e.message || 'Something went wrong', tone: 'error', sticky: !!retry, action: retry ? { label: 'Retry', run: retry } : undefined });
}

interface MoveResponse {
  results: { from: string; uids: number[]; destination: string; uidValidity?: string; uidMap: Record<string, number> }[];
}

function undoMove(res: MoveResponse) {
  return async () => {
    for (const r of res.results) {
      const back = r.uids.map((u) => r.uidMap[u]).filter(Boolean);
      if (!back.length || !r.uidValidity) continue;
      await api('/api/actions/move', { body: { targets: [{ mailbox: r.destination, uidValidity: r.uidValidity, uids: back }], to: r.from } });
    }
    await queryClient.invalidateQueries({ queryKey: ['list'] });
    invalidateSoon();
  };
}

function folderLabel(path: string) {
  const boxes = queryClient.getQueryData<Mailbox[]>(['mailboxes']) ?? [];
  return boxes.find((b) => b.path === path)?.name ?? path;
}

export async function move(items: ListItem[], dest: { role?: 'archive' | 'trash' | 'junk' | 'inbox' | 'notjunk'; to?: string }, verb: string) {
  if (!items.length) return;
  const keys = new Set(items.map((i) => i.key));
  advanceAfterRemoval(keys);
  const snap = removeRows(keys);
  const n = items.length;
  const what = n === 1 ? 'Conversation' : `${n} conversations`;
  try {
    const res = await api<MoveResponse>('/api/actions/move', { body: { targets: targetsFor(items), ...dest } });
    const undo = undoMove(res);
    ui().pushUndo({ label: `${verb} ${what.toLowerCase()}`, undo });
    ui().pushToast({
      message: `${what} ${verb.toLowerCase()}${dest.to ? ` to ${folderLabel(dest.to)}` : ''}`,
      action: { label: 'Undo', run: () => void runUndo() },
    });
    invalidateSoon();
  } catch (err) {
    restore(snap);
    if ((err as ApiError).code === 'NEEDS_ARCHIVE_FOLDER') {
      ui().setDialog({ kind: 'archive-setup' });
      return;
    }
    errorToast(err, () => void move(items, dest, verb));
  }
}

export const archive = (items = actionItems()) => {
  const role = items[0] ? queryClient.getQueryData<Mailbox[]>(['mailboxes'])?.find((b) => b.path === items[0].mailbox)?.role : null;
  if (role === '\\Archive') return move(items, { role: 'inbox' }, 'Moved to Inbox');
  return move(items, { role: 'archive' }, 'Archived');
};

export const trash = (items = actionItems()) => {
  const role = items[0] ? queryClient.getQueryData<Mailbox[]>(['mailboxes'])?.find((b) => b.path === items[0].mailbox)?.role : null;
  if (role === '\\Trash' || role === '\\Junk') return deleteForever(items);
  return move(items, { role: 'trash' }, 'Deleted');
};

export const junk = (items = actionItems()) => {
  const role = items[0] ? queryClient.getQueryData<Mailbox[]>(['mailboxes'])?.find((b) => b.path === items[0].mailbox)?.role : null;
  if (role === '\\Junk') return move(items, { role: 'notjunk' }, 'Marked as not spam');
  return move(items, { role: 'junk' }, 'Marked as spam');
};

export const moveTo = (path: string, items = actionItems()) => move(items, { to: path }, 'Moved');

export function deleteForever(items = actionItems()) {
  if (!items.length) return;
  const n = items.length;
  ui().setDialog({
    kind: 'confirm',
    title: n === 1 ? 'Delete forever?' : `Delete ${n} conversations forever?`,
    body: 'This cannot be undone.',
    confirm: 'Delete forever',
    danger: true,
    run: async () => {
      const keys = new Set(items.map((i) => i.key));
      advanceAfterRemoval(keys);
      const snap = removeRows(keys);
      try {
        await api('/api/actions/delete', { body: { targets: targetsFor(items) } });
        ui().pushToast({ message: n === 1 ? 'Deleted forever' : `${n} deleted forever` });
        invalidateSoon();
      } catch (err) {
        restore(snap);
        errorToast(err);
      }
    },
  });
}

async function flags(items: ListItem[], add: string[], remove: string[], patch: (i: ListItem) => ListItem, label?: string, silent = false) {
  if (!items.length) return;
  const keys = new Set(items.map((i) => i.key));
  const snap = patchRows(keys, patch);
  ui().setVisible(ui().visibleItems.map((i) => (keys.has(i.key) ? patch(i) : i)));
  try {
    await api('/api/actions/flags', { body: { targets: targetsFor(items), add, remove } });
    if (label) {
      ui().pushUndo({
        label,
        undo: async () => {
          await api('/api/actions/flags', { body: { targets: targetsFor(items), add: remove, remove: add } });
          await queryClient.invalidateQueries({ queryKey: ['list'] });
          invalidateSoon();
        },
      });
    }
    if (!silent && label) ui().pushToast({ message: label, action: { label: 'Undo', run: () => void runUndo() } });
    invalidateSoon();
    for (const it of items) void queryClient.invalidateQueries({ queryKey: ['thread', it.threadId] });
  } catch (err) {
    restore(snap);
    errorToast(err, () => void flags(items, add, remove, patch, label, silent));
  }
}

export function toggleStar(items = actionItems()) {
  if (!items.length) return;
  const on = !items.every((i) => i.flagged);
  return flags(items, on ? ['\\Flagged'] : [], on ? [] : ['\\Flagged'], (i) => ({ ...i, flagged: on }), on ? undefined : undefined, true);
}

export function setRead(items: ListItem[], read: boolean, silent = false) {
  const need = items.filter((i) => i.unread === read || (read && i.unreadCount > 0));
  if (!need.length && !silent) return;
  return flags(
    items,
    read ? ['\\Seen'] : [],
    read ? [] : ['\\Seen'],
    (i) => ({ ...i, unread: !read, unreadCount: read ? 0 : Math.max(1, i.unreadCount) }),
    silent ? undefined : read ? `Marked ${items.length > 1 ? `${items.length} ` : ''}as read` : `Marked ${items.length > 1 ? `${items.length} ` : ''}as unread`,
    silent,
  );
}

export async function snooze(until: number, items = actionItems()) {
  if (!items.length) return;
  const keys = new Set(items.map((i) => i.key));
  advanceAfterRemoval(keys);
  const snap = removeRows(keys);
  try {
    for (const t of targetsFor(items)) {
      const res = await api<{ folder: string; uidMap: Record<string, number> }>('/api/snooze', { body: { ...t, until } });
      const mailbox = t.mailbox;
      ui().pushUndo({
        label: 'Snooze',
        undo: async () => {
          const boxes = await queryClient.fetchQuery({ queryKey: ['mailboxes'], queryFn: () => api<{ mailboxes: Mailbox[] }>('/api/mailboxes').then((r) => r.mailboxes) });
          const sn = boxes.find((b) => b.path === res.folder);
          const back = t.uids.map((u) => res.uidMap[u]).filter(Boolean);
          if (sn?.uidValidity && back.length) {
            await api('/api/actions/move', { body: { targets: [{ mailbox: res.folder, uidValidity: sn.uidValidity, uids: back }], to: mailbox } });
          }
          await queryClient.invalidateQueries({ queryKey: ['list'] });
        },
      });
    }
    const when = new Date(until);
    ui().pushToast({
      message: `Snoozed until ${when.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`,
      action: { label: 'Undo', run: () => void runUndo() },
    });
    invalidateSoon();
  } catch (err) {
    restore(snap);
    errorToast(err);
  }
}

export async function runUndo() {
  const u = ui().popUndo();
  if (!u) {
    ui().pushToast({ message: 'Nothing to undo' });
    return;
  }
  try {
    await u.undo();
    ui().pushToast({ message: `Undone: ${u.label}`, tone: 'success' });
  } catch (err) {
    errorToast(err);
  }
}

export async function emptyFolder(path: string, label: string) {
  ui().setDialog({
    kind: 'confirm',
    title: `Empty ${label}?`,
    body: `Every message in ${label} will be permanently deleted. This cannot be undone.`,
    confirm: `Empty ${label}`,
    danger: true,
    run: async () => {
      try {
        const r = await api<{ deleted: number }>('/api/actions/empty', { body: { mailbox: path } });
        ui().pushToast({ message: `${r.deleted} messages deleted forever` });
        await queryClient.invalidateQueries({ queryKey: ['list'] });
        invalidateSoon();
      } catch (err) {
        errorToast(err);
      }
    },
  });
}
