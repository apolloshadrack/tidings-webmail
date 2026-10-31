import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Archive, Check, Clock, Loader2, MailOpen, Mail, Paperclip, RefreshCw, Search, Star, Trash2, X, FolderInput, ShieldAlert } from 'lucide-react';
import { api } from '../api/client';
import type { ListItem, ListPage, Mailbox, SessionInfo } from '../api/types';
import { archive, setRead, toggleStar, trash, junk } from '../lib/actions';
import { editDraftMessage } from '../lib/composeActions';
import { displayName, listDate, plural } from '../lib/format';
import { fetchMessage, listParams, prefetchMessage, queryClient, threadKey, useList, useMailboxes } from '../state/queries';
import { useSettings } from '../state/settings';
import { useUi } from '../state/ui';
import { Avatar } from './Brand';
import { InboxZero } from './InboxZero';

const ROW_H = { compact: 36, cozy: 66, comfortable: 86 } as const;

export function MessageList() {
  const view = useUi((s) => s.view);
  const s = useSettings((st) => st.s);
  const params = useMemo(() => listParams(view), [view, s.conversations, s.splitInbox, s.splitTabs]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useList(params);
  const { data: boxes = [] } = useMailboxes();
  const cursor = useUi((st) => st.cursor);
  const open = useUi((st) => st.open);
  const selection = useUi((st) => st.selection);
  const setVisible = useUi((st) => st.setVisible);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [newPill, setNewPill] = useState(0);
  const firstKey = useRef<string | null>(null);
  const me = new Set([queryClient.getQueryData<SessionInfo>(['session'])?.email ?? '']);

  const [bodyResults, setBodyResults] = useState<ListItem[]>([]);
  const [bodySearch, setBodySearch] = useState<{ done: number; total: number; running: boolean } | null>(null);
  const bodyAbort = useRef(false);
  useEffect(() => {
    setBodyResults([]);
    setBodySearch(null);
    bodyAbort.current = true;
  }, [view]);

  const items = useMemo(() => {
    const base = list.data?.pages.flatMap((p) => p.items) ?? [];
    if (!bodyResults.length) return base;
    const seen = new Set(base.map((i) => i.key));
    return [...base, ...bodyResults.filter((i) => !seen.has(i.key))];
  }, [list.data, bodyResults]);

  useEffect(() => {
    setVisible(items);
    const st = useUi.getState();
    if (items.length && (!st.cursor || !items.some((i) => i.key === st.cursor))) {
      if (!st.cursor) st.setCursor(items[0].key);
    }
    // "N new" pill when mail lands above while the user is scrolled down.
    const top = items[0]?.key ?? null;
    if (firstKey.current && top && top !== firstKey.current && (scrollRef.current?.scrollTop ?? 0) > 40) {
      const idx = items.findIndex((i) => i.key === firstKey.current);
      if (idx > 0) setNewPill(idx);
    }
    firstKey.current = top;
  }, [items, setVisible]);

  useEffect(() => {
    if (!list.isLoading) {
      setShowSkeleton(false);
      return;
    }
    const t = setTimeout(() => setShowSkeleton(true), 150);
    return () => clearTimeout(t);
  }, [list.isLoading]);

  const rowH = ROW_H[s.density];
  const virt = useVirtualizer({ count: items.length, getScrollElement: () => scrollRef.current, estimateSize: () => rowH, overscan: 12 });
  useEffect(() => virt.measure(), [rowH]); // eslint-disable-line react-hooks/exhaustive-deps

  // keep the cursor visible
  useEffect(() => {
    const key = open ?? cursor;
    const idx = items.findIndex((i) => i.key === key);
    if (idx >= 0) virt.scrollToIndex(idx, { align: 'auto' });
  }, [cursor, open]); // eslint-disable-line react-hooks/exhaustive-deps

  // infinite scroll
  const last = virt.getVirtualItems().at(-1);
  useEffect(() => {
    if (last && last.index >= items.length - 15 && list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
  }, [last?.index, items.length, list.hasNextPage, list.isFetchingNextPage]); // eslint-disable-line react-hooks/exhaustive-deps

  // prefetch around the cursor: next 3, previous 1 (thread index + latest body)
  useEffect(() => {
    const idx = items.findIndex((i) => i.key === (open ?? cursor));
    if (idx < 0) return;
    const t = setTimeout(() => {
      for (const it of [items[idx], items[idx + 1], items[idx + 2], items[idx + 3], items[idx - 1]].filter(Boolean) as ListItem[]) {
        void prefetchMessage(it);
        if (s.conversations && it.count > 1) {
          void queryClient.prefetchQuery({
            queryKey: threadKey(it.threadId, it.mailbox),
            queryFn: () => api<{ messages: ListItem[] }>(`/api/thread?threadId=${encodeURIComponent(it.threadId)}&mailbox=${encodeURIComponent(it.mailbox)}`).then((r) => r.messages),
          });
        }
      }
    }, 120);
    return () => clearTimeout(t);
  }, [cursor, open, items, s.conversations]);

  const box = view.kind === 'mailbox' ? boxes.find((b) => b.path === view.path) : undefined;
  const title = view.kind === 'search' ? 'Search' : box ? labelFor(box) : view.kind === 'mailbox' ? view.path : '';
  const isDrafts = box?.role === '\\Drafts';

  const onRowClick = useCallback(
    (e: React.MouseEvent, it: ListItem) => {
      const st = useUi.getState();
      if (e.metaKey || e.ctrlKey) {
        st.toggleSelect(it.key);
        return;
      }
      if (e.shiftKey) {
        st.toggleSelect(it.key, true);
        return;
      }
      if (isDrafts) {
        void fetchMessage(it).then((m) => editDraftMessage(m));
        return;
      }
      st.setCursor(it.key);
      st.setOpen(it.key);
    },
    [isDrafts],
  );

  async function runBodySearch() {
    if (view.kind !== 'search') return;
    const text = view.q.replace(/\b\w+:("[^"]*"|\S+)/g, '').trim();
    if (text.length < 2) {
      useUi.getState().pushToast({ message: 'Type at least two characters of text to search inside messages.' });
      return;
    }
    const folders = boxes.filter((b) => b.role !== '\\Trash' && b.role !== '\\Junk' && b.total > 0);
    bodyAbort.current = false;
    setBodySearch({ done: 0, total: folders.length, running: true });
    for (let i = 0; i < folders.length; i++) {
      if (bodyAbort.current) break;
      try {
        const r = await api<{ items: ListItem[] }>('/api/search/body', { body: { text, mailbox: folders[i].path } });
        if (bodyAbort.current) break;
        setBodyResults((prev) => [...prev, ...r.items]);
      } catch {
        /* one slow folder should not stop the rest */
      }
      setBodySearch({ done: i + 1, total: folders.length, running: i + 1 < folders.length });
    }
    setBodySearch((b) => (b ? { ...b, running: false } : b));
  }

  const tabs = view.kind === 'mailbox' && view.path === 'INBOX' && s.splitInbox ? s.splitTabs : null;
  const activeTab = view.kind === 'mailbox' ? (view.tab ?? s.splitTabs[0]?.id) : undefined;
  const unread = box?.unread ?? 0;

  return (
    <>
      <div className="list-head">
        <h1 className="list-title">{title}</h1>
        {view.kind === 'search' ? (
          <span className="list-sub" title={view.q}>“{view.q}”</span>
        ) : (
          unread > 0 && <span className="list-sub">{plural(unread, 'unread', 'unread')}</span>
        )}
        <span style={{ flex: 1 }} />
        <button
          className="icon-btn"
          aria-label="Refresh"
          title="Refresh"
          onClick={() => {
            if (view.kind === 'mailbox') void api('/api/mailboxes/sync', { body: { path: view.path } }).finally(() => void list.refetch());
            else void list.refetch();
          }}
        >
          <RefreshCw size={16} className={list.isFetching && !list.isFetchingNextPage ? 'spin' : ''} />
        </button>
      </div>
      {tabs && (
        <div className="tabs" role="tablist" aria-label="Split inbox">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={activeTab === t.id} className={`tab${activeTab === t.id ? ' active' : ''}`} onClick={() => useUi.getState().setView({ kind: 'mailbox', path: 'INBOX', tab: t.id })}>
              {t.name}
            </button>
          ))}
          <button role="tab" aria-selected={activeTab === '__all'} className={`tab${activeTab === '__all' ? ' active' : ''}`} onClick={() => useUi.getState().setView({ kind: 'mailbox', path: 'INBOX', tab: '__all' })}>
            Everything
          </button>
        </div>
      )}
      {selection.size > 0 && <BulkBar count={selection.size} />}
      <div className="list-scroll" ref={scrollRef} role="listbox" aria-label={`${title} conversations`} aria-multiselectable="true" tabIndex={-1}>
        {newPill > 0 && (
          <button
            className="new-pill"
            onClick={() => {
              scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
              setNewPill(0);
            }}
          >
            {plural(newPill, 'new conversation')}
          </button>
        )}
        {showSkeleton && !items.length && <Skeletons h={rowH} />}
        {!list.isLoading && !items.length && !list.isError && (
          view.kind === 'search' ? (
            <div className="list-empty">
              <div>
                <Search size={28} />
                <h3>No matches</h3>
                <p>Nothing in your mail matches “{view.q}”.</p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14, flexWrap: 'wrap' }}>
                  <button className="btn" onClick={() => void runBodySearch()}>Search inside messages</button>
                  {!/in:/.test(view.q) && <button className="btn ghost" onClick={() => useUi.getState().setView({ kind: 'search', q: `${view.q} in:anywhere` })}>Include Trash &amp; Spam</button>}
                </div>
              </div>
            </div>
          ) : box?.role === '\\Inbox' ? (
            <InboxZero tab={tabs?.find((t) => t.id === activeTab)?.name} />
          ) : (
            <div className="list-empty">
              <div>
                <Mail size={28} />
                <h3>Nothing in {title}</h3>
                <p>{box && box.total > box.synced ? 'Still loading this folder…' : 'Messages you move here will show up in this list.'}</p>
              </div>
            </div>
          )
        )}
        {list.isError && (
          <div className="list-empty">
            <div>
              <h3>Couldn’t load this folder</h3>
              <p>{(list.error as Error).message}</p>
              <button className="btn" style={{ marginTop: 12 }} onClick={() => void list.refetch()}>Try again</button>
            </div>
          </div>
        )}
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((v) => {
            const it = items[v.index];
            return (
              <Row
                key={it.key}
                item={it}
                top={v.start}
                height={rowH}
                cursor={cursor === it.key}
                open={open === it.key}
                selected={selection.has(it.key)}
                density={s.density}
                showAvatars={s.showAvatars}
                showSnippets={s.showSnippets}
                me={me}
                sentView={box?.role === '\\Sent' || box?.role === '\\Drafts'}
                onClick={onRowClick}
              />
            );
          })}
        </div>
        {list.isFetchingNextPage && (
          <div style={{ padding: 14, textAlign: 'center', color: 'var(--text-3)' }}>
            <Loader2 size={16} className="spin" />
          </div>
        )}
        {view.kind === 'search' && items.length > 0 && (
          <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
            {bodySearch ? (
              bodySearch.running ? (
                <span>
                  <Loader2 size={14} className="spin" style={{ verticalAlign: -2 }} /> Searching inside messages · {bodySearch.done}/{bodySearch.total} folders{' '}
                  <button className="btn sm ghost" onClick={() => (bodyAbort.current = true)}>Stop</button>
                </span>
              ) : (
                <span>Searched inside messages in {bodySearch.done} folders.</span>
              )
            ) : (
              <button className="btn sm" onClick={() => void runBodySearch()}>Also search inside message bodies</button>
            )}
          </div>
        )}
        {box && box.total > box.synced && items.length > 0 && !list.hasNextPage && (
          <div style={{ padding: 14, textAlign: 'center', color: 'var(--text-3)', fontSize: 12.5 }}>
            Indexing older mail · {box.synced.toLocaleString()} of {box.total.toLocaleString()}
          </div>
        )}
      </div>
    </>
  );
}

function labelFor(b: Mailbox) {
  return ({ '\\Inbox': 'Inbox', '\\Sent': 'Sent', '\\Drafts': 'Drafts', '\\Archive': 'Archive', '\\Junk': 'Spam', '\\Trash': 'Trash' } as Record<string, string>)[b.role ?? ''] ?? b.name;
}

function Skeletons({ h }: { h: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} style={{ height: h, display: 'flex', gap: 12, alignItems: 'center', padding: '0 16px', borderBottom: '1px solid var(--hairline)' }}>
          <div className="skeleton" style={{ width: 32, height: 32, borderRadius: '50%' }} />
          <div style={{ flex: 1, display: 'grid', gap: 8 }}>
            <div className="skeleton" style={{ height: 10, width: `${40 + ((i * 37) % 30)}%` }} />
            {h > 40 && <div className="skeleton" style={{ height: 9, width: `${60 + ((i * 23) % 30)}%` }} />}
          </div>
        </div>
      ))}
    </div>
  );
}

function BulkBar({ count }: { count: number }) {
  const ui = useUi.getState;
  return (
    <div className="bulkbar" role="toolbar" aria-label="Selected conversations">
      <button className="icon-btn sm" aria-label="Clear selection" onClick={() => ui().clearSelection()}>
        <X size={15} />
      </button>
      <span className="count">{count} selected</span>
      <button className="btn sm ghost" onClick={() => ui().selectAll()}>Select all</button>
      <button className="icon-btn" title="Archive (e)" aria-label="Archive" onClick={() => void archive()}><Archive size={17} /></button>
      <button className="icon-btn" title="Delete (#)" aria-label="Delete" onClick={() => void trash()}><Trash2 size={17} /></button>
      <button className="icon-btn" title="Spam (!)" aria-label="Mark as spam" onClick={() => void junk()}><ShieldAlert size={17} /></button>
      <button className="icon-btn" title="Mark read (⇧I)" aria-label="Mark as read" onClick={() => void setRead(useUi.getState().visibleItems.filter((i) => useUi.getState().selection.has(i.key)), true)}><MailOpen size={17} /></button>
      <button className="icon-btn" title="Mark unread (⇧U)" aria-label="Mark as unread" onClick={() => void setRead(useUi.getState().visibleItems.filter((i) => useUi.getState().selection.has(i.key)), false)}><Mail size={17} /></button>
      <button className="icon-btn" title="Move (v)" aria-label="Move to folder" onClick={() => ui().setDialog({ kind: 'move', mode: 'move' })}><FolderInput size={17} /></button>
      <button className="icon-btn" title="Snooze (h)" aria-label="Snooze" onClick={() => ui().setDialog({ kind: 'snooze' })}><Clock size={17} /></button>
    </div>
  );
}

interface RowProps {
  item: ListItem;
  top: number;
  height: number;
  cursor: boolean;
  open: boolean;
  selected: boolean;
  density: 'compact' | 'cozy' | 'comfortable';
  showAvatars: boolean;
  showSnippets: boolean;
  me: Set<string>;
  sentView: boolean;
  onClick: (e: React.MouseEvent, it: ListItem) => void;
}

const Row = memo(function Row({ item: it, top, height, cursor, open, selected, density, showAvatars, showSnippets, me, sentView, onClick }: RowProps) {
  const people = sentView ? it.to.slice(0, 3) : it.participants;
  const who =
    people.length > 1
      ? people.map((p) => (people.length > 2 ? displayName(p, me).split(/\s+/)[0] : displayName(p, me))).join(', ')
      : sentView
        ? `To: ${displayName(people[0], me)}`
        : displayName(people[0] ?? it.from, me);
  const avatarAddr = sentView ? it.to[0] : it.from;
  const cls = `row${it.unread ? ' unread' : ''}${cursor ? ' cursor' : ''}${selected ? ' selected' : ''}${open ? ' open' : ''}`;
  const compact = density === 'compact';
  return (
    <div
      className={cls}
      role="option"
      aria-selected={selected || open}
      aria-label={`${it.unread ? 'Unread, ' : ''}${who}, ${it.subject || '(no subject)'}, ${listDate(it.date)}`}
      style={{ top, height }}
      onClick={(e) => onClick(e, it)}
      draggable
      onDragStart={(e) => {
        const st = useUi.getState();
        const keys = st.selection.has(it.key) ? [...st.selection] : [it.key];
        st.setDragItems(keys);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `${keys.length} conversation(s)`);
      }}
      onDragEnd={() => setTimeout(() => useUi.getState().setDragItems(null), 50)}
    >
      <div className="lead">
        {showAvatars ? (
          <span className="avatar-slot">
            <Avatar addr={avatarAddr} />
            <button
              className={`check${selected ? ' on' : ''}`}
              aria-label={selected ? 'Deselect' : 'Select'}
              onClick={(e) => {
                e.stopPropagation();
                useUi.getState().toggleSelect(it.key, e.shiftKey);
              }}
            >
              {selected && <Check size={14} strokeWidth={3} />}
            </button>
          </span>
        ) : (
          <button
            className={`check${selected ? ' on' : ''}`}
            aria-label={selected ? 'Deselect' : 'Select'}
            onClick={(e) => {
              e.stopPropagation();
              useUi.getState().toggleSelect(it.key, e.shiftKey);
            }}
          >
            {selected && <Check size={13} strokeWidth={3} />}
          </button>
        )}
      </div>
      <div className="body">
        <div className="line">
          {it.unread && !showAvatars && <span className="unread-dot" aria-hidden="true" />}
          <bdi className="from">{who}</bdi>
          {it.count > 1 && <span className="n">{it.count}</span>}
          {it.draft && <span className="n" style={{ color: 'var(--danger)' }}>Draft</span>}
        </div>
        <div className="line">
          <bdi className="subject">{it.subject || '(no subject)'}</bdi>
          {(compact || density === 'cozy') && showSnippets && it.snippet && <span className="snippet">— {it.snippet}</span>}
        </div>
        {density === 'comfortable' && showSnippets && (
          <div className="line">
            <span className="snippet">{it.snippet}</span>
          </div>
        )}
      </div>
      <div className="meta">
        <span className="date">{listDate(it.date)}</span>
        <span className="icons">
          {it.hasAttachments && <Paperclip size={13} aria-label="Has attachments" />}
          {it.flagged && <Star size={13} className="star-on" fill="currentColor" aria-label="Starred" />}
          {it.unread && showAvatars && <span className="unread-dot" aria-hidden="true" />}
        </span>
      </div>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn sm" title="Archive (e)" aria-label="Archive" onClick={() => void archive([it])}><Archive size={15} /></button>
        <button className="icon-btn sm" title="Delete (#)" aria-label="Delete" onClick={() => void trash([it])}><Trash2 size={15} /></button>
        <button className="icon-btn sm" title={it.unread ? 'Mark read' : 'Mark unread'} aria-label={it.unread ? 'Mark as read' : 'Mark as unread'} onClick={() => void setRead([it], it.unread)}>
          {it.unread ? <MailOpen size={15} /> : <Mail size={15} />}
        </button>
        <button
          className="icon-btn sm"
          title="Snooze (h)"
          aria-label="Snooze"
          onClick={() => {
            useUi.getState().setCursor(it.key);
            useUi.getState().clearSelection();
            useUi.getState().setDialog({ kind: 'snooze' });
          }}
        >
          <Clock size={15} />
        </button>
        <button className="icon-btn sm" title="Star (s)" aria-label={it.flagged ? 'Unstar' : 'Star'} aria-pressed={it.flagged} onClick={() => void toggleStar([it])}>
          <Star size={15} fill={it.flagged ? 'currentColor' : 'none'} />
        </button>
      </div>
    </div>
  );
});

export type { ListPage };
