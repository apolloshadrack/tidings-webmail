import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import {
  Bold, ChevronDown, Italic, Link2, List, ListOrdered, Loader2, Maximize2, Minimize2, Minus, Paperclip, Quote, Send, Strikethrough, Trash2,
  Type, Underline as UnderlineIcon, X, FileText, Sparkles, RemoveFormatting,
} from 'lucide-react';
import { ApiError, api, qs } from '../api/client';
import type { Address, ComposeState, Identity } from '../api/types';
import { htmlToPlain, isEmail, mentionsAttachment, parseAddressList, signatureFor } from '../lib/compose';
import { bytes, displayName } from '../lib/format';
import { MOD } from '../lib/keys';
import { sanitizeForComposer } from '../lib/sanitize';
import { queryClient, useIdentities, useSnippets } from '../state/queries';
import { useSettings } from '../state/settings';
import { type ComposerWindow, useUi } from '../state/ui';
import { Avatar } from './Brand';
import { Menu, type MenuItem } from './Menu';

// Remember windows by outbox id so "Undo" can restore the exact composer (quoted text, files…).
const sentWindows = new Map<string, ComposerWindow>();

export function ComposerDock() {
  const composers = useUi((s) => s.composers);
  const docked = composers.filter((c) => !c.inlineThread || c.minimized);
  return (
    <div className="composer-dock">
      {docked.map((c) => (
        <ComposerShell key={c.id} id={c.id} />
      ))}
    </div>
  );
}

export function InlineComposer({ id }: { id: string }) {
  return <ComposerShell id={id} inline />;
}

function ComposerShell({ id, inline = false }: { id: string; inline?: boolean }) {
  const w = useUi((s) => s.composers.find((c) => c.id === id));
  const [max, setMax] = useState(false);
  if (!w) return null;
  if (w.minimized) {
    return (
      <div className="composer min" role="dialog" aria-label="Minimized draft">
        <div className="composer-head" onClick={() => useUi.getState().updateComposer(id, { minimized: false })}>
          <span className="title">{w.state.subject || 'New message'}</span>
          <button className="icon-btn sm" aria-label="Expand draft" onClick={(e) => { e.stopPropagation(); useUi.getState().updateComposer(id, { minimized: false }); }}><Maximize2 size={14} /></button>
          <button className="icon-btn sm" aria-label="Close draft" onClick={(e) => { e.stopPropagation(); void closeAndSave(id); }}><X size={15} /></button>
        </div>
      </div>
    );
  }
  return <ComposerBody w={w} inline={inline} max={max} setMax={setMax} />;
}

async function saveDraft(w: ComposerWindow, html: string) {
  const st = { ...w.state, html, text: htmlToPlain(html) };
  await api(`/api/drafts/${w.id}`, { method: 'PUT', body: { ...st, quotedHtml: w.quotedHtml, quotedText: w.quotedText, files: w.files, forwardFiles: w.forwardFiles } });
}

async function closeAndSave(id: string) {
  const w = useUi.getState().composers.find((c) => c.id === id);
  useUi.getState().closeComposer(id);
  if (!w) return;
  const empty = !w.state.to.length && !w.state.subject && !htmlToPlain(w.state.html ?? '').replace(/--[\s\S]*$/, '').trim() && !w.files?.length;
  if (empty) {
    void api(`/api/drafts/${id}`, { method: 'DELETE' }).catch(() => undefined);
    return;
  }
  try {
    await saveDraft(w, w.state.html ?? '');
    await api(`/api/drafts/${id}/sync`, { body: {} });
    useUi.getState().pushToast({ message: 'Draft saved', action: { label: 'Open', run: () => useUi.getState().openComposer({ ...w, minimized: false }) } });
  } catch {
    useUi.getState().pushToast({ message: 'Draft saved on this device only', tone: 'info' });
  }
}

function ComposerBody({ w, inline, max, setMax }: { w: ComposerWindow; inline: boolean; max: boolean; setMax: (v: boolean) => void }) {
  const id = w.id;
  const update = useCallback((patch: Partial<ComposerWindow> | ((c: ComposerWindow) => Partial<ComposerWindow>)) => useUi.getState().updateComposer(id, patch), [id]);
  const setState = (patch: Partial<ComposeState>) => update((c) => ({ state: { ...c.state, ...patch } }));
  const s = useSettings((st) => st.s);
  const idents = useIdentities();
  const identities: Identity[] = idents.data?.identities ?? [];
  const [showCc, setShowCc] = useState(w.state.cc.length > 0);
  const [showBcc, setShowBcc] = useState(w.state.bcc.length > 0);
  const [plain, setPlain] = useState(s.composeMode === 'plain');
  const [plainText, setPlainText] = useState(() => htmlToPlain(w.state.html ?? ''));
  const [showQuote, setShowQuote] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [linkOpen, setLinkOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const lastSync = useRef(0);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto'] }, heading: false, codeBlock: false }),
      Placeholder.configure({ placeholder: 'Write your message…' }),
      Image.configure({ allowBase64: true, inline: false }),
    ],
    content: w.state.html ?? '<p></p>',
    autofocus: w.focus === 'body' ? 'start' : false,
    editorProps: {
      attributes: { class: 'editor', 'aria-label': 'Message body', role: 'textbox', 'aria-multiline': 'true' },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (!files.length) return false;
        const images = files.filter((f) => /^image\/(png|jpe?g|gif|webp)$/.test(f.type) && f.size < 2 * 1024 * 1024);
        const others = files.filter((f) => !images.includes(f));
        images.forEach((f) => insertImage(f));
        if (others.length) void upload(others);
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => {
      dirty.current = true;
      setState({ html: ed.getHTML() });
    },
  });

  function insertImage(f: File) {
    const r = new FileReader();
    r.onload = () => editor?.chain().focus().setImage({ src: String(r.result), alt: f.name }).run();
    r.readAsDataURL(f);
  }

  // Autosave: locally (server SQLite) 1s after typing stops; to IMAP Drafts at most every 30s.
  useEffect(() => {
    if (!dirty.current) return;
    setSaved('saving');
    const t = setTimeout(async () => {
      const cur = useUi.getState().composers.find((c) => c.id === id);
      if (!cur) return;
      try {
        await saveDraft(cur, plain ? plainToHtml(plainText) : (cur.state.html ?? ''));
        setSaved('saved');
        if (Date.now() - lastSync.current > 30_000) {
          lastSync.current = Date.now();
          void api(`/api/drafts/${id}/sync`, { body: {} }).catch(() => undefined);
        }
      } catch {
        setSaved('error');
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [w.state, plainText]); // eslint-disable-line react-hooks/exhaustive-deps

  // Switching From swaps the signature.
  function changeFrom(email: string) {
    const prev = w.state.from;
    setState({ from: email });
    if (!editor) return;
    const html = editor.getHTML();
    const oldSig = signatureFor(prev, identities);
    const newSig = signatureFor(email, identities);
    if (oldSig && html.includes('data-signature')) {
      editor.commands.setContent(html.replace(/<div data-signature="true">[\s\S]*?<\/div>/, newSig.replace('<p></p>', '')));
    } else if (newSig) {
      editor.commands.setContent(html + newSig);
    }
  }

  async function upload(files: File[]) {
    const limit = 25 * 1024 * 1024;
    for (const f of files) {
      if (f.size > limit) {
        useUi.getState().pushToast({ message: `${f.name} is larger than 25 MB`, tone: 'error' });
        continue;
      }
      const tmp = `${f.name}-${Date.now()}`;
      setUploading((u) => [...u, tmp]);
      try {
        const fd = new FormData();
        fd.append('file', f, f.name);
        const r = await api<{ id: string; filename: string; size: number; contentType: string }>(`/api/uploads?${qs({ draftId: id })}`, { raw: fd });
        dirty.current = true;
        update((c) => ({ files: [...(c.files ?? []), r], state: { ...c.state, attachments: [...c.state.attachments, r.id] } }));
      } catch (err) {
        useUi.getState().pushToast({ message: `Couldn’t attach ${f.name}: ${(err as Error).message}`, tone: 'error' });
      } finally {
        setUploading((u) => u.filter((x) => x !== tmp));
      }
    }
  }

  function removeFile(fid: string) {
    void api(`/api/uploads/${fid}`, { method: 'DELETE' }).catch(() => undefined);
    dirty.current = true;
    update((c) => ({ files: (c.files ?? []).filter((f) => f.id !== fid), state: { ...c.state, attachments: c.state.attachments.filter((a) => a !== fid) } }));
  }

  function removeForwardFile(part: string) {
    update((c) => {
      const parts = (c.state.forwardAttachments?.parts ?? []).filter((p) => p !== part);
      return {
        forwardFiles: (c.forwardFiles ?? []).filter((f) => f.part !== part),
        state: { ...c.state, forwardAttachments: c.state.forwardAttachments && parts.length ? { ...c.state.forwardAttachments, parts } : undefined },
      };
    });
  }

  function bodyHtml() {
    return plain ? plainToHtml(plainText) : (editor?.getHTML() ?? '');
  }

  async function send(force = false) {
    const cur = useUi.getState().composers.find((c) => c.id === id) ?? w;
    const st = cur.state;
    if (![...st.to, ...st.cc, ...st.bcc].length) {
      useUi.getState().pushToast({ message: 'Add at least one recipient', tone: 'error' });
      return;
    }
    const bad = [...st.to, ...st.cc, ...st.bcc].find((a) => !isEmail(a.address));
    if (bad) {
      useUi.getState().pushToast({ message: `“${bad.address}” doesn’t look like an email address`, tone: 'error' });
      return;
    }
    const html = bodyHtml();
    const ownText = plain ? plainText : htmlToPlain(html);
    if (!force) {
      const hasFiles = (cur.files?.length ?? 0) + (cur.forwardFiles?.length ?? 0) > 0;
      if (!hasFiles && mentionsAttachment(`${st.subject}\n${ownText}`)) {
        useUi.getState().setDialog({ kind: 'confirm', title: 'Forgot the attachment?', body: 'Your message mentions an attachment, but nothing is attached.', confirm: 'Send anyway', run: () => void send(true) });
        return;
      }
      if (!st.subject.trim()) {
        useUi.getState().setDialog({ kind: 'confirm', title: 'Send without a subject?', body: 'Messages without a subject are easy to miss.', confirm: 'Send anyway', run: () => void send(true) });
        return;
      }
    }
    setSending(true);
    const quotedHtml = cur.quotedHtml ?? '';
    const quotedText = cur.quotedText ?? '';
    const fullHtml = plain ? undefined : quotedHtml ? `${html}<br>${quotedHtml}` : html;
    const fullText = quotedText ? `${ownText}\n\n${quotedText}` : ownText;
    try {
      const r = await api<{ id: string; sendAt: number }>('/api/send', {
        body: { ...st, html: fullHtml, text: fullText, delaySeconds: s.undoSendSeconds },
      });
      sentWindows.set(r.id, { ...cur, state: { ...cur.state, html } });
      useUi.getState().closeComposer(id);
      void queryClient.invalidateQueries({ queryKey: ['outbox'] });
      if (s.undoSendSeconds > 0) {
        const tid = useUi.getState().pushToast({
          message: `Sending in ${s.undoSendSeconds}s…`,
          ttl: s.undoSendSeconds * 1000,
          action: {
            label: 'Undo',
            run: async () => {
              useUi.getState().dismissToast(tid);
              try {
                await api(`/api/outbox/${r.id}/cancel`, { body: {} });
                const back = sentWindows.get(r.id);
                if (back) useUi.getState().openComposer({ ...back, minimized: false, focus: 'body' });
                useUi.getState().pushToast({ message: 'Sending cancelled — back to your draft' });
              } catch (err) {
                useUi.getState().pushToast({ message: (err as ApiError).message, tone: 'error' });
              }
              void queryClient.invalidateQueries({ queryKey: ['outbox'] });
            },
          },
        });
      }
    } catch (err) {
      useUi.getState().pushToast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setSending(false);
    }
  }

  function discard() {
    const snapshot = useUi.getState().composers.find((c) => c.id === id) ?? w;
    useUi.getState().closeComposer(id);
    void api(`/api/drafts/${id}`, { method: 'DELETE' }).catch(() => undefined);
    useUi.getState().pushToast({
      message: 'Draft discarded',
      action: {
        label: 'Undo',
        run: () => {
          useUi.getState().openComposer({ ...snapshot, minimized: false });
          void saveDraft(snapshot, snapshot.state.html ?? '').catch(() => undefined);
        },
      },
    });
  }

  function insertSnippet(e: React.MouseEvent) {
    const list = queryClient.getQueryData<{ id: number; title: string; bodyHtml: string }[]>(['snippets']) ?? [];
    const items: MenuItem[] = list.length
      ? list.map((sn) => ({ label: sn.title, run: () => (plain ? setPlainText((t) => `${t}${htmlToPlain(sn.bodyHtml)}`) : editor?.chain().focus().insertContent(sanitizeForComposer(sn.bodyHtml)).run()) }))
      : [{ label: 'No snippets yet — create one in Settings', run: () => useUi.getState().setDialog({ kind: 'settings', tab: 'snippets' }) }];
    setMenu({ x: e.clientX, y: e.clientY - 40 - items.length * 34, items });
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      void send();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (linkOpen) setLinkOpen(false);
      else update({ minimized: true });
    } else if (mod && e.key.toLowerCase() === 'k' && !e.shiftKey && (e.target as HTMLElement).closest('.editor')) {
      e.preventDefault();
      e.stopPropagation();
      setLinkOpen(true);
    } else {
      e.stopPropagation(); // typing in the composer never triggers mailbox shortcuts
    }
  };

  const title = w.state.subject || (w.state.kind === 'reply' || w.state.kind === 'replyAll' ? 'Reply' : w.state.kind === 'forward' ? 'Forward' : 'New message');
  const fromOptions = identities.length ? identities : [{ email: w.state.from, name: '', signatureHtml: '', isDefault: 1 } as Identity];
  const cls = inline ? 'inline-reply' : `composer${max ? ' max' : ''}`;

  return (
    <div
      ref={root}
      className={cls}
      role={inline ? 'region' : 'dialog'}
      aria-label={title}
      onKeyDown={onKeyDown}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void upload([...e.dataTransfer.files]);
      }}
      style={{ position: inline ? 'relative' : undefined }}
    >
      {!inline && (
        <div className="composer-head" onDoubleClick={() => setMax(!max)}>
          <span className="title">{title}</span>
          <span className="saved" aria-live="polite">{saved === 'saving' ? 'Saving…' : saved === 'saved' ? 'Saved' : saved === 'error' ? 'Not saved' : ''}</span>
          <button className="icon-btn sm" aria-label="Minimize" title="Minimize (Esc)" onClick={() => update({ minimized: true })}><Minus size={15} /></button>
          <button className="icon-btn sm" aria-label={max ? 'Restore size' : 'Full screen'} onClick={() => setMax(!max)}>{max ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
          <button className="icon-btn sm" aria-label="Save and close" title="Save & close" onClick={() => void closeAndSave(id)}><X size={15} /></button>
        </div>
      )}
      {dragging && <div className="drop-overlay">Drop files to attach</div>}
      <div className="composer-fields">
        {fromOptions.length > 1 && (
          <div className="cfield">
            <label htmlFor={`from-${id}`}>From</label>
            <select id={`from-${id}`} className="bare" value={w.state.from} onChange={(e) => changeFrom(e.target.value)}>
              {fromOptions.map((i) => (
                <option key={i.email} value={i.email}>
                  {i.name ? `${i.name} <${i.email}>` : i.email}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="cfield">
          <label>To</label>
          <RecipientField value={w.state.to} onChange={(to) => { dirty.current = true; setState({ to }); }} autoFocus={w.focus === 'to'} label="To" />
          <div className="extras">
            {!showCc && <button onClick={() => setShowCc(true)}>Cc</button>}
            {!showBcc && <button onClick={() => setShowBcc(true)}>Bcc</button>}
          </div>
        </div>
        {showCc && (
          <div className="cfield">
            <label>Cc</label>
            <RecipientField value={w.state.cc} onChange={(cc) => { dirty.current = true; setState({ cc }); }} label="Cc" />
          </div>
        )}
        {showBcc && (
          <div className="cfield">
            <label>Bcc</label>
            <RecipientField value={w.state.bcc} onChange={(bcc) => { dirty.current = true; setState({ bcc }); }} label="Bcc" />
          </div>
        )}
        {!inline && (
          <div className="cfield">
            <label htmlFor={`subj-${id}`}>Subject</label>
            <input id={`subj-${id}`} className="bare" value={w.state.subject} autoFocus={w.focus === 'subject'} onChange={(e) => { dirty.current = true; setState({ subject: e.target.value }); }} />
          </div>
        )}
      </div>
      <div className="editor-wrap" onClick={(e) => { if (e.target === e.currentTarget) editor?.commands.focus('end'); }}>
        {plain ? (
          <textarea className="plain-editor" value={plainText} aria-label="Message body" autoFocus={w.focus === 'body'} onChange={(e) => { dirty.current = true; setPlainText(e.target.value); }} />
        ) : (
          <EditorContent editor={editor} />
        )}
        {linkOpen && editor && <LinkEditor editor={editor} onClose={() => setLinkOpen(false)} />}
        {(w.quotedHtml || w.quotedText) && (
          <>
            <button className="quote-toggle" title={showQuote ? 'Hide quoted text' : 'Show quoted text'} aria-expanded={showQuote} onClick={() => setShowQuote(!showQuote)}>
              •••
            </button>
            {showQuote && (
              <div className="quoted-preview">
                {plain || !w.quotedHtml ? <pre style={{ whiteSpace: 'pre-wrap', font: 'inherit', margin: 0 }}>{w.quotedText}</pre> : <QuotePreview html={w.quotedHtml} />}
              </div>
            )}
          </>
        )}
      </div>
      {((w.files?.length ?? 0) > 0 || (w.forwardFiles?.length ?? 0) > 0 || uploading.length > 0) && (
        <div className="compose-atts">
          {w.forwardFiles?.map((f) => (
            <span key={f.part} className="att">
              <span className="thumb"><FileText size={14} /></span>
              <span className="meta"><span className="fname">{f.filename}</span><span className="fsize">{bytes(f.size)} · forwarded</span></span>
              <button className="icon-btn sm" aria-label={`Remove ${f.filename}`} onClick={() => removeForwardFile(f.part)}><X size={13} /></button>
            </span>
          ))}
          {w.files?.map((f) => (
            <span key={f.id} className="att">
              <span className="thumb"><Paperclip size={14} /></span>
              <span className="meta"><span className="fname">{f.filename}</span><span className="fsize">{bytes(f.size)}</span></span>
              <button className="icon-btn sm" aria-label={`Remove ${f.filename}`} onClick={() => removeFile(f.id)}><X size={13} /></button>
            </span>
          ))}
          {uploading.map((u) => (
            <span key={u} className="att uploading">
              <span className="thumb"><Loader2 size={14} className="spin" /></span>
              <span className="meta"><span className="fname">{u.replace(/-\d+$/, '')}</span><span className="fsize">Uploading…</span></span>
            </span>
          ))}
        </div>
      )}
      {!plain && editor && <FormatBar editor={editor} onLink={() => setLinkOpen(true)} />}
      <div className="composer-foot">
        <span className="send-btn">
          <button className="btn primary" onClick={() => void send()} disabled={sending} title={`Send (${MOD}+Enter)`}>
            {sending ? <Loader2 size={15} className="spin" /> : <Send size={15} />} Send
          </button>
        </span>
        <span className="hint" style={{ marginLeft: 8 }}>{MOD}↵</span>
        <span className="spacer" />
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ''; }} />
        <button className="icon-btn" aria-label="Attach files" title="Attach files" onClick={() => fileInput.current?.click()}><Paperclip size={17} /></button>
        <button className="icon-btn" aria-label="Insert snippet" title="Insert snippet" onClick={insertSnippet}><Sparkles size={17} /></button>
        <button
          className="icon-btn"
          aria-pressed={plain}
          aria-label={plain ? 'Switch to rich text' : 'Switch to plain text'}
          title={plain ? 'Rich text' : 'Plain text'}
          onClick={() => {
            if (plain) {
              editor?.commands.setContent(plainToHtml(plainText));
              setPlain(false);
            } else {
              setPlainText(htmlToPlain(editor?.getHTML() ?? ''));
              setPlain(true);
            }
          }}
        >
          <Type size={17} />
        </button>
        <label className="check-row" style={{ fontSize: 12.5, marginLeft: 4 }} title="Ask the recipient's mail app to confirm it was read">
          <input type="checkbox" checked={w.state.requestReceipt} onChange={(e) => setState({ requestReceipt: e.target.checked })} />
          Receipt
        </label>
        <button className="icon-btn" aria-label="Discard draft" title="Discard" onClick={discard}><Trash2 size={17} /></button>
        {inline && (
          <button className="icon-btn" aria-label="Pop out" title="Pop out" onClick={() => update({ inlineThread: undefined })}>
            <ChevronDown size={17} style={{ transform: 'rotate(-135deg)' }} />
          </button>
        )}
      </div>
      {menu && <Menu x={menu.x} y={Math.max(8, menu.y)} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function plainToHtml(t: string) {
  return t
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function QuotePreview({ html }: { html: string }) {
  const doc = useMemo(() => new DOMParser().parseFromString(sanitizeForComposer(html), 'text/html'), [html]);
  return <div>{htmlToPlain(doc.body.innerHTML)}</div>;
}

function FormatBar({ editor, onLink }: { editor: Editor; onLink: () => void }) {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    editor.on('selectionUpdate', f);
    editor.on('transaction', f);
    return () => {
      editor.off('selectionUpdate', f);
      editor.off('transaction', f);
    };
  }, [editor]);
  const b = (label: string, icon: React.ReactNode, on: boolean, run: () => void, key?: string) => (
    <button className={`icon-btn sm${on ? ' on' : ''}`} aria-label={label} aria-pressed={on} title={key ? `${label} (${key})` : label} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      {icon}
    </button>
  );
  return (
    <div className="format-bar" role="toolbar" aria-label="Formatting">
      {b('Bold', <Bold size={15} />, editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), `${MOD}B`)}
      {b('Italic', <Italic size={15} />, editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), `${MOD}I`)}
      {b('Underline', <UnderlineIcon size={15} />, editor.isActive('underline'), () => editor.chain().focus().toggleUnderline().run(), `${MOD}U`)}
      {b('Strikethrough', <Strikethrough size={15} />, editor.isActive('strike'), () => editor.chain().focus().toggleStrike().run())}
      {b('Bulleted list', <List size={15} />, editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run())}
      {b('Numbered list', <ListOrdered size={15} />, editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run())}
      {b('Quote', <Quote size={15} />, editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run())}
      {b('Link', <Link2 size={15} />, editor.isActive('link'), onLink, `${MOD}K`)}
      {b('Clear formatting', <RemoveFormatting size={15} />, false, () => editor.chain().focus().unsetAllMarks().clearNodes().run())}
    </div>
  );
}

function LinkEditor({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [url, setUrl] = useState(() => (editor.getAttributes('link').href as string) ?? '');
  return (
    <div className="card" style={{ position: 'sticky', bottom: 8, display: 'flex', gap: 8, alignItems: 'center', boxShadow: 'var(--shadow-2)', marginTop: 8 }}>
      <Link2 size={15} />
      <input
        className="input"
        style={{ height: 32 }}
        autoFocus
        placeholder="https://"
        value={url}
        aria-label="Link address"
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const v = url.trim();
            if (!v) editor.chain().focus().unsetLink().run();
            else {
              const href = /^(https?:|mailto:)/i.test(v) ? v : `https://${v}`;
              if (editor.state.selection.empty) editor.chain().focus().insertContent(`<a href="${href.replace(/"/g, '%22')}">${v.replace(/[<>&]/g, '')}</a>`).run();
              else editor.chain().focus().setLink({ href }).run();
            }
            onClose();
          }
        }}
      />
      <button className="btn sm" onClick={() => { editor.chain().focus().unsetLink().run(); onClose(); }}>Remove</button>
    </div>
  );
}

/** Recipient chips with frecency autocomplete, paste-a-list, keyboard editing. */
function RecipientField({ value, onChange, autoFocus, label }: { value: Address[]; onChange: (v: Address[]) => void; autoFocus?: boolean; label: string }) {
  const [text, setText] = useState('');
  const [sugg, setSugg] = useState<Address[]>([]);
  const [active, setActive] = useState(0);
  const [selectedChip, setSelectedChip] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const q = text.trim();
    if (!q) {
      setSugg([]);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api<{ suggestions: Address[] }>(`/api/contacts/suggest?${qs({ q })}`, { signal: ctl.signal })
        .then((r) => {
          const have = new Set(value.map((v) => v.address.toLowerCase()));
          setSugg(r.suggestions.filter((sg) => !have.has(sg.address.toLowerCase())));
          setActive(0);
        })
        .catch(() => undefined);
    }, 90);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  function add(list: Address[]) {
    const have = new Set(value.map((v) => v.address.toLowerCase()));
    const next = [...value, ...list.filter((a) => a.address && !have.has(a.address.toLowerCase()))];
    onChange(next);
    setText('');
    setSugg([]);
  }

  function commitTyped() {
    const t = text.trim().replace(/[,;]$/, '');
    if (!t) return false;
    const parsed = parseAddressList(t);
    add(parsed.length ? parsed : [{ name: '', address: t }]);
    return true;
  }

  return (
    <div className="recips" onClick={() => input.current?.focus()}>
      {value.map((a, i) => (
        <span key={`${a.address}-${i}`} className={`rchip${isEmail(a.address) ? '' : ' invalid'}${selectedChip === i ? ' selected' : ''}`} title={a.address}>
          <span>{a.name ? displayName(a) : a.address}</span>
          <button
            aria-label={`Remove ${a.address}`}
            onClick={(e) => {
              e.stopPropagation();
              onChange(value.filter((_, j) => j !== i));
            }}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        ref={input}
        value={text}
        autoFocus={autoFocus}
        aria-label={`${label} recipients`}
        aria-autocomplete="list"
        onChange={(e) => {
          setSelectedChip(null);
          const v = e.target.value;
          if (/[,;]\s*$/.test(v) && isEmail(v.replace(/[,;]\s*$/, ''))) {
            add([{ name: '', address: v.replace(/[,;]\s*$/, '').trim() }]);
            return;
          }
          setText(v);
        }}
        onPaste={(e) => {
          const t = e.clipboardData.getData('text');
          const list = parseAddressList(t);
          if (list.length > 1 || (list.length === 1 && /[,;<]/.test(t))) {
            e.preventDefault();
            add(list);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && sugg.length) {
            e.preventDefault();
            setActive((a) => (a + 1) % sugg.length);
          } else if (e.key === 'ArrowUp' && sugg.length) {
            e.preventDefault();
            setActive((a) => (a - 1 + sugg.length) % sugg.length);
          } else if ((e.key === 'Enter' || e.key === 'Tab') && (sugg.length || text.trim())) {
            if (sugg[active]) {
              e.preventDefault();
              add([sugg[active]]);
            } else if (commitTyped()) e.preventDefault();
          } else if (e.key === 'Backspace' && !text && value.length) {
            if (selectedChip === null) setSelectedChip(value.length - 1);
            else {
              onChange(value.filter((_, j) => j !== selectedChip));
              setSelectedChip(null);
            }
          } else if (e.key === 'Escape' && sugg.length) {
            e.stopPropagation();
            setSugg([]);
          }
        }}
        onBlur={() => setTimeout(() => {
          commitTyped();
          setSelectedChip(null);
        }, 150)}
      />
      {sugg.length > 0 && (
        <div className="suggest" role="listbox">
          {sugg.map((sg, i) => (
            <button key={sg.address} role="option" aria-selected={i === active} className={i === active ? 'active' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => add([sg])}>
              <Avatar addr={sg} />
              <span>
                {sg.name || sg.address}
                {sg.name && <small>{sg.address}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function useSnippetsWarm() {
  useSnippets();
}
