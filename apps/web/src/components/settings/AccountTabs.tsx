import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { api } from '../../api/client';
import type { Identity } from '../../api/types';
import { useIdentities, useSnippets } from '../../state/queries';
import { InlineError, Section, SkeletonRows, htmlToPlainText, plainToHtml } from './controls';

interface DraftIdentity {
  name: string;
  email: string;
  replyTo: string;
  signature: string; // plain text in the editor, stored as minimal HTML
  isDefault: boolean;
}

export function IdentitiesTab() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useIdentities();
  const [rows, setRows] = useState<DraftIdentity[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const base = useId();

  useEffect(() => {
    if (data && !rows) {
      setRows(
        data.identities.map((i: Identity) => ({
          name: i.name,
          email: i.email,
          replyTo: i.replyTo ?? '',
          signature: htmlToPlainText(i.signatureHtml),
          isDefault: !!i.isDefault,
        })),
      );
    }
  }, [data, rows]);

  if (isLoading || (!rows && !error)) return <SkeletonRows />;
  if (error) return <InlineError error={error} />;
  const allowed = data?.allowed ?? null;
  const list = rows ?? [];
  const edit = (i: number, patch: Partial<DraftIdentity>) => {
    setSaved(false);
    setRows(list.map((r, j) => (j === i ? { ...r, ...patch } : patch.isDefault ? { ...r, isDefault: false } : r)));
  };
  const unused = allowed?.filter((a) => !list.some((r) => r.email === a)) ?? [];
  const canAdd = allowed === null || unused.length > 0;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api('/api/identities', {
        method: 'PUT',
        body: list.map((r) => ({
          name: r.name.trim(),
          email: r.email.trim(),
          replyTo: r.replyTo.trim() || null,
          signatureHtml: r.signature.trim() ? plainToHtml(r.signature.trim()) : '',
          isDefault: r.isDefault,
        })),
      });
      await qc.invalidateQueries({ queryKey: ['identities'] });
      setSaved(true);
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="Identities and signatures"
      lead="The name and address people see when you write. Replies are sent from whichever of your addresses the message was sent to."
    >
      {allowed && (
        <p className="hint s-note">
          Your administrator allows sending from {allowed.length === 1 ? 'this address only' : 'these addresses'}: {allowed.join(', ')}.
        </p>
      )}
      <div className="s-stack">
        {list.map((r, i) => (
          <fieldset className="card s-identity" key={i}>
            <legend className="sr-only">Identity {i + 1}</legend>
            <div className="s-grid2">
              <label className="field">
                <span>Display name</span>
                <input className="input" value={r.name} onChange={(e) => edit(i, { name: e.target.value })} placeholder="Your name" maxLength={200} />
              </label>
              <label className="field">
                <span>Email address</span>
                {allowed ? (
                  <select className="select input" value={r.email} onChange={(e) => edit(i, { email: e.target.value })}>
                    {[r.email, ...unused].filter(Boolean).map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input className="input" type="email" value={r.email} onChange={(e) => edit(i, { email: e.target.value })} placeholder="you@example.com" />
                )}
              </label>
              <label className="field">
                <span>Reply-to (optional)</span>
                <input className="input" type="email" value={r.replyTo} onChange={(e) => edit(i, { replyTo: e.target.value })} placeholder="Replies go to this address" />
              </label>
              <div className="field">
                <span id={`${base}-def-${i}`}>Default</span>
                <label className="check-row">
                  <input type="radio" name={`${base}-default`} checked={r.isDefault} onChange={() => edit(i, { isDefault: true })} aria-labelledby={`${base}-def-${i}`} />
                  Use for new messages
                </label>
              </div>
            </div>
            <label className="field">
              <span>Signature</span>
              <textarea
                className="textarea"
                rows={3}
                value={r.signature}
                onChange={(e) => edit(i, { signature: e.target.value })}
                placeholder={'Alice Wanjiru\nHead of Operations'}
              />
            </label>
            <div className="s-row-actions">
              <button type="button" className="btn sm ghost" onClick={() => setRows(list.filter((_, j) => j !== i))} disabled={list.length <= 1}>
                <Trash2 size={14} aria-hidden="true" /> Remove identity
              </button>
            </div>
          </fieldset>
        ))}
      </div>
      <div className="s-row-actions s-save">
        <button
          type="button"
          className="btn sm"
          disabled={!canAdd}
          onClick={() => setRows([...list, { name: list[0]?.name ?? '', email: unused[0] ?? '', replyTo: '', signature: '', isDefault: false }])}
        >
          <Plus size={14} aria-hidden="true" /> Add identity
        </button>
        <span className="grow" />
        {saved && <span className="hint" role="status">Saved</span>}
        <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save identities'}
        </button>
      </div>
      <InlineError error={saveError} />
    </Section>
  );
}

export function SnippetsTab() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useSnippets();
  const [editing, setEditing] = useState<{ id?: number; title: string; body: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!editing || !editing.title.trim() || !editing.body.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api('/api/snippets', { body: { id: editing.id, title: editing.title.trim(), bodyHtml: plainToHtml(editing.body.trim()) } });
      await qc.invalidateQueries({ queryKey: ['snippets'] });
      setEditing(null);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: number) => {
    try {
      await api(`/api/snippets/${id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['snippets'] });
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <Section title="Snippets" lead="Reusable text you insert while writing. In the composer, open the command palette and type the snippet’s name.">
      {isLoading && <SkeletonRows n={2} />}
      <InlineError error={error} />
      {data && data.length === 0 && !editing && <p className="hint">No snippets yet. Good candidates: directions to your office, a meeting link, a standard reply.</p>}
      <div className="s-stack">
        {data?.map((sn) =>
          editing?.id === sn.id ? null : (
            <div className="card s-snippet" key={sn.id}>
              <div className="grow">
                <b>{sn.title}</b>
                <p className="hint s-clamp">{htmlToPlainText(sn.bodyHtml)}</p>
              </div>
              <button type="button" className="icon-btn sm" aria-label={`Edit ${sn.title}`} onClick={() => setEditing({ id: sn.id, title: sn.title, body: htmlToPlainText(sn.bodyHtml) })}>
                <Pencil size={15} />
              </button>
              <button type="button" className="icon-btn sm" aria-label={`Delete ${sn.title}`} onClick={() => void remove(sn.id)}>
                <Trash2 size={15} />
              </button>
            </div>
          ),
        )}
        {editing && (
          <div className="card s-stack">
            <label className="field">
              <span>Name</span>
              <input className="input" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="Meeting link" autoFocus maxLength={200} />
            </label>
            <label className="field">
              <span>Text</span>
              <textarea className="textarea" rows={5} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
            </label>
            <div className="s-row-actions">
              <span className="grow" />
              <button type="button" className="btn ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="button" className="btn primary" disabled={busy || !editing.title.trim() || !editing.body.trim()} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save snippet'}
              </button>
            </div>
          </div>
        )}
      </div>
      {!editing && (
        <div className="s-row-actions">
          <button type="button" className="btn sm" onClick={() => setEditing({ title: '', body: '' })}>
            <Plus size={14} aria-hidden="true" /> New snippet
          </button>
        </div>
      )}
      <InlineError error={err} />
    </Section>
  );
}
