import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Mail, Plus, Search, Trash2, Upload, Users } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { BASE, api } from '../../api/client';
import { listDate } from '../../lib/format';
import { useUi } from '../../state/ui';
import { Avatar } from './SubscriptionsView';

interface Contact {
  id: number;
  name: string;
  email: string;
  notes: string;
  source: 'manual' | 'sent' | 'received';
  useCount: number;
  lastUsed: number | null;
}

const SOURCE_LABEL: Record<Contact['source'], string> = { manual: 'Saved', sent: 'You wrote to', received: 'Wrote to you' };

export function ContactsView() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['contacts'], queryFn: () => api<{ contacts: Contact[] }>('/api/contacts').then((r) => r.contacts) });
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', notes: '' });
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (q.data ?? []).filter((c) => !f || c.email.toLowerCase().includes(f) || c.name.toLowerCase().includes(f) || c.notes.toLowerCase().includes(f));
  }, [q.data, filter]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['contacts'] });

  const add = async () => {
    setErr(null);
    try {
      await api('/api/contacts', { body: form });
      setForm({ name: '', email: '', notes: '' });
      setAdding(false);
      setNote('Contact saved');
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const remove = (c: Contact) =>
    useUi.getState().setDialog({
      kind: 'confirm',
      title: `Delete ${c.name || c.email}?`,
      body: 'They’ll be removed from your contacts and suggestions. Their messages are not affected.',
      confirm: 'Delete contact',
      danger: true,
      run: async () => {
        try {
          await api(`/api/contacts/${c.id}`, { method: 'DELETE' });
          await refresh();
        } catch (e) {
          setErr((e as Error).message);
        }
      },
    });

  const importFile = async (file: File) => {
    setErr(null);
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('That file is larger than 5 MB.');
      const vcf = await file.text();
      const r = await api<{ imported: number }>('/api/contacts/import', { body: { vcf } });
      setNote(r.imported ? `Imported ${r.imported} contact${r.imported === 1 ? '' : 's'}` : 'No new contacts found in that file');
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const write = (c: Contact) => window.dispatchEvent(new CustomEvent('tidings:compose', { detail: { to: [{ name: c.name, address: c.email }] } }));

  return (
    <div className="page">
      <div className="s-page-head">
        <div>
          <h2>Contacts</h2>
          <p className="hint">People you’ve saved or written to. Tidings suggests them as you type a recipient.</p>
        </div>
        <div className="s-row-actions">
          <input
            ref={fileRef}
            type="file"
            accept=".vcf,text/vcard,text/x-vcard"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
              e.target.value = '';
            }}
          />
          <button type="button" className="btn sm" onClick={() => fileRef.current?.click()}>
            <Upload size={14} aria-hidden="true" /> Import vCard
          </button>
          <a className="btn sm" href={`${BASE}/api/contacts.vcf`} download>
            <Download size={14} aria-hidden="true" /> Export
          </a>
          <button type="button" className="btn sm primary" onClick={() => setAdding(true)}>
            <Plus size={14} aria-hidden="true" /> New contact
          </button>
        </div>
      </div>

      {note && (
        <p className="s-ok" role="status">
          {note}
        </p>
      )}
      {err && (
        <div className="s-error" role="alert">
          {err}
        </div>
      )}

      {adding && (
        <form
          className="card s-stack s-add-contact"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="s-grid2">
            <label className="field">
              <span>Name</span>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus maxLength={200} />
            </label>
            <label className="field">
              <span>Email address</span>
              <input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span>Notes (optional)</span>
            <input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={5000} />
          </label>
          <div className="s-row-actions">
            <span className="grow" />
            <button type="button" className="btn ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={!form.email.trim()}>
              Save contact
            </button>
          </div>
        </form>
      )}

      {(q.data?.length ?? 0) > 0 && (
        <label className="search s-page-search s-wide">
          <Search size={15} aria-hidden="true" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search contacts" aria-label="Search contacts" />
        </label>
      )}

      {q.isLoading && (
        <div aria-busy="true" aria-label="Loading contacts">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 48, marginTop: 10 }} />
          ))}
        </div>
      )}
      {q.data && q.data.length === 0 && !adding && (
        <div className="s-empty">
          <Users size={28} aria-hidden="true" />
          <h3>No contacts yet</h3>
          <p className="hint">People you write to are added automatically. You can also import a vCard file from another app.</p>
        </div>
      )}
      {list.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Source</th>
              <th scope="col">Last written</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id}>
                <td>
                  <div className="s-sender">
                    <Avatar name={c.name} email={c.email} />
                    <div className="s-min">
                      <b className="s-ellipsis">{c.name || c.email}</b>
                      <small className="hint s-ellipsis">
                        {c.email}
                        {c.notes ? ` · ${c.notes}` : ''}
                      </small>
                    </div>
                  </div>
                </td>
                <td>
                  <span className={`s-badge s-badge-${c.source}`}>{SOURCE_LABEL[c.source]}</span>
                </td>
                <td className="hint num">{c.lastUsed ? listDate(c.lastUsed) : '—'}</td>
                <td>
                  <div className="s-row-actions s-end">
                    <button type="button" className="btn sm ghost" onClick={() => write(c)}>
                      <Mail size={14} aria-hidden="true" /> Write
                    </button>
                    <button type="button" className="icon-btn sm" aria-label={`Delete ${c.name || c.email}`} onClick={() => remove(c)}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {q.data && q.data.length > 0 && list.length === 0 && <p className="hint">No contacts match “{filter}”.</p>}
    </div>
  );
}
