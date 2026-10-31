import DOMPurify from 'dompurify';
import { BASE } from '../api/client';

/**
 * Untrusted mail HTML -> safe srcdoc for a sandboxed iframe.
 *
 * Enforcement is layered:
 *  1. DOMPurify (same parser that renders) with a strict allow-list
 *  2. iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" (no scripts, ever)
 *  3. a meta CSP inside the document that blocks every remote load unless images were allowed,
 *     in which case only our signed image proxy is reachable
 */

export const IFRAME_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';

const FORBID_TAGS = [
  'form', 'input', 'button', 'select', 'textarea', 'option', 'meta', 'link', 'base', 'script', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'svg', 'math', 'template', 'noscript', 'portal', 'dialog', 'video', 'audio', 'source', 'track',
  'picture', 'title', 'head',
];
const FORBID_ATTR = ['srcset', 'ping', 'action', 'formaction', 'poster', 'lowsrc', 'dynsrc', 'xlink:href', 'autofocus', 'contenteditable', 'tabindex', 'accesskey'];

const TRACKER_HOSTS = [
  /(^|\.)list-manage\.com$/, /(^|\.)sendgrid\.net$/, /(^|\.)mailgun\.org$/, /(^|\.)mandrillapp\.com$/, /(^|\.)sparkpostmail\.com$/,
  /(^|\.)hubspotemail\.net$/, /(^|\.)hs-analytics\.net$/, /(^|\.)google-analytics\.com$/, /(^|\.)doubleclick\.net$/, /(^|\.)klaviyomail\.com$/,
  /(^|\.)mixpanel\.com$/, /(^|\.)mailtrack\.io$/, /(^|\.)yesware\.com$/, /(^|\.)bananatag\.com$/, /(^|\.)streak\.com$/, /(^|\.)mlsend\.com$/,
  /(^|\.)cmail\d+\.com$/, /(^|\.)exct\.net$/, /(^|\.)pstmrk\.it$/, /(^|\.)customeriomail\.com$/, /(^|\.)intercom-mail\.com$/,
];
const TRACKER_PATH = /(\/(open|track|tracking|pixel|beacon|wf\/open|o\.gif|e\/o|t\.gif|imp)\b|[?&](open|track)=|\/trk\b)/i;
const TRACKING_PARAMS = /^(utm_[a-z]+|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|fbclid|gclid|dclid|msclkid|yclid|igshid|oly_[a-z]+|vero_[a-z]+|ck_subscriber_id)$/i;

export interface SanitizeOptions {
  allowImages: boolean;
  proxyMap?: Record<string, string>; // original url -> signed proxy url
  cidMap?: Record<string, string>; // content-id -> blob url
  stripTracking: boolean;
  theme: { dark: boolean; text: string; surface: string; accent: string; text2: string; border: string; fontSize: number };
  colorMode: 'auto' | 'original' | 'dark';
}

export interface SanitizeResult {
  srcdoc: string;
  remoteImages: string[];
  trackers: number;
  cleanedLinks: number;
  hasOwnColors: boolean;
  blockedImages: number;
}

function isTracker(url: URL, el?: Element): boolean {
  const w = Number(el?.getAttribute('width') ?? NaN);
  const h = Number(el?.getAttribute('height') ?? NaN);
  const style = (el?.getAttribute('style') ?? '').replace(/\s/g, '').toLowerCase();
  const tiny = (w > 0 && w <= 3) || (h > 0 && h <= 3) || /(width|height):[0-3]px/.test(style) || /display:none|visibility:hidden|opacity:0/.test(style);
  return tiny || TRACKER_HOSTS.some((r) => r.test(url.hostname)) || TRACKER_PATH.test(url.pathname + url.search);
}

const IMAGE_FN = /\b(url|image-set|-webkit-image-set|image|cross-fade|element|paint)\s*\(/i;
const BANNED_PROP = /^(behavior|-moz-binding|-ms-behavior)$/i;
const inertDoc = document.implementation.createHTMLDocument('');

/**
 * CSS is sanitised through the CSSOM: the browser parses (and unescapes) it, so tricks like
 * `\75 rl(...)` or `image-set(...)` are seen for what they are. Any image-loading function is
 * dropped unless every url() in it rewrites to a signed proxy URL. Rules that only apply on
 * interaction or in @media / @supports (tracking vectors) never load anything.
 */
function cleanDecls(style: CSSStyleDeclaration, rewriteUrl: (u: string) => string | null, noLoads: boolean) {
  for (const prop of [...style]) {
    const value = style.getPropertyValue(prop);
    if (BANNED_PROP.test(prop) || /expression\s*\(/i.test(value)) {
      style.removeProperty(prop);
      continue;
    }
    if (prop === 'position' && /fixed|sticky/i.test(value)) {
      style.setProperty(prop, 'static');
      continue;
    }
    if (!IMAGE_FN.test(value)) continue;
    const onlyUrls = !/\b(image-set|-webkit-image-set|image|cross-fade|element|paint)\s*\(/i.test(value);
    if (noLoads || !onlyUrls) {
      style.removeProperty(prop);
      continue;
    }
    let ok = true;
    const rewritten = value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_m, _q, u: string) => {
      const r = rewriteUrl(u.trim());
      if (!r) ok = false;
      return r ? `url("${r.replace(/"/g, '%22')}")` : 'none';
    });
    if (ok && !IMAGE_FN.test(rewritten.replace(/url\("[^"]*"\)/g, ''))) style.setProperty(prop, rewritten, style.getPropertyPriority(prop));
    else style.removeProperty(prop);
  }
}

function cleanRules(rules: CSSRuleList, rewriteUrl: (u: string) => string | null, noLoads: boolean): string {
  const out: string[] = [];
  for (const rule of [...rules]) {
    if (rule instanceof CSSStyleRule) {
      const interactive = /:(hover|active|focus|focus-within|visited|target|checked)/i.test(rule.selectorText);
      cleanDecls(rule.style, rewriteUrl, noLoads || interactive);
      if (rule.style.length) out.push(rule.cssText);
    } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
      const inner = cleanRules(rule.cssRules, rewriteUrl, true);
      if (inner) out.push(`${rule instanceof CSSMediaRule ? `@media ${rule.conditionText}` : `@supports ${rule.conditionText}`} {${inner}}`);
    } else if (rule instanceof CSSKeyframesRule) {
      for (const k of [...rule.cssRules]) if (k instanceof CSSKeyframeRule) cleanDecls(k.style, rewriteUrl, true);
      out.push(rule.cssText);
    }
    // @import, @font-face, @namespace, @layer, @page and anything unknown are dropped.
  }
  return out.join('\n');
}

function cleanStylesheet(css: string, rewriteUrl: (u: string) => string | null): string {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css.replace(/@import[^;]*;?/gi, ''));
    return cleanRules(sheet.cssRules, rewriteUrl, false);
  } catch {
    return '';
  }
}

function cleanStyleAttr(css: string, rewriteUrl: (u: string) => string | null): string {
  const el = inertDoc.createElement('div');
  el.setAttribute('style', css);
  cleanDecls(el.style, rewriteUrl, false);
  return el.style.cssText;
}

export function sanitizeEmail(html: string, opts: SanitizeOptions): SanitizeResult {
  const remote = new Set<string>();
  let trackers = 0;
  let cleanedLinks = 0;
  let blocked = 0;

  const rewriteImg = (raw: string, el?: Element): string | null => {
    if (raw.startsWith('cid:')) {
      const id = decodeURIComponent(raw.slice(4)).replace(/^<|>$/g, '');
      return opts.cidMap?.[id] ?? null;
    }
    if (raw.startsWith('data:image/') && !raw.startsWith('data:image/svg')) return raw;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (isTracker(url, el)) {
      trackers++;
      return null; // trackers are never loaded, even when images are allowed
    }
    remote.add(url.toString());
    if (!opts.allowImages) {
      blocked++;
      return null;
    }
    return opts.proxyMap?.[url.toString()] ?? null;
  };

  const purify = DOMPurify();
  purify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && node.textContent) node.textContent = cleanStylesheet(node.textContent, (u) => rewriteImg(u));
  });
  purify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (el.hasAttribute('style')) {
      const cleaned = cleanStyleAttr(el.getAttribute('style') ?? '', (u) => rewriteImg(u, el));
      if (cleaned) el.setAttribute('style', cleaned);
      else el.removeAttribute('style');
    }
    if (el.hasAttribute('background')) {
      const r = rewriteImg(el.getAttribute('background') ?? '', el);
      if (r) el.setAttribute('background', r);
      else el.removeAttribute('background');
    }
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') ?? '';
      const r = rewriteImg(src, el);
      if (r) el.setAttribute('src', r);
      else {
        el.removeAttribute('src');
        if (src && !src.startsWith('cid:')) el.setAttribute('data-blocked', '');
      }
      el.setAttribute('loading', 'lazy');
      el.setAttribute('referrerpolicy', 'no-referrer');
    }
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? '';
      if (!/^(https?:|mailto:|tel:)/i.test(href)) {
        el.removeAttribute('href');
      } else {
        if (opts.stripTracking && /^https?:/i.test(href)) {
          try {
            const u = new URL(href);
            let changed = false;
            for (const k of [...u.searchParams.keys()]) {
              if (TRACKING_PARAMS.test(k)) {
                u.searchParams.delete(k);
                changed = true;
              }
            }
            if (changed) {
              cleanedLinks++;
              el.setAttribute('href', u.toString());
            }
          } catch {
            el.removeAttribute('href');
          }
        }
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
  });

  const body = purify.sanitize(html, {
    WHOLE_DOCUMENT: false,
    FORBID_TAGS,
    FORBID_ATTR,
    ADD_TAGS: ['style', 'center', 'font', 'details', 'summary'],
    ADD_ATTR: ['target', 'bgcolor', 'background', 'align', 'valign', 'cellpadding', 'cellspacing', 'border', 'color', 'face', 'size', 'width', 'height'],
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|cid:|data:image\/(?:png|jpe?g|gif|webp);|blob:)/i,
    FORCE_BODY: true,
    USE_PROFILES: { html: true },
  }) as string;

  // Collapse quoted history (Gmail, Outlook, Apple Mail, Thunderbird) behind a native <details>.
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${body}`, 'text/html');
  const quoteSel = 'div.gmail_quote, blockquote[type="cite"], div#divRplyFwdMsg, div#appendonsend, .yahoo_quoted, blockquote.gmail_quote, div.moz-cite-prefix + blockquote';
  doc.querySelectorAll(quoteSel).forEach((q) => {
    if (q.closest('details')) return;
    const details = doc.createElement('details');
    details.className = 'tq';
    const summary = doc.createElement('summary');
    summary.textContent = '•••';
    summary.setAttribute('title', 'Show quoted text');
    q.replaceWith(details);
    details.append(summary, q);
  });
  const hasOwnColors = /\b(bgcolor|background(-color)?\s*:|color\s*:)/i.test(body);

  // With images allowed, only the signed proxy endpoint is reachable — never the rest of our API.
  const imgSrc = opts.allowImages ? `data: blob: ${location.origin}${BASE}/api/proxy/img` : 'data: blob:';
  const csp = `default-src 'none'; script-src 'none'; object-src 'none'; style-src 'unsafe-inline'; img-src ${imgSrc}; font-src data:; media-src 'none'; frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'`;

  const t = opts.theme;
  const adapt = opts.colorMode === 'dark' || (opts.colorMode === 'auto' && t.dark && !hasOwnColors);
  const paper = opts.colorMode !== 'dark' && t.dark && hasOwnColors; // keep the sender's design on a light sheet
  const base = adapt
    ? `html{background:${t.surface};color:${t.text}} a{color:${t.accent}}`
    : paper
      ? 'html{background:#ffffff;color:#1a1a1a} a{color:#1d4ed8}'
      : `html{background:transparent;color:${t.text}} a{color:${t.accent}}`;
  const forceDark = opts.colorMode === 'dark' && hasOwnColors ? 'html{filter:invert(.92) hue-rotate(180deg)} img,[background],[style*="background-image"]{filter:invert(1) hue-rotate(180deg)}' : '';
  const style = `
    ${base}
    html{font:${t.fontSize}px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;overflow-x:auto;overflow-y:hidden}
    body{margin:0;padding:${paper ? '20px' : '2px 0'};word-wrap:break-word;overflow-wrap:anywhere}
    img{max-width:100%;height:auto}
    img[data-blocked]{display:none}
    table{max-width:100%}
    pre{white-space:pre-wrap}
    blockquote{margin:.5em 0 .5em .25em;padding-left:.9em;border-left:3px solid ${adapt ? t.border : '#d4d4d8'}}
    details.tq>summary{display:inline-block;cursor:pointer;list-style:none;padding:0 8px;border-radius:6px;line-height:16px;font-size:12px;letter-spacing:1px;color:${adapt ? t.text2 : '#52525b'};background:${adapt ? t.border : '#e4e4e7'};margin:6px 0}
    details.tq>summary::-webkit-details-marker{display:none}
    ${forceDark}`;
  const srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>${style}</style></head><body>${doc.body.innerHTML}</body></html>`;
  return { srcdoc, remoteImages: [...remote], trackers, cleanedLinks, hasOwnColors, blockedImages: blocked };
}

/** Sanitize HTML that will be placed into the composer (quoted replies, signatures, snippets). */
export function sanitizeForComposer(html: string): string {
  const purify = DOMPurify();
  purify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') ?? '';
      if (!src.startsWith('data:image/') || src.startsWith('data:image/svg')) el.remove();
    }
  });
  return purify.sanitize(html, {
    FORBID_TAGS: [...FORBID_TAGS, 'style'],
    FORBID_ATTR: [...FORBID_ATTR, 'style', 'class', 'id'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/(?:png|jpe?g|gif|webp);)/i,
  }) as string;
}

/** Plain-text email -> segments (quoted blocks grouped), with format=flowed already unwrapped by the server. */
export function splitQuoted(text: string): { quoted: boolean; text: string }[] {
  const out: { quoted: boolean; text: string }[] = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const q = /^\s*>/.test(line);
    const last = out[out.length - 1];
    if (last && last.quoted === q) last.text += `\n${line}`;
    else out.push({ quoted: q, text: line });
  }
  return out;
}
