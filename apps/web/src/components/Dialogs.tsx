import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Copy, ExternalLink, Folder, FolderPlus, Search, X, Clock, Sunrise, Sunset, CalendarDays, CalendarClock, Coffee } from 'lucide-react';
import { api, qs } from '../api/client';
import type { Mailbox } from '../api/types';
import { moveTo, snooze } from '../lib/actions';
import { type Command, describeKey, getCommands } from '../lib/keys';
import { queryClient, useMailboxes } from '../state/queries';
import { useUi } from '../state/ui';
import { SettingsDialog } from './settings/SettingsDialog';

export function DialogHost() {
  const dialog = useUi((s) => s.dialog);
  const close = () => useUi.getState().setDialog(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (dialog) returnFocus.current ??= document.activeElement as HTMLElement;
    else if (returnFocus.current) {
      returnFocus.current.focus?.();
      returnFocus.current = null;
    }
  }, [dialog]);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'settings':
      return (
        <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <SettingsDialog tab={dialog.tab} onClose={close} />
        </div>
      );
    case 'palette':
      return <Palette onClose={close} />;
    case 'move':
      return <MovePicker onClose={close} />;
    case 'snooze':
      return <SnoozePicker onClose={close} />;
    case 'help':
      return <Help onClose={close} />;
    case 'confirm':
      return (
        <Modal onClose={close} title={dialog.title}>
          <div className="dialog-body">{dialog.body}</div>
          <div className="dialog-foot">
            <button className="btn" onClick={close}>Cancel</button>
            <button
              className={`btn ${dialog.danger ? 'danger' : 'primary'}`}
              autoFocus
              onClick={() => {
                close();
                void dialog.run();
              }}
            >
              {dialog.confirm}
            </button>
          </div>
        </Modal>
      );
    case 'prompt':
      return <PromptDialog d={dialog} onClose={close} />;
    case 'link':
      return <LinkDialog href={dialog.href} text={dialog.text} mismatch={dialog.mismatch} onClose={close} />;
    case 'source':
      return <SourceDialog m={dialog} onClose={close} />;
    case 'archive-setup':
      return <ArchiveSetup onClose={close} />;
    default:
      return null;
  }
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`dialog${wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          } else e.stopPropagation();
        }}
      >
        <div className="dialog-head">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><X size={17} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function PromptDialog({ d, onClose }: { d: Extract<NonNullable<ReturnType<typeof useUi.getState>['dialog']>, { kind: 'prompt' }>; onClose: () => void }) {
  const [v, setV] = useState(d.initial ?? '');
  return (
    <Modal title={d.title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!v.trim()) return;
          onClose();
          void d.run(v.trim());
        }}
      >
        <div className="dialog-body">
          <label className="field">
            <span>{d.label}</span>
            <input className="input" autoFocus value={v} onChange={(e) => setV(e.target.value)} onFocus={(e) => e.target.select()} />
          </label>
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!v.trim()}>{d.confirm}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- fuzzy matching ----------
function score(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const s = q.toLowerCase();
  if (t.startsWith(s)) return 100 - t.length / 100;
  const idx = t.indexOf(s);
  if (idx >= 0) return 80 - idx;
  let ti = 0;
  let gaps = 0;
  for (const ch of s) {
    const f = t.indexOf(ch, ti);
    if (f < 0) return 0;
    gaps += f - ti;
    ti = f + 1;
  }
  return Math.max(1, 50 - gaps);
}

function folderLabel(b: Mailbox) {
  return ({ '\\Inbox': 'Inbox', '\\Sent': 'Sent', '\\Drafts': 'Drafts', '\\Archive': 'Archive', '\\Junk': 'Spam', '\\Trash': 'Trash' } as Record<string, string>)[b.role ?? ''] ?? b.path;
}

const RECENT_FOLDERS = 'tidings.recentFolders';
const recentFolders = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_FOLDERS) ?? '[]');
  } catch {
    return [];
  }
};
const rememberFolder = (p: string) => {
  try {
    localStorage.setItem(RECENT_FOLDERS, JSON.stringify([p, ...recentFolders().filter((x) => x !== p)].slice(0, 5)));
  } catch {
    /* ignore */
  }
};

interface PaletteEntry {
  id: string;
  title: string;
  group: string;
  keys?: string[];
  sub?: string;
  run: () => void;
}

function Palette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const { data: boxes = [] } = useMailboxes();
  const listRef = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => {
    const cmds: PaletteEntry[] = getCommands()
      .filter((c: Command) => !c.when || c.when() || c.id === 'palette')
      .filter((c) => c.id !== 'palette')
      .map((c) => ({ id: c.id, title: c.title, group: c.group, keys: c.keys, sub: c.keywords, run: c.run }));
    const folders: PaletteEntry[] = boxes.map((b) => ({ id: `f:${b.path}`, title: `Go to ${folderLabel(b)}`, group: 'Folders', run: () => useUi.getState().setView({ kind: 'mailbox', path: b.path }) }));
    const all = [...cmds, ...folders];
    if (q.trim()) {
      all.push({ id: 'search', title: `Search mail for “${q.trim()}”`, group: 'Search', run: () => useUi.getState().setView({ kind: 'search', q: q.trim() }) });
    }
    return all
      .map((e) => ({ e, s: Math.max(score(q, e.title), score(q, e.sub ?? '') * 0.6, score(q, e.group) * 0.3) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((x) => x.e);
  }, [q, boxes]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (e: PaletteEntry) => {
    onClose();
    setTimeout(e.run, 0);
  };

  let lastGroup = '';
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <Search size={18} />
          <input
            autoFocus
            placeholder="Type a command, folder or search…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Command"
            aria-controls="palette-list"
            aria-activedescendant={entries[active] ? `pal-${active}` : undefined}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(entries.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (entries[active]) run(entries[active]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
              e.stopPropagation();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {entries.map((e, i) => {
            const header = !q && e.group !== lastGroup ? (lastGroup = e.group) : null;
            return (
              <div key={e.id}>
                {header && <div className="palette-group">{header}</div>}
                <button id={`pal-${i}`} role="option" aria-selected={i === active} className={`palette-item${i === active ? ' active' : ''}`} onMouseMove={() => setActive(i)} onClick={() => run(e)}>
                  <span>{e.title}</span>
                  {q && <span className="sub">{e.group}</span>}
                  {e.keys && (
                    <span className="keys">
                      {e.keys.map((k) => (
                        <kbd key={k}>{describeKey(k)}</kbd>
                      ))}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
          {!entries.length && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-3)' }}>No matching commands</div>}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>?</kbd> all shortcuts</span>
        </div>
      </div>
    </div>
  );
}

function MovePicker({ onClose }: { onClose: () => void }) {
  const { data: boxes = [] } = useMailboxes();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const current = useUi.getState().visibleItems.find((i) => i.key === (useUi.getState().open ?? useUi.getState().cursor))?.mailbox;
  const options = useMemo(() => {
    const recent = recentFolders();
    const list = boxes.filter((b) => b.path !== current && b.role !== '\\Drafts');
    const scored = list
      .map((b) => ({ b, s: score(q, folderLabel(b)) + (recent.includes(b.path) && !q ? 200 - recent.indexOf(b.path) : 0) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.b);
    return scored;
  }, [boxes, q, current]);
  const canCreate = q.trim() && !boxes.some((b) => b.name.toLowerCase() === q.trim().toLowerCase());
  const total = options.length + (canCreate ? 1 : 0);

  async function choose(i: number) {
    onClose();
    if (i === options.length && canCreate) {
      try {
        const r = await api<{ path: string }>('/api/mailboxes', { body: { name: q.trim() } });
        await queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
        rememberFolder(r.path);
        void moveTo(r.path);
      } catch (err) {
        useUi.getState().pushToast({ message: (err as Error).message, tone: 'error' });
      }
      return;
    }
    const b = options[i];
    if (!b) return;
    rememberFolder(b.path);
    void moveTo(b.path);
  }

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Move to folder">
        <div className="palette-input">
          <ArrowRight size={18} />
          <input
            autoFocus
            placeholder="Move to…"
            value={q}
            aria-label="Folder"
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(total - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                void choose(active);
              } else if (e.key === 'Escape') onClose();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" role="listbox">
          {options.map((b, i) => (
            <button key={b.path} role="option" aria-selected={i === active} className={`palette-item${i === active ? ' active' : ''}`} onMouseMove={() => setActive(i)} onClick={() => void choose(i)}>
              {b.color ? <span className="dot" style={{ width: 10, height: 10, borderRadius: 3, background: b.color }} /> : <Folder size={16} />}
              <span>{folderLabel(b)}</span>
              {!q && recentFolders().includes(b.path) && <span className="sub">Recent</span>}
            </button>
          ))}
          {canCreate && (
            <button className={`palette-item${active === options.length ? ' active' : ''}`} onMouseMove={() => setActive(options.length)} onClick={() => void choose(options.length)}>
              <FolderPlus size={16} /> Create “{q.trim()}” and move
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function snoozeOptions(now = new Date()) {
  const at = (d: Date, h: number, m = 0) => {
    const x = new Date(d);
    x.setHours(h, m, 0, 0);
    return x;
  };
  const addDays = (d: Date, n: number) => {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  };
  const opts: { label: string; when: Date; icon: typeof Clock }[] = [];
  const later = new Date(now.getTime() + 3 * 3600_000);
  later.setMinutes(0, 0, 0);
  if (later.getDate() === now.getDate() && later.getHours() < 21) opts.push({ label: 'Later today', when: later, icon: Coffee });
  if (now.getHours() < 17) opts.push({ label: 'This evening', when: at(now, 18), icon: Sunset });
  opts.push({ label: 'Tomorrow morning', when: at(addDays(now, 1), 8), icon: Sunrise });
  const day = now.getDay();
  if (day >= 1 && day <= 4) opts.push({ label: 'This weekend', when: at(addDays(now, 6 - day), 9), icon: CalendarDays });
  opts.push({ label: 'Next week', when: at(addDays(now, ((8 - day) % 7) || 7), 8), icon: CalendarClock });
  return opts;
}

function SnoozePicker({ onClose }: { onClose: () => void }) {
  const opts = snoozeOptions();
  const [custom, setCustom] = useState('');
  const fmt = (d: Date) => d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const pick = (d: Date) => {
    onClose();
    void snooze(d.getTime());
  };
  return (
    <Modal title="Snooze until…" onClose={onClose}>
      <div
        className="dialog-body"
        style={{ display: 'grid', gap: 4 }}
        onKeyDown={(e) => {
          const n = Number(e.key);
          if (n >= 1 && n <= opts.length) pick(opts[n - 1].when);
        }}
      >
        {opts.map((o, i) => (
          <button key={o.label} className="palette-item" style={{ height: 44 }} autoFocus={i === 0} onClick={() => pick(o.when)}>
            <o.icon size={17} />
            <span style={{ color: 'var(--text)' }}>{o.label}</span>
            <span className="sub" style={{ marginLeft: 'auto' }}>{fmt(o.when)}</span>
            <kbd>{i + 1}</kbd>
          </button>
        ))}
        <form
          style={{ display: 'flex', gap: 8, marginTop: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            const t = new Date(custom);
            if (!Number.isNaN(t.getTime()) && t.getTime() > Date.now() + 60_000) pick(t);
          }}
        >
          <input className="input" type="datetime-local" aria-label="Pick a date and time" value={custom} onChange={(e) => setCustom(e.target.value)} min={new Date(Date.now() + 120_000).toISOString().slice(0, 16)} />
          <button className="btn primary" disabled={!custom}>Snooze</button>
        </form>
        <p className="hint" style={{ margin: '10px 0 0' }}>Snoozed mail moves to the Snoozed folder and comes back to your inbox, marked unread, the next time Tidings is open after that time.</p>
      </div>
    </Modal>
  );
}

function Help({ onClose }: { onClose: () => void }) {
  const groups = new Map<string, Command[]>();
  for (const c of getCommands()) {
    if (c.paletteOnly || !c.keys) continue;
    groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  }
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} wide>
      <div className="help-grid">
        {[...groups].map(([g, cmds]) => (
          <div key={g} style={{ display: 'contents' }}>
            <h3>{g}</h3>
            {cmds.map((c) => (
              <div key={c.id} className="help-row">
                <span>{c.title}</span>
                <span className="keys">
                  {[c.keys!, ...(c.alt ?? [])].slice(0, 2).map((seq, i) => (
                    <span key={i} style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
                      {i > 0 && <span style={{ margin: '0 4px' }}>or</span>}
                      {seq.map((k, j) => (
                        <span key={j} style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
                          {j > 0 && <span>then</span>}
                          <kbd>{describeKey(k)}</kbd>
                        </span>
                      ))}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
        <h3>Composer</h3>
        <div className="help-row"><span>Send</span><span className="keys"><kbd>{describeKey('mod+Enter')}</kbd></span></div>
        <div className="help-row"><span>Insert link</span><span className="keys"><kbd>{describeKey('mod+k')}</kbd></span></div>
        <div className="help-row"><span>Minimize draft</span><span className="keys"><kbd>Esc</kbd></span></div>
      </div>
    </Modal>
  );
}

function LinkDialog({ href, text, mismatch, onClose }: { href: string; text: string; mismatch: boolean; onClose: () => void }) {
  let host = '';
  let rest = href;
  try {
    const u = new URL(href);
    host = u.hostname;
    rest = href.slice(href.indexOf(u.hostname) + u.hostname.length);
  } catch {
    /* keep raw */
  }
  const puny = host.includes('xn--');
  return (
    <Modal title={mismatch ? 'This link may not go where it says' : 'Open link?'} onClose={onClose}>
      <div className="dialog-body">
        {mismatch && (
          <div className="banner danger" style={{ margin: '0 0 12px' }}>
            <AlertTriangle size={16} /> <span className="grow">The text shows <b>{text.trim()}</b>, but the link goes to <b>{host}</b>.</span>
          </div>
        )}
        {puny && (
          <div className="banner warn" style={{ margin: '0 0 12px' }}>
            <AlertTriangle size={16} /> <span className="grow">This address uses look-alike characters.</span>
          </div>
        )}
        <div className="card" style={{ fontFamily: 'var(--mono)', fontSize: 12.5, overflowWrap: 'anywhere', color: 'var(--text-2)' }}>
          {href.slice(0, href.indexOf(host))}
          <b style={{ color: 'var(--text)', fontSize: 14 }}>{host}</b>
          {rest.length > 300 ? `${rest.slice(0, 300)}…` : rest}
        </div>
      </div>
      <div className="dialog-foot">
        <button className="btn ghost" onClick={() => void navigator.clipboard?.writeText(href).then(() => useUi.getState().pushToast({ message: 'Link copied' }))}>
          <Copy size={14} /> Copy
        </button>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className={`btn ${mismatch ? 'danger' : 'primary'}`}
          autoFocus={!mismatch}
          onClick={() => {
            window.open(href, '_blank', 'noopener,noreferrer');
            onClose();
          }}
        >
          <ExternalLink size={14} /> Open {host || 'link'}
        </button>
      </div>
    </Modal>
  );
}

function SourceDialog({ m, onClose }: { m: { mailbox: string; uidValidity: string; uid: number }; onClose: () => void }) {
  const q = useQuery({ queryKey: ['source', m.mailbox, m.uid], queryFn: () => api<{ source: string }>(`/api/message/source?${qs(m)}`) });
  return (
    <Modal title="Original message" onClose={onClose} wide>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 20px 20px' }}>
        {q.data ? (
          <pre style={{ margin: 0, font: '12.5px/1.5 var(--mono)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--text-2)' }}>{q.data.source}</pre>
        ) : q.isError ? (
          <p>{(q.error as Error).message}</p>
        ) : (
          <p className="hint">Loading…</p>
        )}
      </div>
      <div className="dialog-foot">
        <button className="btn" onClick={() => void navigator.clipboard?.writeText(q.data?.source ?? '')}>
          <Copy size={14} /> Copy
        </button>
      </div>
    </Modal>
  );
}

function ArchiveSetup({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Set up archiving" onClose={onClose}>
      <div className="dialog-body">
        Your mail server has no Archive folder yet. Archiving moves conversations out of your inbox without deleting them, so your inbox only holds what still needs you.
      </div>
      <div className="dialog-foot">
        <button className="btn" onClick={onClose}>Not now</button>
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api('/api/mailboxes', { body: { name: 'Archive', role: 'archive' } });
              await queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
              useUi.getState().pushToast({ message: 'Archive folder created — press e again to archive' });
            } catch (err) {
              useUi.getState().pushToast({ message: (err as Error).message, tone: 'error' });
            }
            onClose();
          }}
        >
          Create Archive folder
        </button>
      </div>
    </Modal>
  );
}
