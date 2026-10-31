/**
 * Themes are plain data so Settings can preview them as swatches and admins can reference the
 * token names from custom CSS (see docs/THEMING.md). Every text token is checked against its
 * surfaces for WCAG AA by scripts/check-contrast.mjs.
 */
export interface ThemeTokens {
  bg: string; // app background behind panels
  surface: string; // list + reader panels
  sunken: string; // sidebar
  raised: string; // menus, dialogs, composer
  border: string;
  text: string;
  text2: string; // secondary text (snippets, meta)
  text3: string; // tertiary (timestamps, hints) — still >= 4.5:1 on surface
  accent: string;
  accentText: string; // text on accent fills
  unread: string;
  danger: string;
  warn: string;
  ok: string;
  star: string;
}

export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  description: string;
  tokens: ThemeTokens;
}

export const THEMES: Theme[] = [
  {
    id: 'daylight',
    name: 'Daylight',
    dark: false,
    description: 'Crisp and neutral',
    tokens: {
      bg: '#eef0f3', surface: '#ffffff', sunken: '#f6f7f9', raised: '#ffffff', border: '#e3e5ea',
      text: '#14161b', text2: '#4c515c', text3: '#686e7a', accent: '#4f46e5', accentText: '#ffffff',
      unread: '#4f46e5', danger: '#c62828', warn: '#a15c00', ok: '#1b7f4b', star: '#b7791f',
    },
  },
  {
    id: 'paper',
    name: 'Paper',
    dark: false,
    description: 'Warm, easy on the eyes',
    tokens: {
      bg: '#ebe5da', surface: '#fbf8f2', sunken: '#f3eee5', raised: '#fffdf8', border: '#e0d8ca',
      text: '#25211b', text2: '#544b3f', text3: '#6b6153', accent: '#b4400f', accentText: '#ffffff',
      unread: '#b4400f', danger: '#b42318', warn: '#8a5300', ok: '#2f6b3a', star: '#9a6700',
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    dark: false,
    description: 'The classic, in light',
    tokens: {
      bg: '#eee8d5', surface: '#fdf6e3', sunken: '#f6efda', raised: '#fffbee', border: '#e3dbc3',
      text: '#073642', text2: '#3f5a62', text3: '#56686e', accent: '#1d6fae', accentText: '#ffffff',
      unread: '#1d6fae', danger: '#b8261f', warn: '#7d5f00', ok: '#4f6b00', star: '#8a6d00',
    },
  },
  {
    id: 'rose-dawn',
    name: 'Rosé Dawn',
    dark: false,
    description: 'Soft pastels, low glare',
    tokens: {
      bg: '#f2e9e1', surface: '#fffaf3', sunken: '#faf4ed', raised: '#fffdf9', border: '#eadfd5',
      text: '#3a3556', text2: '#57527a', text3: '#6c6789', accent: '#a04f4c', accentText: '#ffffff',
      unread: '#a04f4c', danger: '#a8324a', warn: '#8a5a12', ok: '#2f6f6a', star: '#9a6a12',
    },
  },
  {
    id: 'contrast-light',
    name: 'High Contrast Light',
    dark: false,
    description: 'Maximum legibility',
    tokens: {
      bg: '#ffffff', surface: '#ffffff', sunken: '#f3f3f3', raised: '#ffffff', border: '#1a1a1a',
      text: '#000000', text2: '#1a1a1a', text3: '#333333', accent: '#0033cc', accentText: '#ffffff',
      unread: '#0033cc', danger: '#a30000', warn: '#6b4100', ok: '#00602b', star: '#6b4100',
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    dark: true,
    description: 'Deep focus, after dark',
    tokens: {
      bg: '#07080d', surface: '#0f1118', sunken: '#0b0d13', raised: '#171a24', border: '#1f2331',
      text: '#e9ebf3', text2: '#aab0c3', text3: '#8b91a6', accent: '#9a8cff', accentText: '#0b0a1a',
      unread: '#9a8cff', danger: '#ff7a7a', warn: '#f2b552', ok: '#5fd39a', star: '#f2c14e',
    },
  },
  {
    id: 'carbon',
    name: 'Carbon',
    dark: true,
    description: 'Neutral graphite',
    tokens: {
      bg: '#101013', surface: '#19191d', sunken: '#141417', raised: '#222228', border: '#2b2b32',
      text: '#ececf1', text2: '#b0b0bb', text3: '#8f8f9b', accent: '#8f75ff', accentText: '#0d0820',
      unread: '#8f75ff', danger: '#ff7b7b', warn: '#f0b45a', ok: '#61d095', star: '#f0c14e',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    dark: true,
    description: 'Arctic, calm blues',
    tokens: {
      bg: '#272c36', surface: '#2e3440', sunken: '#2a2f3a', raised: '#3b4252', border: '#3f4758',
      text: '#eceff4', text2: '#c9d0dc', text3: '#aab3c2', accent: '#88c0d0', accentText: '#1b222c',
      unread: '#88c0d0', danger: '#f0a3aa', warn: '#ebcb8b', ok: '#a3be8c', star: '#ebcb8b',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    dark: true,
    description: 'The classic, in dark',
    tokens: {
      bg: '#00212a', surface: '#002b36', sunken: '#00262f', raised: '#073642', border: '#0f4553',
      text: '#eee8d5', text2: '#a9b6b6', text3: '#93a1a1', accent: '#35b8ad', accentText: '#00141a',
      unread: '#35b8ad', danger: '#f0716b', warn: '#d4a017', ok: '#9bb300', star: '#d4a017',
    },
  },
  {
    id: 'rose',
    name: 'Rosé',
    dark: true,
    description: 'Muted dusk violets',
    tokens: {
      bg: '#1b1a2b', surface: '#232136', sunken: '#1f1d30', raised: '#2a273f', border: '#393552',
      text: '#e0def4', text2: '#bdb9d8', text3: '#9a96b6', accent: '#ea9a97', accentText: '#201627',
      unread: '#ea9a97', danger: '#eb6f92', warn: '#f6c177', ok: '#9ccfd8', star: '#f6c177',
    },
  },
  {
    id: 'forest',
    name: 'Forest',
    dark: true,
    description: 'Evergreen and quiet',
    tokens: {
      bg: '#0a110e', surface: '#111b17', sunken: '#0d1512', raised: '#182520', border: '#22332c',
      text: '#e3efe8', text2: '#a8bdb2', text3: '#89a094', accent: '#5bd68f', accentText: '#04180c',
      unread: '#5bd68f', danger: '#ff8a80', warn: '#e9c46a', ok: '#5bd68f', star: '#e9c46a',
    },
  },
  {
    id: 'contrast-dark',
    name: 'High Contrast Dark',
    dark: true,
    description: 'Maximum legibility, dark',
    tokens: {
      bg: '#000000', surface: '#000000', sunken: '#0b0b0b', raised: '#0b0b0b', border: '#e6e6e6',
      text: '#ffffff', text2: '#f2f2f2', text3: '#d6d6d6', accent: '#ffd60a', accentText: '#000000',
      unread: '#ffd60a', danger: '#ff8f8f', warn: '#ffd60a', ok: '#7dffb0', star: '#ffd60a',
    },
  },
];

export const ACCENTS = ['#6d4aff', '#2563eb', '#0891b2', '#0d9488', '#16a34a', '#ca8a04', '#ea580c', '#dc2626', '#db2777', '#9333ea'];

function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
