import type { Address, ComposeState, FullMessage, Identity } from '../api/types';
import { settings } from '../state/settings';
import { fullDate, uuid } from './format';
import { sanitizeForComposer } from './sanitize';

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function textToHtml(s: string) {
  return escapeHtml(s)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function htmlToPlain(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  doc.querySelectorAll('p, div, li, h1, h2, h3, blockquote').forEach((el) => el.append('\n'));
  doc.querySelectorAll('li').forEach((el) => el.prepend('• '));
  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') ?? '';
    if (href && a.textContent && a.textContent.trim() !== href && !href.startsWith('mailto:')) a.append(` <${href}>`);
  });
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

const PREFIX = /^\s*((re|fw|fwd|aw|sv|vs|wg|antw|tr|rif)\s*(\[\d+\])?\s*:\s*)+/i;
export const baseSubject = (s: string) => s.replace(PREFIX, '').trim();
export const replySubject = (s: string) => `Re: ${baseSubject(s)}`;
export const forwardSubject = (s: string) => `Fwd: ${baseSubject(s)}`;

/** Pick the identity the original was addressed to (alias-aware), else the default. */
export function pickIdentity(msg: FullMessage | null, identities: Identity[], fallback: string): string {
  const mine = new Set(identities.map((i) => i.email.toLowerCase()));
  if (msg) {
    const candidates = [...msg.deliveredTo, ...msg.to.map((a) => a.address), ...msg.cc.map((a) => a.address)];
    for (const c of candidates) if (mine.has(c.toLowerCase())) return c.toLowerCase();
  }
  return identities.find((i) => i.isDefault)?.email ?? identities[0]?.email ?? fallback;
}

function dedupe(list: Address[], exclude: Set<string>): Address[] {
  const seen = new Set<string>();
  return list.filter((a) => {
    const k = a.address.toLowerCase();
    if (exclude.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function signatureFor(email: string, identities: Identity[]): string {
  const sig = identities.find((i) => i.email === email)?.signatureHtml;
  return sig ? `<p></p><div data-signature="true">${sanitizeForComposer(sig)}</div>` : '';
}

function quoteHeader(msg: FullMessage) {
  const f = msg.from[0];
  const who = f ? (f.name ? `${escapeHtml(f.name)} &lt;${escapeHtml(f.address)}&gt;` : escapeHtml(f.address)) : 'someone';
  return `On ${escapeHtml(fullDate(msg.date))}, ${who} wrote:`;
}

function quoteHeaderText(msg: FullMessage) {
  const f = msg.from[0];
  const who = f ? (f.name ? `${f.name} <${f.address}>` : f.address) : 'someone';
  return `On ${fullDate(msg.date)}, ${who} wrote:`;
}

function quotedBody(msg: FullMessage): { html: string; text: string } {
  const html = msg.html ? sanitizeForComposer(msg.html) : textToHtml(msg.text ?? '');
  const text = msg.text ?? htmlToPlain(msg.html ?? '');
  return { html, text };
}

export interface ComposeSeed {
  state: ComposeState;
  quotedHtml?: string;
  quotedText?: string;
  bodyHtml: string;
  forwardFiles?: { part: string; filename: string; size: number }[];
}

export function newCompose(identities: Identity[], me: string, to: Address[] = [], subject = '', body = ''): ComposeSeed {
  const from = pickIdentity(null, identities, me);
  return {
    state: {
      draftId: uuid(),
      from,
      to,
      cc: [],
      bcc: [],
      subject,
      text: '',
      attachments: [],
      kind: 'new',
      requestReceipt: false,
      delaySeconds: settings().undoSendSeconds,
    },
    bodyHtml: (body ? textToHtml(body) : '<p></p>') + signatureFor(from, identities),
  };
}

export function replyCompose(msg: FullMessage, all: boolean, identities: Identity[], me: string, selection?: string): ComposeSeed {
  const mine = new Set([me.toLowerCase(), ...identities.map((i) => i.email.toLowerCase())]);
  const from = pickIdentity(msg, identities, me);
  const fromMe = msg.from.some((a) => mine.has(a.address));
  let to: Address[] = fromMe ? msg.to : msg.replyTo.length ? msg.replyTo : msg.from;
  let cc: Address[] = [];
  if (all) {
    cc = dedupe([...(fromMe ? [] : msg.to), ...msg.cc], new Set([...mine, ...to.map((a) => a.address.toLowerCase())]));
  }
  to = dedupe(to, fromMe ? new Set() : mine);
  if (!to.length && msg.from[0]) to = [msg.from[0]];
  const q = quotedBody(msg);
  const header = quoteHeader(msg);
  const sel = selection?.trim();
  const quoteHtml = sel ? `<p>${header}</p><blockquote type="cite">${textToHtml(sel)}</blockquote>` : `<p>${header}</p><blockquote type="cite">${q.html}</blockquote>`;
  const quoteText = `${quoteHeaderText(msg)}\n${(sel ?? q.text)
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')}`;
  return {
    state: {
      draftId: uuid(),
      from,
      to,
      cc,
      bcc: [],
      subject: replySubject(msg.subject),
      text: '',
      attachments: [],
      kind: all ? 'replyAll' : 'reply',
      inReplyTo: { mailbox: msg.mailbox, uidValidity: msg.uidValidity, uid: msg.uid },
      requestReceipt: false,
      delaySeconds: settings().undoSendSeconds,
    },
    bodyHtml: `<p></p>${signatureFor(from, identities)}`,
    quotedHtml: quoteHtml,
    quotedText: quoteText,
  };
}

export function forwardCompose(msg: FullMessage, identities: Identity[], me: string): ComposeSeed {
  const from = pickIdentity(msg, identities, me);
  const q = quotedBody(msg);
  const list = (l: Address[]) => l.map((a) => (a.name ? `${escapeHtml(a.name)} &lt;${escapeHtml(a.address)}&gt;` : escapeHtml(a.address))).join(', ');
  const header =
    `<p>---------- Forwarded message ----------<br>From: ${list(msg.from)}<br>Date: ${escapeHtml(fullDate(msg.date))}<br>Subject: ${escapeHtml(msg.subject)}<br>To: ${list(msg.to)}` +
    (msg.cc.length ? `<br>Cc: ${list(msg.cc)}` : '') +
    '</p>';
  const fwd = msg.attachments.filter((a) => !(a.inline && a.cid));
  const parts = fwd.map((a) => a.part);
  return {
    state: {
      draftId: uuid(),
      from,
      to: [],
      cc: [],
      bcc: [],
      subject: forwardSubject(msg.subject),
      text: '',
      attachments: [],
      kind: 'forward',
      inReplyTo: { mailbox: msg.mailbox, uidValidity: msg.uidValidity, uid: msg.uid },
      forwardAttachments: parts.length ? { mailbox: msg.mailbox, uidValidity: msg.uidValidity, uid: msg.uid, parts } : undefined,
      requestReceipt: false,
      delaySeconds: settings().undoSendSeconds,
    },
    bodyHtml: `<p></p>${signatureFor(from, identities)}`,
    quotedHtml: `${header}${q.html}`,
    forwardFiles: fwd.map((a) => ({ part: a.part, filename: a.filename, size: a.size })),
    quotedText: `---------- Forwarded message ----------\nFrom: ${msg.from.map((a) => a.address).join(', ')}\nDate: ${fullDate(msg.date)}\nSubject: ${msg.subject}\n\n${q.text}`,
  };
}

/** "Forgot the attachment?" — mentions an attachment but has none. */
export function mentionsAttachment(text: string): boolean {
  const own = text.split(/\n>|On .+ wrote:/)[0];
  return /\b(attach(ed|ment|ing)?|enclosed|see the (file|document)|angehängt|anbei|pièce jointe|adjunto|in allegato|bijlage)\b/i.test(own);
}

/** Parse a pasted "a@b.com, Name <c@d.com>; e@f" list into addresses. */
export function parseAddressList(s: string): Address[] {
  const out: Address[] = [];
  const seen = new Set<string>();
  // "Last, First" <a@b>  |  Name <a@b>  |  a@b   (quoted names may contain commas)
  const re = /(?:"([^"]*)"\s*<([^<>\s]+@[^<>\s]+)>|([^"<>,;\n]*?)\s*<([^<>\s]+@[^<>\s]+)>|([^\s<>,;"]+@[^\s<>,;"]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const address = (m[2] ?? m[4] ?? m[5]).trim();
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: (m[1] ?? m[3] ?? '').trim(), address });
  }
  return out;
}

export const isEmail = (s: string) => /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]{2,}$/.test(s.trim());
