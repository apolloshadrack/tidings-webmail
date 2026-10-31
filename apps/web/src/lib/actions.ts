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
  if (st.view.kind !== 'mailbox' && st.view.kind !== 'search') return [];
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
  const msg = e.status === 0 ? 'You appear to be offline. Nothing was changed.' : e.status >= 500 ? 'The mail server didn’t respond. Nothing was changed.' : e.message || 'Something went wrong';
  ui().pushToast({ message: msg, tone: 'error', sticky: !!retry, action: retry ? { label: 'Retry', run: retry } : undefined });
}

/** A successful call clears stale "failed" toasts. */
function clearErrors() {
  for (const t of ui().toasts) if (t.tone === 'error') ui().dismissToast(t.id);
}

/** Retry once on transient server errors before telling the user. */
async function call<T>(path: string, body: unknown): Promise<T> {
  try {
    return await api<T>(path, { body });
  } catch (err) {
    const e = err as ApiError;
    if (e.status >= 500 || e.status === 0) {
      await new Promise((r) => setTimeout(r, 600));
      return api<T>(path, { body });
    }
    throw err;
  }
}

interface MoveResponse {
  results: { from: string; uids: number[]; destination: string; uidValidity?: string; uidMap: Record<string, number> }[];
}

function where() {
  const st = ui();
  return { cursor: st.cursor, open: st.open, selection: new Set(st.selection), view: st.view };
}

/** Undo puts the user back where they were (cursor, open conversation, selection). */
function restoreWhere(w: ReturnType<typeof where>) {
  const st = ui();
  if (JSON.stringify(st.view) !== JSON.stringify(w.view)) return;
  setTimeout(() => {
    useUiSet({ cursor: w.cursor, selection: w.selection });
    if (w.open) ui().setOpen(w.open);
  }, 150);
}

function useUiSet(patch: { cursor: string | null; selection: Set<string> }) {
  ui().setCursor(patch.cursor);
  for (const k of patch.selection) if (!ui().selection.has(k)) ui().toggleSelect(k);
}

function undoMove(res: MoveResponse, w: ReturnType<typeof where>) {
  return async () => {
    for (const r of res.results) {
      const back = r.uids.map((u) => r.uidMap[u]).filter(Boolean);
      if (!back.length || !r.uidValidity) throw new Error('This can’t be undone automatically — the server didn’t report where the messages went.');
      await call('/api/actions/move', { targets: [{ mailbox: r.destination, uidValidity: r.uidValidity, uids: back }], to: r.from });
    }
    await queryClient.invalidateQueries({ queryKey: ['list'] });
    invalidateSoon();
    restoreWhere(w);
  };
}

function folderLabel(path: string) {
  const boxes = queryClient.getQueryData<Mailbox[]>(['mailboxes']) ?? [];
  return boxes.find((b) => b.path === path)?.name ?? path;
}

function roleOf(it: ListItem): string | null {
  return queryClient.getQueryData<Mailbox[]>(['mailboxes'])?.find((b) => b.path === it.mailbox)?.role ?? null;
}

/** Push an undo entry and show its toast; the toast's button undoes exactly that entry. */
function offerUndo(label: string, message: string, undo: () => Promise<void>) {
  const id = ui().pushUndo({ label, undo });
  ui().pushToast({ message, action: { label: 'Undo', run: () => void runUndo(id) } });
}

export async function move(items: ListItem[], dest: { role?: 'archive' | 'trash' | 'junk' | 'inbox' | 'notjunk'; to?: string }, verb: string) {
  if (!items.length) return;
  const w = where();
  const keys = new Set(items.map((i) => i.key));
  advanceAfterRemoval(keys);
  const snap = removeRows(keys);
  const n = items.length;
  const what = n === 1 ? 'Conversation' : `${n} conversations`;
  try {
    const res = await call<MoveResponse>('/api/actions/move', { targets: targetsFor(items), ...dest });
    clearErrors();
    offerUndo(`${verb} ${what.toLowerCase()}`, `${what} ${verb.toLowerCase()}${dest.to ? ` to ${folderLabel(dest.to)}` : ''}`, undoMove(res, w));
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
  // Each item is routed by its own folder: archiving inside Archive moves back to the Inbox.
  const inArchive = items.filter((i) => roleOf(i) === '\\Archive');
  const rest = items.filter((i) => roleOf(i) !== '\\Archive');
  if (inArchive.length) void move(inArchive, { role: 'inbox' }, 'Moved to Inbox');
  if (rest.length) return move(rest, { role: 'archive' }, 'Archived');
};

export const trash = (items = actionItems()) => {
  // Only items already in Trash/Spam are deleted for good; everything else goes to Trash.
  const final = items.filter((i) => ['\\Trash', '\\Junk'].includes(roleOf(i) ?? ''));
  const rest = items.filter((i) => !final.includes(i));
  if (rest.length) void move(rest, { role: 'trash' }, 'Deleted');
  if (final.length) deleteForever(final);
};

export const junk = (items = actionItems()) => {
  const inJunk = items.filter((i) => roleOf(i) === '\\Junk');
  const rest = items.filter((i) => roleOf(i) !== '\\Junk');
  if (inJunk.length) void move(inJunk, { role: 'notjunk' }, 'Marked as not spam');
  if (rest.length) return move(rest, { role: 'junk' }, 'Marked as spam');
};

export const moveTo = (path: string, items = actionItems()) => move(items.filter((i) => i.mailbox !== path), { to: path }, 'Moved');

export function deleteForever(items = actionItems()) {
  if (!items.length) return;
  const n = items.length;
  const where_ = [...new Set(items.map((i) => folderLabel(i.mailbox)))].join(' and ');
  ui().setDialog({
    kind: 'confirm',
    title: n === 1 ? 'Delete forever?' : `Delete ${n} conversations forever?`,
    body: `${n === 1 ? 'This conversation is' : 'These conversations are'} already in ${where_}. Deleting ${n === 1 ? 'it' : 'them'} again removes ${n === 1 ? 'it' : 'them'} permanently and cannot be undone.`,
    confirm: 'Delete forever',
    danger: true,
    run: async () => {
      const keys = new Set(items.map((i) => i.key));
      advanceAfterRemoval(keys);
      const snap = removeRows(keys);
      try {
        await call('/api/actions/delete', { targets: targetsFor(items) });
        clearErrors();
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
  const before = new Map(items.map((i) => [i.key, i]));
  const snap = patchRows(keys, patch);
  ui().setVisible(ui().visibleItems.map((i) => (keys.has(i.key) ? patch(i) : i)));
  try {
    await call('/api/actions/flags', { targets: targetsFor(items), add, remove });
    clearErrors();
    if (label) {
      const undo = async () => {
        await call('/api/actions/flags', { targets: targetsFor(items), add: remove, remove: add });
        patchRows(keys, (i) => before.get(i.key) ?? i);
        await queryClient.invalidateQueries({ queryKey: ['list'] });
        invalidateSoon();
      };
      if (silent) ui().pushUndo({ label, undo });
      else offerUndo(label, label, undo);
    }
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
  const n = items.length > 1 ? `${items.length} conversations` : 'Conversation';
  return flags(items, on ? ['\\Flagged'] : [], on ? [] : ['\\Flagged'], (i) => ({ ...i, flagged: on }), on ? `${n} starred` : `${n} unstarred`, true);
}

export function setRead(items: ListItem[], read: boolean, silent = false) {
  const need = items.filter((i) => (read ? i.unread || i.unreadCount > 0 : !i.unread));
  if (!need.length) return;
  return flags(
    need,
    read ? ['\\Seen'] : [],
    read ? [] : ['\\Seen'],
    (i) => ({ ...i, unread: !read, unreadCount: read ? 0 : Math.max(1, i.unreadCount) }),
    silent ? undefined : read ? `Marked ${need.length > 1 ? `${need.length} ` : ''}as read` : `Marked ${need.length > 1 ? `${need.length} ` : ''}as unread`,
    silent,
  );
}

export async function snooze(until: number, items = actionItems()) {
  if (!items.length) return;
  const w = where();
  const keys = new Set(items.map((i) => i.key));
  advanceAfterRemoval(keys);
  const snap = removeRows(keys);
  try {
    const messageIds: string[] = [];
    for (const t of targetsFor(items)) {
      const res = await call<{ folder: string; messageIds: string[] }>('/api/snooze', { ...t, until });
      messageIds.push(...res.messageIds);
    }
    clearErrors();
    const when = new Date(until);
    offerUndo('Snooze', `Snoozed until ${when.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`, async () => {
      await call('/api/snooze/cancel', { messageIds });
      await queryClient.invalidateQueries({ queryKey: ['list'] });
      invalidateSoon();
      restoreWhere(w);
    });
    invalidateSoon();
  } catch (err) {
    restore(snap);
    errorToast(err);
  }
}

export async function runUndo(id?: number) {
  const u = ui().takeUndo(id);
  if (!u) {
    ui().pushToast({ message: id === undefined ? 'Nothing to undo' : 'Too late to undo that' });
    return;
  }
  try {
    await u.undo();
    ui().pushToast({ message: `Undone: ${u.label.toLowerCase()}`, tone: 'success' });
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
