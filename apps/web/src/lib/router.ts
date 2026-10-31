import { type View, useUi } from '../state/ui';

/**
 * Hash routes keep deep links working at any sub-path without server rewrites:
 *   #/m/INBOX  #/m/INBOX?tab=newsletters  #/search?q=from:bob  #/subscriptions  #/contacts  #/outbox
 */
export function viewToHash(v: View): string {
  switch (v.kind) {
    case 'mailbox':
      return `#/m/${encodeURIComponent(v.path)}${v.tab ? `?tab=${encodeURIComponent(v.tab)}` : ''}`;
    case 'search':
      return `#/search?q=${encodeURIComponent(v.q)}`;
    default:
      return `#/${v.kind}`;
  }
}

export function hashToView(hash: string): View | null {
  const h = hash.replace(/^#/, '');
  const [path, query = ''] = h.split('?');
  const params = new URLSearchParams(query);
  if (path.startsWith('/m/')) {
    const p = decodeURIComponent(path.slice(3));
    return p ? { kind: 'mailbox', path: p, tab: params.get('tab') ?? undefined } : null;
  }
  if (path === '/search') return { kind: 'search', q: params.get('q') ?? '' };
  if (path === '/subscriptions' || path === '/contacts' || path === '/outbox') return { kind: path.slice(1) as 'subscriptions' };
  return null;
}

let applying = false;

export function startRouter() {
  const fromHash = () => {
    const v = hashToView(location.hash);
    if (!v) return;
    const cur = useUi.getState().view;
    if (viewToHash(cur) === viewToHash(v)) return;
    applying = true;
    useUi.getState().setView(v);
    applying = false;
  };
  fromHash();
  window.addEventListener('hashchange', fromHash);
  const unsub = useUi.subscribe((s, prev) => {
    if (s.view === prev.view || applying) return;
    const h = viewToHash(s.view);
    if (location.hash !== h) history.pushState(null, '', h);
  });
  if (!location.hash) history.replaceState(null, '', viewToHash(useUi.getState().view));
  return () => {
    window.removeEventListener('hashchange', fromHash);
    unsub();
  };
}

export function go(v: View) {
  useUi.getState().setView(v);
}
