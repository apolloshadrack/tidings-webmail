import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArrowLeft, ChevronDown, ChevronUp, Clock, Download, Eye, File, FileCode2, FileImage, FileText, Filter, Forward, FolderInput, Loader2, MailOpen,
  MoreHorizontal, Paperclip, Printer, Reply, ReplyAll, ShieldAlert, ShieldCheck, Star, Trash2, UserX, X, AlertTriangle, ImageOff,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { BASE, api, partUrl, qs } from '../api/client';
import type { Attachment, FullMessage, ListItem, Mailbox, SessionInfo } from '../api/types';
import { archive, junk, setRead, toggleStar, trash } from '../lib/actions';
import { editDraftMessage, forward, reply, setCurrentMessage, setQuoteSelection } from '../lib/composeActions';
import { bytes, clean, displayName, fullDate, listDate, relative, senderWarning } from '../lib/format';
import { baseSubject } from '../lib/compose';
import { splitQuoted } from '../lib/sanitize';
import { useMailboxes, useMessage, useThread } from '../state/queries';
import { useSettings } from '../state/settings';
import { useUi } from '../state/ui';
import { Avatar } from './Brand';
import { type FrameInfo, MessageFrame } from './MessageFrame';
import { Menu, type MenuItem } from './Menu';

const InlineComposer = lazy(() => import('./Composer').then((m) => ({ default: m.InlineComposer })));

export function Reader({ session }: { session: SessionInfo }) {
  const open = useUi((s) => s.open);
  const items = useUi((s) => s.visibleItems);
  const item = useMemo(() => items.find((i) => i.key === open) ?? null, [items, open]);
  const lastItem = useRef<ListItem | null>(null);
  if (item) lastItem.current = item;
  const shown = item ?? (open ? lastItem.current : null);
  const layout = useSettings((s) => s.s.layout);

  if (!shown) {
    if (layout === 'list') return null;
    return (
      <div className="reader-empty">
        <div>
          <MailOpen size={30} strokeWidth={1.5} />
          <p style={{ margin: '10px 0 4px', color: 'var(--text-2)', fontWeight: 550 }}>Select a conversation to read</p>
          <p style={{ margin: 0, fontSize: 12.5 }}>
            <kbd>j</kbd> <kbd>k</kbd> to move · <kbd>↵</kbd> to open · <kbd>?</kbd> for all shortcuts
          </p>
        </div>
      </div>
    );
  }
  return <Conversation key={shown.key} item={shown} session={session} />;
}

function Conversation({ item, session }: { item: ListItem; session: SessionInfo }) {
  const conversations = useSettings((s) => s.s.conversations);
  const markDelay = useSettings((s) => s.s.markReadDelay);
  const thread = useThread(item, conversations && item.count > 1);
  const { data: boxes = [] } = useMailboxes();
  const items = useUi((s) => s.visibleItems);
  const senderPanel = useUi((s) => s.senderPanel);
  const composers = useUi((s) => s.composers);
  const messages = thread.data ?? [item];
  const me = useMemo(() => new Set([session.email, ...(session.allowedFrom ?? [])]), [session]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const idx = items.findIndex((i) => i.key === item.key);
  const box = boxes.find((b) => b.path === item.mailbox);

  // Expand unread + last; scroll to the first unread.
  useEffect(() => {
    const keys = new Set<string>();
    messages.forEach((m, i) => {
      if (m.unread || i === messages.length - 1) keys.add(`${m.mailbox}:${m.uid}`);
    });
    setExpanded(keys);
  }, [item.key, messages.map((m) => `${m.mailbox}:${m.uid}`).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const firstUnread = messages.findIndex((m) => m.unread);
    // Scroll only the reader (scrollIntoView would also scroll overflow:hidden ancestors).
    const sc = scrollRef.current;
    if (firstUnread > 0 && sc) {
      requestAnimationFrame(() => {
        const el = document.getElementById(`msg-${messages[firstUnread].mailbox}:${messages[firstUnread].uid}`);
        if (el) sc.scrollTo({ top: el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 12 });
      });
    } else sc?.scrollTo({ top: 0 });
  }, [item.key, messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mark as read after the configured delay; cancelled if the user moves on first.
  useEffect(() => {
    if ((!item.unread && !item.unreadCount) || markDelay < 0) return;
    const t = setTimeout(() => void setRead([item], true, true), markDelay);
    return () => clearTimeout(t);
  }, [item.key, markDelay]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const exp = () => setExpanded(new Set(messages.map((m) => `${m.mailbox}:${m.uid}`)));
    const sp = () => {
      const last = messages[messages.length - 1];
      const st = useUi.getState();
      st.setSenderPanel(st.senderPanel ? null : last.from.address);
    };
    window.addEventListener('tidings:expand-all', exp);
    window.addEventListener('tidings:sender-panel', sp);
    return () => {
      window.removeEventListener('tidings:expand-all', exp);
      window.removeEventListener('tidings:sender-panel', sp);
    };
  }, [messages]);

  const inline = composers.find((c) => c.inlineThread === item.key && !c.minimized);
  const folderChips = [...new Set(messages.map((m) => m.mailbox))].map((p) => boxes.find((b) => b.path === p)).filter(Boolean) as Mailbox[];
  const step = (d: number) => {
    const next = items[idx + d];
    if (next) useUi.getState().setOpen(next.key);
  };

  const moreItems: MenuItem[] = [
    { label: 'Show original', run: () => useUi.getState().setDialog({ kind: 'source', mailbox: messages.at(-1)!.mailbox, uidValidity: messages.at(-1)!.uidValidity, uid: messages.at(-1)!.uid }) },
    { label: 'Download as .eml', run: () => window.open(`${BASE}/api/message/source?${qs({ mailbox: messages.at(-1)!.mailbox, uidValidity: messages.at(-1)!.uidValidity, uid: messages.at(-1)!.uid, download: 1 })}`, '_blank', 'noopener') },
    { label: 'Print', run: () => window.print() },
    { divider: true },
    { label: 'Mark as unread', run: () => void setRead([item], false) },
    { label: 'Filter messages like this', run: () => useUi.getState().setDialog({ kind: 'settings', tab: 'filters' }) },
    { label: `Block ${item.from.address}`, danger: true, run: () => blockSender(item.from.address) },
  ];

  return (
    <>
      <div className="reader-toolbar" role="toolbar" aria-label="Conversation actions">
        <button className="icon-btn" aria-label="Back to list" title="Back (u)" onClick={() => useUi.getState().setOpen(null)}>
          <ArrowLeft size={18} />
        </button>
        <span className="sep" />
        <button className="icon-btn" aria-label={box?.role === '\\Archive' ? 'Move to Inbox' : 'Archive'} title="Archive (e)" onClick={() => void archive([item])}><Archive size={18} /></button>
        <button className="icon-btn" aria-label="Delete" title="Delete (#)" onClick={() => void trash([item])}><Trash2 size={18} /></button>
        <button className="icon-btn" aria-label={box?.role === '\\Junk' ? 'Not spam' : 'Mark as spam'} title="Spam (!)" onClick={() => void junk([item])}><ShieldAlert size={18} /></button>
        <button className="icon-btn" aria-label="Move to folder" title="Move (v)" onClick={() => useUi.getState().setDialog({ kind: 'move', mode: 'move' })}><FolderInput size={18} /></button>
        <button className="icon-btn" aria-label="Snooze" title="Snooze (h)" onClick={() => useUi.getState().setDialog({ kind: 'snooze' })}><Clock size={18} /></button>
        <button className="icon-btn" aria-label={item.flagged ? 'Unstar' : 'Star'} aria-pressed={item.flagged} title="Star (s)" onClick={() => void toggleStar([item])}>
          <Star size={18} fill={item.flagged ? 'currentColor' : 'none'} style={item.flagged ? { color: 'var(--star)' } : undefined} />
        </button>
        <span className="spacer" />
        {idx >= 0 && (
          <span className="list-sub num" style={{ marginRight: 4 }}>
            {idx + 1} of {items.length}
          </span>
        )}
        <button className="icon-btn" aria-label="Newer conversation" title="Newer (k)" disabled={idx <= 0} onClick={() => step(-1)}><ChevronUp size={18} /></button>
        <button className="icon-btn" aria-label="Older conversation" title="Older (j)" disabled={idx < 0 || idx >= items.length - 1} onClick={() => step(1)}><ChevronDown size={18} /></button>
        <button className="icon-btn" aria-label="More actions" aria-haspopup="menu" aria-expanded={!!menu} onClick={(e) => setMenu({ x: e.currentTarget.getBoundingClientRect().right - 220, y: e.currentTarget.getBoundingClientRect().bottom + 4 })}>
          <MoreHorizontal size={18} />
        </button>
      </div>
      <div className="reader-scroll" ref={scrollRef}>
        <article className="thread">
          <h2 className="thread-subject"><bdi>{baseSubject(clean(messages[0]?.subject ?? item.subject)) || '(no subject)'}</bdi></h2>
          <div className="thread-meta">
            {folderChips.map((b) => (
              <span key={b.path} className="folder-chip">
                {b.color && <span className="dot" style={{ width: 8, height: 8, borderRadius: 3, background: b.color }} />}
                {b.role === '\\Inbox' ? 'Inbox' : b.name}
              </span>
            ))}
            {messages.length > 1 && <span>{messages.length} messages</span>}
            {thread.isFetching && <Loader2 size={13} className="spin" />}
          </div>
          {groupRuns(messages, (m) => expanded.has(`${m.mailbox}:${m.uid}`)).map((run) => {
            const cards = run.items.map(({ m, i }) => {
              const k = `${m.mailbox}:${m.uid}`;
              return (
                <MessageCard
                  key={k}
                  item={m}
                  me={me}
                  expanded={expanded.has(k)}
                  isLast={i === messages.length - 1}
                  onToggle={() => {
                    const n = new Set(expanded);
                    if (n.has(k)) n.delete(k);
                    else n.add(k);
                    setExpanded(n);
                  }}
                  threadKey={item.key}
                  isDraftFolder={boxes.find((b) => b.path === m.mailbox)?.role === '\\Drafts'}
                />
              );
            });
            return run.open ? cards : <div key={`stack-${run.items[0].i}`} className="thread-stack">{cards}</div>;
          })}
          {inline ? (
            <Suspense fallback={null}>
              <InlineComposer id={inline.id} />
            </Suspense>
          ) : (
            <ReplyBar last={messages[messages.length - 1]} threadKey={item.key} />
          )}
        </article>
      </div>
      {senderPanel && <SenderPanel email={senderPanel} onClose={() => useUi.getState().setSenderPanel(null)} />}
      {menu && <Menu x={menu.x} y={menu.y} items={moreItems} onClose={() => setMenu(null)} />}
    </>
  );
}

function ReplyBar({ last, threadKey }: { last: ListItem; threadKey: string }) {
  const msg = useMessage(last);
  const multi = (msg.data?.to.length ?? 0) + (msg.data?.cc.length ?? 0) > 1;
  return (
    <div className="reply-bar">
      <button className="btn" disabled={!msg.data} onClick={() => msg.data && void reply(false, msg.data, threadKey)}>
        <Reply size={16} /> Reply <kbd>R</kbd>
      </button>
      {multi && (
        <button className="btn" disabled={!msg.data} onClick={() => msg.data && void reply(true, msg.data, threadKey)}>
          <ReplyAll size={16} /> Reply all <kbd>A</kbd>
        </button>
      )}
      <button className="btn" disabled={!msg.data} onClick={() => msg.data && void forward(msg.data)}>
        <Forward size={16} /> Forward <kbd>F</kbd>
      </button>
    </div>
  );
}

function MessageCard({ item, me, expanded, isLast, onToggle, threadKey, isDraftFolder }: { item: ListItem; me: Set<string>; expanded: boolean; isLast: boolean; onToggle: () => void; threadKey: string; isDraftFolder: boolean }) {
  const msg = useMessage(expanded ? item : null);
  const s = useSettings((st) => st.s);
  const [allowImages, setAllowImages] = useState(false);
  const [colorMode, setColorMode] = useState<'auto' | 'original' | 'dark'>('auto');
  const [mono, setMono] = useState(false);
  const [info, setInfo] = useState<FrameInfo | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const m = msg.data;

  useEffect(() => {
    if (!m) return;
    const policy = s.remoteImages;
    // "Always from this sender" is keyed on a From address, which can be forged: honour it only when
    // the server's trusted Authentication-Results show DKIM passed (or none are configured).
    const senderOk = m.imagesTrusted && (!m.auth || m.auth.dkim === 'pass');
    setAllowImages(policy === 'always' || senderOk);
  }, [m?.uid, m?.imagesTrusted, s.remoteImages]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (m && isLast) setCurrentMessage(m);
  }, [m, isLast]);

  const from = item.from;
  const warning = senderWarning(m?.from[0] ?? from);
  const toLine = (m?.to ?? item.to).map((a) => displayName(a, me)).join(', ');
  const ccLine = (m?.cc ?? item.cc).map((a) => displayName(a, me)).join(', ');
  const authFail = m?.auth?.trusted && (m.auth.dmarc === 'fail' || (m.auth.dkim === 'fail' && m.auth.spf === 'fail'));

  if (!expanded) {
    return (
      <div className="msg collapsed" id={`msg-${item.mailbox}:${item.uid}`}>
        <div className="msg-head" onClick={onToggle} role="button" tabIndex={0} aria-expanded={false} onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggle();
            }
          }}>
          <Avatar addr={from} />
          <div className="who">
            <div>
              <bdi className="name">{displayName(from, me)}</bdi>
            </div>
            <div className="snip">{item.snippet}</div>
          </div>
          <div className="when">
            {item.hasAttachments && <Paperclip size={13} />}
            {item.unread && <span className="unread-dot" />}
            <span title={fullDate(item.date)}>{listDate(item.date)}</span>
          </div>
        </div>
      </div>
    );
  }

  const cardMenu: MenuItem[] = [
    { label: 'Reply', run: () => m && void reply(false, m, threadKey) },
    { label: 'Reply all', run: () => m && void reply(true, m, threadKey) },
    { label: 'Forward', run: () => m && void forward(m) },
    { divider: true },
    { label: 'Show original', run: () => useUi.getState().setDialog({ kind: 'source', mailbox: item.mailbox, uidValidity: item.uidValidity, uid: item.uid }) },
    { label: mono ? 'Proportional font' : 'Monospace font', run: () => setMono(!mono) },
    ...(m?.html ? [{ label: colorMode === 'dark' ? 'Original colours' : 'Force dark colours', run: () => setColorMode(colorMode === 'dark' ? 'original' : 'dark') } as MenuItem] : []),
  ];

  return (
    <div className="msg expanded" id={`msg-${item.mailbox}:${item.uid}`}>
      <div className="msg-head" onClick={(e) => !(e.target as HTMLElement).closest('button') && onToggle()}>
        <button className="icon-btn" style={{ width: 'auto', height: 'auto', padding: 0, borderRadius: '50%' }} aria-label={`About ${from.address}`} onClick={() => useUi.getState().setSenderPanel(from.address)}>
          <Avatar addr={from} size="lg" />
        </button>
        <div className="who">
          <div>
            <bdi className="name">{displayName(from, me)}</bdi>
            {(!m?.senderKnown || !from.name) && <span className="addr">{from.address}</span>}
            {warning && (
              <span className="sender-warning" title={warning} style={{ marginLeft: 8 }}>
                <AlertTriangle size={13} aria-hidden="true" /> Check sender
              </span>
            )}
          </div>
          <div className="to" title={[toLine && `To: ${toLine}`, ccLine && `Cc: ${ccLine}`].filter(Boolean).join(' · ')}>
            to {toLine || 'undisclosed recipients'}
            {ccLine && ` · cc ${ccLine}`}
          </div>
        </div>
        <div className="when">
          {m?.listUnsubscribe && <UnsubscribeChip msg={m} />}
          <span title={fullDate(item.date)}>{relative(item.date)}</span>
          <button className="icon-btn sm" aria-label="Reply" title="Reply (r)" onClick={() => m && void reply(false, m, threadKey)}><Reply size={15} /></button>
          <button className="icon-btn sm" aria-label="Message actions" onClick={(e) => setMenu({ x: e.clientX - 200, y: e.clientY + 10 })}><MoreHorizontal size={15} /></button>
        </div>
      </div>

      {warning && (
        <div className="banner danger" role="alert">
          <AlertTriangle size={16} />
          <span className="grow">{warning}. Be careful with links and attachments.</span>
        </div>
      )}
      {authFail && (
        <div className="banner danger" role="alert">
          <ShieldAlert size={16} />
          <span className="grow">This message failed sender verification and may not be from who it claims.</span>
        </div>
      )}
      {m && info && info.blockedImages > 0 && !allowImages && (
        <div className="banner">
          <ImageOff size={16} />
          <span className="grow">
            Remote images are hidden to protect your privacy{info.trackers ? ` · ${info.trackers} tracker${info.trackers === 1 ? '' : 's'} blocked` : ''}.
          </span>
          <button className="btn sm" onClick={() => setAllowImages(true)}>
            <Eye size={14} /> Show images
          </button>
          <button
            className="btn sm ghost"
            onClick={() => {
              setAllowImages(true);
              void api('/api/senders/trust', { body: { email: from.address, trusted: true } });
            }}
          >
            Always from this sender
          </button>
        </div>
      )}
      {m?.truncated && (
        <div className="banner warn">
          <AlertTriangle size={16} /> <span className="grow">This message is very large; only the first 5 MB is shown.</span>
        </div>
      )}
      {isDraftFolder && m && (
        <div className="banner">
          <FileText size={16} /> <span className="grow">This is a draft.</span>
          <button className="btn sm primary" onClick={() => void editDraftMessage(m)}>Continue editing</button>
        </div>
      )}

      <div className="msg-body" onMouseUp={() => setQuoteSelection(window.getSelection()?.toString() ?? '')}>
        {!m ? (
          msg.isError ? (
            <div className="banner danger">
              <span className="grow">{(msg.error as Error).message}</span>
              <button className="btn sm" onClick={() => void msg.refetch()}>Retry</button>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8, padding: '6px 0 12px' }} aria-busy="true">
              <div className="skeleton" style={{ height: 10, width: '80%' }} />
              <div className="skeleton" style={{ height: 10, width: '92%' }} />
              <div className="skeleton" style={{ height: 10, width: '60%' }} />
            </div>
          )
        ) : m.html ? (
          <MessageFrame msg={m} allowImages={allowImages} colorMode={colorMode} onInfo={setInfo} />
        ) : (
          <PlainText text={m.text ?? ''} mono={mono} />
        )}
        {m && info && (info.trackers > 0 || info.cleanedLinks > 0) && (
          <div className="privacy-line" style={{ marginTop: 10 }}>
            <ShieldCheck size={14} />
            {[info.trackers ? `${info.trackers} tracker${info.trackers === 1 ? '' : 's'} blocked` : '', info.cleanedLinks ? `${info.cleanedLinks} link${info.cleanedLinks === 1 ? '' : 's'} cleaned of tracking` : '']
              .filter(Boolean)
              .join(' · ')}
          </div>
        )}
      </div>
      {m && m.attachments.filter((a) => !(a.inline && a.cid && m.html?.includes(`cid:${a.cid}`))).length > 0 && <Attachments msg={m} />}
      {menu && <Menu x={menu.x} y={menu.y} items={cardMenu} onClose={() => setMenu(null)} />}
    </div>
  );
}

const URL_RE = /\b(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?])/g;

function Linkified({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const mm of text.matchAll(URL_RE)) {
    const i = mm.index ?? 0;
    if (i > last) parts.push(text.slice(last, i));
    const href = mm[0];
    parts.push(
      <a
        key={i}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (useSettings.getState().s.confirmLinks) useUi.getState().setDialog({ kind: 'link', href, text: href, mismatch: false });
          else window.open(href, '_blank', 'noopener,noreferrer');
        }}
      >
        {href}
      </a>,
    );
    last = i + href.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function PlainText({ text, mono }: { text: string; mono: boolean }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const segs = splitQuoted(clean(text));
  return (
    <div className={`msg-plain${mono ? ' mono' : ''}`}>
      {segs.map((sg, i) =>
        sg.quoted && !showQuoted ? (
          <button key={i} className="quote-toggle" onClick={() => setShowQuoted(true)} title="Show quoted text" aria-label="Show quoted text">
            •••
          </button>
        ) : (
          <div key={i} className={sg.quoted ? 'quoted' : undefined}>
            <Linkified text={sg.text} />
          </div>
        ),
      )}
    </div>
  );
}

const RISKY = /\.(exe|scr|bat|cmd|com|js|jse|vbs|vbe|wsf|ps1|msi|jar|hta|lnk|iso|img|dll|reg|html?|svg)$/i;

function Attachments({ msg }: { msg: FullMessage }) {
  const list = msg.attachments.filter((a) => !(a.inline && a.cid && msg.html?.includes(`cid:${a.cid}`)));
  return (
    <div className="attachments" role="group" aria-label="Attachments">
      {list.map((a) => (
        <AttachmentCard key={a.part} msg={msg} a={a} />
      ))}
      {list.length > 1 && (
        <span className="hint" style={{ alignSelf: 'center' }}>
          {list.length} files · {bytes(list.reduce((n, a) => n + a.size, 0))}
        </span>
      )}
    </div>
  );
}

function AttachmentCard({ msg, a }: { msg: FullMessage; a: Attachment }) {
  const isImage = /^image\/(png|jpe?g|gif|webp)$/.test(a.contentType);
  const risky = RISKY.test(a.filename) || /\.\w+\.\w+$/.test(a.filename) && RISKY.test(a.filename.replace(/^.*(\.\w+)$/, 'x$1'));
  const ext = a.filename.split('.').pop()?.slice(0, 4) ?? '';
  const Icon = isImage ? FileImage : /pdf|text|word|document/.test(a.contentType) ? FileText : /html|xml|svg|javascript/.test(a.contentType) ? FileCode2 : File;
  const thumb = useQuery({
    queryKey: ['thumb', msg.mailbox, msg.uid, a.part],
    enabled: isImage && a.size < 8 * 1024 * 1024,
    staleTime: Infinity,
    queryFn: async () => {
      const r = await fetch(partUrl(msg, a.part, true), { credentials: 'same-origin' });
      const type = r.headers.get('content-type') ?? '';
      if (!r.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) return null;
      return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type }));
    },
  });
  return (
    <a className={`att${risky ? ' risky' : ''}`} href={partUrl(msg, a.part, false, a.filename)} download={a.filename} title={risky ? `${a.filename} — this file type can be dangerous; only open it if you trust the sender` : a.filename}>
      <span className="thumb">{thumb.data ? <img src={thumb.data} alt="" /> : ext ? <span>{ext}</span> : <Icon size={18} />}</span>
      <span className="meta">
        <span className="fname"><bdi>{a.filename}</bdi></span>
        <span className="fsize">
          {risky && <AlertTriangle size={11} style={{ color: 'var(--warn)', verticalAlign: -1, marginRight: 4 }} />}
          {bytes(a.size)}
        </span>
      </span>
      <Download size={15} style={{ marginLeft: 'auto', color: 'var(--text-3)', flex: 'none' }} />
    </a>
  );
}

function UnsubscribeChip({ msg }: { msg: FullMessage }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  if (state === 'done') return <span className="folder-chip">Unsubscribed</span>;
  return (
    <button
      className="btn sm"
      disabled={state === 'busy'}
      onClick={() =>
        useUi.getState().setDialog({
          kind: 'confirm',
          title: `Unsubscribe from ${displayName(msg.from[0])}?`,
          body: msg.listUnsubscribeOneClick ? 'Tidings will ask the sender to remove you from this list.' : 'This sender does not support one-click unsubscribe. Tidings will open their unsubscribe page or prepare an email.',
          confirm: 'Unsubscribe',
          run: async () => {
            setState('busy');
            try {
              const r = await api<{ method: string; ok?: boolean; url?: string; mailto?: string }>('/api/unsubscribe', { body: { mailbox: msg.mailbox, uidValidity: msg.uidValidity, uid: msg.uid } });
              if (r.method === 'one-click' && r.ok) {
                setState('done');
                useUi.getState().pushToast({ message: `Unsubscribed from ${displayName(msg.from[0])}`, tone: 'success' });
              } else if (r.mailto) {
                setState('idle');
                window.dispatchEvent(new CustomEvent('tidings:compose', { detail: { mailto: r.mailto } }));
              } else if (r.url) {
                setState('idle');
                window.open(r.url, '_blank', 'noopener,noreferrer');
              }
            } catch (err) {
              setState('idle');
              useUi.getState().pushToast({ message: (err as Error).message, tone: 'error' });
            }
          },
        })
      }
    >
      Unsubscribe
    </button>
  );
}

function blockSender(email: string) {
  useUi.getState().setDialog({
    kind: 'confirm',
    title: `Block ${email}?`,
    body: 'Existing messages from this sender move to Spam, and a filter sends future ones there too (when your server supports filters).',
    confirm: 'Block sender',
    danger: true,
    run: async () => {
      try {
        const r = await api<{ moved: number; filter: boolean }>('/api/senders/block', { body: { email } });
        useUi.getState().pushToast({ message: `Blocked ${email}${r.moved ? ` · ${r.moved} moved to Spam` : ''}${r.filter ? '' : ' (no server filter available)'}` });
      } catch (err) {
        useUi.getState().pushToast({ message: (err as Error).message, tone: 'error' });
      }
    },
  });
}

function SenderPanel({ email, onClose }: { email: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['sender', email],
    queryFn: () =>
      api<{ email: string; name: string | null; received: number; sentTo: number; firstSeen: number | null; lastSeen: number | null; withAttachments: number; newsletter: number; recent: { threadId: string; subject: string; date: number; mailbox: string }[]; blocked: boolean; imagesTrusted: boolean; domain: string }>(
        `/api/sender?${qs({ email })}`,
      ),
  });
  const d = q.data;
  return (
    <aside className="sender-panel" aria-label="Sender details">
      <button className="icon-btn" style={{ position: 'absolute', right: 10, top: 10 }} aria-label="Close sender details" onClick={onClose}>
        <X size={16} />
      </button>
      <Avatar addr={{ name: d?.name ?? '', address: email }} size="xl" />
      <h4><bdi>{d?.name || email.split('@')[0]}</bdi></h4>
      <div className="hint" style={{ overflowWrap: 'anywhere' }}>{email}</div>
      {d && (
        <>
          <div style={{ marginTop: 16 }}>
            <div className="stat"><span>Messages from them</span><b className="num">{d.received}</b></div>
            <div className="stat"><span>Messages you sent</span><b className="num">{d.sentTo}</b></div>
            {d.firstSeen && <div className="stat"><span>First email</span><b>{listDate(d.firstSeen)}</b></div>}
            {d.withAttachments > 0 && <div className="stat"><span>With attachments</span><b className="num">{d.withAttachments}</b></div>}
            {d.newsletter > 0 && <div className="stat"><span>Mailing list</span><b>Yes</b></div>}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={() => window.dispatchEvent(new CustomEvent('tidings:compose', { detail: { to: [{ name: d.name ?? '', address: email }] } }))}>Write email</button>
            <button className="btn sm ghost" onClick={() => useUi.getState().setView({ kind: 'search', q: `from:${email} in:anywhere` })}>All mail</button>
            <button className="btn sm ghost" onClick={() => useUi.getState().setView({ kind: 'search', q: `from:${email} has:attachment in:anywhere` })}>
              <Paperclip size={13} /> Files
            </button>
          </div>
          {d.recent.length > 0 && (
            <div className="recent">
              <div className="nav-section" style={{ padding: '14px 8px 4px' }}>Recent conversations</div>
              {d.recent.map((r) => (
                <button key={r.threadId} onClick={() => useUi.getState().setView({ kind: 'search', q: `from:${email} in:anywhere ${r.subject.replace(/[":]/g, ' ').split(/\s+/).slice(0, 4).join(' ')}` })}>
                  <bdi>{r.subject || '(no subject)'}</bdi>
                  <small>{listDate(r.date)}</small>
                </button>
              ))}
            </div>
          )}
          <div style={{ marginTop: 18, display: 'flex', gap: 6 }}>
            {!d.blocked && (
              <button className="btn sm ghost" style={{ color: 'var(--danger)' }} onClick={() => blockSender(email)}>
                <UserX size={14} /> Block
              </button>
            )}
            <button className="btn sm ghost" onClick={() => useUi.getState().setDialog({ kind: 'settings', tab: 'filters' })}>
              <Filter size={14} /> Create filter
            </button>
          </div>
        </>
      )}
      {q.isLoading && <Loader2 size={16} className="spin" style={{ marginTop: 16 }} />}
      <button className="btn sm ghost" style={{ marginTop: 10 }} onClick={() => window.print()} hidden>
        <Printer size={14} />
      </button>
    </aside>
  );
}

/** Split a thread into runs of consecutive expanded / collapsed messages. */
function groupRuns<T>(list: T[], isOpen: (t: T) => boolean): { open: boolean; items: { m: T; i: number }[] }[] {
  const runs: { open: boolean; items: { m: T; i: number }[] }[] = [];
  list.forEach((m, i) => {
    const open = isOpen(m);
    const last = runs[runs.length - 1];
    if (last && last.open === open && !open) last.items.push({ m, i });
    else runs.push({ open, items: [{ m, i }] });
  });
  return runs;
}
