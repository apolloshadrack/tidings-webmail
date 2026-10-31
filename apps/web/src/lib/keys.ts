/**
 * Keyboard engine. Matches on event.key (layout-aware), supports two-key sequences ("g i") with a 1s
 * timeout, ignores keystrokes while typing (except a few global combos), and is the single source
 * of truth for the command palette and the "?" cheat sheet.
 */
export interface Command {
  id: string;
  title: string;
  group: 'Navigate' | 'Triage' | 'Compose' | 'View' | 'Go to' | 'App';
  keys?: string[]; // e.g. ['e'], ['g', 'i'] means sequence "g then i"; alternatives in `alt`
  alt?: string[][];
  when?: () => boolean;
  run: () => void;
  /** Shown in the palette only (no shortcut) */
  paletteOnly?: boolean;
  keywords?: string;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';

export function describeKey(k: string): string {
  if (/^[A-Z]$/.test(k)) return `⇧${k}`;
  return k
    .replace('mod+', `${MOD}+`)
    .replace('shift+', '⇧')
    .replace('Enter', '↵')
    .replace('Escape', 'Esc')
    .replace('ArrowDown', '↓')
    .replace('ArrowUp', '↑')
    .replace('Backspace', '⌫')
    .replace('Delete', 'Del');
}

export function normalize(e: KeyboardEvent): string {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod || e.altKey) {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    return `${mod ? 'mod+' : ''}${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}${key}`;
  }
  // event.key already reflects Shift and the keyboard layout ("I", "#", "?"); undo Caps Lock for letters.
  if (e.key.length === 1 && /[a-z]/i.test(e.key) && e.getModifierState?.('CapsLock')) return e.shiftKey ? e.key.toUpperCase() : e.key.toLowerCase();
  return e.key;
}

function typingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

const GLOBAL_WHILE_TYPING = new Set(['mod+k', 'mod+shift+k', 'mod+Enter', 'mod+/']);

let commands: Command[] = [];
let enabled = true;
let pending: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

export function registerCommands(list: Command[]) {
  commands = list;
  listeners.forEach((l) => l());
}

export function getCommands() {
  return commands;
}

export function onCommandsChanged(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setShortcutsEnabled(v: boolean) {
  enabled = v;
}

export function pendingPrefix() {
  return pending;
}

function sequences(c: Command): string[][] {
  return [c.keys ?? [], ...(c.alt ?? [])].filter((s) => s.length);
}

export function handleKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing) return;
  const key = normalize(e);
  const typing = typingTarget(e);
  if (typing && !GLOBAL_WHILE_TYPING.has(key)) return;
  if (!enabled && !GLOBAL_WHILE_TYPING.has(key)) return;
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;

  const active = commands.filter((c) => !c.when || c.when());
  if (pending) {
    const seq = [pending, key];
    pending = null;
    clearTimeout(pendingTimer);
    const hit = active.find((c) => sequences(c).some((s) => s.length === 2 && s[0] === seq[0] && s[1] === seq[1]));
    if (hit) {
      e.preventDefault();
      hit.run();
      return;
    }
  }
  const single = active.find((c) => sequences(c).some((s) => s.length === 1 && s[0] === key));
  const startsSeq = active.some((c) => sequences(c).some((s) => s.length === 2 && s[0] === key));
  if (startsSeq && !single) {
    pending = key;
    pendingTimer = setTimeout(() => (pending = null), 1000);
    e.preventDefault();
    return;
  }
  if (single) {
    e.preventDefault();
    single.run();
  }
}
