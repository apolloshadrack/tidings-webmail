import { useEffect, useMemo, useRef, useState } from 'react';
import { Command, Menu as MenuIcon, Search, WifiOff, X, Send } from 'lucide-react';
import { api, qs } from '../api/client';
import type { Address, SessionInfo } from '../api/types';
import { MOD } from '../lib/keys';
import { useOutbox } from '../state/queries';
import { useUi } from '../state/ui';

const OPERATORS = [
  { op: 'from:', hint: 'Sender name or address' },
  { op: 'to:', hint: 'Recipient' },
  { op: 'subject:', hint: 'Words in the subject' },
  { op: 'has:attachment', hint: 'With attachments' },
  { op: 'is:unread', hint: 'Unread only' },
  { op: 'is:starred', hint: 'Starred' },
  { op: 'is:newsletter', hint: 'Mailing lists & newsletters' },
  { op: 'in:', hint: 'inbox, sent, archive, spam, trash, anywhere or a folder' },
  { op: 'after:', hint: 'YYYY-MM-DD' },
  { op: 'before:', hint: 'YYYY-MM-DD' },
  { op: 'larger:', hint: 'Size, e.g. 5M' },
];
const RECENT_KEY = 'tidings.recentSearches';

function recent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}
function remember(q: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...recent().filter((r) => r !== q)].slice(0, 6)));
  } catch {
    /* ignore */
  }
}

export function Topbar({ session }: { session: SessionInfo }) {
  void session;
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const focusTick = useUi((s) => s.searchFocused);
  const online = useUi((s) => s.online);
  const outbox = useOutbox();
  const queued = (outbox.data ?? []).filter((o) => o.state === 'queued' || o.state === 'sending').length;
  const failed = (outbox.data ?? []).filter((o) => o.state === 'failed' || o.state === 'stalled').length;
  const [q, setQ] = useState(view.kind === 'search' ? view.q : '');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [people, setPeople] = useState<Address[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusTick) {
      input.current?.focus();
      input.current?.select();
    }
  }, [focusTick]);
  useEffect(() => {
    setQ(view.kind === 'search' ? view.q : '');
  }, [view]);

  // contact suggestions after from: / to:
  const lastToken = q.split(/\s+/).pop() ?? '';
  const personPrefix = /^(from|to):(.*)$/i.exec(lastToken);
  useEffect(() => {
    if (!personPrefix || personPrefix[2].length < 1) {
      setPeople([]);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api<{ suggestions: Address[] }>(`/api/contacts/suggest?${qs({ q: personPrefix[2] })}`, { signal: ctl.signal })
        .then((r) => setPeople(r.suggestions))
        .catch(() => undefined);
    }, 120);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [personPrefix?.[0]]); // eslint-disable-line react-hooks/exhaustive-deps

  const options = useMemo(() => {
    const out: { label: string; hint?: string; apply: () => void; mono?: boolean }[] = [];
    if (personPrefix) {
      for (const p of people) {
        out.push({
          label: p.name ? `${p.name} <${p.address}>` : p.address,
          apply: () => setQ(`${q.slice(0, q.length - lastToken.length)}${personPrefix[1]}:${p.address} `),
        });
      }
    } else if (lastToken && !lastToken.includes(':')) {
      for (const o of OPERATORS.filter((o) => o.op.startsWith(lastToken.toLowerCase()) && o.op !== lastToken)) {
        out.push({ label: o.op, hint: o.hint, mono: true, apply: () => setQ(`${q.slice(0, q.length - lastToken.length)}${o.op}${o.op.endsWith(':') ? '' : ' '}`) });
      }
    }
    if (!q.trim()) {
      for (const r of recent()) out.push({ label: r, hint: 'Recent', apply: () => run(r) });
      for (const o of OPERATORS.slice(0, 7)) out.push({ label: o.op, hint: o.hint, mono: true, apply: () => setQ(`${o.op}${o.op.endsWith(':') ? '' : ' '}`) });
    }
    return out;
  }, [q, people, lastToken, personPrefix]); // eslint-disable-line react-hooks/exhaustive-deps

  function run(text: string) {
    const t = text.trim();
    if (!t) return;
    remember(t);
    setView({ kind: 'search', q: t });
    setFocused(false);
    input.current?.blur();
  }

  return (
    <header className="topbar">
      <button className="icon-btn mobile-only" aria-label="Open folders" onClick={() => useUi.getState().setMobileNav(true)}>
        <MenuIcon size={20} />
      </button>
      <div className="search" role="search">
        <Search size={17} aria-hidden="true" />
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && options.length) {
              e.preventDefault();
              setActive((a) => (a + 1) % options.length);
            } else if (e.key === 'ArrowUp' && options.length) {
              e.preventDefault();
              setActive((a) => (a - 1 + options.length) % options.length);
            } else if (e.key === 'Tab' && focused && options[active] && (personPrefix || (lastToken && !lastToken.includes(':')))) {
              e.preventDefault();
              options[active].apply();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (focused && options[active] && (personPrefix || (!q.trim() && options.length))) options[active].apply();
              else run(q);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              if (q) setQ('');
              else input.current?.blur();
            }
          }}
          placeholder="Search mail"
          aria-label="Search mail"
          aria-autocomplete="list"
          aria-expanded={focused && options.length > 0}
          spellCheck={false}
        />
        {q && (
          <button
            className="icon-btn sm"
            aria-label="Clear search"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setQ('');
              if (view.kind === 'search') setView({ kind: 'mailbox', path: 'INBOX' });
            }}
          >
            <X size={15} />
          </button>
        )}
        <kbd aria-hidden="true">/</kbd>
        {focused && options.length > 0 && (
          <div className="search-pop" role="listbox">
            {!q.trim() && <h6>Search tips</h6>}
            {options.map((o, i) => (
              <button
                key={`${o.label}-${i}`}
                className={`opt${i === active ? ' active' : ''}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => o.apply()}
              >
                {o.mono ? <span className="chip-op">{o.label}</span> : <span>{o.label}</span>}
                {o.hint && <small>{o.hint}</small>}
              </button>
            ))}
          </div>
        )}
      </div>
      <span style={{ flex: 1 }} />
      {!online && (
        <span className="offline-pill" role="status">
          <WifiOff size={14} /> Offline
        </span>
      )}
      {(queued > 0 || failed > 0) && (
        <button className="btn sm ghost" onClick={() => setView({ kind: 'outbox' })} style={failed ? { color: 'var(--danger)' } : undefined}>
          <Send size={14} /> {failed ? `${failed} not sent` : `Sending ${queued}…`}
        </button>
      )}
      <button className="btn sm ghost" onClick={() => useUi.getState().setDialog({ kind: 'palette' })} title="Command palette">
        <Command size={14} /> <span className="kbd" style={{ boxShadow: 'none', background: 'transparent' }}>{MOD}K</span>
      </button>
    </header>
  );
}
