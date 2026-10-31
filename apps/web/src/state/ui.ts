import { create } from 'zustand';
import type { ComposeState, ListItem } from '../api/types';

export type View =
  | { kind: 'mailbox'; path: string; tab?: string }
  | { kind: 'search'; q: string }
  | { kind: 'subscriptions' }
  | { kind: 'contacts' }
  | { kind: 'outbox' };

export interface Toast {
  id: number;
  message: string;
  tone?: 'info' | 'error' | 'success';
  action?: { label: string; run: () => void };
  sticky?: boolean;
  ttl?: number;
}

export interface UndoEntry {
  label: string;
  undo: () => Promise<void>;
}

export interface ComposerWindow {
  id: string; // = draftId
  state: ComposeState;
  minimized: boolean;
  inlineThread?: string; // when replying inline inside a conversation
  quotedHtml?: string;
  quotedText?: string;
  focus?: 'to' | 'body' | 'subject';
  files?: { id: string; filename: string; size: number; contentType: string }[];
  forwardFiles?: { part: string; filename: string; size: number }[];
  savedAt?: number;
}

export type Dialog =
  | { kind: 'settings'; tab?: string }
  | { kind: 'move'; mode: 'move' }
  | { kind: 'snooze' }
  | { kind: 'help' }
  | { kind: 'palette' }
  | { kind: 'source'; mailbox: string; uidValidity: string; uid: number }
  | { kind: 'link'; href: string; text: string; mismatch: boolean }
  | { kind: 'confirm'; title: string; body: string; confirm: string; danger?: boolean; run: () => void }
  | { kind: 'archive-setup' }
  | { kind: 'prompt'; title: string; label: string; initial?: string; confirm: string; run: (value: string) => void | Promise<void> }
  | null;

interface UiState {
  view: View;
  cursor: string | null; // key of the focused list row
  selection: Set<string>;
  open: string | null; // key of the conversation open in the reader
  focusZone: 'list' | 'reader';
  composers: ComposerWindow[];
  toasts: Toast[];
  undo: UndoEntry[];
  dialog: Dialog;
  senderPanel: string | null;
  visibleItems: ListItem[]; // the list as currently rendered (for keyboard nav + actions)
  searchFocused: number; // bump to focus the search box
  online: boolean;
  newCount: number;
  mobileNav: boolean;
  dragItems: string[] | null;

  setView: (v: View) => void;
  setCursor: (k: string | null) => void;
  setOpen: (k: string | null) => void;
  setFocusZone: (z: 'list' | 'reader') => void;
  toggleSelect: (k: string, range?: boolean) => void;
  clearSelection: () => void;
  selectAll: () => void;
  setVisible: (items: ListItem[]) => void;
  pushToast: (t: Omit<Toast, 'id'>) => number;
  dismissToast: (id: number) => void;
  pushUndo: (u: UndoEntry) => void;
  popUndo: () => UndoEntry | undefined;
  setDialog: (d: Dialog) => void;
  openComposer: (w: ComposerWindow) => void;
  updateComposer: (id: string, patch: Partial<ComposerWindow> | ((w: ComposerWindow) => Partial<ComposerWindow>)) => void;
  closeComposer: (id: string) => void;
  setSenderPanel: (email: string | null) => void;
  focusSearch: () => void;
  setOnline: (o: boolean) => void;
  setMobileNav: (o: boolean) => void;
  setDragItems: (k: string[] | null) => void;
}

let toastId = 1;
let lastSelected: string | null = null;

export const useUi = create<UiState>((set, get) => ({
  view: { kind: 'mailbox', path: 'INBOX' },
  cursor: null,
  selection: new Set(),
  open: null,
  focusZone: 'list',
  composers: [],
  toasts: [],
  undo: [],
  dialog: null,
  senderPanel: null,
  visibleItems: [],
  searchFocused: 0,
  online: navigator.onLine,
  newCount: 0,
  mobileNav: false,
  dragItems: null,

  setView: (v) => set({ view: v, cursor: null, selection: new Set(), open: null, focusZone: 'list', mobileNav: false }),
  setCursor: (k) => set({ cursor: k }),
  setOpen: (k) => set({ open: k, cursor: k ?? get().cursor, focusZone: k ? 'reader' : 'list' }),
  setFocusZone: (z) => set({ focusZone: z }),
  toggleSelect: (k, range) => {
    const sel = new Set(get().selection);
    if (range && lastSelected) {
      const keys = get().visibleItems.map((i) => i.key);
      const a = keys.indexOf(lastSelected);
      const b = keys.indexOf(k);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) sel.add(keys[i]);
        set({ selection: sel });
        lastSelected = k;
        return;
      }
    }
    if (sel.has(k)) sel.delete(k);
    else sel.add(k);
    lastSelected = k;
    set({ selection: sel });
  },
  clearSelection: () => set({ selection: new Set() }),
  selectAll: () => set({ selection: new Set(get().visibleItems.map((i) => i.key)) }),
  setVisible: (items) => set({ visibleItems: items }),
  pushToast: (t) => {
    const id = toastId++;
    set({ toasts: [...get().toasts.filter((x) => !(t.action && x.action && !x.sticky)).slice(-3), { ...t, id }] });
    if (!t.sticky) setTimeout(() => get().dismissToast(id), t.ttl ?? (t.action ? 7000 : 4000));
    return id;
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  pushUndo: (u) => set({ undo: [...get().undo.slice(-9), u] }),
  popUndo: () => {
    const stack = [...get().undo];
    const u = stack.pop();
    set({ undo: stack });
    return u;
  },
  setDialog: (d) => set({ dialog: d }),
  openComposer: (w) => {
    const existing = get().composers.find((c) => c.id === w.id);
    if (existing) {
      set({ composers: get().composers.map((c) => (c.id === w.id ? { ...c, minimized: false } : c)) });
      return;
    }
    // At most 3 docked composers; minimise the others.
    const others = get().composers.map((c) => ({ ...c, minimized: true }));
    set({ composers: [...others.slice(-2), w] });
  },
  updateComposer: (id, patch) =>
    set({
      composers: get().composers.map((c) => (c.id === id ? { ...c, ...(typeof patch === 'function' ? patch(c) : patch) } : c)),
    }),
  closeComposer: (id) => set({ composers: get().composers.filter((c) => c.id !== id) }),
  setSenderPanel: (email) => set({ senderPanel: email }),
  focusSearch: () => set({ searchFocused: get().searchFocused + 1 }),
  setOnline: (o) => set({ online: o }),
  setMobileNav: (o) => set({ mobileNav: o }),
  setDragItems: (k) => set({ dragItems: k }),
}));

export const ui = () => useUi.getState();
