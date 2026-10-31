import type { MessageStructureObject } from 'imapflow';

/** Map MIME charset labels to WHATWG TextDecoder labels; latin1/ascii/unknown -> windows-1252. */
export function decodeCharset(buf: Buffer, charset?: string): string {
  let label = (charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  if (['iso-8859-1', 'latin1', 'us-ascii', 'ascii', 'iso8859-1', 'ansi_x3.4-1968'].includes(label)) label = 'windows-1252';
  try {
    return new TextDecoder(label, { fatal: false }).decode(buf);
  } catch {
    try {
      return new TextDecoder('utf-8').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

/** Decode a (possibly truncated) transfer-encoded buffer. Safe on partial input. */
export function decodeTransfer(buf: Buffer, encoding?: string): Buffer {
  const enc = (encoding ?? '7bit').toLowerCase();
  if (enc === 'base64') {
    const clean = buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), 'base64');
  }
  if (enc === 'quoted-printable') {
    const s = buf.toString('latin1').replace(/=\r?\n/g, '');
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
        out.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else if (s[i] === '=' && i >= s.length - 2) {
        break; // truncated escape at the end
      } else {
        out.push(s.charCodeAt(i) & 0xff);
      }
    }
    return Buffer.from(out);
  }
  return buf;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', zwnj: '', shy: '' };

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

/** Strip characters that could inject headers or reorder display (C0/C1, bidi controls, line separators). */
export function cleanHeaderValue(s: string): string {
  return s.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, ' ').trim();
}

export function makeSnippet(text: string, max = 180): string {
  return text
    .replace(/^>.*$/gm, ' ') // quoted lines
    .replace(/[\u200B-\u200D\uFEFF\u034F\u00AD]/g, '') // zero-width preheader padding
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export interface PartInfo {
  part: string;
  type: string;
  charset?: string;
  encoding?: string;
  size: number;
}

function isAttachmentNode(n: MessageStructureObject): boolean {
  if (n.disposition === 'attachment') return true;
  const name = n.dispositionParameters?.filename ?? n.parameters?.name;
  return !!name && n.disposition !== 'inline';
}

/** Find the best displayable body parts: html and plain (multipart/alternative: last supported wins). */
export function pickBodyParts(root: MessageStructureObject): { html?: PartInfo; text?: PartInfo } {
  const result: { html?: PartInfo; text?: PartInfo } = {};
  const visit = (n: MessageStructureObject) => {
    const type = n.type.toLowerCase();
    if (type === 'message/rfc822') return; // never descend into attached messages for the main body
    if (n.childNodes?.length) {
      if (type === 'multipart/alternative') {
        // later parts are preferred, so walk in order and let later assignments win
        for (const c of n.childNodes) visit(c);
      } else {
        for (const c of n.childNodes) {
          if (result.html && result.text) break;
          visit(c);
        }
      }
      return;
    }
    if (isAttachmentNode(n)) return;
    const info: PartInfo = {
      part: n.part ?? '1',
      type,
      charset: n.parameters?.charset,
      encoding: n.encoding,
      size: n.size ?? 0,
    };
    if (type === 'text/html') {
      if (!result.html || n.part?.split('.').length === result.html.part.split('.').length) result.html = info;
    } else if (type === 'text/plain') {
      if (!result.text) result.text = info;
    }
  };
  visit(root);
  return result;
}

export interface AttachmentInfo {
  part: string;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
  cid?: string;
}

/** Decode RFC 2231 (incl. continuations already merged by imapflow) and strip dangerous characters. */
export function sanitizeFilename(raw: string | undefined, fallback: string): string {
  let name = (raw ?? '').trim();
  const m2231 = /^([\w-]+)'[\w-]*'(.*)$/.exec(name);
  if (m2231) {
    // Percent-escapes are raw bytes in the declared charset: decode bytes first, then the charset.
    const bytes: number[] = [];
    const enc = m2231[2];
    for (let i = 0; i < enc.length; i++) {
      if (enc[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(enc.slice(i + 1, i + 3))) {
        bytes.push(parseInt(enc.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(enc.charCodeAt(i) & 0xff);
    }
    name = decodeCharset(Buffer.from(bytes), m2231[1]);
  }
  name = name
    .replace(/[\u0000-\u001F\u007F-\u009F"\\/\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 200);
  return name || fallback;
}

export function listAttachments(root: MessageStructureObject, bodyParts: Set<string>): AttachmentInfo[] {
  const out: AttachmentInfo[] = [];
  const visit = (n: MessageStructureObject) => {
    const type = n.type.toLowerCase();
    if (n.childNodes?.length && type.startsWith('multipart/')) {
      n.childNodes.forEach(visit);
      return;
    }
    if (n.part && bodyParts.has(n.part)) return;
    if (type.startsWith('multipart/')) return;
    const isText = type === 'text/plain' || type === 'text/html';
    if (isText && !isAttachmentNode(n)) return; // extra alternative bodies, not attachments
    const ext = type.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'bin';
    out.push({
      part: n.part ?? '1',
      filename: sanitizeFilename(n.dispositionParameters?.filename ?? n.parameters?.name, `attachment-${n.part}.${ext}`),
      contentType: type,
      size: n.size ?? 0,
      inline: n.disposition === 'inline' || (!n.disposition && !!n.id),
      cid: n.id ? n.id.replace(/^<|>$/g, '') : undefined,
    });
  };
  visit(root);
  return out;
}

export function hasRealAttachments(root?: MessageStructureObject): boolean {
  if (!root) return false;
  const parts = pickBodyParts(root);
  const set = new Set([parts.html?.part, parts.text?.part].filter(Boolean) as string[]);
  return listAttachments(root, set).some((a) => !a.cid || !a.inline);
}

/** Sniff raster image types by magic bytes. Anything else is not safe to display inline. */
export function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Content-Disposition with ASCII fallback + RFC 5987 UTF-8 form. */
export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** "Re: Re: Fwd: AW: hello" -> "hello" (used for threading fallbacks and display grouping). */
export function normalizeSubject(s: string): string {
  let prev = '';
  let cur = s.trim();
  while (prev !== cur) {
    prev = cur;
    cur = cur.replace(/^\s*(re|fw|fwd|aw|sv|vs|wg|antw|rif|r|tr)\s*(\[\d+\])?\s*:\s*/i, '').replace(/^\[[^\]]{1,40}\]\s*/, '');
  }
  return cur.trim().toLowerCase();
}

const MSGID_RE = /<[^<>\s]{1,250}@[^<>\s]{1,250}>/g;
export function parseMessageIds(v: string | undefined | null): string[] {
  if (!v) return [];
  return Array.from(v.matchAll(MSGID_RE), (m) => m[0]);
}
