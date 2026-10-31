import type { Address } from '../api/types';

const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;

/** List timestamps: 14:05 today, "Tue" this week, "Mar 4" this year, "3/4/24" older. */
export function listDate(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const n = new Date(now);
  const sameDay = d.toDateString() === n.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const days = (n.getTime() - d.getTime()) / 86_400_000;
  if (days < 6 && days > 0) return d.toLocaleDateString(undefined, { weekday: 'short' });
  if (d.getFullYear() === n.getFullYear()) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { year: '2-digit', month: 'numeric', day: 'numeric' });
}

export function fullDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function relative(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (!rtf) return fullDate(ms);
  if (abs < 60_000) return 'just now';
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  if (abs < 30 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), 'day');
  return listDate(ms, now);
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

const BIDI = /[‎‏‪-‮⁦-⁩]/g;
export const clean = (s: string) => s.replace(BIDI, '');

export function displayName(a: Address | undefined, me?: Set<string>): string {
  if (!a) return '(unknown sender)';
  if (me?.has(a.address)) return 'me';
  const name = clean(a.name || '').trim();
  if (name) return name;
  return a.address.split('@')[0] || a.address;
}

export function firstName(a: Address, me?: Set<string>): string {
  const n = displayName(a, me);
  if (n === 'me' || n.includes('@')) return n;
  return n.split(/\s+/)[0];
}

export function initials(a: Address | undefined): string {
  if (!a) return '?';
  const n = clean(a.name || a.address).replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  const parts = n.split(/\s+/).filter(Boolean);
  if (!parts.length) return a.address[0]?.toUpperCase() ?? '?';
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Stable hue per address for avatars (lightness/chroma come from the theme in CSS). */
export function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Phishing tells in a sender: display name containing an address that differs from the real one. */
export function senderWarning(a: Address | undefined): string | null {
  if (!a) return null;
  const name = clean(a.name || '');
  const m = /[\w.+-]+@[\w-]+(\.[\w-]+)+/.exec(name);
  if (m && m[0].toLowerCase() !== a.address.toLowerCase()) {
    return `The name says ${m[0]} but this was sent from ${a.address}`;
  }
  const domain = a.address.split('@')[1] ?? '';
  if (/xn--/.test(domain)) return `The sender's domain uses look-alike characters (${domain})`;
  return null;
}

export function linkMismatch(text: string, href: string): boolean {
  const m = /^\s*(https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})(\/\S*)?\s*$/i.exec(text);
  if (!m) return false;
  try {
    const shown = m[2].toLowerCase().replace(/^www\./, '');
    const real = new URL(href).hostname.toLowerCase().replace(/^www\./, '');
    return shown !== real && !real.endsWith(`.${shown}`);
  } catch {
    return false;
  }
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function uuid(): string {
  return crypto.randomUUID();
}
