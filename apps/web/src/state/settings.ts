import { create } from 'zustand';
import { api } from '../api/client';
import { THEMES, contrast, themeById } from '../styles/themes';

export interface SplitTab {
  id: string;
  name: string;
  query: string; // search operators applied within the Inbox
}

export interface Settings {
  themeMode: 'single' | 'system';
  theme: string; // used when themeMode = single
  lightTheme: string;
  darkTheme: string;
  accent: string | null;
  density: 'comfortable' | 'cozy' | 'compact';
  fontSize: 13 | 14 | 15 | 16;
  font: 'inter' | 'system';
  layout: 'columns' | 'rows' | 'list';
  showSnippets: boolean;
  showAvatars: boolean;
  conversations: boolean;
  afterAction: 'next' | 'previous' | 'list';
  markReadDelay: number; // ms; -1 = manual
  undoSendSeconds: number;
  remoteImages: 'ask' | 'trusted' | 'always';
  stripTracking: boolean;
  confirmLinks: boolean;
  shortcuts: boolean;
  splitTabs: SplitTab[];
  splitInbox: boolean;
  defaultReply: 'reply' | 'replyAll';
  quotePosition: 'top' | 'bottom';
  composeMode: 'rich' | 'plain';
  desktopNotifications: boolean;
  notificationPreview: boolean;
  sidebarCollapsed: boolean;
  favorites: string[]; // folder paths pinned in the sidebar
  listWidth: number;
  reduceMotion: 'system' | 'on' | 'off';
}

export const DEFAULT_SETTINGS: Settings = {
  themeMode: 'system',
  theme: 'daylight',
  lightTheme: 'daylight',
  darkTheme: 'midnight',
  accent: null,
  density: 'cozy',
  fontSize: 14,
  font: 'inter',
  layout: 'columns',
  showSnippets: true,
  showAvatars: true,
  conversations: true,
  afterAction: 'next',
  markReadDelay: 800,
  undoSendSeconds: 10,
  remoteImages: 'ask',
  stripTracking: true,
  confirmLinks: true,
  shortcuts: true,
  splitInbox: true,
  splitTabs: [
    { id: 'important', name: 'Important', query: '-is:newsletter' },
    { id: 'newsletters', name: 'Newsletters', query: 'is:newsletter' },
  ],
  defaultReply: 'reply',
  quotePosition: 'top',
  composeMode: 'rich',
  desktopNotifications: false,
  notificationPreview: true,
  sidebarCollapsed: false,
  favorites: [],
  listWidth: 420,
  reduceMotion: 'system',
};

const LOCAL_KEY = 'tidings.settings.v1';

function readLocal(): Partial<Settings> {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}');
  } catch {
    return {};
  }
}

interface SettingsStore {
  s: Settings;
  set: (patch: Partial<Settings>) => void;
  hydrate: (server: Partial<Settings> | null) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const useSettings = create<SettingsStore>((set, get) => ({
  s: { ...DEFAULT_SETTINGS, ...readLocal() },
  set: (patch) => {
    const next = { ...get().s, ...patch };
    set({ s: next });
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(next));
    } catch {
      /* storage may be unavailable */
    }
    applyAppearance(next);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void api('/api/settings', { method: 'PUT', body: next }).catch(() => undefined);
    }, 600);
  },
  hydrate: (server) => {
    const next = { ...DEFAULT_SETTINGS, ...readLocal(), ...(server ?? {}) };
    set({ s: next });
    applyAppearance(next);
  },
}));

export const settings = () => useSettings.getState().s;

// ---------------------------------------------------------------------------
// Appearance: theme tokens -> CSS custom properties on <html>.

const media = window.matchMedia('(prefers-color-scheme: dark)');
let brandAccent: string | null = null;
/** Admin-configured default accent (TIDINGS_BRAND_ACCENT), used until the user picks one. */
export function setBrandAccent(a: string | null | undefined) {
  brandAccent = a && /^#[0-9a-f]{6}$/i.test(a) ? a : null;
  applyAppearance(useSettings.getState().s);
}
media.addEventListener('change', () => applyAppearance(settings()));
window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => applyAppearance(settings()));

function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

export function activeThemeId(s: Settings): string {
  if (s.themeMode === 'system') return media.matches ? s.darkTheme : s.lightTheme;
  return s.theme;
}

export function applyAppearance(s: Settings) {
  // Suppress colour transitions for one frame so a theme switch never renders half-swapped.
  document.documentElement.classList.add('theme-switching');
  requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('theme-switching')));
  const theme = themeById(activeThemeId(s));
  const t = { ...theme.tokens };
  const accentChoice = s.accent ?? brandAccent;
  if (accentChoice && /^#[0-9a-f]{6}$/i.test(accentChoice)) {
    // Keep a custom accent legible: nudge it toward the text colour until it reads as text on every panel.
    let accent = accentChoice;
    for (let i = 0; i < 12 && Math.min(contrast(accent, t.surface), contrast(accent, t.sunken), contrast(accent, t.raised)) < 4.5; i++) {
      accent = mix(accent, t.text, 0.12);
    }
    t.accent = accent;
    t.unread = accent;
    t.accentText = contrast(accent, '#ffffff') >= contrast(accent, '#0b0b10') ? '#ffffff' : '#0b0b10';
  }
  const root = document.documentElement;
  const vars: Record<string, string> = {
    '--bg': t.bg,
    '--surface': t.surface,
    '--sunken': t.sunken,
    '--raised': t.raised,
    '--border': t.border,
    '--text': t.text,
    '--text-2': t.text2,
    '--text-3': t.text3,
    '--accent': t.accent,
    '--accent-text': t.accentText,
    '--unread': t.unread,
    '--danger': t.danger,
    '--warn': t.warn,
    '--ok': t.ok,
    '--star': t.star,
    '--fs': `${s.fontSize}px`,
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.theme = theme.id;
  root.dataset.dark = theme.dark ? 'true' : 'false';
  root.dataset.density = s.density;
  root.dataset.font = s.font;
  root.dataset.layout = s.layout;
  root.dataset.motion = s.reduceMotion === 'system' ? (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'full') : s.reduceMotion === 'on' ? 'reduce' : 'full';
  root.style.colorScheme = theme.dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]') ?? Object.assign(document.createElement('meta'), { name: 'theme-color' });
  meta.setAttribute('content', t.sunken);
  if (!meta.parentNode) document.head.appendChild(meta);
}

export { THEMES };
