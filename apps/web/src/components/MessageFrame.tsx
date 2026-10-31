import { useEffect, useMemo, useRef, useState } from 'react';
import { api, partUrl } from '../api/client';
import type { FullMessage } from '../api/types';
import { composeFromMailto, setQuoteSelection } from '../lib/composeActions';
import { linkMismatch } from '../lib/format';
import { handleKeydown } from '../lib/keys';
import { IFRAME_SANDBOX, type SanitizeResult, sanitizeEmail } from '../lib/sanitize';
import { activeThemeId, useSettings } from '../state/settings';
import { themeById } from '../styles/themes';
import { useUi } from '../state/ui';

export interface FrameInfo {
  trackers: number;
  cleanedLinks: number;
  blockedImages: number;
  remoteImages: number;
}

/**
 * The ONLY place untrusted HTML is rendered. Sandbox tokens are fixed (no scripts), the document
 * carries its own CSP, and the parent handles links, keys and selection through same-origin access.
 */
export function MessageFrame({ msg, allowImages, colorMode, onInfo }: { msg: FullMessage; allowImages: boolean; colorMode: 'auto' | 'original' | 'dark'; onInfo: (i: FrameInfo) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const s = useSettings((st) => st.s);
  const theme = themeById(activeThemeId(s));
  const [cidMap, setCidMap] = useState<Record<string, string>>({});
  const [proxyMap, setProxyMap] = useState<Record<string, string> | undefined>();
  const [height, setHeight] = useState(60);

  // Inline cid: images -> blob URLs (server only serves sniffed raster images inline).
  useEffect(() => {
    const cids = msg.attachments.filter((a) => a.cid && a.contentType.startsWith('image/'));
    if (!cids.length || !msg.html?.includes('cid:')) return;
    let alive = true;
    const urls: string[] = [];
    void Promise.all(
      cids.map(async (a) => {
        const r = await fetch(partUrl(msg, a.part, true), { credentials: 'same-origin' });
        const type = r.headers.get('content-type') ?? '';
        if (!r.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) return null;
        const blob = new Blob([await r.arrayBuffer()], { type });
        const u = URL.createObjectURL(blob);
        urls.push(u);
        return [a.cid!, u] as const;
      }),
    ).then((pairs) => {
      if (alive) setCidMap(Object.fromEntries(pairs.filter(Boolean) as [string, string][]));
    });
    return () => {
      alive = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [msg]);

  const t = theme.tokens;
  const result: SanitizeResult = useMemo(
    () =>
      sanitizeEmail(msg.html ?? '', {
        allowImages: allowImages && !!proxyMap,
        proxyMap,
        cidMap,
        stripTracking: s.stripTracking,
        colorMode,
        theme: { dark: theme.dark, text: t.text, surface: t.surface, accent: t.accent, text2: t.text2, border: t.border, fontSize: s.fontSize },
      }),
    [msg.html, allowImages, proxyMap, cidMap, s.stripTracking, colorMode, theme.dark, t.text, t.surface, t.accent, t.text2, t.border, s.fontSize],
  );

  // When images are allowed, sign the remote URLs for the privacy proxy, then re-render.
  useEffect(() => {
    if (!allowImages || proxyMap) return;
    const probe = sanitizeEmail(msg.html ?? '', { allowImages: false, stripTracking: true, colorMode: 'auto', theme: { dark: false, text: '#000', surface: '#fff', accent: '#00f', text2: '#333', border: '#ccc', fontSize: 14 } });
    if (!probe.remoteImages.length) {
      setProxyMap({});
      return;
    }
    void api<{ urls: Record<string, string> }>('/api/proxy/sign', { body: { urls: probe.remoteImages.slice(0, 500) } })
      .then((r) => setProxyMap(r.urls))
      .catch(() => setProxyMap({}));
  }, [allowImages, msg.html, proxyMap]);

  useEffect(() => {
    onInfo({ trackers: result.trackers, cleanedLinks: result.cleanedLinks, blockedImages: result.blockedImages, remoteImages: result.remoteImages.length });
  }, [result.trackers, result.cleanedLinks, result.blockedImages, result.remoteImages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wire up the frame once it loads: height, links, keys, selection.
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let ro: ResizeObserver | null = null;
    const onLoad = () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      const measure = () => setHeight(Math.min(100_000, Math.max(40, doc.documentElement.scrollHeight)));
      measure();
      ro = new ResizeObserver(measure);
      ro.observe(doc.documentElement);
      doc.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure, { once: true }));
      // Middle-click and modifier-clicks go through the same confirmation (auxclick + mousedown).
      doc.addEventListener('mousedown', (e) => {
        if (e.button === 1 && (e.target as Element).closest?.('a[href]')) e.preventDefault();
      });
      const onLink = (e: MouseEvent) => {
        const a = (e.target as Element).closest?.('a[href]') as HTMLAnchorElement | null;
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute('href') ?? '';
        if (href.startsWith('mailto:')) {
          void composeFromMailto(href);
          return;
        }
        const text = a.textContent ?? '';
        const mismatch = linkMismatch(text, href);
        if (mismatch || useSettings.getState().s.confirmLinks) {
          useUi.getState().setDialog({ kind: 'link', href, text, mismatch });
        } else {
          window.open(href, '_blank', 'noopener,noreferrer');
        }
      };
      doc.addEventListener('click', onLink);
      doc.addEventListener('auxclick', onLink);
      // Keyboard shortcuts keep working while focus is inside the message.
      doc.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') return;
        handleKeydown(e);
      });
      doc.addEventListener('mouseup', () => setQuoteSelection(doc.getSelection()?.toString() ?? ''));
    };
    frame.addEventListener('load', onLoad);
    return () => {
      frame.removeEventListener('load', onLoad);
      ro?.disconnect();
    };
  }, [result.srcdoc]);

  const paper = theme.dark && result.hasOwnColors && colorMode !== 'dark';
  return (
    <iframe
      ref={ref}
      className={`msg-frame${paper ? ' paper' : ''}`}
      title={`Message from ${msg.from[0]?.address ?? 'unknown sender'}`}
      sandbox={IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={result.srcdoc}
      style={{ height }}
    />
  );
}
